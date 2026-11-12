/**
 * Contract v4 write evidence: a conservative, deterministic heuristic (NOT a
 * shell parser) that notices write-like shell scripts of the current run and
 * extracts literal write targets. Nothing is executed, expanded or looked up
 * on any filesystem. Unknown shapes contribute no paths; the result never
 * claims every write was observed.
 */
import { isSafeAbsolutePath, isSafeToolCallId, normalizeAbsolutePath } from './contracts';
import type { GitRunState } from './coordinator';

export const WRITE_EVIDENCE_MAX_SCRIPTS = 16;
export const WRITE_EVIDENCE_MAX_TARGETS = 300;
const MAX_SCRIPT_EXCERPT = 4_000;
const MAX_OUTPUT_EXCERPT = 1_000;
const MAX_SCAN_CHARS = 64_000;

export interface WriteTarget {
  path: string;
  /** Verified explicit creation evidence (exclusive create, errexit mkdir/noclobber, mktemp). */
  created: boolean;
  /** Explicit removal (rm/unlink/mv source). */
  removed: boolean;
}

export interface ShellWriteEvidence {
  toolCallId: string;
  status: 'succeeded' | 'failed' | 'unknown';
  cwd?: string;
  /** Redacted, bounded excerpt (withheld when a sensitive path is targeted). */
  script: string;
  output: string;
  truncated: boolean;
  redacted: boolean;
  kinds: string[];
  targets: WriteTarget[];
  /**
   * A write target existed but could not be resolved to a literal safe path
   * (variables, globs, relative path without cwd, caps). Coverage is then
   * uncertain and a snapshot is never claimed complete.
   */
  unresolved?: boolean;
  /**
   * Writes recognised as agent task bookkeeping (see `auxiliaryTarget`):
   * well-known metadata files and scratch directories of a provable task
   * directory under `~/.omniAgent/garbage/<id>` or `~/.omnikey/garbage/<id>`.
   * They need no diff coverage but still invalidate a checkpoint they touch.
   * Absent when none were recognised (older evidence shape unchanged).
   */
  auxiliaryTargets?: AuxiliaryTarget[];
}

export interface AuxiliaryTarget {
  /** Well-known entry name inside the task directory (e.g. `summary.md`, `tmp`). */
  name: string;
  /** Literal absolute path when resolvable; absent when only the pattern is proven. */
  path?: string;
  removed: boolean;
}

/** Exact metadata children of a task directory (any write). */
export const TASK_METADATA_NAMES: ReadonlySet<string> = new Set([
  'summary.md',
  'status',
  'ledger.tsv',
  '.omniagent-owned',
]);
/** Scratch directories of a task directory (removal only). */
export const TASK_SCRATCH_NAMES: ReadonlySet<string> = new Set([
  'prompts',
  'logs',
  'handoffs',
  'tmp',
]);
const MAX_AUXILIARY_TARGETS = 32;
/** `<home>/.omniAgent|.omnikey/garbage/<task-id>/<name>` (one child level only). */
export const TASK_ENTRY_PATH =
  /^\/(?:Users|home)\/[^/]+\/\.(?:omniAgent|omnikey)\/garbage\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/([^/]+)$/;

function bookkeepingName(name: string, removed: boolean): string | undefined {
  return TASK_METADATA_NAMES.has(name) || (removed && TASK_SCRATCH_NAMES.has(name))
    ? name
    : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.docker', '.kube', '.git']);
const SENSITIVE_NAMES = new Set(
  (
    'credentials credentials.json credentials.yml credentials.yaml .netrc _netrc .npmrc .pypirc ' +
    '.htpasswd .git-credentials secrets.json secrets.yml secrets.yaml known_hosts authorized_keys'
  ).split(' '),
);
const SENSITIVE_EXT = new Set('pem key p12 pfx keystore jks p8 ppk asc gpg kdbx'.split(' '));
const SAFE_PATH_CHARS = /^\/[A-Za-z0-9._@+\-/]+$/;

/** Mirrors the native GitSensitivePathPolicy (plus Git internals). */
export function isSensitiveWritePath(path: string): boolean {
  const parts = path.toLowerCase().split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some((p) => SENSITIVE_DIRS.has(p))) return true;
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return true;
  if (SENSITIVE_NAMES.has(name) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return true;
  if (name.startsWith('service-account') && name.endsWith('.json')) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && SENSITIVE_EXT.has(name.slice(dot + 1));
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /(["'][^"'\n]*(?:password|secret|token|api_key|apiKey)[^"'\n]*["']\s*:\s*)("[^"\n]*"|'[^'\n]*')/gi,
    '$1"[REDACTED]"',
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED]',
  ],
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g,
    '[REDACTED]',
  ],
  [
    /\b(authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?|bearer\s+)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    '$1[REDACTED]',
  ],
  [
    /\b([A-Za-z0-9_]*(?:secret|token|passw(?:or)?d|api_?key|private_?key|credential)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gi,
    '$1$2[REDACTED]',
  ],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED]@'],
];

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return { text: out, redacted: out !== text };
}

