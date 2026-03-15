"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readTaskPrompt = readTaskPrompt;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Function first reads custom_task.md and if file not found, it will read custom_task.txt. If both files are missing, it returns an empty string.
 * @param logger
 * @returns {string} The content of the custom task file or an empty string if none found.
 */
function readTaskPrompt(logger) {
    const mdFilePath = path_1.default.resolve(process.cwd(), 'custom_task.md');
    // Try reading custom_task.md first
    if (fs_1.default.existsSync(mdFilePath)) {
        try {
            const prompt = fs_1.default.readFileSync(mdFilePath, 'utf-8');
            return prompt;
        }
        catch (err) {
            logger.error(`Failed to read custom_task.md: ${err}`);
        }
    }
    const txtFilePath = path_1.default.resolve(process.cwd(), 'custom_task.txt');
    // If custom_task.md is not found or unreadable, try custom_task.txt
    if (fs_1.default.existsSync(txtFilePath)) {
        try {
            const prompt = fs_1.default.readFileSync(txtFilePath, 'utf-8');
            return prompt;
        }
        catch (err) {
            logger.error(`Failed to read custom_task.txt: ${err}`);
        }
    }
    // If neither file is found, return an empty string
    logger.warn('No custom task file found. Returning empty prompt.');
    return '';
}
