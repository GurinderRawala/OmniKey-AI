#!/usr/bin/env node
/**
 * launchd manager for the telegram-bot service.
 *
 * Inspired by ~/omnikey-ai/cli/src/daemon.ts. macOS only — installs a user
 * LaunchAgent so the bot starts at login, restarts on crash, and survives
 * reboots.
 *
 * Usage (from the project root):
 *   yarn daemon start     install plist + load
 *   yarn daemon stop      unload plist
 *   yarn daemon restart   unload + reload
 *   yarn daemon status    show launchctl list entry + port liveness
 *   yarn daemon logs      tail stdout + stderr logs
 *   yarn daemon uninstall unload + remove plist file
 */
import { execSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const LABEL = "com.gurindersingh.telegram-bot";
const PLIST_NAME = `${LABEL}.plist`;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENTRY_POINT = path.join(PROJECT_ROOT, "dist", "index.js");

const HOME = os.homedir();
const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);
const LOG_DIR = path.join(HOME, "Library", "Logs", "telegram-bot");
const STDOUT_LOG = path.join(LOG_DIR, "out.log");
const STDERR_LOG = path.join(LOG_DIR, "err.log");

function assertMacOS(): void {
  if (process.platform !== "darwin") {
    console.error(
      `This daemon manager only supports macOS (launchd). Detected platform: ${process.platform}`,
    );
    process.exit(1);
  }
}

function ensureBuilt(): void {
  if (fs.existsSync(ENTRY_POINT)) return;
  console.log("dist/index.js not found — running `tsc -p .`...");
  const result = spawnSync("npx", ["tsc", "-p", "."], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("Build failed. Aborting.");
    process.exit(result.status ?? 1);
  }
}

function ensureDirs(): void {
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // Touch log files so launchd can write to them immediately.
  for (const f of [STDOUT_LOG, STDERR_LOG]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, "");
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPlist(): string {
  // Forward a small whitelist of env vars from the current shell so the
  // service inherits credentials without us hard-coding secrets into the
  // plist. Values still come from the project's .env (loaded by dotenv at
  // runtime) — these vars are only forwarded if already set in the parent
  // environment when `daemon start` is run.
  const FORWARD_ENV_KEYS = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "PORT",
    "LOG_LEVEL",
  ];
  const envEntries: string[] = [
    `<key>PATH</key><string>${escapeXml(
      process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    )}</string>`,
    `<key>HOME</key><string>${escapeXml(HOME)}</string>`,
  ];
  for (const key of FORWARD_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length > 0) {
      envEntries.push(`<key>${key}</key><string>${escapeXml(value)}</string>`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(ENTRY_POINT)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(PROJECT_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    ${envEntries.join("\n    ")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(STDOUT_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(STDERR_LOG)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function unloadIfLoaded(): void {
  if (!fs.existsSync(PLIST_PATH)) return;
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    /* not loaded — fine */
  }
}

function start(): void {
  assertMacOS();
  ensureBuilt();
  ensureDirs();

  fs.writeFileSync(PLIST_PATH, buildPlist(), "utf-8");
  console.log(`Wrote LaunchAgent: ${PLIST_PATH}`);

  unloadIfLoaded();
  try {
    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: "inherit" });
  } catch (e) {
    console.error("launchctl load failed:", (e as Error).message);
    process.exit(1);
  }

  console.log(`Loaded ${LABEL}. The service will run at login and on reboot.`);
  console.log(`stdout: ${STDOUT_LOG}`);
  console.log(`stderr: ${STDERR_LOG}`);
}

function stop(): void {
  assertMacOS();
  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`No LaunchAgent at ${PLIST_PATH}. Nothing to stop.`);
    return;
  }
  unloadIfLoaded();
  console.log(`Unloaded ${LABEL}.`);
}

function uninstall(): void {
  assertMacOS();
  unloadIfLoaded();
  if (fs.existsSync(PLIST_PATH)) {
    fs.rmSync(PLIST_PATH);
    console.log(`Removed ${PLIST_PATH}.`);
  } else {
    console.log(`No plist at ${PLIST_PATH}.`);
  }
}

function restart(): void {
  stop();
  start();
}

function status(): void {
  assertMacOS();
  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`Not installed (${PLIST_PATH} missing).`);
    return;
  }
  console.log(`Plist: ${PLIST_PATH}`);
  try {
    const out = execSync(`launchctl list | grep ${LABEL} || true`).toString();
    if (out.trim()) {
      console.log("launchctl list:");
      console.log(out.trim());
    } else {
      console.log("Not currently loaded by launchd.");
    }
  } catch (e) {
    console.warn("launchctl list failed:", (e as Error).message);
  }

  // Port probe — best-effort.
  const port = process.env.PORT || "7072";
  try {
    const lsof = execSync(`lsof -i :${port} -sTCP:LISTEN -t || true`)
      .toString()
      .trim();
    if (lsof) {
      console.log(`Listening on port ${port} (pid ${lsof.split("\n")[0]}).`);
    } else {
      console.log(`Nothing listening on port ${port}.`);
    }
  } catch {
    /* ignore */
  }
}

function logs(): void {
  assertMacOS();
  if (!fs.existsSync(STDOUT_LOG) && !fs.existsSync(STDERR_LOG)) {
    console.log("No log files yet. Start the daemon first.");
    return;
  }
  console.log(`Tailing ${STDOUT_LOG} and ${STDERR_LOG}. Ctrl-C to stop.`);
  // -F follows file rotations; -n shows recent context.
  const child = spawnSync("tail", ["-n", "100", "-F", STDOUT_LOG, STDERR_LOG], {
    stdio: "inherit",
  });
  process.exit(child.status ?? 0);
}

function help(): void {
  console.log(
    [
      "telegram-bot daemon (launchd manager)",
      "",
      "Commands:",
      "  start       Install LaunchAgent and load it",
      "  stop        Unload the LaunchAgent",
      "  restart     Unload + reload",
      "  status      Show launchctl + port status",
      "  logs        Tail stdout + stderr",
      "  uninstall   Unload and remove the plist file",
      "",
      `Plist:   ${PLIST_PATH}`,
      `stdout:  ${STDOUT_LOG}`,
      `stderr:  ${STDERR_LOG}`,
    ].join("\n"),
  );
}

const cmd = (process.argv[2] || "").toLowerCase();
switch (cmd) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    restart();
    break;
  case "status":
    status();
    break;
  case "logs":
    logs();
    break;
  case "uninstall":
    uninstall();
    break;
  case "":
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
