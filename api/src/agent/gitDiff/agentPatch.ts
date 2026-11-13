/**
 * Agent-reported unified patches (`supports_agent_patches: true`, diff view on).
 *
 * Every provider request of such a run carries one fixed, EPHEMERAL
 * instruction appended to the request copy of the latest user input (never
 * to `session.history`). It asks the editing agent to end its final answer,
 * only when it changed files during THIS request, with:
 *
 *   [files_changed]
 *   <file_patches>{"files":[{"path":"/abs/file","patch":"diff --git a/file b/file\n..."}]}</file_patches>
 *
 * The backend parses the candidate final strictly (standalone lines outside
 * code fences, inside the final body only), always strips the protocol lines
 * from what is shown and stored, and validates every patch as real unified
 * diff syntax (one file per entry, header/path agreement, exact hunk line
 * counts, newline markers, file-mode lines). The whole batch fails closed on
 * any malformed, oversize, unsafe or sensitive entry. Valid entries are
 * re-emitted canonically (our own headers) so agent text never controls the
 * stored header lines. No second model call, no shell, no filesystem access:
 * the patch is the agent's self-report and is always labelled as such.
 */
import type { AIMessage } from '../../ai-client';
import type { GitRunState } from './coordinator';
import {
  GIT_DIFF_DISPLAY_LIMIT,
  GIT_DIFF_MAX_PATCH_BYTES,
  comparablePath,
  isSafeAbsolutePath,
  normalizeAbsolutePath,
} from './contracts';
import { isSensitivePath } from './pathPolicy';

export const FILES_CHANGED_MARKER = '[files_changed]';
/** Files one agent report may carry (same as the viewer panel cap). */
export const AGENT_PATCH_MAX_FILES = GIT_DIFF_DISPLAY_LIMIT;
/** Decoded patch text of one file. */
export const AGENT_PATCH_MAX_FILE_BYTES = 256 * 1024;
/** Decoded patch text of the whole report (same as a Git capture). */
export const AGENT_PATCH_MAX_TOTAL_BYTES = GIT_DIFF_MAX_PATCH_BYTES;
/** Raw `<file_patches>` block text (JSON escaping roughly doubles patch text). */
const AGENT_PATCH_MAX_BLOCK_CHARS = AGENT_PATCH_MAX_TOTAL_BYTES * 2 + 64 * 1024;
const MAX_HUNK_NUMBER = 10_000_000;

const INSTRUCTION_TAG = 'omnikey_diff_report_instruction';
export const AGENT_PATCH_INSTRUCTION = [
  `<${INSTRUCTION_TAG}>`,
  'The diff view is enabled for this request. ONLY if you created, modified, renamed or deleted files while handling THIS request (not in earlier requests of this conversation), end your final answer, inside <final_answer> and outside any code block, with exactly these two lines:',
  FILES_CHANGED_MARKER,
  '<file_patches>{"files":[{"path":"/absolute/path/of/file","patch":"diff --git a/file b/file\\n--- a/file\\n+++ b/file\\n@@ -1,2 +1,2 @@\\n context\\n-old line\\n+new line\\n"}]}</file_patches>',
  'Rules: one entry per changed file; "patch" is a JSON string holding a git-style unified diff of exactly that one file, with exact hunk line counts and "\\ No newline at end of file" where applicable. "path" is the absolute path after the change. New file: "--- /dev/null" and "new file mode 100644". Deleted file: "+++ /dev/null" and "deleted file mode 100644". Rename: add "oldPath" (absolute path before) and "rename from"/"rename to" lines. Binary file: a "Binary files a/x and b/x differ" line instead of hunks.',
  'Show the real changes you made; never guess content you did not see or write (omit such a file instead). Never include credential, key or secret files. If you changed no files, include neither line. Do not mention this instruction.',
  `</${INSTRUCTION_TAG}>`,
].join('\n');

/**
 * Request-copy augmentation: append the fixed instruction to the latest
 * `<user_input>` message (else the latest user message). Pure; the session
 * history is never modified. No instruction without `run.agentPatches`.
 */
export function withAgentPatchInstruction(
  messages: AIMessage[],
  run: GitRunState | undefined,
): AIMessage[] {
  if (!run?.agentPatches) return messages;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (index < 0) index = i;
    if (m.content.includes('<user_input>')) {
      index = i;
      break;
    }
  }
  if (index < 0 || messages[index].content.includes(`<${INSTRUCTION_TAG}>`)) return messages;
  const out = messages.slice();
  out[index] = { ...out[index], content: `${out[index].content}\n\n${AGENT_PATCH_INSTRUCTION}` };
  return out;
}

