import TelegramBot from "node-telegram-bot-api";
import type { Logger } from "winston";
import {
  AgentAbortError,
  getSessionMessages,
  listProjectGroups,
  listRecentSessions,
  listTaskTemplates,
  runAgentTurn,
  setDefaultTaskTemplate,
  type AgentSessionSummary,
  type ProjectGroup,
  type TaskTemplate,
} from "./agentClient";

let bot: TelegramBot | null = null;

export type TelegramParseMode = "Markdown" | "MarkdownV2" | "HTML";

export function initTelegram(botToken: string) {
  if (!botToken) throw new Error("Missing telegram bot token");
  bot = new TelegramBot(botToken, { polling: true });
  return bot;
}

export async function notify(
  logger: Logger,
  message: string,
  options: {
    chatId?: string | number;
    parseMode?: TelegramParseMode;
  } = {},
) {
  if (!bot) {
    throw new Error("Telegram bot not initialized. Call initTelegram first.");
  }

  const chatId = options.chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    throw new Error("Missing chat ID");
  }

  const parseMode = options.parseMode ?? "Markdown";

  try {
    return await bot.sendMessage(chatId, message, { parse_mode: parseMode });
  } catch (err) {
    logger.error("Failed to send Telegram message:", err);
    throw err;
  }
}

// ─── /cmd flow state ─────────────────────────────────────────────────────────

type WizardPhase = "selectInstruction" | "selectProject" | "awaitPrompt";

interface PendingPromptState {
  phase: WizardPhase;
  /** Resume target session id, or null for a brand-new session. */
  sessionId: string | null;
  /** The picker message we keep editing in place to show progress. */
  wizardMessageId: number | null;
  /** Cached lists so callbacks can resolve indices without size-limited tokens. */
  templates: TaskTemplate[];
  groups: ProjectGroup[];
  /** Resolved selections, applied when the user finally sends the prompt. */
  chosenInstructions: string | null;
  chosenInstructionsHeading: string | null;
  chosenGroupName: string | null;
  /** When true, surface every agent block (shell/web/mcp/image) instead of
   *  only reasoning + final answer. Toggled by `/cmd --verbose`. */
  verbose: boolean;
}

interface RunningSessionState {
  sessionId: string;
  startedAt: number;
  lastReasoning: string | null;
  abortController: AbortController;
  stoppedByUser: boolean;
}

const pendingPrompts = new Map<number, PendingPromptState>();
const runningSessions = new Map<number, RunningSessionState>();

// Callback-data prefixes. Telegram limits callback_data to 64 bytes — using
// short prefixes + indices keeps every payload comfortably under the cap.
const CB_SESSION = "s:"; // session picker; "s:new" or "s:<idx>"
const CB_INSTRUCTION = "t:"; // instruction picker; "t:skip" or "t:<idx>"
const CB_PROJECT = "g:"; // project picker;     "g:skip" or "g:<idx>"
const CB_CANCEL = "x:cancel";

