import type { Logger } from 'winston';
import { config } from '../../config';
import { logger } from '../../logger';
import { AgentSession } from '../../models/agentSession';
import { Subscription } from '../../models/subscription';
import type { AITool, AICompletionResult } from '../../ai-client';
import { recordTokenUsage } from '../../usageRecorder';
import { getAgentSettings, selectedAgentModelForProvider } from '../../agentSettingsStore';
import { getAgentPrompt } from '../agentPrompts';
import { buildProjectContext, updateSessionGroup } from '../sessionGrouping';
import { getMcpToolsForSubscription } from '../mcpRuntime';
import { getPromptMcpsForSubscription } from '../mcpPromptCache';
import {
  buildAvailableTools,
  createUserContent,
  createUserContentForCronJob,
  pushToSessionHistory,
  sendFinalAnswer,
  SHELL_SCRIPT_TOOL,
  SHELL_SCRIPT_TOOL_LIMITED,
} from '../utils';
import type { AgentMessage, AgentSendFn } from '../types';
import type { AgentTurnOptions } from './serverTypes';
import {
  completeWithContextRecovery,
  OUTPUT_LENGTH_FAILURE_MESSAGE,
  recoverOutputLengthResult,
  removeInjectedUserPromptsFromHistory,
} from './completionRecovery';
import { getOrCreateSession, persistSessionToDB } from './sessionStore';
import { drainSteeringMessagesIntoHistory, sendSteeringAppliedNotice } from './steering';
import { buildShellToolResult } from './terminalOutput';
import { runToolLoop } from './toolLoop';

function hasTag(content: string, tag: string): boolean {
  return new RegExp(`<${tag}\\b`, 'i').test(content);
}

function normalizePlainTextFinalAnswer(content: string): string {
  return `<final_answer>\n${content}\n</final_answer>`;
}

