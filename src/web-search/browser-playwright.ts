import axios from 'axios';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { Browser, Page } from 'playwright-core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pw from 'playwright-core';
import type { Logger } from 'winston';
import { config } from '../config';

// ─── Browser catalogue ────────────────────────────────────────────────────────

interface BrowserCandidate {
  name: string;
  /** Ordered list of possible app executable paths. First existing one is used. */
  executablePaths: string[];
  /** The User Data directory that contains one or more profile subdirectories. */
  userDataDir: string;
}

const home = os.homedir();

const BROWSER_CATALOGUE: BrowserCandidate[] = [
  {
    name: 'Chrome',
    executablePaths: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ],
    userDataDir: path.join(home, 'Library/Application Support/Google/Chrome'),
  },
  {
    name: 'Brave',
    executablePaths: [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      `${home}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    ],
    userDataDir: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
  },
  {
    name: 'Edge',
    executablePaths: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      `${home}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
    ],
    userDataDir: path.join(home, 'Library/Application Support/Microsoft Edge'),
  },
  {
    name: 'Arc',
    executablePaths: [
      '/Applications/Arc.app/Contents/MacOS/Arc',
      `${home}/Applications/Arc.app/Contents/MacOS/Arc`,
    ],
    userDataDir: path.join(home, 'Library/Application Support/Arc/User Data'),
  },
  {
    name: 'Vivaldi',
    executablePaths: [
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      `${home}/Applications/Vivaldi.app/Contents/MacOS/Vivaldi`,
    ],
    userDataDir: path.join(home, 'Library/Application Support/Vivaldi'),
  },
  {
    name: 'Opera',
    executablePaths: [
      '/Applications/Opera.app/Contents/MacOS/Opera',
      `${home}/Applications/Opera.app/Contents/MacOS/Opera`,
    ],
    userDataDir: path.join(home, 'Library/Application Support/com.operasoftware.Opera'),
  },
  {
    name: 'Chromium',
    executablePaths: [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${home}/Applications/Chromium.app/Contents/MacOS/Chromium`,
    ],
    userDataDir: path.join(home, 'Library/Application Support/Chromium'),
  },
];

// ─── Windows browser catalogue ────────────────────────────────────────────────

interface WindowsBrowserEntry {
  name: string;
  executablePaths: string[];
  /** Root user-data directory (contains "Default" profile subfolder and "Local State") */
  userDataDir: string;
}

const WINDOWS_BROWSER_CATALOGUE: WindowsBrowserEntry[] = [
  {
    name: 'Chrome',
    executablePaths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    userDataDir: path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  },
  {
    name: 'Edge',
    executablePaths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    userDataDir: path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  },
  {
    name: 'Brave',
    executablePaths: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      path.join(
        home,
        'AppData',
        'Local',
        'BraveSoftware',
        'Brave-Browser',
        'Application',
        'brave.exe',
      ),
    ],
    userDataDir: path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
  },
];

function resolveExistingExecutablePath(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// ─── Running browser detection ────────────────────────────────────────────────

/**
 * Returns the names of browsers that are currently running.
 * Used to sort the browser list so the active browser (with a live session)
 * is tried first.
 */
function getRunningBrowserNames(): Set<string> {
  const running = new Set<string>();

  if (process.platform === 'win32') {
    // tasklist /FO CSV /NH outputs one "ImageName","PID",... line per process.
    const exeMap: Record<string, string> = {
      'chrome.exe': 'Chrome',
      'msedge.exe': 'Edge',
      'brave.exe': 'Brave',
      'opera.exe': 'Opera',
      'vivaldi.exe': 'Vivaldi',
    };
    try {
      const out = execSync('tasklist /FO CSV /NH 2>nul', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      for (const line of out.split('\n')) {
        const exe = line.split(',')[0]?.replace(/"/g, '').trim().toLowerCase();
        const name = exeMap[exe];
        if (name) running.add(name);
      }
    } catch {
      // tasklist failed — proceed without running-browser info
    }
    return running;
  }

  try {
    // ps -axco command lists only the process name (no path, no args)
    const output = execSync('ps -axco command', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = output.toLowerCase().split('\n');

    const processMap: Record<string, string> = {
      'google chrome': 'Chrome',
      'brave browser': 'Brave',
      'microsoft edge': 'Edge',
      arc: 'Arc',
      vivaldi: 'Vivaldi',
      opera: 'Opera',
      chromium: 'Chromium',
      safari: 'Safari',
    };

    for (const [processName, browserName] of Object.entries(processMap)) {
      if (processName === 'safari') {
        if (lines.some((l) => l.trim() === 'safari')) {
          running.add(browserName);
        }
      } else {
        if (lines.some((l) => l.trim() === processName || l.includes(processName))) {
          running.add(browserName);
        }
      }
    }
  } catch {
    // ps failed — proceed without running-browser info
  }
  return running;
}

/**
 * ─── Strategy -1: CDP via DevToolsActivePort ─────────────────────────────────
 * When Chrome is launched with --remote-debugging-port (or --remote-debugging-port=0
 * to let it pick a free port), it writes a DevToolsActivePort file to the user data
 * directory containing the actual port. Connecting via CDP gives us direct access
 * to the live, JS-rendered tab content without AppleScript permissions or cookie
 * decryption. This is the fastest and most reliable path when available.
 */
async function fetchWithCDP(
  url: string,
  workingPorts: number[],
  log: Logger,
): Promise<{ content: string; finalUrl: string } | null> {
  const targetBase = url.split('?')[0]; // strip query for prefix match

  for (const port of workingPorts) {
    log.info('browser-playwright: CDP — debug endpoint found, connecting', { port });

    let cdpBrowser: Browser | null = null;
    try {
      cdpBrowser = await pw.chromium.connectOverCDP(`http://localhost:${port}`, {
        timeout: 5_000,
      });

      let matchedPage: Page | null = null;
      for (const context of cdpBrowser.contexts()) {
        for (const page of context.pages()) {
          if (page.url().startsWith(targetBase)) {
            matchedPage = page;
            break;
          }
        }
        if (matchedPage) break;
      }

      if (!matchedPage) {
        log.debug('browser-playwright: CDP — no tab found matching URL', { port, url });
        continue;
      }

      log.info('browser-playwright: CDP — tab found, extracting content', {
        port,
        tabUrl: matchedPage.url(),
      });

      try {
        await matchedPage.waitForFunction(
          () => (document.body?.innerText ?? '').trim().length > 200,
          { timeout: 5_000 },
        );
      } catch {
        // Best-effort — extract whatever is rendered so far
      }

      const content: string = await matchedPage.evaluate(
        () => (document.body as HTMLBodyElement).innerText ?? document.body.textContent ?? '',
      );

      log.info('browser-playwright: CDP — content extracted', {
        port,
        contentLength: content.trim().length,
      });

      const trimmed = content.trim();
      return trimmed ? { content: trimmed, finalUrl: matchedPage.url() } : null;
    } catch (err) {
      log.warn('browser-playwright: CDP — connection failed', {
        port,
        error: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    } finally {
      if (cdpBrowser) {
        try {
          await cdpBrowser.close();
        } catch {}
      }
    }
  }

  return null;
}