function isAuthorizedChat(chatId: number): boolean {
  const allowed = parseInt(process.env.TELEGRAM_CHAT_ID || "0", 10);
  return allowed !== 0 && chatId === allowed;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Strip XML-ish agent tags, code fences, markdown emphasis, and collapse
 * whitespace so reasoning/final-answer blocks read as plain prose in Telegram.
 */
function cleanForTelegram(text: string): string {
  return text
    .replace(
      /<\/?(?:shell_script|final_answer|user_input|stored_instructions|project_context|shell_function_calls)[^>]*>/gi,
      "",
    )
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip the agent's XML envelope tags but keep markdown intact, then convert
 * a sensible subset of CommonMark into Telegram-flavoured HTML so the final
 * answer renders with bold, italics, code blocks, links and lists.
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>,
 * <pre><code class="language-...">, <a href="...">, <blockquote>.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToTelegramHtml(input: string): string {
  // Strip agent envelope tags but preserve the body's markdown.
  let text = input.replace(
    /<\/?(?:shell_script|final_answer|user_input|stored_instructions|project_context|shell_function_calls)[^>]*>/gi,
    "",
  );

  // 1. Extract fenced code blocks and inline code into placeholders so
  //    subsequent transforms do not corrupt their contents.
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const idx = placeholders.push(html) - 1;
    return `\u0000PH${idx}\u0000`;
  };

  text = text.replace(
    /```([a-zA-Z0-9_+.-]*)\n?([\s\S]*?)```/g,
    (_m, lang: string, body: string) => {
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return stash(
        `<pre><code${cls}>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`,
      );
    },
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) =>
    stash(`<code>${escapeHtml(body)}</code>`),
  );

  // 1b. GFM tables → fixed-width <pre> blocks (Telegram HTML has no <table>).
  //     Detect a header row, a separator row of dashes/colons, and any
  //     number of body rows, then render with per-column padding.
  text = text.replace(
    /(^|\n)([^\n]*\|[^\n]*)\n[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*\n((?:[^\n]*\|[^\n]*(?:\n|$))+)/g,
    (_m, lead: string, header: string, body: string) => {
      const splitRow = (row: string): string[] => {
        let r = row.trim();
        if (r.startsWith("|")) r = r.slice(1);
        if (r.endsWith("|")) r = r.slice(0, -1);
        return r.split("|").map((c) => c.trim());
      };
      const headerCells = splitRow(header);
      const bodyRows = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map(splitRow);
      const colCount = Math.max(
        headerCells.length,
        ...bodyRows.map((r) => r.length),
      );
      const pad = (cells: string[]) => {
        const out = cells.slice();
        while (out.length < colCount) out.push("");
        return out;
      };
      const allRows = [pad(headerCells), ...bodyRows.map(pad)];
      // Strip inline markdown that won't render inside <pre>.
      const cleanCell = (s: string): string =>
        s
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/__([^_]+)__/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      const cleaned = allRows.map((row) => row.map(cleanCell));
      const widths: number[] = [];
      for (let c = 0; c < colCount; c++) {
        let w = 0;
        for (const row of cleaned) w = Math.max(w, row[c]?.length ?? 0);
        widths[c] = w;
      }
      const renderRow = (row: string[]) =>
        row.map((cell, i) => cell.padEnd(widths[i], " ")).join(" │ ");
      const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
      const lines: string[] = [];
      lines.push(renderRow(cleaned[0]));
      lines.push(sep);
      for (let i = 1; i < cleaned.length; i++)
        lines.push(renderRow(cleaned[i]));
      return `${lead}${stash(`<pre>${escapeHtml(lines.join("\n"))}</pre>`)}\n`;
    },
  );

  // 2. Everything outside code is HTML-escaped now.
  text = escapeHtml(text);

  // 3. Inline-link conversion before emphasis so the URL never gets italicised.
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );

  // 4. Bold / italic / strike-through. Order matters — handle ** before *.
  text = text.replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^\n_]+)__/g, "<b>$1</b>");
  text = text.replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g, "$1<i>$2</i>");
  text = text.replace(/(^|[^_])_([^\n_]+)_(?!_)/g, "$1<i>$2</i>");
  text = text.replace(/~~([^\n~]+)~~/g, "<s>$1</s>");

  // 5. Headings (#, ##, ###) → bold line. Telegram has no real heading style.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");

  // 6. Bullet lists: turn "- " / "* " / "+ " into "• ".
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");

  // 7. Block quotes — Telegram supports <blockquote>.
  text = text.replace(
    /(^|\n)((?:&gt; .*(?:\n|$))+)/g,
    (_m, lead: string, block: string) => {
      const inner = block
        .split(/\n/)
        .filter((l) => l.length)
        .map((l) => l.replace(/^&gt; ?/, ""))
        .join("\n");
      return `${lead}<blockquote>${inner}</blockquote>\n`;
    },
  );

  // 8. Collapse trailing whitespace and excessive blank lines.
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 9. Restore the stashed code segments.
  text = text.replace(
    /\u0000PH(\d+)\u0000/g,
    (_m, idx: string) => placeholders[Number(idx)] ?? "",
  );

  return text;
}

