/**
 * Contract v4 AI reconstruction: when the known coverage of this turn is
 * incomplete (see coverage.ts), one tool-free model call may reconstruct full
 * before/after file contents for the KNOWN MISSING allowlisted paths only
 * (literal current-turn write targets and verified native record paths not
 * covered by any verified patch). The backend validates the strict reply
 * (every required path must be addressed) and builds the unified diff itself;
 * no model patch is ever executed or stored. Every result is labelled
 * unverified; "complete" only ever means known coverage, never accuracy.
 */
import type { AIMessage } from '../../ai-client';
import {
  DIFF_RECOVERY_MAX_LIMITATIONS,
  GIT_DIFF_MAX_REPOSITORIES,
  comparablePath,
  isSafeRelativePath,
  pathIsWithin,
  type GitDiffRepository,
} from './contracts';
import type { DiffRecoveryRunState } from './coordinator';
import type { WriteTarget } from './writeEvidence';

export const DIFF_RECONSTRUCTION_MAX_OUTPUT_TOKENS = 4_096;
export const DIFF_RECONSTRUCTION_MAX_FILES = 300;
export const DIFF_RECONSTRUCTION_MAX_FILE_BYTES = 256 * 1024;
export const DIFF_RECONSTRUCTION_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_CHARS = 512 * 1024;
const MAX_MODEL_LIMITATIONS = 3;
const CONTEXT_LINES = 3;
const REDACTION_MARKER = '[REDACTED]';
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export const DIFF_RECONSTRUCTION_SYSTEM_PROMPT = [
  'You reconstruct file changes for a read-only diff viewer from the shell commands of the CURRENT turn only.',
  'You have no tools and no prior conversation history. Use only the commands and outputs provided.',
  'Reply with exactly one JSON object and nothing else, either:',
  '{"files":[{"path":"<path copied exactly from allowedPaths>","before":"<full content before this turn>"|null,"after":"<full content after the commands>"|null}]}',
  'or {"unavailable":true} if you cannot reconstruct the changes from the provided commands.',
  'Every entry of allowedPaths is REQUIRED: list each exactly once (use identical before and after if it ended unchanged).',
  'If any required path cannot be fully reconstructed, reply {"unavailable":true}; a partial answer is discarded.',
  'Rules: never invent paths; use before:null ONLY when creationVerified is true; use after:null ONLY when deletionAllowed is true;',
  'never pretend an unknown earlier content was empty or new;',
  'never fabricate content that the commands do not determine; prefer {"unavailable":true} over guessing.',
].join('\n');

export interface ReconstructedFile {
  path: string;
  before: string | null;
  after: string | null;
}

/** Union of literal write targets of this run, minus authoritatively reverted roots. */
export function reconstructionAllowlist(state: DiffRecoveryRunState): Map<string, WriteTarget> {
  const allow = new Map<string, WriteTarget>();
  for (const write of state.writes) {
    for (const t of write.targets) {
      if (state.revertedRoots.some((root) => pathIsWithin(t.path, root))) continue;
      const key = comparablePath(t.path);
      const prev = allow.get(key);
      if (!prev && allow.size >= DIFF_RECONSTRUCTION_MAX_FILES) continue;
      // Creation must hold for every write that targets the path.
      allow.set(key, {
        path: t.path,
        created: prev ? prev.created && t.created : t.created,
        removed: (prev?.removed ?? false) || t.removed,
      });
    }
  }
  return allow;
}