async function getWorkingCdpPorts(browsersWithUrl: Set<string>, log: Logger): Promise<number[]> {
  // Collect candidate ports:
  //   1. DevToolsActivePort file (written when Chrome was started with --remote-debugging-port)
  //   2. Well-known default ports developers commonly use
  //   3. On Windows: all ports browser processes are currently listening on
  const candidatePorts: number[] = [];

  if (process.platform !== 'win32') {
    // macOS: read DevToolsActivePort from confirmed-open browsers
    for (const candidate of BROWSER_CATALOGUE) {
      if (!browsersWithUrl.has(candidate.name)) continue;
      if (candidate.name === 'Safari') continue;
      const portFile = path.join(candidate.userDataDir, 'DevToolsActivePort');
      if (fs.existsSync(portFile)) {
        try {
          const raw = fs.readFileSync(portFile, 'utf8');
          const port = parseInt(raw.split('\n')[0].trim(), 10);
          if (!isNaN(port) && port > 0 && !candidatePorts.includes(port)) {
            candidatePorts.push(port);
          }
        } catch {}
      }
    }
  }

  // Windows: AppleScript is unavailable so browsersWithUrl is always empty.
  // Read DevToolsActivePort from Windows browser paths directly, and also ask
  // PowerShell for every TCP port the browser processes are listening on —
  // this catches any --remote-debugging-port value, not just well-known ones.
  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_BROWSER_CATALOGUE) {
      const portFile = path.join(candidate.userDataDir, 'DevToolsActivePort');
      if (fs.existsSync(portFile)) {
        try {
          const raw = fs.readFileSync(portFile, 'utf8');
          const port = parseInt(raw.split('\n')[0].trim(), 10);
          if (!isNaN(port) && port > 0 && !candidatePorts.includes(port)) {
            candidatePorts.push(port);
          }
        } catch {}
      }
    }
    // Enumerate all listening ports owned by browser processes via PowerShell.
    try {
      const psOut = execSync(
        'powershell -NoProfile -NonInteractive -Command ' +
          '"$p=Get-Process -Name chrome,msedge,brave,opera,vivaldi -EA SilentlyContinue;' +
          'if($p){$p|%{$id=$_.Id;Get-NetTCPConnection -OwningProcess $id -State Listen -EA SilentlyContinue}}' +
          '|Select-Object -ExpandProperty LocalPort|Sort-Object -Unique"',
        { encoding: 'utf8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      for (const line of psOut.split('\n')) {
        const port = parseInt(line.trim(), 10);
        if (!isNaN(port) && port > 1024 && !candidatePorts.includes(port)) {
          candidatePorts.push(port);
        }
      }
    } catch {}
  }

  // Always probe the most common debug ports — many developers run Chrome with
  // --remote-debugging-port=9222 and these checks are cheap (instant refusal if closed).
  for (const p of [9222, 9229, 9333]) {
    if (!candidatePorts.includes(p)) candidatePorts.push(p);
  }

  // User-configured port (set via `omnikey grant-browser-access`) gets tried first.
  if (config.browserDebugPort && !candidatePorts.includes(config.browserDebugPort)) {
    candidatePorts.unshift(config.browserDebugPort);
  } else if (config.browserDebugPort) {
    // Already in the list — move it to the front so it is tried before auto-detected ports.
    candidatePorts.splice(candidatePorts.indexOf(config.browserDebugPort), 1);
    candidatePorts.unshift(config.browserDebugPort);
  }

  const workingPorts: number[] = [];
  for (const port of candidatePorts) {
    try {
      // Use 127.0.0.1 explicitly — on Windows, `localhost` may resolve to ::1
      // while Chrome binds its debug endpoint to 127.0.0.1 only.
      const probe = await axios.get(`http://127.0.0.1:${port}/json/version`, { timeout: 800 });
      if (probe.status === 200) {
        workingPorts.push(port);
      }
    } catch {
      // Port not listening — skip without logging noise
    }
  }

  log.debug('browser-playwright: CDP — candidate port probe complete', {
    candidateCount: candidatePorts.length,
    workingCount: workingPorts.length,
    workingPorts,
  });

  return workingPorts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if any supported Chromium browser is currently running.
 */