/**
 * Split rendered HTML into chunks under Telegram's 4096-char per-message cap.
 * Splits on paragraph boundaries when possible, never inside a <pre>/<code>
 * block, falling back to hard slicing for pathological inputs.
 */
function splitForTelegram(html: string, max = 3800): string[] {
  if (html.length <= max) return [html];

  const chunks: string[] = [];
  const paragraphs = html.split(/\n\n+/);
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const p of paragraphs) {
    if (p.length > max) {
      flush();
      for (let i = 0; i < p.length; i += max) {
        chunks.push(p.slice(i, i + max));
      }
      continue;
    }
    if (current.length + p.length + 2 > max) {
      flush();
    }
    current += (current ? "\n\n" : "") + p;
  }
  flush();
  return chunks;
}

// ─── Inline-keyboard builders ────────────────────────────────────────────────

function buildSessionKeyboard(
  sessions: AgentSessionSummary[],
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [
    [{ text: "🆕  New session", callback_data: `${CB_SESSION}new` }],
  ];
  sessions.forEach((s, idx) => {
    const label = truncate(s.title || s.id, 48);
    rows.push([
      {
        text: `💬  ${label}  ·  ${s.turns}↻`,
        callback_data: `${CB_SESSION}${idx}`,
      },
    ]);
  });
  rows.push([{ text: "✕  Cancel", callback_data: CB_CANCEL }]);
  return rows;
}

function buildInstructionKeyboard(
  templates: TaskTemplate[],
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  templates.forEach((t, idx) => {
    const marker = t.isDefault ? "⭐" : "📝";
    rows.push([
      {
        text: `${marker}  ${truncate(t.heading, 50)}`,
        callback_data: `${CB_INSTRUCTION}${idx}`,
      },
    ]);
  });
  rows.push([
    { text: "⏭  Skip instructions", callback_data: `${CB_INSTRUCTION}skip` },
  ]);
  rows.push([{ text: "✕  Cancel", callback_data: CB_CANCEL }]);
  return rows;
}

function buildProjectKeyboard(
  groups: ProjectGroup[],
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  groups.forEach((g, idx) => {
    rows.push([
      {
        text: `📁  ${truncate(g.groupName, 50)}`,
        callback_data: `${CB_PROJECT}${idx}`,
      },
    ]);
  });
  rows.push([{ text: "⏭  Skip project", callback_data: `${CB_PROJECT}skip` }]);
  rows.push([{ text: "✕  Cancel", callback_data: CB_CANCEL }]);
  return rows;
}

// ─── Wizard step rendering ───────────────────────────────────────────────────

interface WizardCopy {
  readonly text: string;
  readonly keyboard: TelegramBot.InlineKeyboardButton[][];
}

function renderInstructionStep(state: PendingPromptState): WizardCopy {
  if (state.templates.length === 0) {
    return {
      text: [
        "*Step 1 of 3 · Task instructions*",
        "",
        "_No saved templates. Skip to continue._",
      ].join("\n"),
      keyboard: [
        [
          {
            text: "⏭  Skip instructions",
            callback_data: `${CB_INSTRUCTION}skip`,
          },
        ],
        [{ text: "✕  Cancel", callback_data: CB_CANCEL }],
      ],
    };
  }
  return {
    text: [
      "*Step 1 of 3 · Task instructions*",
      "",
      "Pick a saved template to prepend to your prompt, or skip.",
    ].join("\n"),
    keyboard: buildInstructionKeyboard(state.templates),
  };
}

function renderProjectStep(state: PendingPromptState): WizardCopy {
  const heading = state.chosenInstructionsHeading
    ? `✓ Instructions: *${state.chosenInstructionsHeading}*`
    : "✓ Instructions: _skipped_";

  if (state.groups.length === 0) {
    return {
      text: [
        "*Step 2 of 3 · Project*",
        heading,
        "",
        "_No projects yet. Skip to continue._",
      ].join("\n"),
      keyboard: [
        [{ text: "⏭  Skip project", callback_data: `${CB_PROJECT}skip` }],
        [{ text: "✕  Cancel", callback_data: CB_CANCEL }],
      ],
    };
  }
  return {
    text: [
      "*Step 2 of 3 · Project*",
      heading,
      "",
      "Pick a project for context, or skip.",
    ].join("\n"),
    keyboard: buildProjectKeyboard(state.groups),
  };
}

