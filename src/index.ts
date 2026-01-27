import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import winston from 'winston';

dotenv.config();

const app = express();
const PORT = 7172;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `${timestamp} [${level}] ${message}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

interface EnhanceRequestBody {
  text?: string;
}

async function enhanceText(text: string): Promise<string> {
  const trimmed = text.trim();

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY is not set; returning original text with marker.');
    return trimmed;
  }

  try {
    const systemPrompt = `
You are a prompt-writer for an AI coding assistant.

Given some rough user text (often a messy or informal prompt), rewrite it into a clear, concise, and "LLM-friendly" prompt.

Follow these rules:
- Start by clearly stating the overall goal of the task.
- Organize the instructions into short bullet points or numbered steps when it helps clarity.
- Fix grammar, spelling, and punctuation; use a neutral, professional, and concise tone.
- Make the prompt explicitly address the AI assistant and specify the desired output format if relevant.
- Call out important requirements, constraints, and edge cases so the AI can follow them precisely.
- If there are code blocks:
  - Preserve language and structure.
  - Keep placeholders consistent and descriptive.
- Do not go for answering the prompt yourself; focus on improving the prompt only. 
- Do not omit any details from the original text; ensure all user requirements are included.
- Do not add extra commentary about what you changed; just return the final improved prompt text that the user can send directly to an AI coding assistant.
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.3,
    });

    const enhanced = completion.choices[0]?.message?.content?.trim();

    if (!enhanced) {
      logger.warn('LLM returned empty content; falling back to original text.');
      return trimmed;
    }

    return enhanced;
  } catch (err) {
    logger.error(`Error calling OpenAI: ${err instanceof Error ? err.message : String(err)}`);
    return trimmed;
  }
}

async function handleEnhance(req: Request, res: Response) {
  const body = req.body as EnhanceRequestBody;
  logger.info(`Received enhance request: ${JSON.stringify(body)}`);

  if (!body || typeof body.text !== 'string' || body.text.trim() === '') {
    logger.warn('Enhance request missing or empty "text" field.');
    return res.status(400).json({ error: 'Missing or empty "text" field in request body.' });
  }

  const result = await enhanceText(body.text);

  return res.json({ result });
}

// Main endpoint used by the macOS app
app.post('/api/enhance', handleEnhance);

// Alias endpoint in case the client uses /api/enhancer
app.post('/api/enhancer', handleEnhance);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  logger.info(`Enhancer API listening on http://localhost:${PORT}`);
});