export function buildReconstructionMessages(
  state: DiffRecoveryRunState,
  allow: Map<string, WriteTarget>,
): AIMessage[] {
  const payload = {
    userInput: state.input ?? '',
    ...(state.steering?.length ? { steeringUpdates: [...state.steering] } : {}),
    limits: {
      maxFiles: DIFF_RECONSTRUCTION_MAX_FILES,
      maxFileBytes: DIFF_RECONSTRUCTION_MAX_FILE_BYTES,
    },
    allowedPaths: [...allow.values()].map((t) => ({
      path: t.path,
      creationVerified: t.created,
      deletionAllowed: t.removed,
    })),
    commands: state.writes.map((w) => ({
      toolCallId: w.toolCallId,
      status: w.status,
      ...(w.cwd ? { cwd: w.cwd } : {}),
      writeKinds: w.kinds,
      script: w.script,
      output: w.output,
      excerptIncomplete: w.truncated || w.redacted,
    })),
  };
  return [
    { role: 'system', content: DIFF_RECONSTRUCTION_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * Strict `{files, limitations}` parser. Fail closed: any unknown key, a path
 * outside the allowlist, a duplicate, an unverified creation/deletion, NUL
 * bytes or a size bound rejects the whole reply. Returns null when invalid.
 */
export function parseReconstructionFiles(
  value: Record<string, unknown>,
  allow: Map<string, WriteTarget>,
  options: { requireAll?: boolean } = {},
): { files: ReconstructedFile[]; limitations: string[] } | null {
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'files,limitations' && keys !== 'files') return null;
  const { files, limitations = [] } = value as { files: unknown; limitations?: unknown };
  if (!Array.isArray(files) || files.length < 1 || files.length > DIFF_RECONSTRUCTION_MAX_FILES)
    return null;
  if (!Array.isArray(limitations) || limitations.some((l) => typeof l !== 'string')) return null;
  const seen = new Set<string>();
  const out: ReconstructedFile[] = [];
  let total = 0;
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    if (Object.keys(entry).sort().join(',') !== 'after,before,path') return null;
    const { path, before, after } = entry as Record<string, unknown>;
    if (typeof path !== 'string') return null;
    const target = allow.get(comparablePath(path));
    if (!target || target.path !== path || seen.has(path)) return null;
    seen.add(path);
    for (const side of [before, after]) {
      if (side !== null && typeof side !== 'string') return null;
      if (typeof side === 'string') {
        if (side.includes('\u0000') || utf8(side) > DIFF_RECONSTRUCTION_MAX_FILE_BYTES) return null;
        total += utf8(side);
      }
    }
    if (before === null && (!target.created || after === null)) return null;
    if (after === null && !target.removed) return null;
    if (total > DIFF_RECONSTRUCTION_MAX_TOTAL_BYTES) return null;
    if (before === after) continue; // no change: nothing to show
    out.push({ path, before: before as string | null, after: after as string | null });
  }
  // Coverage mode: a subset of the required paths is a known omission.
  if (options.requireAll && seen.size !== allow.size) return null;
  if (!out.length && !options.requireAll) return null;
  return {
    files: out,
    limitations: (limitations as string[])
      .slice(0, MAX_MODEL_LIMITATIONS)
      .map((l) => l.replace(CONTROL_CHARS, ' ').trim().slice(0, 200))
      .filter(Boolean),
  };
}

/** Strip a single fenced block and parse a top-level JSON object, or null. */
export function parseReplyObject(content: string): Record<string, unknown> | null {
  let text = (content ?? '').trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith('{') || text.length > MAX_REPLY_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Lines with their terminator; the last one may lack `\n`. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  const eol = text.endsWith('\n');
  if (eol) parts.pop();
  return parts.map((l, i) => (i === parts.length - 1 && !eol ? l : `${l}\n`));
}

function emit(prefix: string, line: string): string {
  return line.endsWith('\n')
    ? `${prefix}${line}`
    : `${prefix}${line}\n\\ No newline at end of file\n`;
}

function range(start: number, len: number): string {
  return `${len ? start + 1 : start},${len}`;
}

/**
 * Deterministic git-style patch for one file: one hunk around the changed
 * region (common prefix/suffix trimmed, 3 context lines). Bounded by input.
 */
export function buildFilePatch(rel: string, before: string | null, after: string | null): string {
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const head = [`diff --git a/${rel} b/${rel}`];
  if (before === null) head.push('new file mode 100644');
  if (after === null) head.push('deleted file mode 100644');
  if (!a.length && !b.length) return `${head.join('\n')}\n`;
  head.push(before === null ? '--- /dev/null' : `--- a/${rel}`);
  head.push(after === null ? '+++ /dev/null' : `+++ b/${rel}`);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const start = Math.max(0, p - CONTEXT_LINES);
  const tail = Math.min(CONTEXT_LINES, s);
  const endA = a.length - s + tail;
  const endB = b.length - s + tail;
  const body = [
    ...a.slice(start, p).map((l) => emit(' ', l)),
    ...a.slice(p, a.length - s).map((l) => emit('-', l)),
    ...b.slice(p, b.length - s).map((l) => emit('+', l)),
    ...a.slice(a.length - s, endA).map((l) => emit(' ', l)),
  ].join('');
  return `${head.join('\n')}\n@@ -${range(start, endA - start)} +${range(start, endB - start)} @@\n${body}`;
}

/**
 * Group validated files under deterministic roots (a known shell cwd that
 * contains the path, else its parent directory). Never model controlled.
 */
export function reconstructionRepositories(
  files: ReconstructedFile[],
  cwds: readonly string[],
  /** Verified base roots: a file inside one is grouped under it (same relative paths). */
  preferredRoots: readonly string[] = [],
): { repositories: GitDiffRepository[]; dropped: number; redactedDropped: number } {
  const groups = new Map<string, string[]>();
  let dropped = 0;
  let redactedDropped = 0;
  for (const f of files) {
    if (f.after?.includes(REDACTION_MARKER) && !f.before?.includes(REDACTION_MARKER)) {
      redactedDropped += 1; // content derived from redacted evidence would be fiction
      continue;
    }
    const within = (roots: readonly string[]) =>
      roots
        .filter((c) => pathIsWithin(f.path, c) && comparablePath(c) !== comparablePath(f.path))
        .sort((x, y) => y.length - x.length)[0];
    const cwd = within(preferredRoots) ?? within(cwds);
    const root = cwd ?? f.path.slice(0, f.path.lastIndexOf('/'));
    const rel = comparablePath(f.path).slice(comparablePath(root).length + 1);
    if (!root || !isSafeRelativePath(rel)) {
      dropped += 1;
      continue;
    }
    if (!groups.has(root) && groups.size >= GIT_DIFF_MAX_REPOSITORIES) {
      dropped += 1;
      continue;
    }
    const list = groups.get(root) ?? [];
    list.push(buildFilePatch(rel, f.before, f.after));
    groups.set(root, list);
  }
  return {
    repositories: [...groups].map(([root, patches]) => ({
      root,
      patch: patches.join(''),
      scope: 'working_tree' as const,
      reconstructed: true as const,
    })),
    dropped,
    redactedDropped,
  };
}

/**
 * Fixed, honest limitation lines for an AI-reconstructed snapshot whose known
 * coverage passed. They state what is unverified and the detection boundary;
 * they never describe a known omission (those are withheld instead).
 */
export function reconstructionLimitations(
  state: DiffRecoveryRunState,
  files: ReconstructedFile[],
  extra: {
    base?: 'automatic' | 'checkpoint';
    unchanged: number;
    checkpointLimitations?: string[];
  },
): string[] {
  const lines = [
    "AI-reconstructed from this turn's write-like shell commands; not verified against the filesystem.",
  ];
  if (extra.base === 'automatic')
    lines.push('Other files are from the automatic Git capture of this turn.');
  if (extra.base === 'checkpoint')
    lines.push('Other files are from native per-command checkpoints of this turn.');
  if (files.some((f) => f.before !== null))
    lines.push('Earlier file contents were inferred by the model and may be inaccurate.');
  if (extra.unchanged > 0)
    lines.push(
      `The model reported ${extra.unchanged} written ${extra.unchanged === 1 ? 'file' : 'files'} as unchanged at the end of the turn (unverified).`,
    );
  if (state.writes.some((w) => w.status !== 'succeeded'))
    lines.push(
      'Some write commands failed or reported no status; reconstructed content may be inaccurate.',
    );
  if (state.writes.some((w) => w.redacted))
    lines.push('Secrets in command evidence were redacted before reconstruction.');
  for (const note of extra.checkpointLimitations ?? []) lines.push(note);
  lines.push(
    'Writes the backend did not recognise (for example dynamic paths) cannot be detected.',
  );
  return lines.slice(0, DIFF_RECOVERY_MAX_LIMITATIONS);
}