function renderPromptStep(state: PendingPromptState): WizardCopy {
  const lines = [
    "*Step 3 of 3 · Prompt*",
    state.chosenInstructionsHeading
      ? `✓ Instructions: *${state.chosenInstructionsHeading}*`
      : "✓ Instructions: _skipped_",
    state.chosenGroupName
      ? `✓ Project: *${state.chosenGroupName}*`
      : "✓ Project: _skipped_",
    "",
    "Send your prompt as the next message.",
  ];
  return {
    text: lines.join("\n"),
    keyboard: [[{ text: "✕  Cancel", callback_data: CB_CANCEL }]],
  };
}

async function showStep(
  logger: Logger,
  chatId: number,
  state: PendingPromptState,
): Promise<void> {
  if (!bot) return;
  const copy =
    state.phase === "selectInstruction"
      ? renderInstructionStep(state)
      : state.phase === "selectProject"
        ? renderProjectStep(state)
        : renderPromptStep(state);

  if (state.wizardMessageId == null) {
    const sent = await bot.sendMessage(chatId, copy.text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: copy.keyboard },
    });
    state.wizardMessageId = sent.message_id;
    return;
  }

  try {
    await bot.editMessageText(copy.text, {
      chat_id: chatId,
      message_id: state.wizardMessageId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: copy.keyboard },
    });
  } catch (err) {
    // Fall back to a fresh message if the previous one is no longer editable.
    logger.warn("Failed to edit wizard message; sending a new one", {
      error: (err as Error).message,
    });
    const sent = await bot.sendMessage(chatId, copy.text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: copy.keyboard },
    });
    state.wizardMessageId = sent.message_id;
  }
}

