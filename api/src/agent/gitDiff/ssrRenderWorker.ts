/**
 * Isolated execution of @pierre/diffs SSR in a worker thread.
 *
 * Pierre + Shiki highlighting is synchronous, CPU-bound work; running it on
 * the API thread blocks the event loop and cannot be interrupted by a timer.
 * Every render therefore runs in a dedicated `worker_threads` Worker that the
 * parent can hard-terminate, with one active render, a short waiting queue,
 * and a deadline that covers queue time.
 *
 * The worker is started from an *eval'd JavaScript source* assembled from the
 * pure helper functions below (`Function.prototype.toString`). That keeps one
 * code path for the compiled CommonJS server (api/dist, cli/backend-dist) and
 * the vitest TypeScript environment: no compiled worker file, no TS loader.
 * The serialized functions must stay self-contained: no imports, no
 * module-level references, no literal dynamic `import` (which TypeScript and
 * vitest would rewrite) — those are injected as parameters by the bootstrap.
 *
 * The ESM-only Pierre package is located by a controlled walk of
 * `node_modules` directories above this module, pinned to a known version,
 * and loaded inside the worker by absolute file URL. The parent never loads
 * Pierre, so there is no in-process fallback.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { Worker, type ResourceLimits } from 'worker_threads';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { SessionDiffPayload } from './contracts';

export type DiffTheme = 'dark' | 'light';
export type DiffLayout = 'unified' | 'split';
export type FileKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';

/** File panels (rendered or honest per-file notice) across all repositories. */
export const SSR_MAX_RENDERED_FILES = 50;
export const SSR_MAX_FILE_SECTION_BYTES = 512 * 1024;
export const SSR_MAX_HTML_BYTES = 16 * 1024 * 1024;
export const SSR_RENDER_TIMEOUT_MS = 15_000;
export const SSR_MAX_ACTIVE_RENDERS = 1;
export const SSR_MAX_QUEUED_RENDERS = 2;
/** Exact @pierre/diffs version whose dist layout this module was verified against. */
export const PIERRE_DIFFS_VERSION = '1.6.4';
const WORKER_IDLE_MS = 30_000;
const WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8,
};

export class DiffRenderTimeoutError extends Error {
  constructor(message = 'Diff render timed out') {
    super(message);
    this.name = 'DiffRenderTimeoutError';
  }
}

/** Queue full. Subclass of the timeout error so callers map it to 503 too. */
export class DiffRenderBusyError extends DiffRenderTimeoutError {
  constructor() {
    super('Diff renderer busy');
    this.name = 'DiffRenderBusyError';
  }
}

export class DiffRenderWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffRenderWorkerError';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers. Serialized into the worker source: keep self-contained.
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Split a Git patch into `diff --git` sections without interpreting content. */
export function splitPatchSections(patch: string): string[] {
  const sections: string[] = [];
  const starts: number[] = [];
  const re = /^diff --git /gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(patch))) starts.push(match.index);
  for (let i = 0; i < starts.length; i += 1) {
    sections.push(patch.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : patch.length));
  }
  return sections;
}

export function headerPath(section: string): string {
  const newline = section.indexOf('\n');
  const firstLine = newline >= 0 ? section.slice(0, newline) : section;
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(firstLine);
  return (m && m[2] !== undefined ? m[2] : firstLine.replace(/^diff --git /, '')).slice(0, 1024);
}

export function classifySection(section: string, file?: FileDiffMetadata): FileKind {
  const head = section.slice(0, 4096);
  const type = file ? file.type : undefined;
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(head)) return 'binary';
  if (/^rename from /m.test(head) || type === 'rename-pure' || type === 'rename-changed') {
    return 'renamed';
  }
  if (/^new file mode /m.test(head) || type === 'new') return 'added';
  if (/^deleted file mode /m.test(head) || type === 'deleted') return 'deleted';
  return 'modified';
}

export interface RenderLimits {
  maxRenderedFiles: number;
  maxFileSectionBytes: number;
  maxHtmlBytes: number;
  pageCss: string;
  csp: string;
}

