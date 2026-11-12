/**
 * Worker-isolated Pierre SSR: the real renderer runs off the main thread,
 * is hard-terminated on deadline, bounded in concurrency/queue, dedups
 * identical in-flight requests and releases its slot on worker failure.
 * Real @pierre/diffs is used for SSR; injected worker programs exercise the
 * same production DiffRenderPool for CPU-bound / crashing renderers.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  clearDiffRenderCacheForTesting,
  diffRenderPoolStats,
  DiffRenderBusyError,
  DiffRenderPool,
  DiffRenderTimeoutError,
  DiffRenderWorkerError,
  renderSessionDiffHtml,
  shutdownDiffRenderer,
  SSR_MAX_HTML_BYTES,
} from '../agent/gitDiff/ssrRenderer';
import {
  buildSsrWorkerSource,
  DEFAULT_RENDER_LIMITS,
  resolvePierreEntryUrls,
  PIERRE_DIFFS_VERSION,
} from '../agent/gitDiff/ssrRenderWorker';
import type { SessionDiffPayload } from '../agent/gitDiff/contracts';

const ROOT = '/Users/dev/projects/app';

function bigFile(name: string, lines: number): string {
  const body: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    body.push(
      `+export const value${i}: Record<string, number> = { a: ${i}, b: "${name}-${i}" }; // ${'x'.repeat(i % 40)}`,
    );
  }
  return [
    `diff --git a/${name} b/${name}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${name}`,
    `@@ -0,0 +1,${lines} @@`,
    ...body,
    '',
  ].join('\n');
}

function payloadOf(patch: string, notice?: string): SessionDiffPayload {
  return {
    version: 1,
    repositories: [{ root: ROOT, patch, scope: 'working_tree' }],
    ...(notice ? { notice } : {}),
  };
}

const SMALL_PATCH = [
  'diff --git a/src/<img src=x onerror=alert(1)>.ts b/src/<img src=x onerror=alert(1)>.ts',
  'index 1111111..2222222 100644',
  '--- a/src/<img src=x onerror=alert(1)>.ts',
  '+++ b/src/<img src=x onerror=alert(1)>.ts',
  '@@ -1 +1 @@',
  '-const a = "</template><script>alert(1)</script>";',
  '+const a = 2;',
  '',
].join('\n');

const pools: DiffRenderPool[] = [];
function pool(source: string, opts: { maxQueued?: number } = {}): DiffRenderPool {
  const p = new DiffRenderPool({ workerSource: source, workerData: () => ({}), ...opts });
  pools.push(p);
  return p;
}

// Injected worker programs (plain JS, eval'd like the production source).
const ECHO_SLOW = `
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => setTimeout(() => parentPort.postMessage({ id: m.id, ok: true, html: 'ok:' + m.theme }), 100));
`;
const CPU_BOUND = `
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => { if (m.theme === 'light') { parentPort.postMessage({ id: m.id, ok: true, html: 'fine' }); return; } for (;;) {} });
`;
const CRASH_ON_DARK = `
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => {
  if (m.theme === 'dark') { if (m.payload.version === 1) throw new Error('boom'); process.exit(7); }
  parentPort.postMessage({ id: m.id, ok: true, html: 'recovered' });
});
`;

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});
afterAll(async () => {
  await shutdownDiffRenderer();
});

describe('Pierre resolution and worker source', () => {
  it('resolves the pinned ESM entries inside the package and builds self-contained source', () => {
    const urls = resolvePierreEntryUrls();
    expect(urls.ssrUrl).toMatch(/^file:\/\/.*\/@pierre\/diffs\/dist\/ssr\/index\.js$/);
    expect(urls.coreUrl).toMatch(/^file:\/\/.*\/@pierre\/diffs\/dist\/index\.js$/);
    expect(PIERRE_DIFFS_VERSION).toBe('1.6.4');
    const src = buildSsrWorkerSource();
    // Must parse as plain JS and carry no transformer/compiler artefacts.
    expect(() => new Function(src)).not.toThrow();
    expect(src).not.toMatch(/__vi_|\w_1\.|__awaiter|__name\(|\(0, [\w$]+\.|require\(["']\./);
    expect(src).toContain('(s) => import(s)');
  });
});

describe('real SSR in the worker', () => {
  it('keeps the main event loop responsive during a large real render', async () => {
    clearDiffRenderCacheForTesting();
    const patch = Array.from({ length: 12 }, (_, i) => bigFile(`src/big${i}.ts`, 2500)).join('');
    let ticks = 0;
    let maxGap = 0;
    let last = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks += 1;
    }, 5);
    const started = Date.now();
    const html = await renderSessionDiffHtml('sdiff_large', payloadOf(patch), 'dark', 120_000);
    clearInterval(interval);
    const elapsed = Date.now() - started;
    expect(html).toContain('<template shadowrootmode="open">');
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(SSR_MAX_HTML_BYTES);
    // The render took long enough to matter, and timers kept firing.
    expect(elapsed).toBeGreaterThan(200);
    expect(ticks).toBeGreaterThan(elapsed / 5 / 4);
    expect(maxGap).toBeLessThan(150);
  }, 180_000);

  it('includes Pierre CSS and escapes injected markup through the worker', async () => {
    clearDiffRenderCacheForTesting();
    const html = await renderSessionDiffHtml(
      'sdiff_safe',
      payloadOf(SMALL_PATCH, '<i>note</i>'),
      'light',
    );
    expect(html).toContain('data-core-css');
    expect(html).toMatch(/--diffs-token-light:#[0-9A-Fa-f]{6}/);
    expect(html).toContain("script-src 'none'");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain('<i>note</i>');
    expect((html.match(/<\/template>/g) ?? []).length).toBe(1);
  });

  it('hard-times-out a real render and recovers with a fresh worker', async () => {
    clearDiffRenderCacheForTesting();
    const patch = Array.from({ length: 8 }, (_, i) => bigFile(`src/t${i}.ts`, 2500)).join('');
    await expect(
      renderSessionDiffHtml('sdiff_slow', payloadOf(patch), 'dark', 30),
    ).rejects.toBeInstanceOf(DiffRenderTimeoutError);
    const html = await renderSessionDiffHtml('sdiff_after', payloadOf(SMALL_PATCH), 'dark');
    expect(html).toContain('shadowrootmode');
    expect(diffRenderPoolStats()?.workersKilled).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('dedups concurrent identical requests into one worker job', async () => {
    clearDiffRenderCacheForTesting();
    const before = diffRenderPoolStats()?.jobsStarted ?? 0;
    const payload = payloadOf(SMALL_PATCH);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => renderSessionDiffHtml('sdiff_dedup', payload, 'dark')),
    );
    expect(new Set(results).size).toBe(1);
    expect(diffRenderPoolStats()!.jobsStarted - before).toBe(1);
  });

  it('caps the final document at the HTML limit with metadata accounted', async () => {
    // Exercise the production document builder with a tiny limit via the
    // real Pierre modules loaded in a worker.
    const limits = { ...DEFAULT_RENDER_LIMITS, maxHtmlBytes: 64 * 1024 };
    const urls = resolvePierreEntryUrls();
    const p = new DiffRenderPool({
      workerData: () => ({ ssrUrl: urls.ssrUrl, coreUrl: urls.coreUrl, limits }),
      maxHtmlBytes: limits.maxHtmlBytes,
    });
    pools.push(p);
    const patch = Array.from({ length: 6 }, (_, i) => bigFile(`src/c${i}.ts`, 200)).join('');
    const html = await p.render('k', payloadOf(patch, 'n'.repeat(500)), 'dark', 60_000);
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(limits.maxHtmlBytes);
    expect(html).toMatch(/files were not rendered \(viewer limit\)/);
    expect(html.endsWith('</main></body></html>')).toBe(true);
  }, 60_000);
});

describe('DiffRenderPool scheduling (injected worker programs)', () => {
  it('terminates a CPU-bound renderer at the deadline and releases the slot', async () => {
    const p = pool(CPU_BOUND);
    let ticks = 0;
    const interval = setInterval(() => (ticks += 1), 5);
    const t0 = Date.now();
    await expect(p.render('spin', payloadOf(''), 'dark', 200)).rejects.toBeInstanceOf(
      DiffRenderTimeoutError,
    );
    clearInterval(interval);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThan(5);
    expect(p.stats().workersKilled).toBe(1);
    await expect(p.render('next', payloadOf(''), 'light', 5_000)).resolves.toBe('fine');
    expect(p.stats().workersSpawned).toBe(2);
  });

  it('rejects overflow beyond one active + two queued, and counts queue time in the deadline', async () => {
    const p = pool(ECHO_SLOW);
    const a = p.render('a', payloadOf(''), 'dark', 5_000);
    const b = p.render('b', payloadOf(''), 'dark', 5_000);
    const c = p.render('c', payloadOf(''), 'dark', 150); // waits ~200ms behind a and b
    await expect(p.render('d', payloadOf(''), 'dark', 5_000)).rejects.toBeInstanceOf(
      DiffRenderBusyError,
    );
    expect(p.stats()).toMatchObject({ active: 1, queued: 2 });
    await expect(c).rejects.toBeInstanceOf(DiffRenderTimeoutError);
    await expect(Promise.all([a, b])).resolves.toEqual(['ok:dark', 'ok:dark']);
    expect(p.stats()).toMatchObject({ active: 0, queued: 0, inFlightKeys: 0, jobsStarted: 2 });
  });

  it('dedups identical in-flight keys (theme click flood)', async () => {
    const p = pool(ECHO_SLOW);
    const flood = Array.from({ length: 20 }, (_, i) =>
      p.render(i % 2 ? 'snap:light' : 'snap:dark', payloadOf(''), i % 2 ? 'light' : 'dark', 5_000),
    );
    const out = await Promise.all(flood);
    expect(new Set(out)).toEqual(new Set(['ok:dark', 'ok:light']));
    expect(p.stats().jobsStarted).toBe(2);
  });

  it('releases the slot when the worker throws or exits', async () => {
    const p = pool(CRASH_ON_DARK);
    await expect(p.render('x', payloadOf(''), 'dark', 5_000)).rejects.toBeInstanceOf(
      DiffRenderWorkerError,
    );
    await expect(p.render('y', payloadOf(''), 'light', 5_000)).resolves.toBe('recovered');
    await expect(
      p.render('z', { ...payloadOf(''), version: 2 as 1 }, 'dark', 5_000),
    ).rejects.toThrow(/exited \(7\)/);
    await expect(p.render('w', payloadOf(''), 'light', 5_000)).resolves.toBe('recovered');
    expect(p.stats()).toMatchObject({ active: 0, queued: 0, inFlightKeys: 0, workersSpawned: 3 });
  });

  it('rejects oversized worker output', async () => {
    const p = new DiffRenderPool({
      workerSource: `const { parentPort } = require('worker_threads');
        parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, ok: true, html: 'x'.repeat(2048) }));`,
      workerData: () => ({}),
      maxHtmlBytes: 1024,
    });
    pools.push(p);
    await expect(p.render('big', payloadOf(''), 'dark', 5_000)).rejects.toThrow(/exceeds limit/);
  });
});