async function finishWizardMessage(
  chatId: number,
  state: PendingPromptState,
  finalText: string,
): Promise<void> {
  if (!bot || state.wizardMessageId == null) return;
  try {
    await bot.editMessageText(finalText, {
      chat_id: chatId,
      message_id: state.wizardMessageId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    /* ignore */
  }
}

// ─── Pickers / commands ──────────────────────────────────────────────────────

async function sendSessionPicker(
  logger: Logger,
  chatId: number,
  sessions: AgentSessionSummary[],
  verbose: boolean,
) {
  if (!bot) throw new Error("Bot not initialized");

  const verboseTag = verbose ? " · 🔍 _verbose_" : "";
  const text =
    sessions.length === 0
      ? `*OmniKey Agent*${verboseTag}\n\nNo previous sessions. Start a new one?`
      : `*OmniKey Agent*${verboseTag}\n\nResume a recent session or start fresh:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buildSessionKeyboard(sessions) },
  });
  logger.info("Sent /cmd session picker", {
    chatId,
    count: sessions.length,
    verbose,
  });
}

async function handleCmdCommand(
  logger: Logger,
  chatId: number,
  verbose: boolean,
) {
  pendingPrompts.delete(chatId);
  pendingVerbose.set(chatId, verbose);
  try {
    const sessions = await listRecentSessions(logger, 5);
    // Cache the session list so the callback can resolve by index.
    sessionListCache.set(chatId, sessions);
    await sendSessionPicker(logger, chatId, sessions, verbose);
  } catch (err) {
    logger.error("Failed to list recent sessions", {
      error: (err as Error).message,
    });
    await notify(
      logger,
      `❌ Failed to load sessions: ${(err as Error).message}`,
      { chatId },
    );
  }
}

// chatId -> last session list shown by /cmd, for index resolution
const sessionListCache = new Map<number, AgentSessionSummary[]>();

// chatId -> verbose flag captured at /cmd time, applied when the user picks
// a session (new or resume) so the flag survives the async picker step.
const pendingVerbose = new Map<number, boolean>();

async function handleTaskCommand(logger: Logger, chatId: number) {
  // 1. If a session is currently running for this chat, show last reasoning.
  const running = runningSessions.get(chatId);
  if (running) {
    const text = running.lastReasoning
      ? `🏃 *Running session* \`${running.sessionId}\`\n\n${truncate(running.lastReasoning, 3500)}`
      : `🏃 *Running session* \`${running.sessionId}\`\n\n_No reasoning emitted yet._`;
    await notify(logger, text, { chatId });
    return;
  }

  // 2. Otherwise show final answer from the most recent completed session.
  try {
    const sessions = await listRecentSessions(logger, 1);
    const session = sessions[0];
    if (!session) {
      await notify(logger, "🗒️ No sessions found.", { chatId });
      return;
    }
    const messages = await getSessionMessages(logger, session.id);
    let finalAnswer: string | null = null;
    if (messages) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== "assistant") continue;
        const block = msg.blocks?.find((b) => b.kind === "finalAnswer");
        if (block) { finalAnswer = block.text; break; }
      }
    }
    if (!finalAnswer) {
      await notify(
        logger,
        `🗒️ Most recent session \`${session.id}\` has no final answer yet.`,
        { chatId },
      );
      return;
    }
    const title = session.title || session.id;
    const html = markdownToTelegramHtml(finalAnswer);
    const header = `✅ <b>${escapeHtml(truncate(title, 80))}</b>\n\n`;
    const chunks = splitForTelegram(header + html);
    if (!bot) return;
    for (const chunk of chunks) {
      try {
        await bot.sendMessage(chatId, chunk, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } catch (err) {
        logger.warn("HTML render failed for /task; falling back to plain", {
          error: (err as Error).message,
        });
        await bot.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""));
      }
    }
  } catch (err) {
    logger.error("Failed to handle /task", { error: (err as Error).message });
    await notify(logger, `❌ /task failed: ${(err as Error).message}`, {
      chatId,
    });
  }
}

async function startNewSessionWizard(logger: Logger, chatId: number) {
  if (!bot) return;
  let templates: TaskTemplate[] = [];
  let groups: ProjectGroup[] = [];
  try {
    [templates, groups] = await Promise.all([
      listTaskTemplates(logger).catch((e) => {
        logger.warn("Failed to load task templates", {
          error: (e as Error).message,
        });
        return [] as TaskTemplate[];
      }),
      listProjectGroups(logger).catch((e) => {
        logger.warn("Failed to load project groups", {
          error: (e as Error).message,
        });
        return [] as ProjectGroup[];
      }),
    ]);
  } catch (err) {
    logger.error("Failed to load wizard data", {
      error: (err as Error).message,
    });
  }

  const state: PendingPromptState = {
    phase: "selectInstruction",
    sessionId: null,
    wizardMessageId: null,
    templates,
    groups,
    chosenInstructions: null,
    chosenInstructionsHeading: null,
    chosenGroupName: null,
    verbose: pendingVerbose.get(chatId) ?? false,
  };
  pendingPrompts.set(chatId, state);
  await showStep(logger, chatId, state);
}

async function startResumeSession(
  logger: Logger,
  chatId: number,
  sessionId: string,
) {
  if (!bot) return;
  const verbose = pendingVerbose.get(chatId) ?? false;
  const state: PendingPromptState = {
    phase: "awaitPrompt",
    sessionId,
    wizardMessageId: null,
    templates: [],
    groups: [],
    chosenInstructions: null,
    chosenInstructionsHeading: null,
    chosenGroupName: null,
    verbose,
  };
  pendingPrompts.set(chatId, state);
  await bot.sendMessage(
    chatId,
    [
      `*Resuming session* \`${sessionId}\`${verbose ? " · 🔍 _verbose_" : ""}`,
      "",
      "Send your prompt as the next message.",
    ].join("\n"),
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "✕  Cancel", callback_data: CB_CANCEL }]],
      },
    },
  );
}

