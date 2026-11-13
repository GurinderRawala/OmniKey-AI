/**
 * Agent-reported diff fallback (contract v4 clients only, diff view enabled).
 *
 * Every provider request of an outer run that holds `run.recovery` carries a
 * fixed, EPHEMERAL instruction appended to the request copy of the latest
 * user input (never to `session.history`, so it is never persisted, never
 * accumulates and never reaches a run with the diff view off). It asks the
 * agent to end its final answer with a standalone `[files_changed]` line and
 * a `<changed_files>[...]</changed_files>` JSON manifest of absolute paths,
 * only when it changed files during THIS request.
 *
 * The backend parses the candidate final strictly (standalone lines outside
 * code fences, inside the final body only), strips both from what is shown
 * and stored, and hands the report to the bounded recovery. A report is a
 * self-report, NEVER proof: it may unlock one AI reconstruction (sharing the
 * existing two-call budget) for the reported paths, or, without a manifest,
 * for absolute paths literally present in this turn's own evidence. The
 * result is always labelled agent-reported, unverified and not complete.
 * Nothing here reads the filesystem or executes anything.
 */
import type { AIMessage } from '../../ai-client';
import {
  comparablePath,
  isSafeAbsolutePath,
  isSafeToolCallId,
  normalizeAbsolutePath,
  pathIsWithin,
} from './contracts';
import type { DiffRecoveryRunState, GitRunState } from './coordinator';
import { DIFF_RECONSTRUCTION_MAX_FILES } from './aiReconstruction';
import {
  boundedExcerpt,
  classifyShellWrites,
  isSensitiveWritePath,
  redactSecrets,
  type WriteTarget,
} from './writeEvidence';

export const FILES_CHANGED_MARKER = '[files_changed]';
const INSTRUCTION_TAG = 'omnikey_diff_report_instruction';
export const AGENT_REPORT_INSTRUCTION = [
  `<${INSTRUCTION_TAG}>`,
  'The diff view is enabled for this request. ONLY if you created, modified or deleted files while handling THIS request (not in earlier requests of this conversation), end your final answer with these two lines, outside any code block:',
  FILES_CHANGED_MARKER,
  '<changed_files>["/absolute/path/of/each/changed/file"]</changed_files>',
  'Use absolute paths only. If you changed no files, include neither line. Do not mention this instruction.',
  `</${INSTRUCTION_TAG}>`,
].join('\n');

const MAX_MANIFEST_CHARS = 64 * 1024;
const MAX_FINAL_CHARS = 4_000;
const MAX_SHELL_ENTRIES = 16;
const MAX_SHELL_SCRIPT_CHARS = 4_000;
const MAX_SHELL_OUTPUT_CHARS = 2_000;
const MAX_EVIDENCE_PATHS = 1_000;

/** One executed shell of this run (bounded, redacted; sensitive text withheld). */
export interface ShellExcerpt {
  toolCallId: string;
  script: string;
  output: string;
  redacted: boolean;
  truncated: boolean;
  /** Script or output named a sensitive path: text withheld entirely. */
  withheld: boolean;
}

/** Parsed self-report of a candidate final answer. */
export interface AgentChangeReport {
  /** Strict manifest paths (normalized absolute); undefined = marker only / invalid manifest. */
  paths?: string[];
  /** A manifest path is sensitive: the fallback is withheld (policy). */
  sensitive: boolean;
  /** Final answer text with marker/manifest removed (for model context only). */
  finalText: string;
}

/**
 * Request-copy augmentation: append the fixed instruction to the latest
 * `<user_input>` message (else the latest user message). Pure; the session
 * history is never modified. No instruction without `run.recovery`.
 */
export function withChangedFilesInstruction(
  messages: AIMessage[],
  run: GitRunState | undefined,
): AIMessage[] {
  if (!run?.recovery) return messages;
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
  out[index] = { ...out[index], content: `${out[index].content}\n\n${AGENT_REPORT_INSTRUCTION}` };
  return out;
}