interface PierreSsr {
  preloadPatchFile(args: {
    patch: string;
    options: unknown;
  }): Promise<{ prerenderedHTML: string }[]>;
}
interface PierreCore {
  parsePatchFiles(patch: string): { files: FileDiffMetadata[] }[];
}

/**
 * Build the whole document. Every value placed in markup here is escaped;
 * Pierre escapes code and file names. The final document never exceeds
 * `limits.maxHtmlBytes`: page shell and the skipped-files note are reserved
 * up front, and file chunks and placeholders are only added if they fit.
 */
export async function renderSnapshotDocument(
  ssr: PierreSsr,
  core: PierreCore,
  payload: SessionDiffPayload,
  theme: DiffTheme,
  limits: RenderLimits,
  layout: DiffLayout = 'unified',
): Promise<string> {
  const kindLabel: Record<FileKind, string> = {
    added: 'Added',
    deleted: 'Deleted',
    modified: 'Modified',
    renamed: 'Renamed',
    binary: 'Binary',
  };
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  const options = {
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType: theme,
    diffStyle: layout === 'split' ? 'split' : 'unified',
    overflow: 'scroll',
    // SSR stays unhydrated (JavaScript is intentionally disabled). Pierre's
    // dehydrated split CSS flattens code wrappers and clips content. Restore
    // two bounded code scrollports inside the shadow root, not on the page.
    // Keep the row-span/subgrid metadata so buffers/hunks remain aligned.
    unsafeCSS: `
:host{display:block;min-width:0;max-width:100%;box-sizing:border-box}
[data-diff]{min-width:0;max-width:100%;box-sizing:border-box;margin-inline:0}
[data-dehydrated][data-diff-type="split"][data-overflow="scroll"]{
  grid-template-columns:repeat(2,minmax(0,1fr));width:100%;padding-block:0;overflow:clip
}
[data-dehydrated][data-diff-type="split"][data-overflow="scroll"]>[data-code]{
  display:grid;grid-template-columns:max-content minmax(max-content,1fr);min-width:0;max-width:100%;width:100%;
  box-sizing:border-box;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain
}
[data-dehydrated][data-diff-type="split"][data-overflow="scroll"]>[data-code]>[data-gutter]{grid-column:1}
[data-dehydrated][data-diff-type="split"][data-overflow="scroll"]>[data-code]>[data-content]{
  grid-column:2;min-width:max-content;overflow:visible
}
[data-dehydrated][data-diff-type="split"][data-overflow="scroll"]>[data-additions]{
  border-inline-start:1px solid var(--diffs-bg-context)
}
[data-dehydrated][data-diff-type="split"][data-overflow="scroll"]>[data-code]::-webkit-scrollbar-thumb{
  background-color:var(--diffs-bg-context)
}
`,
  };
  let totalFiles = 0;
  for (const repo of payload.repositories) totalFiles += splitPatchSections(repo.patch).length;
  // At most this many file panels exist in the DOM; the rest are counted in
  // one summary line, never as per-file placeholders.
  const requestedLimit =
    typeof payload.displayLimit === 'number' && payload.displayLimit > 0
      ? Math.floor(payload.displayLimit)
      : limits.maxRenderedFiles;
  const panelLimit = Math.min(requestedLimit, limits.maxRenderedFiles);

  const scopes = new Set(payload.repositories.map((r) => r.scope));
  const isTurn = scopes.has('turn');
  // v4 provenance: an agent-assisted recovery is labelled as such, never as a
  // normal snapshot, with an explicit partial warning and its limitations.
  // An AI reconstruction is additionally labelled unverified (never complete).
  const recovery =
    payload.recovery &&
    (payload.recovery.kind === 'agent_assisted' || payload.recovery.kind === 'ai_reconstructed')
      ? payload.recovery
      : undefined;
  const aiReconstructed = recovery?.kind === 'ai_reconstructed';
  // Merged snapshots mark their AI entries; older AI payloads are AI-only.
  const markedEntries = payload.repositories.some((r) => r.reconstructed === true);
  const isAiEntry = (repo: (typeof payload.repositories)[number]) =>
    aiReconstructed && (markedEntries ? repo.reconstructed === true : true);
  const mergedBase = aiReconstructed && payload.repositories.some((r) => !isAiEntry(r));
  const recoveryNotes = recovery
    ? (aiReconstructed
        ? recovery.complete
          ? `<p class="limit"><strong>Unverified:</strong> ${mergedBase ? 'files marked AI-reconstructed' : 'these changes'} were reconstructed by the AI model from this turn's shell commands and were not read from disk. They may be inaccurate. Every change the backend knew about is shown, but changes made by unrecognised commands cannot be detected.</p>`
          : '<p class="limit"><strong>Unverified:</strong> these changes were reconstructed by the AI model from this turn\'s shell commands and were not read from disk. They may be partial or inaccurate.</p>'
        : recovery.complete
          ? ''
          : '<p class="limit"><strong>Partial recovery:</strong> some changes from this turn may be missing.</p>') +
      (Array.isArray(recovery.limitations)
        ? recovery.limitations
            .slice(0, 8)
            .map((l) => `<p>${escapeHtml(String(l).slice(0, 500))}</p>`)
            .join('')
        : '')
    : '';
  const scopeLabel = aiReconstructed
    ? mergedBase
      ? 'Turn changes with AI-reconstructed files'
      : 'AI-reconstructed turn changes'
    : recovery
      ? 'Recovered turn changes'
      : isTurn
        ? 'Turn changes'
        : scopes.size > 1
          ? 'Working tree and commit changes'
          : scopes.has('commit')
            ? 'Commit changes'
            : 'Working tree changes';
  const disclaimer = aiReconstructed
    ? mergedBase
      ? 'Verified captures of this turn merged with files reconstructed by the AI model from write-like shell commands (unverified).'
      : 'Reconstructed by the AI model from write-like shell commands of this turn only (not a repository snapshot); unverified.'
    : recovery
      ? 'Recovered with agent assistance from native per-command checkpoints of this turn (not a full repository snapshot); it may include changes not made by the agent.'
      : isTurn
        ? 'Net committed and uncommitted changes from the turn baseline to the working tree when the answer was produced; it may include changes not made by the agent.'
        : 'Snapshot taken when the answer was produced; it may include changes not made by the agent.';
  const repoCount = payload.repositories.length;
  const head = [
    '<!doctype html>',
    `<html data-theme="${theme}" data-layout="${layout === 'split' ? 'split' : 'unified'}"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${limits.csp}">`,
    `<meta name="color-scheme" content="${theme}">`,
    `<style>${limits.pageCss}</style></head><body>`,
    `<header class="snapshot"><h1>${scopeLabel}</h1>`,
    `<p>${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'} · ${totalFiles} file${totalFiles === 1 ? '' : 's'}. ${disclaimer}</p>`,
    payload.notice && !recovery ? `<p>${escapeHtml(payload.notice)}</p>` : '',
    recoveryNotes,
  ].join('');
  const tail = '</main></body></html>';
  const skippedNote = (n: number) =>
    n ? `<p>${n} of ${totalFiles} files were not rendered (viewer limit).</p>` : '';
  const showingNote = (shown: number) =>
    shown < totalFiles ? `<p class="limit">Showing ${shown} of ${totalFiles} files.</p>` : '';
  // Shell + worst-case notes + '</header><main>'.
  const reserved =
    bytes(head) +
    bytes(tail) +
    bytes(skippedNote(totalFiles)) +
    bytes(showingNote(Math.max(totalFiles - 1, 0))) +
    16;
  if (reserved > limits.maxHtmlBytes) throw new Error('Diff document shell exceeds HTML limit');
  let remaining = limits.maxHtmlBytes - reserved;
  const parts: string[] = [];
  const tryPush = (s: string): boolean => {
    const n = bytes(s);
    if (n > remaining) return false;
    remaining -= n;
    parts.push(s);
    return true;
  };
  const sectionClose = '</section>';
  let skippedFiles = 0;
  let panels = 0;
  const oid = (value: string | null | undefined) =>
    value
      ? `<code class="oid">${escapeHtml(value.slice(0, 12))}</code>`
      : '<code class="oid">unborn</code>';

  for (const repo of payload.repositories) {
    const sections = splitPatchSections(repo.patch);
    if (panels >= panelLimit) continue; // counted by the "Showing" note
    const title =
      repo.scope === 'turn'
        ? `${escapeHtml(repo.root)} · ${oid(repo.baselineHead)} → ${oid(repo.head)} + working tree · baseline ${repo.baselineSource === 'before_tool' ? 'before first tool use' : 'at turn start'}${repo.baselineCapturedAt ? ` (${escapeHtml(repo.baselineCapturedAt)})` : ''}`
        : repo.scope === 'commit' && repo.commit
          ? `${escapeHtml(repo.root)} · commit <code class="oid">${escapeHtml(repo.commit.slice(0, 12))}</code>`
          : isAiEntry(repo)
            ? `${escapeHtml(repo.root)} · AI-reconstructed (unverified)`
            : recovery
              ? `${escapeHtml(repo.root)} · recovered from turn checkpoints`
              : isTurn
                ? `${escapeHtml(repo.root)} · working tree vs HEAD (turn baseline unavailable)`
                : `${escapeHtml(repo.root)} · working tree vs HEAD`;
    // Always keep room to close the section we open.
    const sectionOpen = `<section class="repo"><h2>${title}</h2>`;
    if (bytes(sectionOpen) + bytes(sectionClose) > remaining || !tryPush(sectionOpen)) {
      skippedFiles += sections.length;
      continue;
    }
    remaining -= sectionClose.length;
    for (const section of sections) {
      if (panels >= panelLimit) break; // no DOM for files past the panel cap
      panels += 1;
      const filePath = headerPath(section);
      const stub = (label: string, reason: string) =>
        `<details class="file"><summary><span class="kind">${label}</span>${escapeHtml(filePath)}</summary><div class="note">${reason}</div></details>`;
      if (bytes(section) > limits.maxFileSectionBytes || remaining <= 0) {
        skippedFiles += 1;
        tryPush(
          stub(
            kindLabel[classifySection(section)],
            bytes(section) > limits.maxFileSectionBytes
              ? 'Not rendered: this file is larger than the viewer limit.'
              : 'Not rendered: this snapshot exceeds the viewer limit.',
          ),
        );
        continue;
      }
      const parsed = core.parsePatchFiles(section);
      const file = parsed[0] ? parsed[0].files[0] : undefined;
      const kind = classifySection(section, file);
      let body: string;
      if (kind === 'binary') {
        body = '<div class="note">Binary file changed; content is not shown.</div>';
      } else if (!file) {
        body = '<div class="note">No textual changes.</div>';
      } else {
        const rendered = await ssr.preloadPatchFile({ patch: section, options });
        body = rendered
          .map(
            (r) =>
              `<div class="diffs-host"><template shadowrootmode="open">${r.prerenderedHTML}</template></div>`,
          )
          .join('');
      }
      const displayPath =
        kind === 'renamed' && file && file.prevName
          ? `${file.prevName} → ${file.name}`
          : file
            ? file.name
            : filePath;
      const chunk = `<details class="file" open><summary><span class="kind">${kindLabel[kind]}</span>${escapeHtml(displayPath)}</summary>${body}</details>`;
      if (!tryPush(chunk)) {
        skippedFiles += 1;
        tryPush(
          stub(kindLabel[kind], 'Not rendered: this snapshot exceeds the viewer HTML limit.'),
        );
      }
    }
    parts.push(sectionClose); // already reserved above
  }
  return (
    head +
    showingNote(Math.min(panels, totalFiles)) +
    skippedNote(skippedFiles) +
    '</header><main>' +
    parts.join('') +
    tail
  );
}