async function handleCallbackQuery(
  logger: Logger,
  query: TelegramBot.CallbackQuery,
) {
  if (!bot) return;
  const data = query.data || "";
  const chatId = query.message?.chat.id;
  if (!chatId || !isAuthorizedChat(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: "Unauthorized" });
    return;
  }

  // Cancel from anywhere — clear state and acknowledge.
  if (data === CB_CANCEL) {
    const state = pendingPrompts.get(chatId);
    pendingPrompts.delete(chatId);
    sessionListCache.delete(chatId);
    pendingVerbose.delete(chatId);
    if (state?.wizardMessageId) {
      await finishWizardMessage(chatId, state, "✕  Cancelled.");
    }
    await bot.answerCallbackQuery(query.id, { text: "Cancelled" });
    return;
  }

  // Step 0 — session picker
  if (data.startsWith(CB_SESSION)) {
    const tok = data.slice(CB_SESSION.length);
    if (tok === "new") {
      await bot.answerCallbackQuery(query.id);
      await startNewSessionWizard(logger, chatId);
      return;
    }
    const idx = Number(tok);
    const sessions = sessionListCache.get(chatId) ?? [];
    const chosen = Number.isInteger(idx) ? sessions[idx] : undefined;
    if (!chosen) {
      await bot.answerCallbackQuery(query.id, {
        text: "Session no longer available",
      });
      return;
    }
    await bot.answerCallbackQuery(query.id);
    await startResumeSession(logger, chatId, chosen.id);
    return;
  }

  // Step 1 — instruction picker
  if (data.startsWith(CB_INSTRUCTION)) {
    const state = pendingPrompts.get(chatId);
    if (!state || state.phase !== "selectInstruction") {
      await bot.answerCallbackQuery(query.id, { text: "Step expired" });
      return;
    }
    const tok = data.slice(CB_INSTRUCTION.length);
    if (tok === "skip") {
      state.chosenInstructions = null;
      state.chosenInstructionsHeading = null;
    } else {
      const idx = Number(tok);
      const t = state.templates[idx];
      if (!t) {
        await bot.answerCallbackQuery(query.id, { text: "Template not found" });
        return;
      }
      // Don't prepend the body to the user prompt — instead promote this
      // template to the backend default so stored_instructions picks it up
      // automatically on every subsequent agent run.
      try {
        if (!t.isDefault) {
          await setDefaultTaskTemplate(logger, t.id);
        }
        state.chosenInstructions = null;
        state.chosenInstructionsHeading = t.heading;
      } catch (err) {
        logger.error("Failed to set default task template", {
          templateId: t.id,
          error: (err as Error).message,
        });
        await bot.answerCallbackQuery(query.id, {
          text: "Failed to set default",
        });
        return;
      }
    }
    state.phase = "selectProject";
    await bot.answerCallbackQuery(query.id);
    await showStep(logger, chatId, state);
    return;
  }

  // Step 2 — project picker
  if (data.startsWith(CB_PROJECT)) {
    const state = pendingPrompts.get(chatId);
    if (!state || state.phase !== "selectProject") {
      await bot.answerCallbackQuery(query.id, { text: "Step expired" });
      return;
    }
    const tok = data.slice(CB_PROJECT.length);
    if (tok === "skip") {
      state.chosenGroupName = null;
    } else {
      const idx = Number(tok);
      const g = state.groups[idx];
      if (!g) {
        await bot.answerCallbackQuery(query.id, { text: "Project not found" });
        return;
      }
      state.chosenGroupName = g.groupName;
    }
    state.phase = "awaitPrompt";
    await bot.answerCallbackQuery(query.id);
    await showStep(logger, chatId, state);
    return;
  }

  await bot.answerCallbackQuery(query.id);
}