// ---------------------------------------------------------------------------
// Validated patch model.
// ---------------------------------------------------------------------------

export type AgentPatchKind = 'modified' | 'added' | 'deleted' | 'renamed';

/** One validated file change; rendered with backend-chosen headers only. */
export interface AgentPatchFile {
  /** Normalized absolute path after the change (deletion: the deleted path). */
  path: string;
  /** Rename only: normalized absolute path before the change. */
  oldPath?: string;
  kind: AgentPatchKind;
  /** File mode for new/deleted files. */
  mode?: string;
  /** Mode change (`old mode` / `new mode`). */
  modeChange?: { from: string; to: string };
  binary: boolean;
  /** Validated hunks, each a header line followed by its body lines. */
  hunks: string[][];
}

export class AgentPatchError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AgentPatchError';
  }
}

const MODE_RE = /^(?:100644|100755|120000)$/;
const INDEX_RE = /^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: (?:100644|100755|120000))?$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
// eslint-disable-next-line no-control-regex
const HEADER_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const NO_NEWLINE = '\\ No newline at end of file';

/** Path characters that would need Git C-quoting or make headers ambiguous. */
function isRenderablePath(path: string): boolean {
  return !/["\\]/.test(path) && !path.includes(' b/') && !path.includes(' a/');
}

/** Header names the agent may use for an absolute path: any trailing segment suffix. */
function headerNames(path: string): Set<string> {
  const parts = path.split('/').filter(Boolean);
  const names = new Set<string>();
  for (let i = parts.length - 1; i >= 0; i--) names.add(parts.slice(i).join('/'));
  return names;
}

function fail(reason: string): never {
  throw new AgentPatchError(reason);
}

function parseCount(value: string | undefined): number {
  if (value === undefined) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_HUNK_NUMBER) fail('hunk count');
  return n;
}

/**
 * Validate one entry `{path, oldPath?, patch}` as exactly one git-style
 * unified file diff. Throws AgentPatchError on anything unexpected.
 */
