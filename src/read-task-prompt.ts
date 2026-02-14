import fs from 'fs';
import path from 'path';
import { Logger } from 'winston';

/**
 * Function first reads custom_task.md and if file not found, it will read custom_task.txt. If both files are missing, it returns an empty string.
 * @param logger
 * @returns {string} The content of the custom task file or an empty string if none found.
 */
export function readTaskPrompt(logger: Logger): string {
  const mdFilePath = path.resolve(process.cwd(), 'custom_task.md');

  // Try reading custom_task.md first
  if (fs.existsSync(mdFilePath)) {
    try {
      const prompt = fs.readFileSync(mdFilePath, 'utf-8');
      return prompt;
    } catch (err) {
      logger.error(`Failed to read custom_task.md: ${err}`);
    }
  }

  const txtFilePath = path.resolve(process.cwd(), 'custom_task.txt');
  // If custom_task.md is not found or unreadable, try custom_task.txt
  if (fs.existsSync(txtFilePath)) {
    try {
      const prompt = fs.readFileSync(txtFilePath, 'utf-8');
      return prompt;
    } catch (err) {
      logger.error(`Failed to read custom_task.txt: ${err}`);
    }
  }

  // If neither file is found, return an empty string
  logger.warn('No custom task file found. Returning empty prompt.');
  return '';
}