export function isAnyBrowserRunning(): boolean {
  return getRunningBrowserNames().size > 0;
}

// ─── AppleScript browser metadata ────────────────────────────────────────────

interface BrowserAppleScript {
  /** macOS application name used in `tell application "..."` */
  appName: string;
  /** Verb to execute JS in a tab: Chrome-family = "execute javascript", Safari = "do JavaScript" */
  jsVerb: string;
}

const BROWSER_APPLESCRIPT: Record<string, BrowserAppleScript> = {
  Chrome: { appName: 'Google Chrome', jsVerb: 'execute javascript' },
  Brave: { appName: 'Brave Browser', jsVerb: 'execute javascript' },
  Edge: { appName: 'Microsoft Edge', jsVerb: 'execute javascript' },
  Arc: { appName: 'Arc', jsVerb: 'execute javascript' },
  Vivaldi: { appName: 'Vivaldi', jsVerb: 'execute javascript' },
  Opera: { appName: 'Opera', jsVerb: 'execute javascript' },
  Chromium: { appName: 'Chromium', jsVerb: 'execute javascript' },
  Safari: { appName: 'Safari', jsVerb: 'do JavaScript' },
};

// ─── Tab detection ────────────────────────────────────────────────────────────

/**
 * Returns the names of running browsers that are confirmed to have the given
 * URL's hostname open in a tab, via AppleScript.
 * Only browsers where AppleScript succeeds AND the hostname is found are included.
 * Browsers where AppleScript fails are silently skipped (not assumed to have it open).
 */