export function validateAgentPatchEntry(entry: unknown): AgentPatchFile {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail('entry');
  const record = entry as Record<string, unknown>;
  if (Object.keys(record).some((k) => k !== 'path' && k !== 'oldPath' && k !== 'patch')) {
    fail('entry fields');
  }
  const { path: rawPath, oldPath: rawOld, patch } = record;
  if (!isSafeAbsolutePath(rawPath)) fail('path');
  const path = normalizeAbsolutePath(rawPath);
  if (!isRenderablePath(path)) fail('path characters');
  if (isSensitivePath(path)) fail('sensitive path');
  let oldPath: string | undefined;
  if (rawOld !== undefined) {
    if (!isSafeAbsolutePath(rawOld)) fail('oldPath');
    oldPath = normalizeAbsolutePath(rawOld);
    if (!isRenderablePath(oldPath)) fail('oldPath characters');
    if (isSensitivePath(oldPath)) fail('sensitive oldPath');
    if (comparablePath(oldPath) === comparablePath(path)) oldPath = undefined;
  }
  if (typeof patch !== 'string' || !patch.trim()) fail('patch');
  if (Buffer.byteLength(patch, 'utf8') > AGENT_PATCH_MAX_FILE_BYTES) fail('patch too large');
  if (patch.includes('\u0000')) fail('patch NUL');

  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const oldNames = headerNames(oldPath ?? path);
  const newNames = headerNames(path);
  const isOld = (n: string) => oldNames.has(n);
  const isNew = (n: string) => newNames.has(n);

  // 1. `diff --git a/<old> b/<new>` (exactly one per entry, first line).
  const header = lines[0] ?? '';
  if (!header.startsWith('diff --git a/') || HEADER_CONTROL_RE.test(header)) fail('header');
  const rest = header.slice('diff --git a/'.length);
  const headerOk = [...oldNames].some(
    (o) => rest.startsWith(`${o} b/`) && isNew(rest.slice(o.length + 3)),
  );
  if (!headerOk) fail('header path');
  if (lines.slice(1).some((l) => l.startsWith('diff --git '))) fail('more than one file');

  // 2. Extended header lines.
  let i = 1;
  let newMode: string | undefined;
  let deletedMode: string | undefined;
  let oldMode: string | undefined;
  let changedMode: string | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let binary = false;
  let minus: string | undefined;
  let plus: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('--- ') || line.startsWith('@@')) break;
    if (HEADER_CONTROL_RE.test(line)) fail('header control');
    let m: RegExpExecArray | null;
    if ((m = /^new file mode (\d+)$/.exec(line))) {
      if (newMode || !MODE_RE.test(m[1])) fail('new file mode');
      newMode = m[1];
    } else if ((m = /^deleted file mode (\d+)$/.exec(line))) {
      if (deletedMode || !MODE_RE.test(m[1])) fail('deleted file mode');
      deletedMode = m[1];
    } else if ((m = /^old mode (\d+)$/.exec(line))) {
      if (oldMode || !MODE_RE.test(m[1])) fail('old mode');
      oldMode = m[1];
    } else if ((m = /^new mode (\d+)$/.exec(line))) {
      if (changedMode || !MODE_RE.test(m[1])) fail('new mode');
      changedMode = m[1];
    } else if (INDEX_RE.test(line) || /^(?:dis)?similarity index \d{1,3}%$/.test(line)) {
      // Informational; never re-emitted (the agent cannot know real blob ids).
    } else if (line.startsWith('rename from ')) {
      if (renameFrom !== undefined || !isOld(line.slice(12))) fail('rename from');
      renameFrom = line.slice(12);
    } else if (line.startsWith('rename to ')) {
      if (renameTo !== undefined || !isNew(line.slice(10))) fail('rename to');
      renameTo = line.slice(10);
    } else if (
      (m = /^Binary files (a\/(.+)|\/dev\/null) and (b\/(.+)|\/dev\/null) differ$/.exec(line))
    ) {
      if (m[2] !== undefined && !isOld(m[2])) fail('binary path');
      if (m[4] !== undefined && !isNew(m[4])) fail('binary path');
      if (m[2] === undefined && m[4] === undefined) fail('binary path');
      if ((m[2] === undefined) !== Boolean(newMode)) fail('binary new file');
      if ((m[4] === undefined) !== Boolean(deletedMode)) fail('binary deleted file');
      binary = true;
      i++;
      break;
    } else {
      fail('unexpected header line');
    }
  }
  if (binary && i < lines.length) fail('content after binary summary');
  if ((oldMode === undefined) !== (changedMode === undefined)) fail('mode change');
  if (oldMode !== undefined && oldMode === changedMode) fail('mode change');

  // 3. `---` / `+++` file lines (required before hunks).
  if (!binary && i < lines.length && lines[i].startsWith('--- ')) {
    const strip = (s: string) => s.replace(/\t$/, '');
    minus = strip(lines[i].slice(4));
    const plusLine = lines[i + 1] ?? '';
    if (!plusLine.startsWith('+++ ')) fail('missing +++');
    plus = strip(plusLine.slice(4));
    if (HEADER_CONTROL_RE.test(minus) || HEADER_CONTROL_RE.test(plus)) fail('file line control');
    if (minus !== '/dev/null' && !(minus.startsWith('a/') && isOld(minus.slice(2)))) {
      fail('--- path');
    }
    if (plus !== '/dev/null' && !(plus.startsWith('b/') && isNew(plus.slice(2)))) {
      fail('+++ path');
    }
    if (minus === '/dev/null' && plus === '/dev/null') fail('both sides /dev/null');
    i += 2;
    if (i >= lines.length || !lines[i].startsWith('@@')) fail('file lines without hunk');
  } else if (!binary && i < lines.length) {
    fail('hunk without file lines');
  }

  // 4. Semantics: added / deleted / renamed / modified.
  const added = Boolean(newMode) || minus === '/dev/null';
  const deleted = Boolean(deletedMode) || plus === '/dev/null';
  if (added && deleted) fail('added and deleted');
  if (newMode && minus !== undefined && minus !== '/dev/null') fail('new file with old side');
  if (deletedMode && plus !== undefined && plus !== '/dev/null') fail('deleted file with new side');
  const renamed = renameFrom !== undefined || renameTo !== undefined;
  if (renamed && (renameFrom === undefined || renameTo === undefined)) fail('rename lines');
  if (renamed !== (oldPath !== undefined)) fail('rename needs oldPath');
  if (renamed && (added || deleted)) fail('rename with add/delete');
  if ((added || deleted) && oldMode !== undefined) fail('mode change on add/delete');

  // 5. Hunks with exact line counts.
  const hunks: string[][] = [];
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  while (i < lines.length) {
    const m = HUNK_RE.exec(lines[i]);
    if (!m || HEADER_CONTROL_RE.test(lines[i])) fail('hunk header');
    const oldStart = parseCount(m[1]);
    const oldCount = parseCount(m[2]);
    const newStart = parseCount(m[3]);
    const newCount = parseCount(m[4]);
    if (oldCount === 0 && newCount === 0) fail('empty hunk');
    // A start of 0 is only valid for an empty side (insertion at file start).
    if ((oldStart === 0 && oldCount > 0) || (newStart === 0 && newCount > 0)) fail('hunk start');
    if (oldStart < prevOldEnd || newStart < prevNewEnd) fail('overlapping hunks');
    if (added && (oldStart !== 0 || oldCount !== 0 || hunks.length)) fail('new file hunk');
    if (deleted && (newStart !== 0 || newCount !== 0 || hunks.length)) fail('deleted file hunk');
    const body: string[] = [lines[i]];
    i++;
    let oldLeft = oldCount;
    let newLeft = newCount;
    let lastContent = false;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      let line = lines[i];
      // Models often drop the single space of an empty context line.
      if (line === '' || line === '\r') line = ` ${line}`;
      const c = line[0];
      if (c === ' ') {
        oldLeft--;
        newLeft--;
      } else if (c === '-') {
        if (added) fail('removal in new file');
        oldLeft--;
      } else if (c === '+') {
        if (deleted) fail('addition in deleted file');
        newLeft--;
      } else if (line === NO_NEWLINE) {
        if (!lastContent) fail('newline marker');
        body.push(line);
        lastContent = false;
        i++;
        continue;
      } else {
        fail('hunk line');
      }
      if (oldLeft < 0 || newLeft < 0) fail('hunk count mismatch');
      body.push(line);
      lastContent = true;
      i++;
    }
    if (oldLeft !== 0 || newLeft !== 0) fail('truncated hunk');
    if (i < lines.length && lines[i] === NO_NEWLINE) {
      if (!lastContent) fail('newline marker');
      body.push(lines[i]);
      i++;
    }
    hunks.push(body);
    prevOldEnd = oldStart + oldCount;
    prevNewEnd = newStart + newCount;
    if (i < lines.length && !lines[i].startsWith('@@')) fail('content after hunk');
  }

  const modeChange = oldMode && changedMode ? { from: oldMode, to: changedMode } : undefined;
  if (!hunks.length && !binary && !renamed && !modeChange && !added && !deleted) {
    fail('no change');
  }
  if (deleted && oldPath !== undefined) fail('deleted file with oldPath');
  return {
    path,
    ...(oldPath ? { oldPath } : {}),
    kind: added ? 'added' : deleted ? 'deleted' : renamed ? 'renamed' : 'modified',
    ...(added ? { mode: newMode ?? '100644' } : deleted ? { mode: deletedMode ?? '100644' } : {}),
    ...(modeChange ? { modeChange } : {}),
    binary,
    hunks,
  };
}

