import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import cuid from 'cuid';
import { aiClient, AITool } from '../ai-client';
import { logger } from '../logger';

type ImageFormat = 'png' | 'webp' | 'jpeg';
type ImageSize = '1024x1024' | '1024x1536' | '1536x1024';
type ImageQuality = 'low' | 'medium' | 'high';
type ImageBackground = 'transparent' | 'opaque' | 'auto';

const ALLOWED_FORMATS: ReadonlySet<string> = new Set(['png', 'webp', 'jpeg']);
const ALLOWED_SIZES: ReadonlySet<string> = new Set(['1024x1024', '1024x1536', '1536x1024']);
const ALLOWED_QUALITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const ALLOWED_BACKGROUNDS: ReadonlySet<string> = new Set(['transparent', 'opaque', 'auto']);

export const IMAGE_GENERATE_TOOL: AITool = {
  name: 'generate_image',
  description:
    'Generate an image from a prompt and save it to disk. Use this when the user asks you to create artwork, mockups, logos, diagrams, or visual assets.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed image prompt describing what to generate.',
      },
      file_path: {
        type: 'string',
        description:
          'Absolute or relative output path where the image should be saved. If omitted, a temp file path is used automatically.',
      },
      format: {
        type: 'string',
        enum: ['png', 'webp', 'jpeg'],
        description: 'Output image format. Defaults to png.',
      },
      size: {
        type: 'string',
        enum: ['1024x1024', '1024x1536', '1536x1024'],
        description: 'Image dimensions. Defaults to 1024x1024.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Generation quality. Defaults to medium.',
      },
      background: {
        type: 'string',
        enum: ['transparent', 'opaque', 'auto'],
        description: 'Background behavior. Defaults to auto.',
      },
    },
    required: ['prompt'],
  },
};

/**
 * Reads a string argument from a tool-call payload and trims surrounding whitespace.
 *
 * @param args - Raw tool-call argument object.
 * @param key - Argument key to read.
 * @returns A trimmed string value, or `undefined` when missing/non-string/empty.
 */
function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

/**
 * Resolves the final output path for the generated image.
 *
 * When `filePathArg` is provided, relative paths are resolved from the
 * backend process working directory. Otherwise, a temp-file path is generated.
 *
 * @param filePathArg - Optional caller-provided output path.
 * @param format - File format to use when generating a temp filename.
 * @returns Absolute path where the image should be written.
 */
function resolveOutputPath(filePathArg: string | undefined, format: ImageFormat): string {
  if (filePathArg) {
    return path.isAbsolute(filePathArg) ? filePathArg : path.resolve(process.cwd(), filePathArg);
  }
  return path.join(os.tmpdir(), `omnikey-generated-${cuid()}.${format}`);
}

/**
 * Converts a MIME type to the internal file-format enum.
 *
 * @param mimeType - MIME type returned by the provider (e.g. image/png).
 * @param fallback - Format used when MIME type is missing or unknown.
 * @returns Normalized image format used for file extension selection.
 */
function formatFromMime(mimeType: string | undefined, fallback: ImageFormat): ImageFormat {
  if (!mimeType) return fallback;
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpeg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

/**
 * Writes generated image bytes to disk, creating parent directories as needed.
 *
 * @param outputPath - Absolute path to write to.
 * @param imageBuffer - Binary image contents.
 */
async function writeImageFile(outputPath: string, imageBuffer: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, imageBuffer);
}

/**
 * Executes the `generate_image` tool call.
 *
 * Validates and normalizes user arguments, requests image generation through
 * the configured AI provider in `aiClient`, writes the image to disk, and
 * returns a user-facing status message containing the saved path.
 *
 * @param args - Tool arguments supplied by the model.
 * @param log - Structured logger scoped to the current agent turn.
 * @returns Success or error message for the tool result block.
 */
export async function executeImageGenerationTool(
  args: Record<string, unknown>,
  log: typeof logger,
): Promise<string> {
  const prompt = readStringArg(args, 'prompt');
  if (!prompt) {
    return 'Error: prompt parameter is required.';
  }

  const rawFormat = readStringArg(args, 'format') ?? 'png';
  const format: ImageFormat = (ALLOWED_FORMATS.has(rawFormat) ? rawFormat : 'png') as ImageFormat;

  const rawSize = readStringArg(args, 'size') ?? '1024x1024';
  const size: ImageSize = (ALLOWED_SIZES.has(rawSize) ? rawSize : '1024x1024') as ImageSize;

  const rawQuality = readStringArg(args, 'quality') ?? 'medium';
  const quality: ImageQuality = (
    ALLOWED_QUALITIES.has(rawQuality) ? rawQuality : 'medium'
  ) as ImageQuality;

  const rawBackground = readStringArg(args, 'background') ?? 'auto';
  const background: ImageBackground = (
    ALLOWED_BACKGROUNDS.has(rawBackground) ? rawBackground : 'auto'
  ) as ImageBackground;
  const filePathArg = readStringArg(args, 'file_path');

  try {
    const generated = await aiClient.generateImage({
      prompt,
      format,
      size,
      quality,
      background,
    });

    const actualFormat = formatFromMime(generated.mimeType, format);
    const outputPath = resolveOutputPath(filePathArg, actualFormat);
    await writeImageFile(outputPath, Buffer.from(generated.imageBase64, 'base64'));

    log.info('Image generated and saved', {
      provider: generated.provider,
      outputPath,
      bytes: Buffer.byteLength(generated.imageBase64, 'base64'),
      size,
      quality,
      format: actualFormat,
    });

    return [
      `Image generated successfully with ${generated.provider}. Saved to: ${outputPath}`,
      generated.note ? `Note: ${generated.note}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('generate_image tool failed', { error: message, provider: aiClient.getProvider() });
    return `Error generating image: ${message}`;
  }
}
