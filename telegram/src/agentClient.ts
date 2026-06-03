import axios from "axios";
import WebSocket from "ws";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Logger } from "winston";
import { omnikeyBaseUrl, omnikeyWsUrl } from "./config";
import { fetchJwtToken } from "./omnikeyAuth";

export interface AgentSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly turns: number;
  readonly lastActiveAt: string;
}

export async function listRecentSessions(
  logger: Logger,
  limit = 5,
): Promise<AgentSessionSummary[]> {
  const token = await fetchJwtToken(logger);
  const url = `${omnikeyBaseUrl()}/api/agent/sessions`;
  const resp = await axios.get<AgentSessionSummary[]>(url, {
    timeout: 10_000,
    headers: { Authorization: `Bearer ${token}` },
  });
  return (resp.data ?? []).slice(0, limit);
}

export interface TaskTemplate {
  readonly id: string;
  readonly heading: string;
  readonly instructions: string;
  readonly isDefault: boolean;
}

export async function listTaskTemplates(
  logger: Logger,
): Promise<TaskTemplate[]> {
  const token = await fetchJwtToken(logger);
  const url = `${omnikeyBaseUrl()}/api/instructions/templates`;
  const resp = await axios.get<{ templates: TaskTemplate[] }>(url, {
    timeout: 10_000,
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.data?.templates ?? [];
}

/**
 * Mark a task template as the active default on the backend. Subsequent
 * agent runs automatically pick it up via stored_instructions — no need
 * to prepend it to the user prompt.
 */
export async function setDefaultTaskTemplate(
  logger: Logger,
  templateId: string,
): Promise<void> {
  const token = await fetchJwtToken(logger);
  const url = `${omnikeyBaseUrl()}/api/instructions/templates/${encodeURIComponent(templateId)}/set-default`;
  await axios.post(url, undefined, {
    timeout: 10_000,
    headers: { Authorization: `Bearer ${token}` },
  });
  logger.info("Set default task template", { templateId });
}

export interface ProjectGroup {
  readonly groupName: string;
  readonly groupDescription: string | null;
}

export async function listProjectGroups(
  logger: Logger,
): Promise<ProjectGroup[]> {
  const token = await fetchJwtToken(logger);
  const url = `${omnikeyBaseUrl()}/api/agent/groups`;
  const resp = await axios.get<{ groups: ProjectGroup[] }>(url, {
    timeout: 10_000,
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.data?.groups ?? [];
}

// Wire-format mirrors omnikey-ai/src/agent/types.ts AgentMessage.
interface AgentWireMessage {
  session_id: string;
  sender: string;
  content: string;
  is_terminal_output?: boolean;
  is_error?: boolean;
  is_web_call?: boolean;
  is_image_rendering?: boolean;
  is_mcp_call?: boolean;
  platform?: string;
  group_name?: string;
}

export type AgentBlockKind =
  | "reasoning"
  | "shellCommand"
  | "terminalOutput"
  | "webCall"
  | "mcpCall"
  | "imageRendering"
  | "finalAnswer";

export interface AgentBlock {
  readonly kind: AgentBlockKind;
  readonly text: string;
}

export interface RunAgentOptions {
  readonly sessionId?: string;
  readonly prompt: string;
  readonly groupName?: string;
  readonly onBlock: (block: AgentBlock) => void | Promise<void>;
  /**
   * Optional abort signal. When aborted, the underlying WebSocket is closed
   * and the run rejects with an `AbortError` so callers can surface a
   * "stopped by user" status.
   */
  readonly signal?: AbortSignal;
}

export class AgentAbortError extends Error {
  constructor(message = "Agent run aborted") {
    super(message);
    this.name = "AgentAbortError";
  }
}

export interface RunAgentResult {
  readonly sessionId: string;
  readonly finalAnswer: string;
}

function extractTagged(content: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = content.match(re);
  return m?.[1]?.trim() || null;
}

function stripTagged(content: string, tag: string): string {
  return content.replace(
    new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
    "",
  );
}

function cleanReasoning(content: string): string {
  return content
    .replace(/<\/?shell_function_calls>/gi, "")
    .replace(/<final_answer>([\s\S]*?)<\/final_answer>/gi, "$1")
    .trim();
}

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const SHELL_OUTPUT_MAX = 64 * 1024;

// Mirrors WINDOWS_SHELL_CANDIDATES in src/agent/mcpRuntime.ts
const WINDOWS_SHELL_CANDIDATES = [
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Program Files\\PowerShell\\6\\pwsh.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Windows\\System32\\cmd.exe",
  "C:\\Windows\\cmd.exe",
] as const;

// Resolve the Windows shell: COMSPEC → SystemRoot\System32\cmd.exe → candidate list.
// Mirrors resolveLoginShell() in src/agent/mcpRuntime.ts, with SystemRoot used to
// locate cmd.exe from the Win32 system root rather than a hardcoded drive letter.
function resolveWindowsShell(): string {
  const comspec = process.env.COMSPEC ?? "";
  if (comspec && existsSync(comspec)) return comspec;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const cmdFromRoot = path.join(systemRoot, "System32", "cmd.exe");
  if (existsSync(cmdFromRoot)) return cmdFromRoot;
  for (const candidate of WINDOWS_SHELL_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return "cmd.exe";
}

// Build shell args for the resolved shell — mirrors wrapWithLoginShell() in
// src/agent/mcpRuntime.ts.  PowerShell/pwsh use -NoProfile -Command; cmd uses /c.
function buildWindowsShellArgs(shell: string, script: string): string[] {
  const name = path.basename(shell).toLowerCase();
  if (name === "pwsh.exe" || name === "powershell.exe") {
    return ["-NoProfile", "-Command", script];
  }
  return ["/c", script];
}

const PLATFORM =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";

/**
 * Execute a shell script locally and capture combined stdout+stderr.
 * On macOS/Linux: invoke the login shell with `-l -c <script>` (mirrors the
 * macOS AgentRunner.runShellCommandWithStatus path).
 * On Windows: resolve the shell via COMSPEC / SystemRoot / candidate list and
 * pass the script with the appropriate flags (-NoProfile -Command or /c),
 * mirroring how the Windows app executes scripts in the terminal.
 * Output is capped so a runaway script can't blow up the WebSocket payload.
 */
function runShellScript(
  script: string,
  logger: Logger,
): Promise<{ output: string; status: number }> {
  return new Promise((resolve) => {
    let shell: string;
    let shellArgs: string[];

    if (process.platform !== "darwin" && process.platform === "win32") {
      shell = resolveWindowsShell();
      shellArgs = buildWindowsShellArgs(shell, script);
    } else {
      shell = process.env.SHELL || "/bin/zsh";
      shellArgs = ["-l", "-c", script];
    }

    logger.info("Executing shell script from agent", {
      shell,
      platform: PLATFORM,
      length: script.length,
    });

    const child = spawn(shell, shellArgs, {
      cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
      env: process.env,
    });

    let buf = "";
    let truncated = false;
    const append = (chunk: Buffer) => {
      if (truncated) return;
      const room = SHELL_OUTPUT_MAX - buf.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      if (text.length <= room) {
        buf += text;
      } else {
        buf += text.slice(0, room);
        truncated = true;
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timeout = setTimeout(() => {
      logger.warn("Shell script timed out; sending SIGTERM", {
        timeoutMs: SHELL_TIMEOUT_MS,
      });
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }, SHELL_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        output: `${buf}\n[shell spawn error: ${err.message}]`,
        status: -1,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const status = typeof code === "number" ? code : signal ? 1 : 0;
      const finalOutput = truncated
        ? `${buf}\n... [truncated to ${SHELL_OUTPUT_MAX} bytes]`
        : buf;
      logger.info("Shell script finished", {
        status,
        signal,
        outputLength: finalOutput.length,
      });
      resolve({ output: finalOutput, status });
    });
  });
}

/**
 * Drive a single agent turn over the /ws/omni-agent WebSocket. Streams
 * intermediate blocks via `onBlock` and resolves with the final answer.
 *
 * When the agent emits a `<shell_script>` block we execute it locally with
 * the user's login shell (mirroring the macOS app's AgentRunner) and send
 * the combined stdout+stderr back as the next user turn so the agent can
 * continue reasoning over the result.
 */
export async function runAgentTurn(
  logger: Logger,
  opts: RunAgentOptions,
): Promise<RunAgentResult> {
  const token = await fetchJwtToken(logger);
  const sessionId = opts.sessionId || randomUUID();
  const url = omnikeyWsUrl("/ws/omni-agent");

  return new Promise<RunAgentResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AgentAbortError());
      return;
    }

    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let settled = false;
    const finish = (err: Error | null, result?: RunAgentResult) => {
      if (settled) return;
      settled = true;
      if (opts.signal && onAbort) {
        opts.signal.removeEventListener("abort", onAbort);
      }
      try {
        ws.close();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else if (result) resolve(result);
    };

    const onAbort = opts.signal
      ? () => {
          logger.info("Agent run aborted by caller", { sessionId });
          finish(new AgentAbortError());
        }
      : null;
    if (opts.signal && onAbort) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const send = (msg: AgentWireMessage) => {
      ws.send(JSON.stringify(msg), (err) => {
        if (err) finish(err);
      });
    };

    ws.on("open", () => {
      logger.info("Agent WebSocket open", { sessionId });
      send({
        session_id: sessionId,
        sender: "client",
        content: opts.prompt,
        is_terminal_output: false,
        is_error: false,
        platform: PLATFORM,
        group_name: opts.groupName,
      });
    });

    ws.on("message", async (data) => {
      let msg: AgentWireMessage;
      try {
        msg = JSON.parse(data.toString()) as AgentWireMessage;
      } catch (e) {
        logger.warn("Failed to parse agent ws message", {
          error: (e as Error).message,
        });
        return;
      }

      const content = msg.content || "";

      if (msg.is_error) {
        finish(new Error(content || "Agent reported an error"));
        return;
      }

      if (msg.is_web_call) {
        await opts.onBlock({ kind: "webCall", text: content });
        return;
      }
      if (msg.is_image_rendering) {
        await opts.onBlock({ kind: "imageRendering", text: content });
        return;
      }
      if (msg.is_mcp_call) {
        await opts.onBlock({ kind: "mcpCall", text: content });
        return;
      }

      const finalAnswer = extractTagged(content, "final_answer");
      if (finalAnswer) {
        await opts.onBlock({ kind: "finalAnswer", text: finalAnswer });
        finish(null, { sessionId, finalAnswer });
        return;
      }

      const shellScript = extractTagged(content, "shell_script");
      if (shellScript) {
        const reasoning = cleanReasoning(stripTagged(content, "shell_script"));
        if (reasoning)
          await opts.onBlock({ kind: "reasoning", text: reasoning });
        await opts.onBlock({ kind: "shellCommand", text: shellScript });

        try {
          const { output, status } = await runShellScript(shellScript, logger);
          const statusLabel =
            status === 0 ? "success" : `error (exit code: ${status})`;
          await opts.onBlock({
            kind: "terminalOutput",
            text: `[terminal ${statusLabel}]\n${output}`,
          });
          send({
            session_id: sessionId,
            sender: "client",
            content: output,
            is_terminal_output: true,
            is_error: status !== 0,
            platform: PLATFORM,
          });
        } catch (err) {
          const message = (err as Error).message;
          logger.error("Shell execution failed", { error: message });
          await opts.onBlock({
            kind: "terminalOutput",
            text: `[terminal error]\n${message}`,
          });
          send({
            session_id: sessionId,
            sender: "client",
            content: `Failed to execute shell script: ${message}`,
            is_terminal_output: true,
            is_error: true,
            platform: PLATFORM,
          });
        }
        return;
      }

      const reasoning = cleanReasoning(content);
      if (reasoning) {
        await opts.onBlock({ kind: "reasoning", text: reasoning });
      }
    });

    ws.on("error", (err) => {
      logger.error("Agent WebSocket error", { error: err.message });
      finish(err);
    });

    ws.on("close", () => {
      if (!settled)
        finish(new Error("Agent WebSocket closed before final answer"));
    });
  });
}

/**
 * Find the most recent `<final_answer>` text in a stored session's history JSON.
 */
export function extractFinalAnswerFromHistory(
  historyJson: string,
): string | null {
  try {
    const history = JSON.parse(historyJson) as Array<{
      role?: string;
      content?: unknown;
    }>;
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.role !== "assistant") continue;
      const content = typeof entry.content === "string" ? entry.content : "";
      const fa = extractTagged(content, "final_answer");
      if (fa) return fa;
    }
  } catch {
    /* ignore */
  }
  return null;
}