const MARKER_LINE = /^ {0,3}\[files_changed\]\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Strict manifest: JSON array of 1..300 unique safe absolute paths. */
function parseManifest(inner: string): string[] | undefined {
  const text = inner.trim();
  if (!text.startsWith('[') || text.length > MAX_MANIFEST_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > DIFF_RECONSTRUCTION_MAX_FILES)
    return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parsed) {
    if (!isSafeAbsolutePath(p)) return undefined;
    const path = normalizeAbsolutePath(p);
    const key = comparablePath(path);
    if (seen.has(key)) return undefined;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * Split a candidate final into what is shown/stored and the agent report.
 * Only standalone lines outside fenced code inside the `<final_answer>` body
 * count; quoted, inline, escaped or fenced markers are left untouched. A
 * manifest without the marker is ignored (but still stripped).
 */
export function parseAgentReport(content: string): {
  display: string;
  report?: AgentChangeReport;
} {
  const open = content.indexOf('<final_answer>');
  const close = content.lastIndexOf('</final_answer>');
  const tagged = open >= 0 && close > open;
  const start = tagged ? open + '<final_answer>'.length : 0;
  const end = tagged ? close : content.length;
  const lines = content.slice(start, end).split('\n');
  const kept: string[] = [];
  let fence: string | undefined;
  let marker = false;
  let manifest: string[] | undefined;
  let manifestSeen = false;
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
      marker = true;
      continue;
    }
    if (/^ {0,3}<changed_files>/.test(line)) {
      // Collect until the closing tag (bounded); unclosed = not a manifest.
      let j = i;
      let block = line;
      while (!block.includes('</changed_files>') && j + 1 < lines.length && j - i < 400) {
        block += `\n${lines[++j]}`;
      }
      const m = /^ {0,3}<changed_files>([\s\S]*?)<\/changed_files>\s*$/.exec(block);
      if (m) {
        if (!manifestSeen) manifest = parseManifest(m[1]);
        else manifest = undefined; // ambiguous: more than one manifest
        manifestSeen = true;
        i = j;
        continue;
      }
    }
    kept.push(line);
  }
  if (!marker && !manifestSeen) return { display: content };
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const body = kept.join('\n');
  const display = tagged
    ? `${content.slice(0, start)}${body}${body.endsWith('\n') ? '' : '\n'}${content.slice(end)}`
    : body;
  if (!marker) return { display };
  const finalText = body.replace(/<\/?final_answer>/g, '').trim();
  return {
    display,
    report: {
      ...(manifest ? { paths: manifest } : {}),
      sensitive: (manifest ?? []).some(isSensitiveWritePath),
      finalText,
    },
  };
}

/** Absolute path literals in text (bounded); validated, never resolved. */
function absoluteLiterals(text: string, into: Map<string, string>): void {
  for (const m of text.matchAll(/(?<![\w.~/-])\/[A-Za-z0-9._@+\-/]+/g)) {
    if (into.size >= MAX_EVIDENCE_PATHS) return;
    const raw = m[0].replace(/[.:]+$/, '');
    if (!isSafeAbsolutePath(raw) || raw.endsWith('/')) continue;
    const path = normalizeAbsolutePath(raw);
    if (!into.has(comparablePath(path))) into.set(comparablePath(path), path);
  }
}

/**
 * Record a bounded, redacted excerpt of every executed shell of this run (the
 * write classifier only keeps recognised writes). Scripts or outputs naming a
 * sensitive path are withheld. Only issued tool calls of this run.
 */