/** Worker entry. Dependencies are injected by the bootstrap source. */
export function ssrWorkerMain(
  wt: typeof import('worker_threads'),
  dynamicImport: (specifier: string) => Promise<unknown>,
): void {
  const port = wt.parentPort;
  const data = wt.workerData as { ssrUrl: string; coreUrl: string; limits: RenderLimits };
  if (!port) return;
  let modules: Promise<unknown[]> | null = null;
  port.on(
    'message',
    async (msg: {
      id: number;
      payload: SessionDiffPayload;
      theme: DiffTheme;
      layout?: DiffLayout;
    }) => {
      try {
        if (!modules)
          modules = Promise.all([dynamicImport(data.ssrUrl), dynamicImport(data.coreUrl)]);
        const loaded = await modules;
        const html = await renderSnapshotDocument(
          loaded[0] as PierreSsr,
          loaded[1] as PierreCore,
          msg.payload,
          msg.theme,
          data.limits,
          msg.layout,
        );
        port.postMessage({ id: msg.id, ok: true, html });
      } catch (err) {
        port.postMessage({
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.name : 'Error',
        });
      }
    },
  );
}

/** The eval'd worker program: serialized helpers plus a bootstrap call. */
export function buildSsrWorkerSource(): string {
  return [
    '"use strict";',
    escapeHtml.toString(),
    splitPatchSections.toString(),
    headerPath.toString(),
    classifySection.toString(),
    renderSnapshotDocument.toString(),
    `(${ssrWorkerMain.toString()})(require('worker_threads'), (s) => import(s));`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pierre resolution (parent side, filesystem metadata only — never imported).
// ---------------------------------------------------------------------------

export interface PierreEntryUrls {
  packageDir: string;
  ssrUrl: string;
  coreUrl: string;
}

let pierreEntries: PierreEntryUrls | null = null;

/**
 * Find `@pierre/diffs` by walking `node_modules` directories upward from
 * `fromDir` (default: this module), the same search Node itself performs.
 * Accept only the pinned version and `import` entries that resolve inside
 * the package directory.
 */
export function resolvePierreEntryUrls(fromDir: string = __dirname): PierreEntryUrls {
  let dir = path.resolve(fromDir);
  for (;;) {
    const pkgDir = path.join(dir, 'node_modules', '@pierre', 'diffs');
    const pkgJson = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as {
        version?: string;
        exports?: Record<string, { import?: string }>;
      };
      if (pkg.version !== PIERRE_DIFFS_VERSION) {
        throw new DiffRenderWorkerError(
          `@pierre/diffs ${String(pkg.version)} found; renderer requires ${PIERRE_DIFFS_VERSION}`,
        );
      }
      const realDir = fs.realpathSync(pkgDir);
      const entry = (subpath: string): string => {
        const rel = pkg.exports?.[subpath]?.import;
        if (typeof rel !== 'string') {
          throw new DiffRenderWorkerError(`@pierre/diffs export ${subpath} missing`);
        }
        const abs = fs.realpathSync(path.resolve(realDir, rel));
        if (!abs.startsWith(realDir + path.sep)) {
          throw new DiffRenderWorkerError(`@pierre/diffs export ${subpath} escapes package`);
        }
        return pathToFileURL(abs).href;
      };
      return { packageDir: realDir, ssrUrl: entry('./ssr'), coreUrl: entry('.') };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new DiffRenderWorkerError('@pierre/diffs not found');
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Pool: one worker, one active job, bounded queue, hard deadlines.
// ---------------------------------------------------------------------------

export interface DiffRenderPoolOptions {
  /** Worker program; defaults to the real Pierre SSR source. Tests inject. */
  workerSource?: string;
  workerData?: () => unknown;
  maxQueued?: number;
  maxHtmlBytes?: number;
  idleMs?: number;
  resourceLimits?: ResourceLimits;
}

export interface DiffRenderPoolStats {
  active: number;
  queued: number;
  inFlightKeys: number;
  workerAlive: boolean;
  workersSpawned: number;
  jobsStarted: number;
  workersKilled: number;
}

interface Job {
  id: number;
  key: string;
  payload: SessionDiffPayload;
  theme: DiffTheme;
  layout: DiffLayout;
  state: 'queued' | 'active' | 'done';
  timer: ReturnType<typeof setTimeout>;
  resolve: (html: string) => void;
  reject: (err: Error) => void;
}

export class DiffRenderPool {
  private readonly source: string;
  private readonly makeWorkerData: () => unknown;
  private readonly maxQueued: number;
  private readonly maxHtmlBytes: number;
  private readonly idleMs: number;
  private readonly resourceLimits: ResourceLimits;
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<string, Promise<string>>();
  private worker: Worker | null = null;
  private active: Job | null = null;
  /** True while a job runs or a killed worker is still shutting down. */
  private busy = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private counters = { workersSpawned: 0, jobsStarted: 0, workersKilled: 0 };

  constructor(options: DiffRenderPoolOptions = {}) {
    this.source = options.workerSource ?? buildSsrWorkerSource();
    this.makeWorkerData =
      options.workerData ??
      (() => {
        pierreEntries ??= resolvePierreEntryUrls();
        return {
          ssrUrl: pierreEntries.ssrUrl,
          coreUrl: pierreEntries.coreUrl,
          limits: DEFAULT_RENDER_LIMITS,
        };
      });
    this.maxQueued = options.maxQueued ?? SSR_MAX_QUEUED_RENDERS;
    this.maxHtmlBytes = options.maxHtmlBytes ?? SSR_MAX_HTML_BYTES;
    this.idleMs = options.idleMs ?? WORKER_IDLE_MS;
    this.resourceLimits = options.resourceLimits ?? WORKER_RESOURCE_LIMITS;
  }

  stats(): DiffRenderPoolStats {
    return {
      active: this.active ? 1 : 0,
      queued: this.queue.length,
      inFlightKeys: this.inFlight.size,
      workerAlive: this.worker !== null,
      ...this.counters,
    };
  }

  /**
   * Render in the worker. Identical in-flight keys share one job. The
   * deadline starts now and covers queue wait plus render; on expiry a
   * queued job is dropped and an active one has its worker terminated.
   */
  render(
    key: string,
    payload: SessionDiffPayload,
    theme: DiffTheme,
    timeoutMs: number,
    layout: DiffLayout = 'unified',
  ): Promise<string> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const queuedOrActive = this.queue.length + (this.busy ? SSR_MAX_ACTIVE_RENDERS : 0);
    if (queuedOrActive >= SSR_MAX_ACTIVE_RENDERS + this.maxQueued) {
      return Promise.reject(new DiffRenderBusyError());
    }
    const promise = new Promise<string>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        key,
        payload,
        theme,
        layout,
        state: 'queued',
        timer: setTimeout(() => this.onDeadline(job), Math.max(0, timeoutMs)),
        resolve,
        reject,
      };
      this.queue.push(job);
    });
    this.inFlight.set(key, promise);
    const forget = () => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    };
    promise.then(forget, forget);
    this.pump();
    return promise;
  }

  /** Terminate the worker and reject everything. For tests and shutdown. */
  async close(): Promise<void> {
    for (const job of this.queue.splice(0))
      this.settle(job, new DiffRenderWorkerError('Renderer closed'));
    if (this.active) this.settle(this.active, new DiffRenderWorkerError('Renderer closed'));
    this.active = null;
    await this.killWorker();
    this.busy = false;
  }

  private settle(job: Job, result: string | Error): void {
    if (job.state === 'done') return;
    job.state = 'done';
    clearTimeout(job.timer);
    if (typeof result === 'string') job.resolve(result);
    else job.reject(result);
  }

  private onDeadline(job: Job): void {
    if (job.state === 'queued') {
      const i = this.queue.indexOf(job);
      if (i >= 0) this.queue.splice(i, 1);
      this.settle(job, new DiffRenderTimeoutError());
      return;
    }
    if (job.state === 'active') {
      this.settle(job, new DiffRenderTimeoutError());
      this.active = null;
      // Hard stop: the CPU-bound render cannot observe a cancellation flag.
      void this.killWorker().then(() => this.release());
    }
  }

  private release(): void {
    this.busy = false;
    this.pump();
  }

  private async killWorker(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.clearIdle();
    if (!w) return;
    this.counters.workersKilled += 1;
    try {
      await w.terminate();
    } catch {
      /* already gone */
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private spawn(): Worker {
    const w = new Worker(this.source, {
      eval: true,
      workerData: this.makeWorkerData(),
      env: {},
      execArgv: [],
      resourceLimits: this.resourceLimits,
      stdout: false,
      stderr: false,
    });
    this.counters.workersSpawned += 1;
    w.on('message', (msg: unknown) => this.onMessage(w, msg));
    w.on('error', (err: Error) =>
      this.onWorkerGone(w, new DiffRenderWorkerError(`Renderer worker failed: ${err.name}`)),
    );
    w.on('exit', (code: number) =>
      this.onWorkerGone(w, new DiffRenderWorkerError(`Renderer worker exited (${code})`)),
    );
    return w;
  }

  private onMessage(w: Worker, msg: unknown): void {
    const job = this.active;
    if (w !== this.worker || !job) return;
    const m = msg as { id?: unknown; ok?: unknown; html?: unknown; error?: unknown } | null;
    if (!m || m.id !== job.id) return;
    this.active = null;
    if (m.ok === true && typeof m.html === 'string') {
      if (Buffer.byteLength(m.html, 'utf8') > this.maxHtmlBytes) {
        this.settle(job, new DiffRenderWorkerError('Rendered HTML exceeds limit'));
      } else {
        this.settle(job, m.html);
      }
    } else {
      this.settle(job, new DiffRenderWorkerError(`Render failed: ${String(m.error ?? 'unknown')}`));
    }
    this.release();
  }

  private onWorkerGone(w: Worker, err: Error): void {
    if (w !== this.worker) return; // already killed/replaced deliberately
    this.worker = null;
    this.clearIdle();
    const job = this.active;
    this.active = null;
    if (job) {
      this.settle(job, err);
      this.release();
    }
  }

  private pump(): void {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) {
      this.scheduleIdle();
      return;
    }
    this.clearIdle();
    this.busy = true;
    this.active = job;
    job.state = 'active';
    try {
      this.worker ??= this.spawn();
      this.worker.ref();
      this.counters.jobsStarted += 1;
      this.worker.postMessage({
        id: job.id,
        payload: job.payload,
        theme: job.theme,
        layout: job.layout,
      });
    } catch (err) {
      this.active = null;
      this.settle(
        job,
        err instanceof Error ? err : new DiffRenderWorkerError('Renderer start failed'),
      );
      void this.killWorker().then(() => this.release());
    }
  }

  private scheduleIdle(): void {
    const w = this.worker;
    if (!w || this.idleTimer) return;
    w.unref();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.worker === w && !this.busy) void this.killWorker();
    }, this.idleMs);
    this.idleTimer.unref();
  }
}