function getBrowsersWithUrlOpen(url: string, log: Logger): Set<string> {
  const confirmed = new Set<string>();

  let targetHostname: string;
  try {
    targetHostname = new URL(url).hostname;
  } catch {
    return confirmed;
  }

  const runningBrowsers = getRunningBrowserNames();
  if (runningBrowsers.size === 0) return confirmed;

  for (const browserName of runningBrowsers) {
    const info = BROWSER_APPLESCRIPT[browserName];
    if (!info) continue;

    try {
      const script = `tell application "${info.appName}" to get URL of every tab of every window`;
      const output = execSync(`osascript -e '${script}'`, {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const found = output
        .split(/[,\n]/)
        .map((u) => u.trim())
        .some((u) => {
          try {
            return new URL(u).hostname === targetHostname;
          } catch {
            return false;
          }
        });

      log.info('browser-playwright: tab check', { browser: browserName, targetHostname, found });
      if (found) confirmed.add(browserName);
    } catch {
      log.warn('browser-playwright: AppleScript tab check failed — skipping browser', {
        browser: browserName,
      });
    }
  }

  return confirmed;
}

/**
 * Returns true if the given URL's hostname is confirmed open in any running
 * browser tab. On macOS this uses AppleScript; on Windows it queries the CDP
 * debug endpoint's /json tab list (requires --remote-debugging-port).
 */
export async function isBrowserOpenWithUrl(url: string, log: Logger): Promise<boolean> {
  if (process.platform === 'win32') {
    return isBrowserOpenWithUrlWindows(url, log);
  }
  return getBrowsersWithUrlOpen(url, log).size > 0;
}

async function isBrowserOpenWithUrlWindows(url: string, log: Logger): Promise<boolean> {
  let targetHostname: string;
  try {
    targetHostname = new URL(url).hostname;
  } catch {
    return false;
  }

  // If no browser processes are running at all, skip the port probes.
  if (getRunningBrowserNames().size === 0) return false;

  const candidatePorts: number[] = [];
  if (config.browserDebugPort) candidatePorts.push(config.browserDebugPort);
  for (const p of [9222, 9229, 9333]) {
    if (!candidatePorts.includes(p)) candidatePorts.push(p);
  }

  for (const port of candidatePorts) {
    try {
      const resp = await axios.get<{ url?: string }[]>(`http://127.0.0.1:${port}/json`, {
        timeout: 800,
      });
      if (!Array.isArray(resp.data)) continue;
      const found = resp.data.some((tab) => {
        try {
          return new URL(tab.url ?? '').hostname === targetHostname;
        } catch {
          return false;
        }
      });
      if (found) {
        log.info('browser-playwright: Windows CDP tab check confirmed URL open', {
          port,
          hostname: targetHostname,
        });
        return true;
      }
    } catch {
      // Port not listening — skip
    }
  }

  return false;
}

// ─── Strategy 0: Live-tab AppleScript extraction ──────────────────────────────
//
// When the user already has the URL open in a browser we can pull the rendered
// page text directly via AppleScript — no cookie decryption, no profile copying,
// no headless browser launch needed.  This is the most reliable strategy for
// authenticated pages because the live tab already holds the valid session.

/**
 * Writes an AppleScript to a temp file, executes it with `osascript`, then
 * deletes the file. Using a temp file avoids heredoc parsing issues that arise
 * when multi-line scripts are passed inline to execSync.
 *
 * On failure, the thrown Error includes the osascript stderr so callers can
 * log the actual reason (e.g. "Allow JavaScript from Apple Events is not enabled").
 */
function runAppleScript(script: string, timeoutMs: number): string {
  const tmpPath = path.join(
    os.tmpdir(),
    `omnikey-as-${Date.now()}-${Math.random().toString(36).slice(2)}.applescript`,
  );
  fs.writeFileSync(tmpPath, script, 'utf8');
  try {
    return execSync(`osascript "${tmpPath}"`, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    // Enrich the error with osascript's stderr so callers get the real reason.
    const stderr: string = (err as any)?.stderr?.toString?.().trim() ?? '';
    const base = err instanceof Error ? err.message : String(err);
    const enriched = new Error(stderr ? `${base}\n${stderr}` : base);
    throw enriched;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}

/**
 * Finds the window/tab index of `url` inside `appName` via AppleScript.
 * Returns { winIdx, tabIdx } (1-based) or null if not found.
 */
function findTabLocation(appName: string, url: string): { winIdx: number; tabIdx: number } | null {
  // Strip query-string for the prefix match so deep links still resolve.
  const urlBase = url.split('?')[0].replace(/"/g, ''); // remove double-quotes to avoid breaking AppleScript string

  const script = [
    `tell application "${appName}"`,
    `  repeat with wIdx from 1 to count of windows`,
    `    repeat with tIdx from 1 to count of tabs of window wIdx`,
    `      if URL of tab tIdx of window wIdx starts with "${urlBase}" then`,
    `        return (wIdx as string) & ":" & (tIdx as string)`,
    `      end if`,
    `    end repeat`,
    `  end repeat`,
    `  return ""`,
    `end tell`,
  ].join('\n');

  try {
    const result = runAppleScript(script, 5_000).trim();
    if (!result) return null;
    const [w, t] = result.split(':').map(Number);
    if (!w || !t || isNaN(w) || isNaN(t)) return null;
    return { winIdx: w, tabIdx: t };
  } catch {
    return null;
  }
}

/**
 * Attempts to extract the rendered text of `url` directly from an open browser
 * tab using AppleScript JS execution. Only tries browsers confirmed to have the
 * URL open. Returns null if the URL is not open or extraction fails.
 */
async function fetchFromRunningBrowserTab(
  url: string,
  browsersWithUrl: Set<string>,
  log: Logger,
): Promise<string | null> {
  if (config.terminalPlatform !== 'macos' || browsersWithUrl.size === 0) return null;

  for (const browserName of browsersWithUrl) {
    const info = BROWSER_APPLESCRIPT[browserName];
    if (!info) continue;

    const location = findTabLocation(info.appName, url);
    if (!location) {
      log.debug('browser-playwright: tab location not found', { browser: browserName, url });
      continue;
    }

    const { winIdx, tabIdx } = location;

    log.info('browser-playwright: extracting content from live tab', {
      browser: browserName,
      winIdx,
      tabIdx,
      url,
    });

    // ── Attempt A: execute JavaScript to get the JS-rendered innerText ────────
    // Requires "Allow JavaScript from Apple Events" in Chrome (View → Developer)
    // or Safari (Develop → Allow JavaScript from Apple Events).
    //
    // Chrome ONLY allows execute javascript on the ACTIVE tab of a window, even
    // with "Allow JavaScript from Apple Events" enabled. We must set the active
    // tab index first, then use the `tell tab` block form (not the `in tab` form)
    // which is more reliably dispatched by Chrome's Apple Event handler.
    const extractJsScript =
      browserName === 'Safari'
        ? [
            `tell application "${info.appName}"`,
            `  ${info.jsVerb} "document.body.innerText || document.body.textContent || ''" in tab ${tabIdx} of window ${winIdx}`,
            `end tell`,
          ].join('\n')
        : [
            `tell application "${info.appName}"`,
            `  set active tab index of window ${winIdx} to ${tabIdx}`,
            `  tell tab ${tabIdx} of window ${winIdx}`,
            `    execute javascript "document.body.innerText || document.body.textContent || ''"`,
            `  end tell`,
            `end tell`,
          ].join('\n');

    try {
      const content = runAppleScript(extractJsScript, 10_000).trim();

      if (content && content.length > 100) {
        log.info('browser-playwright: live tab JS content extracted', {
          browser: browserName,
          url,
          contentLength: content.length,
        });
        return content;
      }

      log.debug('browser-playwright: live tab JS content too short or empty', {
        browser: browserName,
        url,
        contentLength: content.length,
      });
    } catch (err) {
      // The first line of err.message is "Command failed: osascript ...".
      // The second line (from stderr) is the real reason, e.g.:
      //   "Google Chrome got an error: Allow JavaScript from Apple Events is not enabled"
      const lines = (err instanceof Error ? err.message : String(err)).split('\n');
      const detail = lines.find((l) => l.trim() && !l.startsWith('Command failed')) ?? lines[0];
      log.warn('browser-playwright: live tab JS extraction failed — falling back to page source', {
        browser: browserName,
        url,
        reason: detail.trim(),
      });
    }

    // ── Attempt B: get source of tab (Safari only) ───────────────────────────
    // Chrome-family does NOT expose a `source` property on tab objects via
    // AppleScript — the only content-extraction path is `execute javascript`
    // (Attempt A), which requires "Allow JavaScript from Apple Events".
    // Safari exposes `source` on `document` objects (not `tab`), so we compute
    // the global document index by counting tabs across all windows in order.
    if (browserName !== 'Safari') {
      log.info(
        'browser-playwright: live tab JS execution failed — ensure "Allow JavaScript from Apple Events" is enabled (Chrome: View → Developer → Allow JavaScript from Apple Events) and restart Chrome after enabling it',
        {
          browser: browserName,
          url,
        },
      );
      continue;
    }

    const getSourceScript = [
      `tell application "${info.appName}"`,
      `  set docIdx to 0`,
      `  repeat with w from 1 to count of windows`,
      `    repeat with t from 1 to count of tabs of window w`,
      `      set docIdx to docIdx + 1`,
      `      if w = ${winIdx} and t = ${tabIdx} then`,
      `        return source of document docIdx`,
      `      end if`,
      `    end repeat`,
      `  end repeat`,
      `  return ""`,
      `end tell`,
    ].join('\n');

    try {
      const html = runAppleScript(getSourceScript, 10_000).trim();

      if (html && html.length > 200) {
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (text.length > 100) {
          log.info('browser-playwright: live tab page source extracted', {
            browser: browserName,
            url,
            contentLength: text.length,
          });
          return text;
        }
      }

      log.debug('browser-playwright: live tab page source too short or empty', {
        browser: browserName,
        url,
      });
    } catch (err) {
      const lines = (err instanceof Error ? err.message : String(err)).split('\n');
      const detail = lines.find((l) => l.trim() && !l.startsWith('Command failed')) ?? lines[0];
      log.warn('browser-playwright: live tab page source extraction failed', {
        browser: browserName,
        url,
        reason: detail.trim(),
      });
    }
  }

  return null;
}

/**
 * Fetches a URL using the user's browser session.
 *
 * Strategies:
 *  -1. CDP via --remote-debugging-port — macOS + Windows; requires Chrome to be
 *      started with --remote-debugging-port=9222.
 *   0. Live-tab AppleScript extraction — macOS only.
 */
export async function fetchWithPlaywright(url: string, log: Logger): Promise<string | null> {
  const browsersWithUrl = getBrowsersWithUrlOpen(url, log);

  log.info('browser-playwright: browsers with URL open', {
    url,
    browsers: [...browsersWithUrl],
  });

  const workingPorts = await getWorkingCdpPorts(browsersWithUrl, log);
  const cdpResult = await fetchWithCDP(url, workingPorts, log);
  if (cdpResult) return cdpResult.content;

  const liveContent = await fetchFromRunningBrowserTab(url, browsersWithUrl, log);
  if (liveContent) return liveContent;

  log.warn(
    'browser-playwright: all strategies exhausted — on Windows, launch Chrome with --remote-debugging-port=9222',
    { url },
  );
  return null;
}
