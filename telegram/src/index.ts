import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { randomUUID } from "crypto";
import winston from "winston";
import { z } from "zod";
import { initTelegram, notify, setupMessageListener } from "./notifyTelegram";
import { closeDb, initDb } from "./db";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  defaultMeta: { conId: randomUUID() },
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaString = Object.keys(meta).length ? JSON.stringify(meta) : "";
      const date = new Date(timestamp as string).toLocaleString();
      return `[${date}] ${level}: ${message} ${metaString}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 6666;

try {
  initDb(logger);
} catch (e) {
  logger.error("Failed to open omnikey SQLite database:", e);
}

const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (botToken) {
  try {
    const bot = initTelegram(botToken);
    logger.info("Telegram bot initialized", {
      botTokenSet: !!botToken,
      bot: !!bot,
    });

    setupMessageListener(logger, bot);
  } catch (e) {
    logger.error("Failed to init telegram:", e);
  }
}

app.use(express.json());

const sendBodySchema = z.object({
  message: z.string().min(1, "message must not be empty"),
  parseMode: z.enum(["Markdown", "MarkdownV2", "HTML"]).optional(),
});

app.get("/", (req, res) => {
  res.send("Telegram bot service (TypeScript)");
});

app.post("/telegram/send", async (req, res) => {
  logger.defaultMeta = { conId: "sending notification" };
  const parsed = sendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn("Invalid /telegram/send body", {
      issues: parsed.error.issues,
    });
    return res.status(400).json({
      message: "Invalid request body",
      issues: parsed.error.issues,
    });
  }

  const { message, parseMode } = parsed.data;
  try {
    await notify(logger, message, { parseMode });
    return res.json({
      message: "Message sent",
      parseMode: parseMode ?? "Markdown",
    });
  } catch (e) {
    logger.error("Failed to send message:", e);
    const description =
      (e as { response?: { body?: { description?: string } } })?.response?.body
        ?.description ?? (e as Error).message;
    return res.status(502).json({
      message: "Failed to deliver message to Telegram",
      error: description,
    });
  }
});

app.listen(port, () => {
  logger.info(`Server listening on http://localhost:${port}`);
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT. Exiting...");
  closeDb(logger);
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM. Exiting...");
  closeDb(logger);
  process.exit(0);
});