interface Word {
  value: string;
  tilde: boolean;
  /** A `$` came from single quotes (literal, not an expansion): never resolved. */
  quotedDollar?: boolean;
}
type Token = Word | { op: string };

/** Quote-aware lexer: words, separators and redirections; heredoc bodies skipped. */
function lex(script: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: string[] = [];
  let word = null as Word | null;
  const flush = () => {
    if (word) tokens.push(word);
    word = null;
  };
  const push = (ch: string, quoted = false) => {
    word ??= { value: '', tilde: !quoted && ch === '~' };
    word.value += ch;
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === "'" || ch === '"') {
      const end = script.indexOf(ch, i + 1);
      const stop = end < 0 ? script.length : end;
      word ??= { value: '', tilde: false };
      const quoted = script.slice(i + 1, stop);
      if (ch === "'" && quoted.includes('$')) word.quotedDollar = true;
      word.value += quoted;
      i = stop;
    } else if (ch === '\\' && i + 1 < script.length) {
      push(script[++i], true);
    } else if (ch === '#' && !word) {
      while (i + 1 < script.length && script[i + 1] !== '\n') i++;
    } else if (ch === '\n') {
      flush();
      tokens.push({ op: ';' });
      for (const delim of heredocs.splice(0)) {
        const lines = script.slice(i + 1).split('\n');
        let skip = 0;
        while (skip < lines.length && lines[skip].trim() !== delim) skip++;
        i += lines.slice(0, Math.min(skip + 1, lines.length)).join('\n').length + 1;
      }
    } else if (/[;&|()]/.test(ch)) {
      flush();
      if (ch === '&' && script[i + 1] === '>') continue; // `&>` handled as `>`
      tokens.push({ op: ch === '&' && script[i + 1] !== '&' ? ';' : ch });
      if ((ch === '&' || ch === '|') && script[i + 1] === ch) i++;
    } else if (ch === '>' || ch === '<') {
      const fd = word && /^\d$/.test(word.value);
      if (fd) word = null;
      else flush();
      let op = ch;
      while (
        script[i + 1] === '>' ||
        script[i + 1] === '<' ||
        script[i + 1] === '|' ||
        script[i + 1] === '-'
      )
        op += script[++i];
      if (script[i + 1] === '&') {
        i++; // fd duplication (`>&2`, `2>&1`): not a file
        while (/[\d-]/.test(script[i + 1] ?? '')) i++;
        continue;
      }
      if (op.startsWith('<<') && op !== '<<<') {
        while (script[i + 1] === ' ') i++;
        let delim = '';
        while (i + 1 < script.length && !/[\s;&|<>]/.test(script[i + 1])) delim += script[++i];
        heredocs.push(delim.replace(/['"\\]/g, ''));
        continue;
      }
      tokens.push({ op: op.replace(/-$/, '') });
    } else if (/\s/.test(ch)) {
      flush();
    } else push(ch);
  }
  flush();
  return tokens;
}

interface Resolver {
  cwd?: string;
  vars: Map<string, string | null>;
  /** Variables with proven task-directory provenance (see `taskDirectoryVariables`). */
  taskDirCandidates?: ReadonlySet<string>;
  /** Candidates whose single assignment has already been executed (lexical order). */
  taskDirs?: Set<string>;
}

/**
 * Pieces a task id may be built from: safe literal characters, `date +FMT`
 * with directives that never produce `/`, and random/pid sources.
 */
const TASK_ID_PIECE = String.raw`(?:[A-Za-z0-9_-]|\$\((?:date(?: -u)? \+(?:%[YmdHMSjyFTsz]|[A-Za-z0-9_-])+|uuidgen|openssl rand -hex \d{1,2})\)|\$RANDOM|\$\$)`;
const COMPOUND_LINE =
  /^\s*(?:if|elif|else|then|while|until|for|case|do|select|function)\b|^\s*[({]|[{(]\s*$|\)\s*\{|(?:&&|\|\||\\)\s*$/;

/**
 * Shell variables that provably name ONE task directory
 * `$HOME/.omniAgent|.omnikey/garbage/<child>`: assigned exactly once, on a
 * top-level line before any compound construct, from either a safe child
 * built of literals/timestamp/random pieces (possibly via a task-id variable)
 * or the bounded "current task" lookup
 * `$(ls -td "$HOME/.omniAgent/garbage"/<glob> 2>/dev/null | head -1)`.
 * Nothing is executed; anything else is not proven.
 */
function taskDirectoryVariables(text: string): Set<string> {
  if (/\\\r?\n/.test(text)) return new Set();
  const dequoted = text.replace(/['"\\]/g, '');
  if (/\b(?:eval|source|trap)\b|(?:^|[;&|\n])\s*\.\s|(?:^|[;&|\n])\s*\$/.test(dequoted))
    return new Set();
  if (
    /\b(?:export|declare|typeset|readonly|local|integer|float|read|mapfile|readarray|getopts|let|unset)\b|\bprintf\s+-v\b/.test(
      dequoted,
    )
  )
    return new Set();
  const proven = new Set<string>();
  const ids = new Set<string>();
  const singlyAssigned = (name: string) => {
    // Every bare occurrence must be the one declaration. References are
    // allowed, but quoted exports, array assignments and hidden rebinding
    // all contribute another bare occurrence and therefore fail closed.
    const referencesRemoved = dequoted.replace(
      new RegExp(`\\$\\{${name}\\}|\\$${name}(?!\\w)`, 'g'),
      '',
    );
    const occurrences = referencesRemoved.match(new RegExp(`(?<![\\w$])${name}(?!\\w)`, 'g'));
    return occurrences?.length === 1;
  };
  const ref = (set: Set<string>) =>
    set.size ? `|\\$(?:\\{(?:${[...set].join('|')})\\}|(?:${[...set].join('|')})(?!\\w))` : '';
  const lines = text.split('\n');
  for (const line of lines) {
    if (COMPOUND_LINE.test(line)) break;
    const m = /^(?:export )?([A-Za-z_]\w*)=(\S.*)$/.exec(line.trimEnd());
    if (!m || !singlyAssigned(m[1])) continue;
    const raw = m[2];
    if (/['`\\]/.test(raw) || raw.startsWith('"~')) continue;
    const norm = raw.replace(/"/g, '').replace(/\s+/g, ' ');
    const home = raw.startsWith('~/')
      ? '~'
      : String.raw`\$HOME|\$\{HOME\}|/(?:Users|home)/[A-Za-z0-9._-]+`;
    const piece = `(?:${TASK_ID_PIECE}${ref(ids)})`;
    if (new RegExp(`^(?!\\.)${piece}+$`).test(norm)) ids.add(m[1]);
    else if (
      new RegExp(`^(?:${home})/\\.(?:omniAgent|omnikey)/garbage/(?![.])${piece}+$`).test(norm) ||
      new RegExp(
        String.raw`^\$\(ls -(?:td|dt) (?:\$HOME|\$\{HOME\})/\.(?:omniAgent|omnikey)/garbage/(?![.])[A-Za-z0-9._*-]+(?: 2>/dev/null)? \| head -(?:n ?)?1\)$`,
      ).test(norm)
    )
      proven.add(m[1]);
  }
  return proven;
}

/** Bookkeeping entry named by `$TASK_DIR/<name>` for an active proven variable. */
function patternBookkeeping(word: Word, r: Resolver, removed: boolean): string | undefined {
  if (word.tilde || word.quotedDollar) return undefined;
  const m = /^\$(?:\{(\w+)\}|(\w+))\/([^/]+)$/.exec(word.value);
  if (!m || !r.taskDirs?.has(m[1] ?? m[2])) return undefined;
  return bookkeepingName(m[3], removed);
}

function homeOf(cwd: string | undefined): string | undefined {
  return cwd ? /^\/(?:Users|home)\/[^/]+/.exec(cwd)?.[0] : undefined;
}

/** Literal path resolution: absolute, ~/$HOME and $PWD/relative only with a known cwd. */
function resolve(word: Word, r: Resolver): string | undefined {
  if (word.quotedDollar) return undefined;
  let v = word.value;
  const home = homeOf(r.cwd);
  if (word.tilde) {
    if (!home || !(v === '~' || v.startsWith('~/'))) return undefined;
    v = home + v.slice(1);
  }
  let unresolved = false;
  v = v.replace(/\$(?:\{(\w+)\}|(\w+))/g, (_m, a: string, b: string) => {
    const name = a ?? b;
    const value = name === 'HOME' ? home : name === 'PWD' ? r.cwd : (r.vars.get(name) ?? undefined);
    if (!value) unresolved = true;
    return value ?? '';
  });
  if (unresolved || /[$`*?[\]{}]/.test(v) || !v) return undefined;
  if (!v.startsWith('/')) {
    if (!r.cwd) return undefined;
    v = `${r.cwd}/${v.replace(/^\.\//, '')}`;
  }
  return isSafeAbsolutePath(v) ? normalizeAbsolutePath(v) : undefined;
}

const GIT_WRITES = new Set(
  'apply am checkout restore reset stash merge rebase cherry-pick revert pull mv rm clean switch'.split(
    ' ',
  ),
);
const PREFIXES = new Set(
  'sudo env command nohup time exec xargs if then do else elif while until ! {'.split(' '),
);

interface Scan {
  kinds: Set<string>;
  targets: Map<string, WriteTarget>;
  createdDirs: string[];
  mktemp: Set<string>;
  sensitive: boolean;
  unresolved: boolean;
  commands: number;
  auxiliary: AuxiliaryTarget[];
}

function addAuxiliary(s: Scan, target: AuxiliaryTarget): void {
  const same = s.auxiliary.find(
    (a) => a.name === target.name && a.path === target.path && a.removed === target.removed,
  );
  if (same) return;
  // Over the bound the remainder is unknown rather than silently ignored.
  if (s.auxiliary.length >= MAX_AUXILIARY_TARGETS) s.unresolved = true;
  else s.auxiliary.push(target);
}

function addTarget(s: Scan, path: string | undefined, flags: Partial<WriteTarget> = {}): void {
  if (!path) {
    s.unresolved = true;
    return;
  }
  if (path.startsWith('/dev/')) return;
  if (isSensitiveWritePath(path)) {
    s.sensitive = true;
    return;
  }
  if (
    !SAFE_PATH_CHARS.test(path) ||
    (!s.targets.has(path) && s.targets.size >= WRITE_EVIDENCE_MAX_TARGETS)
  ) {
    s.unresolved = true;
    return;
  }
  const prev = s.targets.get(path) ?? { path, created: false, removed: false };
  s.targets.set(path, {
    path,
    created: prev.created || flags.created === true,
    removed: prev.removed || flags.removed === true,
  });
}

function scanCommand(
  words: Word[],
  redirects: Array<[string, Word]>,
  r: Resolver,
  s: Scan,
  ctx: { noclobber: boolean },
) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i].value)) i++;
  if (i === words.length || words[i]?.value === 'export') {
    for (const w of words.slice(words[i]?.value === 'export' ? i + 1 : 0)) {
      const m = /^([A-Za-z_]\w*)=(.*)$/.exec(w.value);
      if (!m) continue;
      const value =
        resolve({ value: m[2], tilde: m[2].startsWith('~'), quotedDollar: w.quotedDollar }, r) ??
        null;
      r.vars.set(m[1], r.vars.has(m[1]) ? null : value); // reassigned => unknown
      if (r.taskDirCandidates?.has(m[1])) r.taskDirs?.add(m[1]);
    }
  }
  /** One write operand: bookkeeping is recorded separately, anything else as a target. */
  const write = (w: Word, flags: Partial<WriteTarget> = {}) => {
    const removed = flags.removed === true;
    const path = resolve(w, r);
    // A path built from any variable but $HOME is bookkeeping only through a
    // proven task-directory variable; a literal one only by its exact shape.
    const viaVariable = /\$(?!HOME\b|\{HOME\})/.test(w.value);
    const literal = path && !viaVariable ? TASK_ENTRY_PATH.exec(path) : null;
    const name = literal
      ? bookkeepingName(literal[1], removed)
      : viaVariable
        ? patternBookkeeping(w, r, removed)
        : undefined;
    if (name) addAuxiliary(s, { name, ...(path ? { path } : {}), removed });
    else addTarget(s, path, flags);
  };
  for (const [op, target] of redirects) {
    if (!op.startsWith('>') || target.value.startsWith('/dev/')) continue;
    s.kinds.add('redirect');
    write(target, { created: ctx.noclobber && op === '>' });
  }
  while (i < words.length && PREFIXES.has(words[i].value)) i++;
  const cmd = (words[i]?.value ?? '').split('/').pop() ?? '';
  const args = words.slice(i + 1);
  const operands = (skipValueOf: RegExp = /^$/) => {
    const out: Word[] = [];
    let opts = true;
    for (let k = 0; k < args.length; k++) {
      const v = args[k].value;
      if (opts && v === '--') opts = false;
      else if (opts && v.startsWith('-') && v !== '-') {
        if (skipValueOf.test(v)) k++;
      } else if (v !== '') out.push(args[k]);
    }
    return out;
  };
  const paths = (ws: Word[]) => ws.map((w) => resolve(w, r));
  if (cmd === 'cd') {
    const dest = args[0] ? resolve(args[0], r) : undefined;
    r.cwd = dest;
  } else if (cmd === 'pushd' || cmd === 'popd') {
    r.cwd = undefined;
  } else if (cmd === 'tee' || cmd === 'touch' || cmd === 'truncate') {
    if (cmd !== 'tee' || operands().length > 0) s.kinds.add(cmd);
    operands(/^-s$/).forEach((w) => write(w));
  } else if (cmd === 'mkdir') {
    s.kinds.add('mkdir');
    if (!args.some((a) => /^-\w*p|^--parents/.test(a.value)))
      paths(operands(/^-m$/)).forEach((p) => p && s.createdDirs.push(p));
  } else if (cmd === 'ln') {
    s.kinds.add(cmd);
    s.unresolved = true; // Metadata symlinks can redirect later auxiliary writes.
    const ops = operands();
    if (ops.length >= 2) addTarget(s, resolve(ops[ops.length - 1], r));
  } else if (cmd === 'cp' || cmd === 'mv' || cmd === 'install' || cmd === 'rsync') {
    s.kinds.add(cmd);
    const ops = operands(/^-[mogt]$/);
    if (ops.length >= 2) write(ops[ops.length - 1]);
    else s.unresolved = true;
    if (cmd === 'mv') ops.slice(0, -1).forEach((w) => write(w, { removed: true }));
  } else if (cmd === 'rm' || cmd === 'unlink' || cmd === 'rmdir') {
    s.kinds.add(cmd);
    operands().forEach((w) => write(w, { removed: true }));
  } else if (
    (cmd === 'sed' || cmd === 'perl') &&
    args.some((a) => /^-\w*i|^--in-place/.test(a.value))
  ) {
    s.kinds.add(`${cmd} -i`);
    const exprFlag = args.some((a) => /^-\w*[eEf]$/.test(a.value));
    const ops = operands(/^-\w*[eEf]$/);
    (cmd === 'sed' && !exprFlag ? ops.slice(1) : ops).forEach((w) => write(w));
  } else if (cmd === 'dd') {
    s.kinds.add('dd');
    const of = args.find((a) => a.value.startsWith('of='));
    if (of) write({ value: of.value.slice(3), tilde: false });
    else s.kinds.delete('dd'); // stdout only
  } else if (cmd === 'curl' || cmd === 'wget') {
    const k = args.findIndex(
      (a) => a.value === (cmd === 'curl' ? '-o' : '-O') || a.value === '--output',
    );
    if (k >= 0 && args[k + 1]) {
      s.kinds.add(cmd);
      write(args[k + 1]);
    }
  } else if (cmd === 'patch') {
    s.kinds.add('patch');
  } else if (cmd === 'git') {
    let k = 0;
    while (k < args.length && args[k].value.startsWith('-'))
      k += /^-[Cc]$/.test(args[k].value) ? 2 : 1;
    if (GIT_WRITES.has(args[k]?.value ?? '')) s.kinds.add(`git ${args[k].value}`);
  }
}

const PY_PATH_WRITE = /Path\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.\s*write_(?:text|bytes)\(/g;
const PY_OPEN = /\bopen\(\s*(['"])([^'"\n]+)\1\s*,\s*(?:mode\s*=\s*)?(['"])([rwaxbt+]+)\3/g;
const NODE_WRITE =
  /\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\(\s*(['"])([^'"\n]+)\1/g;

const PY_VAR_WRITE = /(?<![\w.])([A-Za-z_]\w*)\s*\.\s*write_(?:text|bytes)\(/g;
/** Python constructs that can rebind names or change cwd invisibly: no variable resolution. */
const PY_OPAQUE =
  /\b(?:match|case)\b|\bdef\s+\w+\s*\(|\blambda\b[^:\n]*:|\bclass\s+\w+\s*[(:]|\b(?:exec|eval|globals|locals|vars|setattr|getattr|chdir|__import__)\s*\(|\bimportlib\b/;

/**
 * Literal path of `NAME.write_text(…)`/`write_bytes(…)` when NAME has exactly
 * one binding in the whole script, and that binding is a top-level, unconditional
 * `NAME = Path('<literal>')` statement. Any other binding form (reassignment,
 * augmented/tuple/walrus/for/with/import/del/global, attribute mutation, use
 * as a call keyword), indentation, a single-line compound (`:` before it), or
 * a non-literal value leaves the write unknown. Python is never evaluated.
 */
function pythonVariablePath(text: string, name: string): string | undefined {
  if (name === 'Path' || PY_OPAQUE.test(text)) return undefined;
  const token = new RegExp(`(?<![\\w.])${name}(?!\\w)`, 'g');
  let binding: { index: number; literal: string } | undefined;
  for (const m of text.matchAll(token)) {
    const index = m.index ?? 0;
    const before = text.slice(Math.max(0, index - 40), index);
    const after = text.slice(index + name.length, index + name.length + 400);
    const rebinds =
      /(?:\bas|\bfor|\bdel|\bglobal|\bnonlocal|\bimport|,|\*)\s*$/.test(before) ||
      /^\s*[)\]]*\s*(?:,|(?:\/\/|\*\*|>>|<<|[-+*/%&|^@])?=(?!=)|:=|\.\s*\w+\s*=(?!=)|\[)/.test(
        after,
      );
    if (!rebinds) continue;
    if (binding) return undefined; // more than one binding
    const value =
      /^\s*=\s*(?:pathlib\s*\.\s*)?Path\(\s*(['"])([^'"\n\\$`{}]+)\1\s*\)\s*(?=[;\n#"']|$)/.exec(
        after,
      );
    if (!value) return undefined;
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const prefix = text.slice(lineStart, index);
    // Top level: no indentation, no single-line compound header, statement start.
    if (/^\s/.test(prefix) || prefix.includes(':')) return undefined;
    if (prefix && !/(?:;|-c\s+["'])\s*$/.test(prefix)) return undefined;
    binding = { index, literal: value[2] };
  }
  return binding?.literal;
}

/** Classify one script; `undefined` when nothing write-like was recognised. */
export function classifyShellWrites(
  script: string,
  input: { cwd?: string; output?: string; status: ShellWriteEvidence['status'] },
):
  | (Omit<
      ShellWriteEvidence,
      'toolCallId' | 'status' | 'cwd' | 'script' | 'output' | 'truncated' | 'redacted'
    > & { sensitive: boolean })
  | undefined {
  const text = script.slice(0, MAX_SCAN_CHARS);
  const s: Scan = {
    kinds: new Set(),
    targets: new Map(),
    createdDirs: [],
    mktemp: new Set(),
    sensitive: false,
    unresolved: false,
    commands: 0,
    auxiliary: [],
  };
  const r: Resolver = {
    cwd: input.cwd,
    vars: new Map(),
    taskDirCandidates: taskDirectoryVariables(text),
    taskDirs: new Set(),
  };
  // No creation claims for conditional/error-masking or mode-changing
  // scripts. Detecting a write remains deliberately broader than proving creation.
  const conditional =
    /(?:[|&`()]|\$\(|[{}]|\b(?:trap|try|except|suppress)\b|&&|\|\||\b(?:if|while|until|elif|else|then|function|eval)\b|(?:^|[;\n])\s*!|\bset\s+\+)/.test(
      text,
    );
  const first =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) ?? '';
  const errexit = /^set\s+(?:-[a-zA-Z]*e[a-zA-Z]*|-o\s+errexit)(?:\s|;|$)/.test(first);
  const ctx = { noclobber: false };
  let creationSafeCommands = true;
  let words: Word[] = [];
  let redirects: Array<[string, Word]> = [];
  const tokens = lex(text);
  const end = () => {
    if (words.length || redirects.length) {
      s.commands += 1;
      const executable = words.filter((w) => !/^[A-Za-z_]\w*=/.test(w.value));
      const cmd = executable[0]?.value;
      if (cmd && !['set', 'cd', 'mkdir', 'printf', 'echo', 'cat', 'mktemp'].includes(cmd))
        creationSafeCommands = false;
      if (cmd === 'set' && executable.slice(1).some((w) => w.value.startsWith('+')))
        creationSafeCommands = false;
      if (cmd === 'mkdir' && executable.some((w) => /^-.*p|^--parents/.test(w.value)))
        creationSafeCommands = false;
      if (cmd === 'set') {
        for (let n = 1; n < executable.length; n++) {
          const option = executable[n].value;
          if (option === '-o') {
            if (
              !['errexit', 'noclobber', 'pipefail', 'nounset', 'xtrace'].includes(
                executable[++n]?.value,
              )
            )
              creationSafeCommands = false;
          } else if (!/^-[eCux]+$/.test(option)) creationSafeCommands = false;
        }
      }
      if (words[0]?.value === 'set') {
        for (let n = 1; n < words.length; n++) {
          const option = words[n].value;
          if ((option === '-o' || option === '+o') && words[n + 1]?.value === 'noclobber') {
            ctx.noclobber = option === '-o';
            n++;
          } else if (/^[-+][a-zA-Z]*C/.test(option)) ctx.noclobber = option.startsWith('-');
        }
      }
      scanCommand(words, redirects, r, s, ctx);
    }
    words = [];
    redirects = [];
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if ('op' in t) {
      if (/^[<>]/.test(t.op)) {
        const next = tokens[k + 1];
        if (next && !('op' in next)) {
          redirects.push([t.op, next]);
          k++;
        }
      } else end();
    } else words.push(t);
  }
  end();
  const pyCwd = input.cwd ?? leadingDirectory(text);
  for (const [re, kind] of [
    [PY_PATH_WRITE, 'python write'],
    [PY_OPEN, 'python open'],
    [NODE_WRITE, 'node write'],
  ] as const) {
    for (const m of text.matchAll(re)) {
      const mode = re === PY_OPEN ? m[4] : 'w';
      if (!/[wax+]/.test(mode)) continue;
      s.kinds.add(kind);
      const p = resolve({ value: m[2], tilde: false }, { cwd: pyCwd, vars: new Map() });
      addTarget(s, p); // Interpreter execution alone cannot prove absence at turn start.
    }
  }
  let literalInterpreterWrites = [PY_PATH_WRITE, PY_OPEN, NODE_WRITE].reduce(
    (n, re) => n + [...text.matchAll(re)].length,
    0,
  );
  // `p = Path('<literal>')` … `p.write_text(…)`: one provable binding only.
  // Relative literals need the starting cwd to still hold (no cd/chdir later).
  const cds = text.match(/(?:^|[;&|(\n]|\bthen|\bdo)\s*(?:cd|pushd|popd)\b/g)?.length ?? 0;
  const lead = leadingDirectory(text);
  const varCwd = cds === 0 ? input.cwd : cds === 1 && lead ? lead : undefined;
  const bindings = new Map<string, string | undefined>();
  for (const m of text.matchAll(PY_VAR_WRITE)) {
    if (!bindings.has(m[1])) bindings.set(m[1], pythonVariablePath(text, m[1]));
    const literal = bindings.get(m[1]);
    if (!literal) continue;
    const p = resolve({ value: literal, tilde: false }, { cwd: varCwd, vars: new Map() });
    if (!p) continue;
    s.kinds.add('python write');
    addTarget(s, p);
    literalInterpreterWrites += 1;
  }
  const genericInterpreterWrites = (
    text.match(
      /\.write_(?:text|bytes)\(|\bopen\([^)\n]*,\s*['"][wax]|\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\(/g,
    ) ?? []
  ).length;
  if (genericInterpreterWrites) s.kinds.add('python write');
  // A dynamic interpreter write (computed path) cannot be attributed.
  if (genericInterpreterWrites > literalInterpreterWrites) s.unresolved = true;
  // Only a bare successful mktemp invocation proves what produced stdout.
  const bare = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ');
  if (
    /^mktemp(?:\s+[^;&|<>$`"'{}\\]+)?$/.test(bare) &&
    !/(?:^|\s)-(?:[a-zA-Z]*[du]|-directory|-[a-zA-Z]*dry-run)/.test(bare) &&
    input.status === 'succeeded' &&
    input.output
  ) {
    s.kinds.add('mktemp');
    const value = input.output.trim();
    if (
      /^(?:\/private)?\/(?:tmp|var\/folders)\/[A-Za-z0-9._@+\-/]+$/.test(value) &&
      isSafeAbsolutePath(value)
    ) {
      s.mktemp.add(normalizeAbsolutePath(value));
      addTarget(s, normalizeAbsolutePath(value));
    }
  }
  if (!s.kinds.size) return undefined;
  // Creation evidence only holds if the script provably stopped on failure.
  const strict =
    input.status === 'succeeded' &&
    creationSafeCommands &&
    !conditional &&
    (errexit || s.commands <= 1);
  const targets = [...s.targets.values()].map((t) => ({
    ...t,
    created:
      (input.status !== 'failed' && s.mktemp.has(t.path)) ||
      (strict && (t.created || s.createdDirs.some((d) => t.path.startsWith(`${d}/`)))),
  }));
  return {
    kinds: [...s.kinds].slice(0, 12),
    targets,
    sensitive: s.sensitive,
    unresolved: s.unresolved,
    auxiliaryTargets: s.auxiliary,
  };
}

function excerpt(
  text: string,
  max: number,
): { text: string; truncated: boolean; redacted: boolean } {
  const clean = text.replace(CONTROL, '');
  const red = redactSecrets(clean.slice(0, max));
  return { text: red.text, truncated: clean.length > max, redacted: red.redacted };
}

/**
 * Record write evidence for an issued shell of this run, only after the
 * client's actual terminal reply. Failed scripts count (partial writes).
 */
export function recordShellWriteEvidence(
  run: GitRunState | undefined,
  toolCallId: string,
  input: { script: string; cwd?: string; output: string; isError: boolean | undefined },
): boolean {
  const state = run?.recovery;
  if (!run || !state || run.connection?.aborted) return false;
  if (!isSafeToolCallId(toolCallId) || !state.issuedToolCalls.has(toolCallId)) return false;
  if (state.writes.some((w) => w.toolCallId === toolCallId)) return false;
  const status =
    input.isError === true ? 'failed' : input.isError === false ? 'succeeded' : 'unknown';
  const cwd = input.cwd ?? leadingDirectory(input.script);
  const found = classifyShellWrites(input.script, { cwd: input.cwd, output: input.output, status });
  if (!found) return false;
  if (state.writes.length >= WRITE_EVIDENCE_MAX_SCRIPTS) {
    state.writesOmitted = (state.writesOmitted ?? 0) + 1;
    return false;
  }
  const script = found.sensitive
    ? { text: '[script withheld: it targets a sensitive path]', truncated: true, redacted: true }
    : excerpt(input.script, MAX_SCRIPT_EXCERPT);
  const output = found.sensitive
    ? { text: '', truncated: false, redacted: true }
    : excerpt(input.output, MAX_OUTPUT_EXCERPT);
  state.writes.push({
    toolCallId,
    status,
    ...(cwd ? { cwd } : {}),
    script: script.text,
    output: output.text,
    truncated: script.truncated || output.truncated,
    redacted: script.redacted || output.redacted,
    kinds: found.kinds,
    ...(found.unresolved ? { unresolved: true } : {}),
    ...(found.auxiliaryTargets?.length ? { auxiliaryTargets: found.auxiliaryTargets } : {}),
    targets: found.targets.map((t) => ({
      ...t,
      // Absence proven only in the first issued shell can describe turn start.
      // Later creation may replace something removed by an earlier command.
      created:
        t.created &&
        !state.priorNonShellTool &&
        state.issuedToolCalls.values().next().value === toolCallId,
    })),
  });
  return true;
}

/** Literal leading `cd /abs` of a script (the shell's starting cwd hint). */
export function leadingDirectory(script: string): string | undefined {
  const m = /^\s*cd\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|'"]+))\s*(?:&&|;|\n)/.exec(script);
  const path = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  return path && isSafeAbsolutePath(path) ? normalizeAbsolutePath(path) : undefined;
}