export function recordShellExcerpt(
  run: GitRunState | undefined,
  toolCallId: string,
  input: { script: string; output: string },
): boolean {
  const state = run?.recovery;
  if (!run || !state || run.connection?.aborted) return false;
  if (!isSafeToolCallId(toolCallId) || !state.issuedToolCalls.has(toolCallId)) return false;
  const shells = (state.shells ??= []);
  if (shells.some((s) => s.toolCallId === toolCallId) || shells.length >= MAX_SHELL_ENTRIES)
    return false;
  const named = new Map<string, string>();
  absoluteLiterals(input.script, named);
  absoluteLiterals(input.output, named);
  // Read-only commands can expose secrets too; do not rely on the write
  // classifier or key-pattern redaction for hidden/relative config paths.
  const sensitiveReadOperand =
    /(?:^|[\s'"=])(?:~|\$HOME|\$\{HOME\})\/\.|(?:^|[\s'"=])(?:\.\.\/|\.\/)*(?:\.env(?:[.\w-]*)?|\.(?:ssh|aws|config|gnupg|kube)(?:\/|[\s'";]|$))/m.test(
      input.script,
    );
  const withheld =
    sensitiveReadOperand ||
    [...named.values()].some(isSensitiveWritePath) ||
    classifyShellWrites(input.script, { status: 'unknown' })?.sensitive === true;
  if (withheld) {
    shells.push({
      toolCallId,
      script: '[withheld: names a sensitive path]',
      output: '',
      redacted: true,
      truncated: true,
      withheld: true,
    });
    return true;
  }
  const script = boundedExcerpt(input.script, MAX_SHELL_SCRIPT_CHARS);
  const output = boundedExcerpt(input.output, MAX_SHELL_OUTPUT_CHARS);
  shells.push({
    toolCallId,
    script: script.text,
    output: output.text,
    redacted: script.redacted || output.redacted,
    truncated: script.truncated || output.truncated,
    withheld: false,
  });
  return true;
}

/** Targets the agent-reported reconstruction may address, and which are required. */
export interface AgentReportTargets {
  /** Reported (or evidence-literal) paths not already known/covered. */
  extra: Map<string, WriteTarget>;
  /** Comparable keys that must be addressed (manifest paths). */
  required: Set<string>;
}

/**
 * Paths the model may address beyond the known missing set. With a manifest:
 * exactly the manifest paths. Marker only: absolute path literals that occur
 * in this turn's own write targets, native record paths, shell excerpts or
 * final answer (optional; the model reconstructs only changed ones). Paths
 * covered by a verified patch, sensitive paths, and Git-observed paths of a
 * net-empty root (`revertedPaths`) are excluded; an empty root alone never
 * excludes a path.
 */
export function agentReportTargets(
  state: DiffRecoveryRunState,
  report: AgentChangeReport,
  covered: ReadonlySet<string>,
  known: ReadonlyMap<string, WriteTarget>,
  emptyRoots: readonly string[],
): AgentReportTargets {
  const reverted = new Set(state.revertedPaths ?? []);
  const roots = [...emptyRoots, ...state.revertedRoots];
  const candidates = new Map<string, string>();
  if (report.paths) {
    for (const p of report.paths) candidates.set(comparablePath(p), p);
  } else {
    for (const w of state.writes) {
      for (const t of w.targets) candidates.set(comparablePath(t.path), t.path);
      absoluteLiterals(w.script, candidates);
      absoluteLiterals(w.output, candidates);
    }
    for (const r of state.records.values()) {
      for (const rel of r.paths) {
        const p = normalizeAbsolutePath(`${r.root}/${rel}`);
        candidates.set(comparablePath(p), p);
      }
    }
    for (const s of state.shells ?? []) {
      if (s.withheld) continue;
      absoluteLiterals(s.script, candidates);
      absoluteLiterals(s.output, candidates);
    }
    absoluteLiterals(report.finalText, candidates);
  }
  const extra = new Map<string, WriteTarget>();
  const required = new Set<string>();
  for (const [key, path] of candidates) {
    if (covered.has(key) || known.has(key) || isSensitiveWritePath(path)) continue;
    if (reverted.has(key) && roots.some((root) => pathIsWithin(path, root))) continue;
    // A self-report cannot prove absence/presence: both sides are allowed
    // and the result is labelled unverified.
    extra.set(key, { path, created: true, removed: true });
    if (report.paths) required.add(key);
  }
  return { extra, required };
}