const PAGE_CSS = `
:root{color-scheme:var(--scheme);font:13px -apple-system,system-ui,sans-serif}
html[data-theme=dark]{--scheme:dark;--bg:#0d0d0d;--fg:#e6e6e6;--muted:#9a9a9a;--line:#2a2a2a;--card:#151515}
html[data-theme=light]{--scheme:light;--bg:#ffffff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e3e3e6;--card:#f7f7f8}
html,body{width:100%;max-width:100%;min-width:0;overflow-x:clip}
body{margin:0;background:var(--bg);color:var(--fg)}
main,section.repo,details.file,.diffs-host{display:block;min-width:0;max-width:100%;box-sizing:border-box}
.diffs-host{width:100%;overflow-x:clip}
header.snapshot{padding:12px 14px;border-bottom:1px solid var(--line)}
header.snapshot h1{font-size:13px;margin:0 0 4px}
header.snapshot p{margin:2px 0;color:var(--muted)}
section.repo>h2{font-size:12px;margin:0;padding:8px 14px;color:var(--muted);border-bottom:1px solid var(--line);word-break:break-all}
details.file{border-bottom:1px solid var(--line)}
details.file>summary{cursor:default;padding:6px 14px;background:var(--card);list-style-position:inside;word-break:break-all}
.kind{display:inline-block;min-width:62px;font-size:11px;color:var(--muted)}
.note{padding:8px 14px;color:var(--muted)}
code.oid{font:12px ui-monospace,Menlo,monospace}
`;

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; " +
  "script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  maxRenderedFiles: SSR_MAX_RENDERED_FILES,
  maxFileSectionBytes: SSR_MAX_FILE_SECTION_BYTES,
  maxHtmlBytes: SSR_MAX_HTML_BYTES,
  pageCss: PAGE_CSS,
  csp: CSP,
};
