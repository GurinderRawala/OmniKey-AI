import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import winston from 'winston';
import util from 'util';
import { EnhanceCommand } from './types';
import { readTaskPrompt } from './read-task-prompt';

dotenv.config();

const app = express();
const PORT = 7172;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.metadata({ fillExcept: ['timestamp', 'level', 'message'] }),
    winston.format.printf((info) => {
      const { level, message, timestamp, metadata } = info as {
        level: string;
        message: string;
        timestamp: string;
        metadata?: unknown;
      };

      const isLocal = process.env.LOCAL === 'true';

      let metaString = '';
      if (
        metadata &&
        (typeof metadata === 'object' ? Object.keys(metadata as object).length > 0 : true)
      ) {
        if (isLocal) {
          metaString = `\n${util.inspect(metadata, { colors: true, depth: null, breakLength: 80 })}`;
        } else {
          metaString = ` ${JSON.stringify(metadata)}`;
        }
      }

      const base = `${timestamp} [${level}] ${message}`;
      return isLocal
        ? winston.format.colorize().colorize(level, `${base}${metaString}`)
        : `${base}${metaString}`;
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

function parseImprovedTextResponse(response: string): string {
  const match = response.match(/<improved_text>([\s\S]*?)<\/improved_text>/);
  if (match && match[1]) {
    return match[1].trim();
  }
  logger.warn(
    'LLM response did not contain expected <improved_text> tags; returning raw response.',
  );
  return response.trim();
}

const enhancePromptSystemInstruction = `
You are a prompt-writer for an AI coding assistant.

Your only job is to rewrite rough user text (often a messy or informal prompt) into a clear, concise, and "LLM-friendly" prompt for a coding assistant.

<rules>
- Do NOT answer the user's question or solve the task.
- Do NOT write or modify any code beyond what the user already provided.
- Do NOT remove, shorten, or skip any user-provided requirements, notes, or examples.
- Preserve the original intent, constraints, and level of detail; only improve wording and structure.
</rules>

<code_handling>
- Treat anything that appears to be code as literal content that must be preserved.
- For any text inside Markdown code fences ( \`\`\` ... \`\`\` ), copy it exactly as-is:
  - Do not change identifiers, logic, comments, or formatting except for trivial whitespace needed for validity.
  - Do not remove or add lines of code.
- If the user includes inline code snippets (e.g., within quotes or surrounded by backticks), keep them unchanged.
</code_handling>

<rewriting_guidelines>
- Start by clearly stating the overall goal of the task.
- Organize the instructions into short bullet points or numbered steps when it helps clarity.
- Fix grammar, spelling, and punctuation; use a neutral, professional, and concise tone.
- Make the prompt explicitly address the AI assistant and specify the desired output format if relevant.
- Call out important requirements, constraints, and edge cases so the AI can follow them precisely.
- If the user text already contains a well-structured prompt, only make minimal edits for clarity and correctness.
</rewriting_guidelines>

<behavior_constraints>
- If the user asks for an answer (e.g., "solve this bug", "write this function"), you must keep that request as part of the improved prompt, not fulfill it.
- Do not introduce new requirements, features, or examples that were not present in the original text.
- Do not explain what you changed or why.
</behavior_constraints>

<output_format>
Return ONLY the improved prompt, wrapped in the following XML tags:

<improved_text>
...final prompt here...
</improved_text>

Do not include any other commentary, explanations, or XML outside of <improved_text>...</improved_text>.
</output_format>
`;

const grammarPromptSystemInstruction = `
You are a writing assistant that rewrites user text to improve grammar, spelling, punctuation, and clarity while preserving the original meaning, intent, and tone.

<rules>
- Do NOT answer the user's questions or perform tasks.
- Do NOT introduce new ideas, facts, or arguments that are not present in the original text.
- Preserve the user's original intent, message, and tone as much as possible.
- Make minimal, necessary edits to improve correctness and readability.
</rules>

<rewriting_guidelines>
- Correct grammatical errors, spelling mistakes, and punctuation.
- Improve sentence structure and flow so it reads naturally, like a fluent human writer.
- Keep the original style (formal or informal, friendly or professional) unless it is clearly inconsistent.
- Make the text suitable as a direct reply or as documentation that can be sent or published as-is.
- Where the original is unclear, gently clarify wording without adding new facts or changing the meaning.
- Do not significantly shorten or lengthen the text unless necessary for clarity.
</rewriting_guidelines>

<behavior_constraints>
- Do not change the underlying meaning of any sentence.
- Do not remove important qualifiers, caveats, or constraints.
- Do not add examples, analogies, or explanations that were not in the original.
- Do not comment on the quality of the text or describe your changes.
</behavior_constraints>

<output_format>
Return ONLY the corrected, polished version of the text, wrapped in the following XML tags:

<improved_text>
...final text here...
</improved_text>

Do not include any other commentary, explanations, or XML outside of <improved_text>...</improved_text>.
</output_format>
`;

const prompts: Record<EnhanceCommand, string> = {
  enhance: enhancePromptSystemInstruction,
  grammar: grammarPromptSystemInstruction,
  task: readTaskPrompt(logger),
};

async function enhanceText(text: string, cmd: EnhanceCommand): Promise<string> {
  const trimmed = text.trim();

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY is not set; returning original text with marker.');
    return trimmed;
  }

  try {
    const systemPrompt = prompts[cmd];

    if (!systemPrompt) {
      logger.error(`No system prompt found for command: ${cmd}`);
      return trimmed;
    }

    const completion = await openai.chat.completions.create({
      model: cmd === 'task' ? 'gpt-5.1' : 'gpt-4.1-mini',
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

    logger.info(`LLM response received for command "${cmd}", length: ${enhanced.length}`);

    return parseImprovedTextResponse(enhanced);
  } catch (err) {
    logger.error(`Error calling OpenAI: ${err instanceof Error ? err.message : String(err)}`);
    return trimmed;
  }
}

async function handleEnhance(cmd: EnhanceCommand, req: Request, res: Response) {
  const body = req.body as EnhanceRequestBody;
  logger.info(
    `Received request for command "${cmd}" with text length: ${body.text ? body.text.length : 0}`,
  );

  if (!body || typeof body.text !== 'string' || body.text.trim() === '') {
    logger.warn('Enhance request missing or empty "text" field.');
    return res.status(400).json({ error: 'Missing or empty "text" field in request body.' });
  }

  const result = await enhanceText(body.text, cmd);

  return res.json({ result });
}

// Main endpoint used by the macOS app
app.post('/api/enhance', handleEnhance.bind(null, 'enhance'));

// Alias endpoint in case the client uses /api/enhancer
app.post('/api/enhancer', handleEnhance.bind(null, 'enhance'));

app.post('/api/grammar', handleEnhance.bind(null, 'grammar'));

app.post('/api/custom-task', handleEnhance.bind(null, 'task'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const server = app.listen(PORT, () => {
  logger.info(`Enhancer API listening on http://localhost:${PORT}`);
});

function gracefulShutdown(signal: NodeJS.Signals) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  server.close((err) => {
    if (err) {
      logger.error('Error during HTTP server shutdown.', { error: err });
      process.exitCode = 1;
      return;
    }

    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