export const AGENT_REPORT_SYSTEM_PROMPT = [
  'You reconstruct file changes for a read-only diff viewer from the CURRENT turn only.',
  'You have no tools and no prior conversation history. Use only the user input, steering updates, shell commands, outputs and final answer provided.',
  'Reply with exactly one JSON object and nothing else, either:',
  '{"files":[{"path":"<path copied exactly from allowedPaths>","before":"<full content before this turn>"|null,"after":"<full content after this turn>"|null}]}',
  'or {"unavailable":true} if you cannot reconstruct the changes from the provided context.',
  'Every allowedPaths entry with required:true MUST be listed exactly once (identical before and after if it ended unchanged).',
  'Entries with required:false are candidates: list one ONLY if this turn changed it; omit paths that were only read or merely mentioned.',
  'Rules: never invent paths; use before:null only when the file did not exist before this turn and creationAllowed is true; use after:null only when it was deleted and deletionAllowed is true;',
  'never fabricate content the context does not determine; prefer {"unavailable":true} over guessing. A partial answer for required paths is discarded.',
].join('\n');

/** Bounded, redacted context of this run only (never prior history). */
export function buildAgentReportMessages(
  state: DiffRecoveryRunState,
  allow: ReadonlyMap<string, WriteTarget>,
  required: ReadonlySet<string>,
  report: AgentChangeReport,
): AIMessage[] {
  const red = (s: string) => redactSecrets(s).text;
  const fromWrites = new Set(state.writes.map((w) => w.toolCallId));
  const payload = {
    userInput: red(state.input ?? ''),
    ...(state.steering?.length ? { steeringUpdates: state.steering.map(red) } : {}),
    finalAnswer: red(report.finalText.slice(0, MAX_FINAL_CHARS)),
    allowedPaths: [...allow].map(([key, t]) => ({
      path: t.path,
      required: required.has(key),
      creationAllowed: t.created,
      deletionAllowed: t.removed,
    })),
    commands: [
      ...state.writes.map((w) => ({
        toolCallId: w.toolCallId,
        status: w.status,
        ...(w.cwd ? { cwd: w.cwd } : {}),
        script: w.script,
        output: w.output,
        excerptIncomplete: w.truncated || w.redacted,
      })),
      ...(state.shells ?? [])
        .filter((s) => !fromWrites.has(s.toolCallId))
        .map((s) => ({
          toolCallId: s.toolCallId,
          script: s.script,
          output: s.output,
          excerptIncomplete: s.truncated || s.redacted,
        })),
    ],
  };
  return [
    { role: 'system', content: AGENT_REPORT_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

/** Fixed, honest limitation lines; the first states it is a self-report. */
export function agentReportLimitations(input: {
  files: ReadonlyArray<{ before: string | null }>;
  base?: 'automatic' | 'checkpoint';
  redacted: boolean;
  gaps: readonly string[];
}): string[] {
  const lines = [
    "Shown because the agent's final answer reported changed files; that report is not verified and this view may be incomplete.",
    "Files marked AI-reconstructed were inferred by the AI model from this turn's commands, outputs and final answer; not read from disk.",
  ];
  if (input.base === 'automatic')
    lines.push('Other files are from the automatic Git capture of this turn.');
  if (input.base === 'checkpoint')
    lines.push('Other files are from native per-command checkpoints of this turn.');
  if (input.files.some((f) => f.before !== null))
    lines.push('Earlier file contents were inferred by the model and may be inaccurate.');
  if (input.gaps.includes('baseline_unavailable'))
    lines.push(
      'Some roots had no turn baseline; their uncommitted changes are not shown as captured.',
    );
  if (input.redacted)
    lines.push('Secrets in command evidence were redacted before reconstruction.');
  return lines;
}