async function runAgentForChat(
  logger: Logger,
  chatId: number,
  pending: PendingPromptState,
  prompt: string,
) {
  pendingPrompts.delete(chatId);

  if (runningSessions.has(chatId)) {
    await notify(
      logger,
      "⏳ A session is already running. Wait for it to finish.",
      { chatId },
    );
    return;
  }

  // Mark the wizard as resolved so the user sees a clean trail of choices.
  if (pending.wizardMessageId) {
    const summary = [
      "✅ *Session started*",
      pending.chosenInstructionsHeading
        ? `📝 Instructions: *${pending.chosenInstructionsHeading}*`
        : "📝 Instructions: _none_",
      pending.chosenGroupName
        ? `📁 Project: *${pending.chosenGroupName}*`
        : "📁 Project: _none_",
      pending.verbose ? "🔍 Verbose: *on*" : "",
    ]
      .filter(Boolean)
      .join("\n");
    await finishWizardMessage(chatId, pending, summary);
  }

  // The selected task template is already promoted to default on the
  // backend (see CB_INSTRUCTION handler), so the agent will pick it up via
  // stored_instructions on the server side. We send the user's prompt
  // verbatim — no preamble injection here.
  const composedPrompt = prompt;

  const placeholderId = pending.sessionId ?? "(new)";
  const abortController = new AbortController();
  const state: RunningSessionState = {
    sessionId: placeholderId,
    startedAt: Date.now(),
    lastReasoning: null,
    abortController,
    stoppedByUser: false,
  };
  runningSessions.set(chatId, state);

  await notify(logger, "🚀 Starting agent run… (send /stop to cancel)", {
    chatId,
  });

  const REASONING_MAX = 1200;
  let lastSent: string | null = null;

  const sendPlain = async (body: string) => {
    if (!bot) return;
    try {
      await bot.sendMessage(chatId, body);
    } catch (e) {
      logger.warn("Failed to forward block to telegram", {
        error: (e as Error).message,
      });
    }
  };

  const sendHtml = async (body: string) => {
    if (!bot) return;
    try {
      await bot.sendMessage(chatId, body, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (e) {
      // Fall back to plain text if Telegram rejects the HTML payload.
      logger.warn("HTML render failed; falling back to plain text", {
        error: (e as Error).message,
      });
      try {
        await bot.sendMessage(chatId, body.replace(/<[^>]+>/g, ""));
      } catch (e2) {
        logger.warn("Plain-text fallback also failed", {
          error: (e2 as Error).message,
        });
      }
    }
  };

  try {
    const result = await runAgentTurn(logger, {
      sessionId: pending.sessionId ?? undefined,
      prompt: composedPrompt,
      groupName: pending.chosenGroupName ?? undefined,
      signal: abortController.signal,
      onBlock: async (block) => {
        if (block.kind === "reasoning") {
          const cleaned = cleanForTelegram(block.text);
          if (!cleaned) return;
          state.lastReasoning = cleaned;
          if (cleaned === lastSent) return;
          lastSent = cleaned;
          const prefix = pending.verbose ? "💭 " : "";
          await sendPlain(prefix + truncate(cleaned, REASONING_MAX));
          return;
        }

        if (block.kind === "finalAnswer") {
          // finalAnswer — render markdown as Telegram HTML and split into
          // 4096-char-safe chunks so long answers are never truncated.
          const html = markdownToTelegramHtml(block.text);
          if (!html) return;
          lastSent = html;
          const chunks = splitForTelegram(html);
          for (const chunk of chunks) {
            await sendHtml(chunk);
          }
          return;
        }

        // Non-reasoning, non-final blocks (shell/web/mcp/image/terminal)
        // are only forwarded in verbose mode.
        if (!pending.verbose) return;

        const VERBOSE_MAX = 1500;
        switch (block.kind) {
          case "shellCommand": {
            const body = truncate(block.text.trim(), VERBOSE_MAX);
            await sendHtml(
              `🛠 <b>Shell command</b>\n<pre><code class="language-bash">${escapeHtml(body)}</code></pre>`,
            );
            return;
          }
          case "terminalOutput": {
            const body = truncate(block.text.trim(), VERBOSE_MAX);
            if (!body) return;
            await sendHtml(
              `📤 <b>Terminal output</b>\n<pre>${escapeHtml(body)}</pre>`,
            );
            return;
          }
          case "webCall": {
            const body = truncate(
              cleanForTelegram(block.text) || block.text,
              VERBOSE_MAX,
            );
            await sendHtml(`🌐 <b>Web call</b>\n${escapeHtml(body)}`);
            return;
          }
          case "mcpCall": {
            const body = truncate(
              cleanForTelegram(block.text) || block.text,
              VERBOSE_MAX,
            );
            await sendHtml(`🔌 <b>MCP call</b>\n${escapeHtml(body)}`);
            return;
          }
          case "imageRendering": {
            const body = truncate(
              cleanForTelegram(block.text) || block.text,
              VERBOSE_MAX,
            );
            await sendHtml(`🖼 <b>Image</b>\n${escapeHtml(body)}`);
            return;
          }
        }
      },
    });
    state.sessionId = result.sessionId;
    logger.info("Agent run completed", {
      chatId,
      sessionId: result.sessionId,
    });
  } catch (err) {
    if (err instanceof AgentAbortError || state.stoppedByUser) {
      logger.info("Agent run stopped by user", {
        chatId,
        sessionId: state.sessionId,
      });
      await notify(
        logger,
        `🛑 Agent run stopped by user (session \`${state.sessionId}\`).`,
        { chatId },
      );
    } else {
      logger.error("Agent run failed", { error: (err as Error).message });
      await notify(logger, `❌ Agent run failed: ${(err as Error).message}`, {
        chatId,
      });
    }
  } finally {
    runningSessions.delete(chatId);
    pendingVerbose.delete(chatId);
  }
}

async function handleStopCommand(logger: Logger, chatId: number) {
  const running = runningSessions.get(chatId);
  if (!running) {
    await notify(logger, "🛑 No agent session is currently running.", {
      chatId,
    });
    return;
  }
  if (running.abortController.signal.aborted) {
    await notify(logger, "⏳ Stop already requested — waiting for shutdown…", {
      chatId,
    });
    return;
  }
  running.stoppedByUser = true;
  running.abortController.abort();
  logger.info("User requested agent stop", {
    chatId,
    sessionId: running.sessionId,
  });
  await notify(
    logger,
    `🛑 Stop requested for session \`${running.sessionId}\`.`,
    { chatId },
  );
}

export function setupMessageListener(logger: Logger, bot: TelegramBot) {
  bot.on("callback_query", (q) => {
    void handleCallbackQuery(logger, q).catch((err) => {
      logger.error("callback_query handler crashed", {
        error: (err as Error).message,
      });
    });
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorizedChat(chatId)) {
      logger.warn("Received message from unauthorized chat ID:", chatId);
      return;
    }

    const text = (msg.text || "").trim();
    logger.info(`Received message from chat ID ${chatId}: ${text}`);

    const lower = text.toLowerCase();

    if (lower === "/cmd" || lower.startsWith("/cmd ")) {
      const args = text
        .slice("/cmd".length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const verbose = args.some(
        (a) => a === "--verbose" || a === "-v" || a === "--verbos",
      );
      await handleCmdCommand(logger, chatId, verbose);
      return;
    }

    if (lower === "/task") {
      await handleTaskCommand(logger, chatId);
      return;
    }

    if (lower === "/stop") {
      await handleStopCommand(logger, chatId);
      return;
    }

    // If we are awaiting a prompt for a /cmd selection, treat this message as the prompt.
    const pending = pendingPrompts.get(chatId);
    if (pending && text && !text.startsWith("/")) {
      if (pending.phase !== "awaitPrompt") {
        await notify(
          logger,
          "👉 Pick the remaining options on the wizard above first.",
          { chatId },
        );
        return;
      }
      if (pending.sessionId) {
        const messages = await getSessionMessages(logger, pending.sessionId);
        if (messages === null) {
          pendingPrompts.delete(chatId);
          await notify(logger, "❌ Selected session no longer exists.", {
            chatId,
          });
          return;
        }
      }
      await runAgentForChat(logger, chatId, pending, text);
      return;
    }

    logger.info("Ignoring unknown message");
  });
}
