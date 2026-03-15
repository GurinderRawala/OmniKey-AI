"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPromptForCommand = getPromptForCommand;
exports.runEnhancementModel = runEnhancementModel;
exports.createFeatureRouter = createFeatureRouter;
const express_1 = __importDefault(require("express"));
const openai_1 = __importDefault(require("openai"));
const zod_1 = __importDefault(require("zod"));
const types_1 = require("./types");
const prompts_1 = require("./prompts");
const config_1 = require("./config");
const authMiddleware_1 = require("./authMiddleware");
const subscription_1 = require("./models/subscription");
const subscriptionUsage_1 = require("./models/subscriptionUsage");
const compression_1 = require("./compression");
const subscriptionTaskTemplate_1 = require("./models/subscriptionTaskTemplate");
function parseImprovedTextResponse(logger, response) {
    const match = response.match(/<improved_text>([\s\S]*?)<\/improved_text>/);
    if (match && match[1]) {
        return match[1].trim();
    }
    logger.warn('LLM response did not contain expected <improved_text> tags; returning raw response.');
    return response.trim();
}
const openai = new openai_1.default({
    apiKey: config_1.config.openaiApiKey,
});
const enhanceRequestSchema = zod_1.default.object({
    text: zod_1.default.string(),
});
async function getPromptForCommand(logger, cmd, subscription) {
    if (cmd === 'enhance') {
        return prompts_1.enhancePromptSystemInstruction;
    }
    if (cmd === 'grammar') {
        return prompts_1.grammarPromptSystemInstruction;
    }
    try {
        const template = await subscriptionTaskTemplate_1.SubscriptionTaskTemplate.findOne({
            where: { subscriptionId: subscription.id, isDefault: true },
            order: [['createdAt', 'ASC']],
        });
        if (template) {
            const decompressed = (0, compression_1.decompressString)(template.instructions);
            if (decompressed) {
                return decompressed;
            }
        }
    }
    catch (err) {
        logger.error('Error loading subscription task template; falling back to legacy instructions.', {
            error: err,
            subscriptionId: subscription.id,
        });
    }
    return '';
}
function getModelForCommand(cmd) {
    return cmd === 'task' ? 'gpt-5.1' : 'gpt-4o-mini';
}
function createMessagesParams(cmd, input, prompt) {
    if (cmd === 'task') {
        return [
            {
                role: 'system',
                content: [prompts_1.taskPromptSystemInstruction, prompts_1.OUTPUT_FORMAT_INSTRUCTION].join('\n'),
            },
            {
                role: 'user',
                content: `<user_configured_instructions>
# User-Configured Task Instructions
${prompt}
</user_configured_instructions>
<current_input>
# Current user input for this execution
${input}
</current_input>`,
            },
        ];
    }
    return [
        {
            role: 'system',
            content: [prompt, prompts_1.OUTPUT_FORMAT_INSTRUCTION].join('\n'),
        },
        {
            role: 'user',
            content: input,
        },
    ];
}
async function runEnhancementModel(logger, text, cmd, subscription, onDelta) {
    const trimmed = text.trim();
    if (!config_1.config.openaiApiKey) {
        logger.warn('OPENAI_API_KEY is not set; returning null from runEnhancementModel.');
        return new types_1.OmniKeyError('OpenAI API key is not configured.', 500);
    }
    const prompt = await getPromptForCommand(logger, cmd, subscription);
    if (!prompt) {
        logger.error(`No system prompt found for command: ${cmd}`);
        return new types_1.OmniKeyError(`No system prompt found for command: ${cmd}`, 404);
    }
    const model = getModelForCommand(cmd);
    const stream = await openai.chat.completions.create({
        model,
        messages: createMessagesParams(cmd, trimmed, prompt),
        temperature: 0.3,
        stream: true,
        stream_options: { include_usage: true },
    });
    let rawResponse = '';
    let usage;
    for await (const part of stream) {
        const delta = part.choices?.[0]?.delta?.content ?? '';
        if (delta) {
            rawResponse += delta;
            if (onDelta) {
                onDelta(delta);
            }
        }
        if (part.usage) {
            usage = part.usage;
        }
    }
    return { rawResponse, usage, model };
}
async function enhanceText(logger, text, cmd, subscription) {
    const trimmed = text.trim();
    try {
        const result = await runEnhancementModel(logger, trimmed, cmd, subscription);
        if (!result || result instanceof types_1.OmniKeyError) {
            return result instanceof types_1.OmniKeyError ? result : new types_1.OmniKeyError('Unknown error', 500);
        }
        const { rawResponse, usage, model } = result;
        // Record token usage for this subscription and model, if usage
        // data is available and we know which subscription made the call.
        if (usage && subscription.id) {
            try {
                await subscriptionUsage_1.SubscriptionUsage.create({
                    subscriptionId: subscription.id,
                    model,
                    promptTokens: usage.prompt_tokens ?? 0,
                    completionTokens: usage.completion_tokens ?? 0,
                    totalTokens: usage.total_tokens ?? 0,
                });
                await subscription_1.Subscription.increment('totalTokensUsed', {
                    by: usage.total_tokens ?? 0,
                    where: { id: subscription.id },
                });
            }
            catch (err) {
                logger.error('Failed to record subscription usage metrics.', {
                    error: err,
                    subscriptionId: subscription.id,
                });
            }
        }
        const enhanced = rawResponse.trim();
        if (!enhanced) {
            logger.warn('LLM returned empty content; falling back to original text.');
            return trimmed;
        }
        logger.info(`LLM response received for command "${cmd}", length: ${enhanced.length}`);
        return parseImprovedTextResponse(logger, enhanced);
    }
    catch (err) {
        logger.error(`Error calling OpenAI: ${err instanceof Error ? err.message : String(err)}`);
        return trimmed;
    }
}
async function streamEnhanceResponse(res, text, cmd) {
    const { logger, subscription } = res.locals;
    const trimmed = text.trim();
    let headersSent = false;
    const ensureHeadersSent = () => {
        if (!headersSent) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.flushHeaders?.();
            headersSent = true;
        }
    };
    try {
        const result = await runEnhancementModel(logger, trimmed, cmd, subscription, (delta) => {
            if (!delta)
                return;
            ensureHeadersSent();
            res.write(delta);
        });
        if (result instanceof types_1.OmniKeyError) {
            logger.error('Error during streaming enhancement model execution.', {
                error: result,
                command: cmd,
            });
            if (!headersSent) {
                res.status(result.statusCode ?? 500).json({ error: result.message });
            }
            else {
                try {
                    res.end();
                }
                catch {
                    // ignore secondary errors when ending stream
                }
            }
            return;
        }
        if (!result) {
            // Fall back to returning the original text once.
            ensureHeadersSent();
            res.write(trimmed);
            res.end();
            return;
        }
        const { usage, model } = result;
        if (usage && subscription.id) {
            try {
                await subscriptionUsage_1.SubscriptionUsage.create({
                    subscriptionId: subscription.id,
                    model,
                    promptTokens: usage.prompt_tokens ?? 0,
                    completionTokens: usage.completion_tokens ?? 0,
                    totalTokens: usage.total_tokens ?? 0,
                });
                await subscription_1.Subscription.increment('totalTokensUsed', {
                    by: usage.total_tokens ?? 0,
                    where: { id: subscription.id },
                });
            }
            catch (err) {
                logger.error('Failed to record subscription usage metrics during stream.', {
                    error: err,
                    subscriptionId: subscription.id,
                });
            }
        }
        if (!headersSent) {
            ensureHeadersSent();
        }
        res.end();
    }
    catch (err) {
        logger.error('Error streaming enhance response.', {
            error: err,
            command: cmd,
        });
        try {
            if (!headersSent) {
                res.status(500).json({ error: 'Internal server error.' });
            }
            else {
                res.end();
            }
        }
        catch {
            // ignore secondary errors when ending stream
        }
    }
}
function makeEnhanceHandler(cmd) {
    return async (req, res) => {
        const { logger, subscription } = res.locals;
        try {
            const body = enhanceRequestSchema.parse(req.body);
            const wantsStream = req.header('x-omnikey-stream') === 'true';
            if (wantsStream) {
                await streamEnhanceResponse(res, body.text, cmd);
                return;
            }
            const result = await enhanceText(logger, body.text, cmd, subscription);
            if (result instanceof types_1.OmniKeyError) {
                logger.error('Error during enhanceText execution.', {
                    error: result,
                    command: cmd,
                });
                return res.status(result.statusCode ?? 500).json({ error: result.message });
            }
            return res.json({ result });
        }
        catch (err) {
            logger.error('Error processing enhance request.', { error: err });
            return res.status(500).json({ error: 'Internal server error.' });
        }
    };
}
function createFeatureRouter() {
    const router = express_1.default.Router();
    // Main endpoints used by the macOS app
    router.post('/enhance', authMiddleware_1.authMiddleware, makeEnhanceHandler('enhance'));
    router.post('/grammar', authMiddleware_1.authMiddleware, makeEnhanceHandler('grammar'));
    router.post('/custom-task', authMiddleware_1.authMiddleware, makeEnhanceHandler('task'));
    return router;
}