async function runAgentTurnInternal(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: AgentSendFn,
  log: Logger,
  options?: AgentTurnOptions & { untaggedDepth?: number; webFallbackDepth?: number },
): Promise<void> {
  const {
    sessionState: session,
    hasStoredPrompt,
    contextExists,
    groupName,
  } = await getOrCreateSession(
    sessionId,
    subscription,
    clientMessage.platform,
    log,
    options?.isCronJob,
    clientMessage.group_name,
  );

  // Count this call as one agent iteration.
  session.turns += 1;
  const agentSettings = await getAgentSettings();
  const agentModel = selectedAgentModelForProvider(agentSettings, config.aiProvider);
  session.activeModel = agentModel;

  log.info('Starting agent turn', {
    sessionId,
    subscriptionId: subscription.id,
    turn: session.turns,
    contextExists,
    model: agentModel,
  });

  if (!clientMessage.is_web_call) {
    try {
      const installedMcps = await getPromptMcpsForSubscription(subscription.id, log);
      const systemPrompt = getAgentPrompt(
        clientMessage.platform,
        hasStoredPrompt,
        installedMcps,
        agentSettings,
      );
      const systemIndex = session.history.findIndex((message) => message.role === 'system');
      if (systemIndex >= 0) {
        session.history[systemIndex] = { ...session.history[systemIndex], content: systemPrompt };
      } else {
        session.history.unshift({ role: 'system', content: systemPrompt });
      }
    } catch (err) {
      log.warn('Failed to refresh agent system prompt with latest settings', { error: err });
    }
  }

  // Append the client message as user content, marking terminal
  // output and errors in the text so the agent can reason about them.
  let userContent = clientMessage.content || '';
  const isTerminalOutput = Boolean(clientMessage.is_terminal_output);
  const isErrorFlag = Boolean(clientMessage.is_error);

  if (isTerminalOutput || isErrorFlag) {
    userContent = buildShellToolResult(userContent, isErrorFlag, []);
  }

  const currentGroupName = clientMessage.group_name ?? groupName;

  // Prepend the <project_context> block whenever the client has a group
  // selected AND the session's persisted history does NOT already carry one.
  if (
    currentGroupName &&
    !isTerminalOutput &&
    !isErrorFlag &&
    !clientMessage.is_web_call &&
    !contextExists
  ) {
    try {
      // Pass the CURRENT turn's text as the only input so confidence can
      // compare the stored project root against any path the user just typed.
      const ctx = await buildProjectContext(
        subscription.id,
        currentGroupName,
        [clientMessage.content || ''],
        sessionId,
      );
      if (ctx?.text) {
        logger.info('Prepending <project_context> block to user content', {
          sessionId,
          groupName: currentGroupName,
          text: ctx.text,
        });
        userContent = `${ctx.text}\n\n${userContent}`;
      }
    } catch (err) {
      log.warn('Failed to build <project_context> block', { error: err });
    }
  }

  log.info('Agent turn received client message', {
    sessionId,
    isTerminalOutput,
    isError: isErrorFlag,
    rawContentLength: (clientMessage.content || '').length,
    userContentLength: userContent.length,
    isRecursiveCall: clientMessage.is_web_call,
  });

  const isAssistance = isTerminalOutput || isErrorFlag;

  if (!clientMessage?.is_web_call) {
    if (!isAssistance) {
      removeInjectedUserPromptsFromHistory(session, log);
    }

    // Terminal output and command errors are always user-role messages — they
    // represent environment feedback that the agent must reason about next.
    // Pushing them as assistant would create two consecutive assistant turns.
    pushToSessionHistory(logger, session, {
      role: 'user',
      content: isAssistance
        ? userContent
        : [
            `<user_input>`,
            !options?.isCronJob
              ? createUserContent(userContent, hasStoredPrompt)
              : createUserContentForCronJob(userContent),
            `</user_input>`,
          ].join('\n'),
    });
    session.lastModelPromptTokens = undefined;

    // Use the first real user message (turn 1) as the session title.
    if (session.turns === 1 && !isAssistance) {
      const rawInput = clientMessage.content || '';
      const titleSlug = rawInput.trim().slice(0, 60).replace(/\s+/g, ' ');
      if (titleSlug) {
        AgentSession.update({ title: titleSlug }, { where: { id: sessionId } }).catch((err) => {
          log.error('Failed to update agent session title', { sessionId, error: err });
        });
      }
    }

    // Durable checkpoint for interrupted turns.
    await persistSessionToDB(sessionId, session);
  }

  const mcpBundle = await getMcpToolsForSubscription(subscription.id, log);
  // All providers receive shell_script as a native function tool.
  const shellTool =
    agentSettings.terminalAccess === 'limited' ? SHELL_SCRIPT_TOOL_LIMITED : SHELL_SCRIPT_TOOL;
  const toolSettings = options?.disableWebTools
    ? { ...agentSettings, webSearchEnabled: false }
    : agentSettings;
  const shellTools: AITool[] = [shellTool];
  const tools = buildAvailableTools(toolSettings, [
    ...shellTools,
    ...mcpBundle.aiTools,
    ...(options?.extraTools ?? []),
  ]);

  const recordUsage = async (result: AICompletionResult) => {
    const usage = result.usage;
    if (!usage) return;
    session.lastModelPromptTokens = usage.prompt_tokens;

    // Update the cumulative per-session token counters in the DB. The
    // "context remaining" signal is refreshed from stored history in
    // persistSessionToDB so it stays accurate after pruning.
    try {
      await AgentSession.increment(
        {
          promptTokensUsed: usage.prompt_tokens,
          completionTokensUsed: usage.completion_tokens,
          totalTokensUsed: usage.total_tokens,
        },
        { where: { id: sessionId } },
      );
    } catch (err) {
      log.error('Failed to update agent session token usage', { sessionId, error: err });
    }

    await recordTokenUsage(
      log,
      subscription,
      usage,
      result.model,
      options?.isCronJob ? 'scheduled-agent' : 'agent',
      sessionId,
    );
  };

  const completeWithSteeringRecovery = async (): Promise<AICompletionResult> => {
    let current = await completeWithContextRecovery(
      session,
      sessionId,
      agentModel,
      {
        tools: tools?.length ? tools : undefined,
        temperature: 0.2,
      },
      log,
      recordUsage,
    );
    await recordUsage(current);

    for (;;) {
      const steeringMessageCount = drainSteeringMessagesIntoHistory(
        sessionId,
        session,
        hasStoredPrompt,
        log,
      );
      if (steeringMessageCount === 0) return current;

      await persistSessionToDB(sessionId, session);
      sendSteeringAppliedNotice(send, sessionId, steeringMessageCount);

      current = await completeWithContextRecovery(
        session,
        sessionId,
        agentModel,
        {
          tools: tools?.length ? tools : undefined,
          temperature: 0.2,
        },
        log,
        recordUsage,
      );
      await recordUsage(current);
    }
  };

  const restartAfterPendingSteering = async (): Promise<boolean> => {
    const steeringMessageCount = drainSteeringMessagesIntoHistory(
      sessionId,
      session,
      hasStoredPrompt,
      log,
    );
    if (steeringMessageCount === 0) return false;

    await persistSessionToDB(sessionId, session);
    sendSteeringAppliedNotice(send, sessionId, steeringMessageCount);

    await runAgentTurnInternal(
      sessionId,
      subscription,
      {
        sender: 'agent',
        session_id: sessionId,
        content: '',
        is_web_call: true,
      },
      send,
      logger,
      options,
    );
    return true;
  };

  try {
    log.debug('Calling AI provider for agent turn', {
      sessionId,
      provider: config.aiProvider,
      model: agentModel,
      turn: session.turns,
      historyLength: session.history.length,
    });

    let result = await completeWithSteeringRecovery();

    const recoveredInitialResult = await recoverOutputLengthResult(
      result,
      session,
      sessionId,
      agentModel,
      tools,
      log,
      recordUsage,
    );
    if (!recoveredInitialResult) {
      pushToSessionHistory(logger, session, {
        role: 'assistant',
        content: `<final_answer>\n${OUTPUT_LENGTH_FAILURE_MESSAGE}\n</final_answer>`,
      });
      await persistSessionToDB(sessionId, session);
      sendFinalAnswer(send, sessionId, OUTPUT_LENGTH_FAILURE_MESSAGE, true);
      return;
    }
    result = recoveredInitialResult;

    if (await restartAfterPendingSteering()) return;

    let content = result.content.trim();

    if (!content && result.finish_reason !== 'tool_calls') {
      log.warn('Agent LLM returned empty content; sending generic error to client.');

      const errorMessage = 'The agent returned an empty response. Please try again.';

      await persistSessionToDB(sessionId, session);
      sendFinalAnswer(send, sessionId, errorMessage, true);
      return;
    }

    if (result.finish_reason === 'tool_calls') {
      log.info('Running web tool calls to gather information', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
      });

      const toolLoopHistoryStart = session.history.length;
      let toolLoopResult = await runToolLoop(
        result,
        session,
        sessionId,
        agentModel,
        send,
        log,
        tools,
        mcpBundle.dispatch,
        recordUsage,
        Boolean(options?.isCronJob),
        hasStoredPrompt,
        options?.toolHandlers,
      );

      for (;;) {
        const recoveredToolLoopResult = await recoverOutputLengthResult(
          toolLoopResult,
          session,
          sessionId,
          agentModel,
          tools,
          log,
          recordUsage,
        );
        if (!recoveredToolLoopResult) {
          pushToSessionHistory(logger, session, {
            role: 'assistant',
            content: `<final_answer>\n${OUTPUT_LENGTH_FAILURE_MESSAGE}\n</final_answer>`,
          });
          await persistSessionToDB(sessionId, session);
          sendFinalAnswer(send, sessionId, OUTPUT_LENGTH_FAILURE_MESSAGE, true);
          return;
        }

        if (recoveredToolLoopResult.finish_reason === 'tool_calls') {
          log.info('Output-length recovery requested more tools; continuing tool loop', {
            sessionId,
          });
          toolLoopResult = await runToolLoop(
            recoveredToolLoopResult,
            session,
            sessionId,
            agentModel,
            send,
            log,
            tools,
            mcpBundle.dispatch,
            recordUsage,
            Boolean(options?.isCronJob),
            hasStoredPrompt,
            options?.toolHandlers,
          );
          continue;
        }

        const toolLoopContent = recoveredToolLoopResult.content.trim();
        const toolLoopHasFinal = hasTag(toolLoopContent, 'final_answer');
        const webToolFailed = session.history
          .slice(toolLoopHistoryStart)
          .some(
            (msg) =>
              msg.role === 'tool' &&
              (msg.tool_name === 'web_search' || msg.tool_name === 'web_fetch') &&
              typeof msg.content === 'string' &&
              msg.content.startsWith('Error'),
          );

        if (toolLoopHasFinal && (!webToolFailed || recoveredToolLoopResult.toolLoopStopped)) {
          // The tool loop produced a final answer, or hit its own hard stop. Use
          // hard-stop answers directly so web-failure recovery cannot bypass the
          // tool-iteration cap.
        log.info('Tool loop produced final answer; processing inline', { sessionId });
        content = toolLoopContent;
        result = recoveredToolLoopResult;
        break;
        }

        const webFallbackDepth = options?.webFallbackDepth ?? 0;
        if (webFallbackDepth >= 1) {
          const message = webToolFailed
            ? 'The web retrieval step failed repeatedly and the agent did not switch to terminal-based retrieval. The work so far has been saved; please ask it to continue using shell_script.'
            : 'The agent did not produce a structured response after the fallback retry. The work so far has been saved; please ask it to continue from the latest result.';
          log.warn('Tool-loop fallback already attempted; stopping recursive recovery', {
            sessionId,
            webFallbackDepth,
            webToolFailed,
          });
          await persistSessionToDB(sessionId, session);
          sendFinalAnswer(send, sessionId, message, true);
          return;
        }

        // The tool loop returned plain text, or a final answer after a web tool
        // failed. Make one more AI turn so the model can correct itself and use
        // shell_script as the fallback.
        if (recoveredToolLoopResult.assistantMessage?.content?.trim()) {
          pushToSessionHistory(logger, session, {
            role: 'assistant',
            content: recoveredToolLoopResult.assistantMessage.content,
          });
        }

        pushToSessionHistory(logger, session, {
          role: 'user',
          content: webToolFailed
            ? [
                'IMPORTANT: The web search tool failed and is unavailable. Do NOT attempt any further web calls or ask the user to run commands manually.',
                'You MUST retrieve any needed data by calling the shell_script tool to run terminal commands (curl, grep, cat, etc.).',
                'The shell script output will be returned to you automatically.',
                '',
                'Respond with exactly one of:',
                '- a shell_script tool call — to fetch or retrieve data via terminal commands',
                '- <final_answer>...</final_answer> — only if you already have enough information',
                'No plain text. No web tool calls. No other format.',
              ].join('\n')
            : [
                'Web research is complete. The results are in the conversation above.',
                '',
                'Now respond with exactly one of:',
                '- a shell_script tool call — to run terminal commands (output will be returned to you automatically)',
                '- <final_answer>...</final_answer> — only if you genuinely have enough information',
                'No plain text. No other format.',
              ].join('\n'),
        });

        await persistSessionToDB(sessionId, session);

        return await runAgentTurnInternal(
          sessionId,
          subscription,
          {
            sender: 'agent',
            session_id: sessionId,
            content: '',
            is_web_call: true,
          },
          send,
          logger,
          {
            ...options,
            disableWebTools: webToolFailed || options?.disableWebTools,
            webFallbackDepth: webFallbackDepth + 1,
          },
        );
      }
    }

    if (content && !hasTag(content, 'final_answer') && !hasTag(content, 'shell_script')) {
      log.info('Agent returned plain text; treating it as a final answer', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
      });
      content = normalizePlainTextFinalAnswer(content);
      result = {
        ...result,
        content,
        assistantMessage: {
          ...result.assistantMessage,
          content,
        },
      };
    }

    if (await restartAfterPendingSteering()) return;

    const hasFinalAnswerTag = hasTag(content, 'final_answer');

    if (hasFinalAnswerTag) {
      log.info('Finalizing agent session after final answer tag', {
        sessionId,
        subscriptionId: subscription.id,
        turns: session.turns,
        hasFinalAnswerTag,
      });

      pushToSessionHistory(logger, session, { role: 'assistant', content });
      await persistSessionToDB(sessionId, session);
      if (await restartAfterPendingSteering()) return;

      send({
        session_id: sessionId,
        sender: 'agent',
        content: hasFinalAnswerTag ? content : `<final_answer>\n${content}\n</final_answer>`,
      });

      if (!options?.skipGrouping && !session.groupName && !session.groupLocked) {
        void updateSessionGroup(sessionId, subscription.id).then(async () => {
          try {
            const refreshed = await AgentSession.findOne({
              where: { id: sessionId, subscriptionId: subscription.id },
              attributes: ['groupName'],
            });
            if (refreshed?.groupName) {
              session.groupName = refreshed.groupName;
            }
          } catch (err) {
            log.warn('Failed to read back groupName after classification', { error: err });
          }
        });
      } else {
        log.info('Skipping session group classification — group already assigned', {
          sessionId,
          groupName: session.groupName,
        });
      }
    } else if (content) {
      const untaggedDepth = options?.untaggedDepth ?? 0;

      // Safety valve: after two consecutive format-correction attempts the
      // model is clearly stuck. Abort rather than loop indefinitely.
      if (untaggedDepth >= 2) {
        log.warn('Agent stuck in untagged response loop; aborting after max retries', {
          sessionId,
          untaggedDepth,
        });
        await persistSessionToDB(sessionId, session);
        sendFinalAnswer(
          send,
          sessionId,
          'The agent failed to produce a structured response after multiple attempts. Please try again.',
          true,
        );
        return;
      }

      log.info('Agent returned untagged content; injecting format-correction directive', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
        untaggedDepth,
      });

      pushToSessionHistory(logger, session, { role: 'assistant', content });
      pushToSessionHistory(logger, session, {
        role: 'user',
        content: [
          'Your response was plain text, which is not a valid format.',
          'You MUST respond with exactly one of:',
          '- a shell_script tool call — to run terminal commands',
          '- <final_answer>...</final_answer> — to conclude',
          'Respond immediately. No reasoning, no explanation.',
        ].join('\n'),
      });
      await persistSessionToDB(sessionId, session);
      return await runAgentTurnInternal(
        sessionId,
        subscription,
        {
          sender: 'agent',
          session_id: sessionId,
          content: '',
          is_web_call: true,
        },
        send,
        logger,
        { ...options, untaggedDepth: untaggedDepth + 1 },
      );
    } else {
      log.warn('Agent returned empty content with no recognized tags; sending error', {
        sessionId,
      });
      await persistSessionToDB(sessionId, session);
      sendFinalAnswer(
        send,
        sessionId,
        'The agent returned an empty response. Please try again.',
        true,
      );
    }
  } catch (err) {
    log.error('Agent LLM call failed', {
      error: {
        message: err instanceof Error ? err.message : String(err),
        status: (err as any).status,
        type: (err as any).error?.type ?? (err as any).type,
        code: (err as any).code,
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined,
      },
    });
    const errorMessage = 'Agent failed to call language model. Please try again later.';
    await persistSessionToDB(sessionId, session);
    sendFinalAnswer(send, sessionId, errorMessage, true);
  }
}

export async function runAgentTurn(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: AgentSendFn,
  log: Logger,
  options?: AgentTurnOptions,
): Promise<void> {
  // untaggedDepth always starts at 0 for external callers; it is only threaded
  // through the internal recursive path.
  return runAgentTurnInternal(sessionId, subscription, clientMessage, send, log, options);
}
