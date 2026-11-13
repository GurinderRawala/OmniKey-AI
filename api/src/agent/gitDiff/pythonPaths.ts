/**
 * Bounded STATIC resolution of Python path variables used by write calls
 * (`NAME.write_text(…)`, `NAME.write_bytes(…)`, `open(NAME, 'w')`). Python is
 * never executed. A variable resolves only when EVERY binding of it in the
 * script is a top-level, unconditional `NAME = <path expression>` statement;
 * a use then takes the latest binding textually before it (sequential
 * rebinding). Path expressions are limited to:
 *
 *   Path('<lit>') | Path.home() | Path(<expr>, '<lit>', …) | NAME
 *   <expr> / '<lit>' | <expr>.joinpath('<lit>', …)
 *   os.path.expanduser('~' | '~/<lit>') | os.path.join(<expr>, '<lit>', …)
 *
 * `Path.home()`/`~` need the home directory of the known absolute shell cwd;
 * any HOME/user override (env assignment, sudo/su, os.environ) or opaque
 * construct (see PY_OPAQUE) leaves the write unknown. Anything else, too.
 */

/** Python constructs that can rebind names or change cwd invisibly: no variable resolution. */
export const PY_OPAQUE =
  /"""|'''|\bimport\s*\*|\b(?:match|case)\b|\bdef\s+\w+\s*\(|\blambda\b[^:\n]*:|\bclass\s+\w+\s*[(:]|\b(?:exec|eval|globals|locals|vars|setattr|getattr|chdir|__import__)\s*\(|\bimportlib\b/;
/** The home directory could have been overridden for the interpreter. */
const HOME_OVERRIDE =
  /\b(?:docker|podman|ssh|runuser|pkexec|launchctl)\b|\benv\s+-i\b|\bHOME\s*=|\bsudo\b|\bsu\b|\bos\s*\.\s*(?:environ|putenv)\b|\bdoas\b/;
const MAX_DEPTH = 8;
const LITERAL = String.raw`\s*(['"])([^'"\n\\$\`{}]*)\1[ \t]*`;
const HEAD_PATH_LITERAL = new RegExp(String.raw`^(?:pathlib\s*\.\s*)?Path\(${LITERAL}\)`);
const HEAD_HOME = /^(?:pathlib\s*\.\s*)?Path\s*\.\s*home\(\s*\)/;
const HEAD_EXPANDUSER = new RegExp(String.raw`^os\s*\.\s*path\s*\.\s*expanduser\(${LITERAL}\)`);
const HEAD_CALL = /^(?:(?:pathlib\s*\.\s*)?Path|os\s*\.\s*path\s*\.\s*join)\(/;
const NAME_RE = /^([A-Za-z_]\w*)/;
const JOIN_SLASH = new RegExp(String.raw`^\s*/(?!/|=)${LITERAL}`);
const JOINPATH = /^\s*\.\s*joinpath\(/;
const LIT_ARG = new RegExp(String.raw`^,${LITERAL}`);
/** Statement end after a binding value (`;`, newline, comment, closing `-c` quote). */
const STATEMENT_END = /^\s*(?:[;\n#"']|$)/;

type Binding = { index: number; valueStart: number };

const join = (base: string, part: string) =>
  part.startsWith('/') ? part : part ? `${base.replace(/\/$/, '')}/${part}` : base;

export class PythonPathResolver {
  private readonly bindings = new Map<string, Binding[] | null>();
  private readonly home: string | undefined;
  readonly opaque: boolean;

  constructor(
    private readonly text: string,
    home: string | undefined,
  ) {
    this.opaque = PY_OPAQUE.test(text);
    this.home = HOME_OVERRIDE.test(text) ? undefined : home;
  }

  /** Literal (possibly relative) path of `name` as used at `at`, or undefined. */
  pathAt(name: string, at: number, depth = 0): string | undefined {
    if (this.opaque || depth > MAX_DEPTH || name === 'Path' || name === 'os') return undefined;
    const binding = this.bindingsOf(name)
      ?.filter((b) => b.index < at)
      .pop();
    if (!binding) return undefined;
    const parsed = this.expr(binding.valueStart, binding.index, depth + 1);
    if (!parsed || !STATEMENT_END.test(this.text.slice(parsed.end, parsed.end + 4)))
      return undefined;
    return parsed.path;
  }

  /** Every binding of `name`, or null when any of them is not provably simple. */
  private bindingsOf(name: string): Binding[] | null {
    if (this.bindings.has(name)) return this.bindings.get(name)!;
    const text = this.text;
    const out: Binding[] = [];
    let result: Binding[] | null = out;
    for (const m of text.matchAll(new RegExp(`(?<![\\w.])${name}(?!\\w)`, 'g'))) {
      const index = m.index ?? 0;
      const before = text.slice(Math.max(0, index - 40), index);
      const after = text.slice(index + name.length, index + name.length + 400);
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      const prefix = text.slice(lineStart, index);
      // `f(a, NAME, …)` is a use; a bare `NAME,` at depth 0 may be tuple binding.
      const inCall = (prefix.match(/\(/g)?.length ?? 0) > (prefix.match(/\)/g)?.length ?? 0);
      if (
        new RegExp(`^\\s*${name}\\s*:(?!=)`).test(text.slice(lineStart, index + name.length + 60))
      ) {
        result = null;
        break;
      }
      if (!inCall && /^\s*:(?!=)/.test(after)) {
        result = null;
        break;
      }
      const rebinds =
        /(?:\bas|\bfor|\bdel|\bglobal|\bnonlocal|\bimport|\*)\s*$/.test(before) ||
        (!inCall && /,\s*$/.test(before)) ||
        /^\s*[)\]]*\s*(?:(?:\/\/|\*\*|>>|<<|[-+*/%&|^@])?=(?!=)|:=|\.\s*\w+\s*=(?!=)|\[)/.test(
          after,
        ) ||
        (!inCall && /^\s*[)\]]*\s*,/.test(after));
      if (!rebinds) continue;
      const simple = /^\s*=(?!=)\s*/.exec(after);
      // Top level: no indentation, no single-line compound header, statement start.
      const topLevel =
        !/^\s/.test(prefix) &&
        !prefix.includes(':') &&
        (!prefix || /(?:;|-c\s+["'])\s*$/.test(prefix));
      if (!simple || !topLevel) {
        result = null;
        break;
      }
      out.push({ index, valueStart: index + name.length + simple[0].length });
    }
    this.bindings.set(name, result);
    return result;
  }

  /** Parse one path expression at `pos`; names resolve as bound before `at`. */
  private expr(
    pos: number,
    at: number,
    depth: number,
    literalHead = false,
  ): { path: string; end: number } | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const src = (from: number) => this.text.slice(from, from + 600);
    /** Consume `, '<lit>'`… then `)` from `from`; joins onto `base`. */
    const literalArgs = (base: string, from: number) => {
      let path = base;
      let cursor = from;
      for (let lit; (lit = LIT_ARG.exec(src(cursor))); cursor += lit[0].length) {
        if (!lit[2]) return undefined;
        path = join(path, lit[2]);
      }
      const close = /^\s*\)/.exec(src(cursor));
      return close ? { path, end: cursor + close[0].length } : undefined;
    };
    const head = src(pos);
    let value: { path: string | undefined; end: number } | undefined;
    let m: RegExpExecArray | null;
    if ((m = HEAD_PATH_LITERAL.exec(head)))
      value = { path: m[2] || undefined, end: pos + m[0].length };
    else if ((m = HEAD_HOME.exec(head))) value = { path: this.home, end: pos + m[0].length };
    else if ((m = HEAD_EXPANDUSER.exec(head))) {
      const lit = m[2];
      const ok = this.home && (lit === '~' || lit.startsWith('~/'));
      value = { path: ok ? this.home + lit.slice(1) : undefined, end: pos + m[0].length };
    } else if ((m = HEAD_CALL.exec(head))) {
      const inner = this.expr(pos + m[0].length, at, depth + 1, true);
      value = inner && literalArgs(inner.path, inner.end);
    } else if (literalHead && (m = new RegExp(`^${LITERAL}`).exec(head))) {
      value = { path: m[2] || undefined, end: pos + m[0].length };
    } else if ((m = NAME_RE.exec(head)) && !/^\s*[([]/.test(head.slice(m[0].length))) {
      value = { path: this.pathAt(m[1], at, depth), end: pos + m[0].length };
    }
    if (!value?.path) return undefined;
    let { path, end } = value;
    // Postfix joins: `/ '<lit>'` and `.joinpath('<lit>', …)`.
    for (;;) {
      const tail = src(end);
      if ((m = JOIN_SLASH.exec(tail))) {
        if (!m[2]) return undefined;
        path = join(path, m[2]);
        end += m[0].length;
      } else if ((m = JOINPATH.exec(tail))) {
        const first = new RegExp(`^${LITERAL}`).exec(src(end + m[0].length));
        if (!first?.[2]) return undefined;
        const rest = literalArgs(join(path, first[2]), end + m[0].length + first[0].length);
        if (!rest) return undefined;
        ({ path, end } = rest);
      } else break;
    }
    return { path, end };
  }
}
