/**
 * Server-side rendering of a stored Git snapshot with @pierre/diffs SSR.
 *
 * Output is one self-contained HTML document for WKWebView.loadHTMLString:
 * strict CSP (no scripts, network, forms or frames), Pierre's own highlighted
 * markup and styles inside declarative shadow roots (supported by WebKit in
 * macOS 15), and native <details> for per-file collapse. Every value we place
 * in markup ourselves (roots, paths, notices, OIDs) is HTML-escaped; Pierre
 * escapes code and file names. Repository content is never executed.
 *
 * Rendering never runs on this thread: it is delegated to a terminable
 * worker thread (see ./ssrRenderWorker) with one active render, at most two
 * waiting, and a deadline covering queue time. Results are cached by
 * immutable snapshot id + theme, and identical in-flight requests share one
 * render. It never reads repository files.
 */
import type { SessionDiffPayload } from './contracts';
import {
  DiffRenderPool,
  SSR_MAX_HTML_BYTES,
  SSR_RENDER_TIMEOUT_MS,
  type DiffTheme,
} from './ssrRenderWorker';

export {
  classifySection,
  DiffRenderBusyError,
  DiffRenderPool,
  DiffRenderTimeoutError,
  DiffRenderWorkerError,
  escapeHtml,
  splitPatchSections,
  SSR_MAX_FILE_SECTION_BYTES,
  SSR_MAX_HTML_BYTES,
  SSR_MAX_QUEUED_RENDERS,
  SSR_MAX_RENDERED_FILES,
  SSR_RENDER_TIMEOUT_MS,
} from './ssrRenderWorker';
export type { DiffTheme, FileKind } from './ssrRenderWorker';

export const CACHE_MAX_ENTRIES = 8;
export const CACHE_MAX_BYTES = 48 * 1024 * 1024;

const cache = new Map<string, { html: string; size: number }>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<string>>();
let pool: DiffRenderPool | null = null;

function getPool(): DiffRenderPool {
  pool ??= new DiffRenderPool();
  return pool;
}

function cachePut(key: string, html: string): void {
  const size = Buffer.byteLength(html, 'utf8');
  if (size > SSR_MAX_HTML_BYTES || size > CACHE_MAX_BYTES / 2) return;
  const prior = cache.get(key);
  if (prior) {
    cacheBytes -= prior.size;
    cache.delete(key);
  }
  cache.set(key, { html, size });
  cacheBytes += size;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value as string;
    cacheBytes -= cache.get(oldest)?.size ?? 0;
    cache.delete(oldest);
  }
}

export function clearDiffRenderCacheForTesting(): void {
  cache.clear();
  cacheBytes = 0;
}

export function diffRenderCacheStatsForTesting(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cacheBytes };
}

/** Pool statistics of the shared renderer (tests and diagnostics). */
export function diffRenderPoolStats(): ReturnType<DiffRenderPool['stats']> | null {
  return pool ? pool.stats() : null;
}

/** Terminate the shared renderer worker (tests and graceful shutdown). */
export async function shutdownDiffRenderer(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.close();
}

/**
 * Render (or reuse) the HTML for an immutable snapshot. Rejects with
 * DiffRenderTimeoutError when the deadline (queue wait + render) expires
 * — the worker is then terminated — and with DiffRenderBusyError (a
 * DiffRenderTimeoutError) when the queue is full.
 */
export function renderSessionDiffHtml(
  cacheKey: string,
  payload: SessionDiffPayload,
  theme: DiffTheme,
  timeoutMs = SSR_RENDER_TIMEOUT_MS,
): Promise<string> {
  const safeTheme: DiffTheme = theme === 'light' ? 'light' : 'dark';
  const key = `${cacheKey}:${safeTheme}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit.html);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = getPool()
    .render(key, payload, safeTheme, timeoutMs)
    .then((html) => {
      cachePut(key, html);
      return html;
    });
  inFlight.set(key, work);
  const forget = () => {
    if (inFlight.get(key) === work) inFlight.delete(key);
  };
  work.then(forget, forget);
  return work;
}