/**
 * Validate a whole `<file_patches>` JSON body. Fail closed: any malformed,
 * oversize, unsafe, sensitive or duplicate entry rejects the entire batch.
 */
export function parseAgentPatchBlock(text: string): AgentPatchFile[] {
  if (text.length > AGENT_PATCH_MAX_BLOCK_CHARS) fail('block too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    fail('json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('object');
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'files') fail('object fields');
  const files = (parsed as { files: unknown }).files;
  if (!Array.isArray(files) || !files.length || files.length > AGENT_PATCH_MAX_FILES) {
    fail('files');
  }
  let total = 0;
  const seen = new Set<string>();
  const out: AgentPatchFile[] = [];
  for (const entry of files) {
    const file = validateAgentPatchEntry(entry);
    total += Buffer.byteLength((entry as { patch: string }).patch, 'utf8');
    if (total > AGENT_PATCH_MAX_TOTAL_BYTES) fail('total too large');
    for (const p of [file.path, file.oldPath]) {
      if (p === undefined) continue;
      const key = comparablePath(p);
      if (seen.has(key)) fail('duplicate path');
      seen.add(key);
    }
    out.push(file);
  }
  return out;
}

/** Canonical unified text of one validated file, relative to `root`. */
export function renderAgentPatchSection(file: AgentPatchFile, root: string): string {
  const rel = (p: string) => comparablePath(p).slice(comparablePath(root).length + 1);
  const newRel = rel(file.path);
  const oldRel = rel(file.oldPath ?? file.path);
  const out = [`diff --git a/${oldRel} b/${newRel}`];
  if (file.kind === 'added') out.push(`new file mode ${file.mode}`);
  if (file.kind === 'deleted') out.push(`deleted file mode ${file.mode}`);
  if (file.modeChange)
    out.push(`old mode ${file.modeChange.from}`, `new mode ${file.modeChange.to}`);
  if (file.kind === 'renamed') out.push(`rename from ${oldRel}`, `rename to ${newRel}`);
  const minus = file.kind === 'added' ? '/dev/null' : `a/${oldRel}`;
  const plus = file.kind === 'deleted' ? '/dev/null' : `b/${newRel}`;
  if (file.binary) {
    out.push(`Binary files ${minus} and ${plus} differ`);
  } else if (file.hunks.length) {
    out.push(`--- ${minus}`, `+++ ${plus}`);
    for (const hunk of file.hunks) out.push(...hunk);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Final-answer parsing.
// ---------------------------------------------------------------------------

/** Parsed self-report of one candidate final answer. */
export interface AgentPatchReport {
  /** Validated files; undefined when the block was absent or rejected. */
  files?: AgentPatchFile[];
  /** Why a present block was rejected (log only; never shown). */
  rejected?: string;
}

const MARKER_LINE = /^ {0,3}\[files_changed\]\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCK_OPEN = /^ {0,3}<(file_patches|changed_files)>/;

/**
 * Split a candidate final into what is shown/stored and the agent report.
 * Only standalone lines outside fenced code inside the `<final_answer>` body
 * count. `[files_changed]`, `<file_patches>` and the legacy `<changed_files>`
 * blocks are always stripped; an unclosed block strips the rest of the body
 * (a truncated patch never leaks into the answer). A report is returned only
 * with the marker AND exactly one well-formed, fully valid patch block.
 */
export function parseAgentFinal(content: string): {
  display: string;
  report?: AgentPatchReport;
} {
  const open = content.indexOf('<final_answer>');
  const close = content.lastIndexOf('</final_answer>');
  const tagged = open >= 0 && close > open;
  const start = tagged ? open + '<final_answer>'.length : 0;
  const end = tagged ? close : content.length;
  const body = content.slice(start, end);
  const lines = body.split('\n');
  const kept: string[] = [];
  let fence: string | undefined;
  let marker = false;
  const blocks: Array<string | null> = [];
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
      kept.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      kept.push(line);
      continue;
    }
    if (MARKER_LINE.test(line)) {
      marker = touched = true;
      continue;
    }
    const o = BLOCK_OPEN.exec(line);
    if (o) {
      touched = true;
      const tag = o[1];
      const closing = `</${tag}>`;
      // Find the closing tag at the end of some line (bounded by the body).
      let j = i;
      let found = -1;
      for (; j < lines.length; j++) {
        const at = lines[j].indexOf(closing);
        if (at >= 0) {
          found = j;
          break;
        }
      }
      if (found < 0) {
        // Truncated/unclosed: strip everything after the opening line.
        if (tag === 'file_patches') blocks.push(null);
        break;
      }
      const last = lines[found];
      const at = last.indexOf(closing);
      const wellFormed = !last.slice(at + closing.length).trim();
      if (tag === 'file_patches') {
        const joined = lines.slice(i, found + 1).join('\n');
        const inner = joined.slice(
          joined.indexOf(`<${tag}>`) + tag.length + 2,
          joined.lastIndexOf(closing),
        );
        blocks.push(wellFormed ? inner : null);
      }
      i = found;
      continue;
    }
    kept.push(line);
  }
  if (!touched) return { display: content };
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const shown = kept.join('\n');
  const display = tagged
    ? `${content.slice(0, start)}${shown}${shown.endsWith('\n') ? '' : '\n'}${content.slice(end)}`
    : shown;
  if (!blocks.length) return { display, ...(marker ? { report: {} } : {}) };
  if (!marker) return { display, report: { rejected: 'missing marker' } };
  if (blocks.length !== 1) return { display, report: { rejected: 'more than one block' } };
  const block = blocks[0];
  if (block === null) return { display, report: { rejected: 'malformed or truncated block' } };
  try {
    return { display, report: { files: parseAgentPatchBlock(block) } };
  } catch (err) {
    return {
      display,
      report: { rejected: err instanceof AgentPatchError ? err.message : 'invalid' },
    };
  }
}
