"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachAgentWebSocketServer = attachAgentWebSocketServer;
const ws_1 = __importStar(require("ws"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const openai_1 = __importDefault(require("openai"));
const cuid_1 = __importDefault(require("cuid"));
const config_1 = require("./config");
const logger_1 = require("./logger");
const subscription_1 = require("./models/subscription");
const subscriptionUsage_1 = require("./models/subscriptionUsage");
const agentPrompts_1 = require("./agentPrompts");
const featureRoutes_1 = require("./featureRoutes");
const authMiddleware_1 = require("./authMiddleware");
const openai = new openai_1.default({
    apiKey: config_1.config.openaiApiKey,
});
const sessionMessages = new Map();
const MAX_TURNS = 10;
async function getOrCreateSession(sessionId, subscription, log) {
    const existing = sessionMessages.get(sessionId);
    if (existing) {
        log.debug('Reusing existing agent session', {
            sessionId,
            subscriptionId: existing.subscription.id,
            turns: existing.turns,
        });
        return existing;
    }
    // use these instructions as user instructions
    const prompt = await (0, featureRoutes_1.getPromptForCommand)(log, 'task', subscription).catch((err) => {
        log.error('Failed to get system prompt for new agent session', { error: err });
        return '';
    });
    const entry = {
        subscription,
        history: [
            {
                role: 'system',
                content: agentPrompts_1.AGENT_SYSTEM_PROMPT,
            },
            ...(prompt
                ? [
                    {
                        role: 'assistant',
                        content: `<user_configured_instructions>
# User-Configured Task Instructions
${prompt}
</user_configured_instructions>`,
                    },
                ]
                : []),
        ],
        turns: 0,
    };
    sessionMessages.set(sessionId, entry);
    log.info('Created new agent session', {
        sessionId,
        subscriptionId: subscription.id,
        hasCustomPrompt: Boolean(prompt),
    });
    return entry;
}
async function authenticateFromAuthHeader(authHeader, log) {
    if (config_1.config.isSelfHosted) {
        log.info('Self-hosted mode: skipping JWT authentication for agent WebSocket connection.');
        try {
            const subscription = await (0, authMiddleware_1.selfHostedSubscription)();
            log.info('Retrieved self-hosted subscription for agent WebSocket connection', {
                subscriptionId: subscription.id,
            });
            return subscription;
        }
        catch (err) {
            log.error('Failed to retrieve self-hosted subscription for agent WebSocket connection', {
                error: err,
            });
            return null;
        }
    }
    if (!config_1.config.jwtSecret) {
        log.error('JWT secret is not configured. Cannot authenticate subscription from auth header.');
        return null;
    }
    if (!authHeader) {
        log.warn('Agent WebSocket connection missing authorization header');
        return null;
    }
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
        log.warn('Agent WebSocket connection has malformed authorization header');
        return null;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwtSecret);
        const subscription = await subscription_1.Subscription.findByPk(decoded.sid);
        if (!subscription) {
            log.warn('Agent WebSocket auth failed: subscription not found', {
                sid: decoded.sid,
            });
            return null;
        }
        if (subscription.subscriptionStatus === 'expired') {
            log.warn('Agent WebSocket auth failed: subscription expired', {
                sid: decoded.sid,
            });
            return null;
        }
        const now = new Date();
        if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
            subscription.subscriptionStatus = 'expired';
            await subscription.save();
            log.info('Agent WebSocket auth: subscription key expired during connection', {
                subscriptionId: subscription.id,
            });
            return null;
        }
        log.debug('Agent WebSocket auth succeeded', {
            subscriptionId: subscription.id,
            status: subscription.subscriptionStatus,
        });
        return subscription;
    }
    catch (err) {
        log.warn('Agent WebSocket auth failed: invalid or expired JWT', { error: err });
        return null;
    }
}
async function runAgentTurn(sessionId, subscription, clientMessage, send, log) {
    const session = await getOrCreateSession(sessionId, subscription, log);
    // Count this call as one agent iteration.
    session.turns += 1;
    log.info('Starting agent turn', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
    });
    // On the MAX_TURNS iteration, instruct the LLM to provide a final,
    // consolidated answer based on the full conversation context.
    if (session.turns === MAX_TURNS) {
        session.history.push({
            role: 'system',
            content: 'Provide a single, final, concise answer based on the entire conversation so far. Wrap the answer in a <final_answer>...</final_answer> block and do not ask for further input or mention additional shell scripts to run. Do not include any <shell_script> block in this response.',
        });
    }
    // Append the client message as user content, marking terminal
    // output and errors in the text so the agent can reason about them.
    let userContent = clientMessage.content || '';
    const isTerminalOutput = Boolean(clientMessage.is_terminal_output);
    const isErrorFlag = Boolean(clientMessage.is_error);
    if (isTerminalOutput) {
        userContent = `TERMINAL OUTPUT:\n${userContent}`;
    }
    if (isErrorFlag) {
        userContent = `COMMAND ERROR:\n${userContent}`;
    }
    log.info('Agent turn received client message', {
        sessionId,
        isTerminalOutput,
        isError: isErrorFlag,
        rawContentLength: (clientMessage.content || '').length,
        userContentLength: userContent.length,
    });
    session.history.push({
        role: 'user',
        content: userContent,
    });
    if (!config_1.config.openaiApiKey) {
        log.warn('OPENAI_API_KEY is not set; returning error to client.');
        const errorMessage = 'The server is missing its OpenAI API key. Please configure OPENAI_API_KEY on the backend and try again.';
        send({
            session_id: sessionId,
            sender: 'agent',
            content: `<final_answer>\n${errorMessage}\n</final_answer>`,
            is_terminal_output: false,
            is_error: true,
        });
        // Clear any cached session state so a subsequent attempt can
        // start fresh once the environment is correctly configured.
        sessionMessages.delete(sessionId);
        return;
    }
    try {
        log.debug('Calling OpenAI for agent turn', {
            sessionId,
            turn: session.turns,
            historyLength: session.history.length,
        });
        const completion = await openai.chat.completions.create({
            model: 'gpt-5.1',
            // The OpenAI client accepts a superset of this simple
            // message shape; we safely cast here to keep our local
            // types minimal.
            messages: session.history,
            temperature: 0.2,
        });
        // Record token usage for this subscription and model, if usage
        // data is available and we know which subscription made the call.
        const usage = completion.usage;
        if (usage && subscription.id) {
            try {
                await subscriptionUsage_1.SubscriptionUsage.create({
                    subscriptionId: subscription.id,
                    model: completion.model ?? 'gpt-5.1',
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
                log.error('Failed to record subscription usage metrics for agent.', {
                    error: err,
                    subscriptionId: subscription.id,
                });
            }
        }
        const choice = completion.choices[0];
        const content = (choice.message.content ?? '').toString().trim();
        if (!content) {
            log.warn('Agent LLM returned empty content; sending generic error to client.');
            const errorMessage = 'The agent returned an empty response. Please try again.';
            sendFinalAnswer(send, sessionId, errorMessage, true);
            // Clear any cached session state so a subsequent attempt can
            // start fresh without a polluted history.
            sessionMessages.delete(sessionId);
            return;
        }
        // Ensure that a proper <final_answer> block is produced for the
        // desktop clients once we reach the final turn. If the model did
        // not emit either a <shell_script> or <final_answer> tag on the
        // MAX_TURNS turn, we treat this as the final natural-language answer
        // and wrap it in <final_answer> tags so the client can stop
        // waiting and paste the result.
        const hasShellScriptTag = content.includes('<shell_script>');
        const hasFinalAnswerTag = content.includes('<final_answer>');
        log.info('Agent LLM raw response summary', {
            sessionId,
            turn: session.turns,
            rawContentLength: content.length,
            hasShellScriptTag,
            hasFinalAnswerTag,
        });
        const normalizedContent = !hasShellScriptTag && !hasFinalAnswerTag && session.turns >= MAX_TURNS
            ? `<final_answer>\n${content}\n</final_answer>`
            : content;
        log.info('Agent LLM normalized response summary', {
            sessionId,
            turn: session.turns,
            normalizedContentLength: normalizedContent.length,
        });
        // Record assistant message back into history for future turns.
        session.history.push({
            role: 'assistant',
            content: normalizedContent,
        });
        send({
            session_id: sessionId,
            sender: 'agent',
            content: normalizedContent,
            is_terminal_output: false,
            is_error: false,
        });
        // After the MAX_TURNS iteration or if a final answer tag is present, treat this as the final answer
        // and clear the session from memory while marking it completed.
        if (session.turns >= MAX_TURNS || hasFinalAnswerTag) {
            log.info('Finalizing agent session after max turns or final answer tag', {
                sessionId,
                subscriptionId: subscription.id,
                turns: session.turns,
                hasFinalAnswerTag,
            });
            sessionMessages.delete(sessionId);
        }
        log.info('Completed agent turn', {
            sessionId,
            subscriptionId: subscription.id,
            turn: session.turns,
            responseLength: normalizedContent.length,
        });
    }
    catch (err) {
        log.error('Agent LLM call failed', { error: err });
        const errorMessage = 'Agent failed to call language model. Please try again later.';
        sendFinalAnswer(send, sessionId, errorMessage, true);
        // Clear any cached session state so a subsequent attempt can
        // start fresh without being polluted by a failed turn.
        sessionMessages.delete(sessionId);
    }
}
function sendFinalAnswer(send, sessionId, message, isError) {
    send({
        session_id: sessionId,
        sender: 'agent',
        content: `<final_answer>\n${message}\n</final_answer>`,
        is_terminal_output: false,
        is_error: isError,
    });
}
function createLazyAuthContext(authHeader, log) {
    let authenticatedSubscription = null;
    let authFailed = false;
    let authPromise = null;
    const ensureAuthenticated = async () => {
        if (authenticatedSubscription) {
            return true;
        }
        if (authFailed) {
            return false;
        }
        if (!authPromise) {
            authPromise = (async () => {
                try {
                    const sub = await authenticateFromAuthHeader(authHeader, log);
                    if (!sub) {
                        authFailed = true;
                        return;
                    }
                    authenticatedSubscription = sub;
                    log.info('Agent WebSocket authenticated', {
                        subscriptionId: authenticatedSubscription.id,
                    });
                }
                catch (err) {
                    authFailed = true;
                    log.error('Unexpected error during agent WebSocket auth', { error: err });
                }
            })();
        }
        await authPromise;
        return Boolean(authenticatedSubscription);
    };
    const getSubscription = () => authenticatedSubscription;
    return { ensureAuthenticated, getSubscription };
}
function attachAgentWebSocketServer(server) {
    const wss = new ws_1.WebSocketServer({ server, path: '/ws/omni-agent' });
    wss.on('connection', (ws, req) => {
        const traceId = (0, cuid_1.default)();
        const log = logger_1.logger.child({ traceId });
        log.info('Agent WebSocket connection opened');
        const authHeaderValue = req.headers['authorization'];
        const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;
        const { ensureAuthenticated, getSubscription } = createLazyAuthContext(authHeader, log);
        const send = (msg) => {
            try {
                ws.send(JSON.stringify(msg));
            }
            catch (err) {
                log.error('Failed to write AgentMessage to WebSocket', { error: err });
            }
        };
        ws.on('message', (data) => {
            void (async () => {
                const ok = await ensureAuthenticated();
                const subscription = getSubscription();
                if (!ok || !subscription) {
                    if (ws.readyState === ws_1.default.OPEN) {
                        log.warn('Closing Agent WebSocket due to failed authentication');
                        send({
                            session_id: '',
                            sender: 'agent',
                            content: 'Unauthorized: missing or invalid subscription. Please re-activate your key.',
                            is_terminal_output: false,
                            is_error: true,
                        });
                        ws.close();
                    }
                    return;
                }
                let message;
                try {
                    const text = typeof data === 'string' ? data : data.toString('utf8');
                    log.info('Agent WebSocket received message from client', {
                        approximateLength: text.length,
                    });
                    message = JSON.parse(text);
                }
                catch (err) {
                    log.warn('Received invalid AgentMessage payload over WebSocket', { error: err });
                    return;
                }
                const sessionId = message.session_id || 'default';
                log.debug('Received AgentMessage from client (WebSocket)', {
                    sessionId,
                    sender: message.sender,
                    isTerminalOutput: message.is_terminal_output,
                    isError: message.is_error,
                });
                void runAgentTurn(sessionId, subscription, message, send, log);
            })();
        });
        ws.on('error', (err) => {
            log.warn('Agent WebSocket error', { error: err });
        });
        ws.on('close', () => {
            log.info('Agent WebSocket connection closed', {
                hadAuthenticatedSubscription: Boolean(getSubscription()),
            });
        });
    });
    logger_1.logger.info('Agent WebSocket server attached at path /ws/omni-agent');
    return wss;
}
