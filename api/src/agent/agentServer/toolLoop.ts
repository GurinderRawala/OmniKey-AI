import type { Logger } from 'winston';
import { logger } from '../../logger';
import { runScript } from '../../shellRunner';
import { executeTool } from '../../web-search/web-search-provider';
import { executeImageGenerationTool } from '../imageTool';
import { executeMcpTool, MCP_TOOL_PREFIX } from '../mcpRuntime';
import { pushToSessionHistory } from '../utils';
import type { AgentSendFn, SessionState } from '../types';
import type { AITool, AICompletionResult } from '../../ai-client';
import type { CustomToolHandler } from './serverTypes';
import { pendingShellScripts } from './runtimeState';
import { persistSessionToDB } from './sessionStore';
import {
  consumeSteeringRestart,
  drainSteeringMessagesIntoHistory,
  sendSteeringAppliedNotice,
  STEERING_RESTART_LIMIT_MESSAGE,
  type SteeringRestartBudget,
} from './steering';
import { buildShellToolResult, collectShellOutputFilterKeywords } from './terminalOutput';
import { completeWithContextRecovery } from './completionRecovery';
import { extractProgressSummary } from './progressSummary';

export { extractProgressSummary } from './progressSummary';

const MAX_TOOL_CALLS_PER_ITERATION = 8;

function isWebTool(name: string): boolean {
  return name === 'web_search' || name === 'web_fetch';
}

export function isToolFailureResult(result: string): boolean {
  const trimmed = result.trimStart();
  if (/^(error\b|command error:|command failed:)/i.test(trimmed)) return true;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      parsed.ok === false ||
      parsed.success === false ||
      (typeof parsed.error === 'string' && parsed.error.trim().length > 0)
    );
  } catch {
    return false;
  }
}

export function imageActivityResult(toolResult: string): {
  content: string;
  isError: boolean;
  phase: 'completed' | 'failed';
} {
  const isError = isToolFailureResult(toolResult);
  return {
    content: isError ? toolResult : `Image saved to: ${toolResult}`,
    isError,
    phase: isError ? 'failed' : 'completed',
  };
}

function toolLoopLimitResult(model: string, message: string): AICompletionResult {
  const content = `<final_answer>\n${message}\n</final_answer>`;
  return {
    content,
    finish_reason: 'stop',
    model,
    toolLoopStopped: true,
    assistantMessage: { role: 'assistant', content },
  };
}

function webToolFailureInterruptResult(model: string): AICompletionResult {
  return {
    content: '',
    finish_reason: 'stop',
    model,
    assistantMessage: { role: 'assistant', content: '' },
  };
}

export async function runToolLoop(
  initialResult: AICompletionResult,
  session: SessionState,
  sessionId: string,
  model: string,
  send: AgentSendFn,
  log: Logger,
  tools: AITool[],
  mcpDispatch: Map<string, { serverId: string; mcpToolName: string }>,
  onUsage: (result: AICompletionResult) => Promise<void>,
  isCronJob: boolean,
  hasStoredPrompt: boolean,
  steeringRestartBudget: SteeringRestartBudget,
  toolHandlers?: Map<string, CustomToolHandler>,
): Promise<AICompletionResult> {
  // Tools the model is allowed to invoke on this turn. Built from the same
  // list we hand to the AI client, so flipping WEB_SEARCH_ENABLED (or any
  // future capability toggle) actually disables the tool at the execution
  // boundary, not just at registration.
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  let toolIterations = 0;
  let result = initialResult;

  while (result.finish_reason === 'tool_calls') {
    toolIterations++;

    const preToolSteeringMessages = drainSteeringMessagesIntoHistory(
      sessionId,
      session,
      hasStoredPrompt,
      log,
    );
    if (preToolSteeringMessages.length > 0) {
      await persistSessionToDB(sessionId, session);
      if (
        !consumeSteeringRestart(
          steeringRestartBudget,
          sessionId,
          log,
          'before executing stale tool calls',
        )
      ) {
        return toolLoopLimitResult(model, STEERING_RESTART_LIMIT_MESSAGE);
      }

      sendSteeringAppliedNotice(send, sessionId, preToolSteeringMessages);
      result = await completeWithContextRecovery(
        session,
        sessionId,
        model,
        {
          tools: tools.length ? tools : undefined,
          temperature: 0.2,
        },
        log,
        onUsage,
      );
      await onUsage(result);
      continue;
    }

    const toolCalls = result.tool_calls ?? [];

    // If the model claims tool_calls but sent none, treat it as a normal text
    // response — pushing an assistant message with no following tool results
    // would leave the history ending with an assistant turn, causing a 400.
    if (!toolCalls.length) break;

    if (toolCalls.length > MAX_TOOL_CALLS_PER_ITERATION) {
      log.warn('Agent requested too many parallel tool calls; stopping turn', {
        sessionId,
        requestedToolCalls: toolCalls.length,
        maxToolCallsPerIteration: MAX_TOOL_CALLS_PER_ITERATION,
        tools: toolCalls.map((tc) => tc.name),
      });
      return toolLoopLimitResult(
        model,
        `The agent requested ${toolCalls.length} tool calls at once, which exceeds the per-step limit of ${MAX_TOOL_CALLS_PER_ITERATION}. The work so far has been saved; please ask it to continue in smaller steps.`,
      );
    }

    const progressSummary = extractProgressSummary(result.content ?? '');
    if (progressSummary && !isCronJob) {
      send({
        session_id: sessionId,
        sender: 'agent',
        content: progressSummary,
        is_terminal_output: false,
        is_error: false,
      });
    }

    pushToSessionHistory(logger, session, result.assistantMessage);
    log.info('Agent executing tool calls', {
      sessionId,
      turn: session.turns,
      toolIteration: toolIterations,
      tools: toolCalls.map((tc) => tc.name),
    });

    const executeOneToolCall = async (
      tc: NonNullable<AICompletionResult['tool_calls']>[number],
    ): Promise<{ id: string; name: string; result: string }> => {
      const args = tc.arguments as Record<string, unknown>;

      // If the tool is not in the per-turn allowed list (e.g. the user
      // disabled web search via Settings -> Agent Access, or the model
      // hallucinated a tool name), refuse the call instead of forwarding it.
      if (!allowedToolNames.has(tc.name)) {
        log.warn('Refusing tool call: tool is not enabled for this session', {
          sessionId,
          tool: tc.name,
          allowed: Array.from(allowedToolNames),
        });
        send({
          session_id: sessionId,
          sender: 'agent',
          content: `Tool: ${tc.name}\n\nError: Tool "${tc.name}" is not enabled for this session.`,
          is_terminal_output: false,
          is_error: true,
          activity_id: tc.id,
          activity_phase: 'failed',
        });
        return {
          id: tc.id,
          name: tc.name,
          result:
            `Error: Tool "${tc.name}" is not enabled for this session. ` +
            `Available tools: ${Array.from(allowedToolNames).join(', ') || '(none)'}.`,
        };
      }

      if (tc.name.startsWith(MCP_TOOL_PREFIX)) {
        send({
          session_id: sessionId,
          sender: 'agent',
          content: `Calling MCP tool: ${tc.name}`,
          is_terminal_output: false,
          is_error: false,
          is_web_call: false,
          is_mcp_call: true,
          activity_id: tc.id,
          activity_phase: 'started',
        });
        const toolResult = await executeMcpTool(tc.name, args, mcpDispatch, log);
        log.info('Tool call completed', {
          sessionId,
          tool: tc.name,
          resultLength: toolResult.length,
        });
        send({
          session_id: sessionId,
          sender: 'agent',
          content: `Tool: ${tc.name}\n\n${toolResult}`,
          is_terminal_output: false,
          is_error: isToolFailureResult(toolResult),
          is_mcp_call: true,
          activity_id: tc.id,
          activity_phase: isToolFailureResult(toolResult) ? 'failed' : 'completed',
        });
        return { id: tc.id, name: tc.name, result: toolResult };
      }

      // Injected server-side tools (e.g. the session-grouping cron's
      // assign_session_groups). Intercept BEFORE the web/executeTool path so
      // a custom tool name is never mistaken for a web tool.
      if (toolHandlers?.has(tc.name)) {
        send({
          session_id: sessionId,
          sender: 'agent',
          content: `Running ${tc.name}`,
          is_terminal_output: false,
          is_error: false,
        });
        const toolResult = await toolHandlers.get(tc.name)!(args, log);
        log.info('Custom tool call completed', {
          sessionId,
          tool: tc.name,
          resultLength: toolResult.length,
        });
        return { id: tc.id, name: tc.name, result: toolResult };
      }

      if (tc.name === 'generate_image') {
        const prompt = typeof args.prompt === 'string' ? args.prompt : '';
        send({
          session_id: sessionId,
          sender: 'agent',
          content: `Generating image: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
          is_terminal_output: false,
          is_error: false,
          is_web_call: false,
          is_image_rendering: true,
          activity_id: tc.id,
          activity_phase: 'started',
        });

        const toolResult = await executeImageGenerationTool(args, log);
        const imageResult = imageActivityResult(toolResult);
        log.info('Tool call completed', {
          sessionId,
          tool: tc.name,
          resultLength: toolResult.length,
        });

        send({
          session_id: sessionId,
          sender: 'agent',
          content: imageResult.content,
          is_terminal_output: false,
          is_error: imageResult.isError,
          is_web_call: false,
          is_image_rendering: true,
          activity_id: tc.id,
          activity_phase: imageResult.phase,
        });

        return { id: tc.id, name: tc.name, result: toolResult };
      }

      // shell_script is a real tool. For interactive sessions we send the
      // script to the frontend and suspend until the WebSocket handler
      // resolves the pending promise with the terminal output. Cron jobs run
      // server-side -- there is no frontend -- so we execute the script here
      // and feed the output straight back as the tool result.
      if (tc.name === 'shell_script') {
        const script = typeof args.script === 'string' ? args.script : '';
        const filterKeywords = collectShellOutputFilterKeywords(args, script);

        if (isCronJob) {
          log.info('Cron job: executing shell_script tool server-side', {
            sessionId,
            toolIteration: toolIterations,
            scriptLength: script.length,
            filterKeywords,
          });
          const { output, isError } = await runScript(script);
          const result = buildShellToolResult(output, isError, filterKeywords);
          log.info('Cron job: shell_script finished', {
            sessionId,
            isError,
            outputLength: output.length,
            resultLength: result.length,
          });
          return { id: tc.id, name: tc.name, result };
        }

        log.info('Agent invoking shell_script tool; forwarding to frontend', {
          sessionId,
          toolIteration: toolIterations,
          scriptLength: script.length,
          filterKeywords,
        });
        send({
          session_id: sessionId,
          sender: 'agent',
          content: `<shell_script>\n${script}\n</shell_script>`,
          is_terminal_output: false,
          is_error: false,
          activity_id: tc.id,
          activity_phase: 'started',
        });
        const terminalOutput = await new Promise<string>((resolve) => {
          pendingShellScripts.set(sessionId, { resolve, filterKeywords });
        });
        return { id: tc.id, name: tc.name, result: terminalOutput };
      }

      // Notify the frontend that a web tool call is about to execute.
      const webCallContent =
        tc.name === 'web_search'
          ? `Searching the web for: "${String(args.query ?? '')}"`
          : `Fetching URL: ${String(args.url ?? '')}`;
      send({
        session_id: sessionId,
        sender: 'agent',
        content: webCallContent,
        is_terminal_output: false,
        is_error: false,
        is_web_call: true,
        activity_id: tc.id,
        activity_phase: 'started',
      });

      const toolResult = await executeTool(tc.name, args as Record<string, string>, log);
      log.info('Tool call completed', {
        sessionId,
        tool: tc.name,
        resultLength: toolResult.length,
      });
      send({
        session_id: sessionId,
        sender: 'agent',
        content: `Tool: ${tc.name}\n\n${toolResult}`,
        is_terminal_output: false,
        is_error: isToolFailureResult(toolResult),
        is_web_call: true,
        activity_id: tc.id,
        activity_phase: isToolFailureResult(toolResult) ? 'failed' : 'completed',
      });
      return { id: tc.id, name: tc.name, result: toolResult };
    };

    const toolResults = new Array<{ id: string; name: string; result: string }>(toolCalls.length);
    let callIndex = 0;
    while (callIndex < toolCalls.length) {
      const tc = toolCalls[callIndex];
      if (tc.name === 'shell_script') {
        toolResults[callIndex] = await executeOneToolCall(tc);
        callIndex++;
        continue;
      }

      const batchStart = callIndex;
      const batch: typeof toolCalls = [];
      while (callIndex < toolCalls.length && toolCalls[callIndex].name !== 'shell_script') {
        batch.push(toolCalls[callIndex]);
        callIndex++;
      }
      const batchResults = await Promise.all(batch.map(executeOneToolCall));
      batchResults.forEach((toolResult, offset) => {
        toolResults[batchStart + offset] = toolResult;
      });
    }

    for (const { id, name, result: toolResult } of toolResults) {
      pushToSessionHistory(logger, session, {
        role: 'tool',
        tool_call_id: id,
        tool_name: name,
        content: toolResult,
      });
    }

    // Checkpoint only after the assistant tool_calls have their matching tool
    // results. Persisting the assistant call alone would create an invalid
    // provider history on resume, but waiting until final answer means a user
    // stop can lose all completed work from this turn.
    await persistSessionToDB(sessionId, session);

    const steeringMessages = drainSteeringMessagesIntoHistory(
      sessionId,
      session,
      hasStoredPrompt,
      log,
    );
    if (steeringMessages.length > 0) {
      await persistSessionToDB(sessionId, session);
      if (!consumeSteeringRestart(steeringRestartBudget, sessionId, log, 'after tool results')) {
        return toolLoopLimitResult(model, STEERING_RESTART_LIMIT_MESSAGE);
      }

      sendSteeringAppliedNotice(send, sessionId, steeringMessages);
    }

    if (
      toolResults.some(
        (toolResult) => isWebTool(toolResult.name) && isToolFailureResult(toolResult.result),
      )
    ) {
      log.warn('Web tool failed during tool loop; interrupting loop for shell fallback', {
        sessionId,
        toolIteration: toolIterations,
        failedTools: toolResults
          .filter(
            (toolResult) => isWebTool(toolResult.name) && isToolFailureResult(toolResult.result),
          )
          .map((toolResult) => toolResult.name),
      });
      return webToolFailureInterruptResult(model);
    }

    // Call the AI again with the tool results in history to get the next response.
    result = await completeWithContextRecovery(
      session,
      sessionId,
      model,
      {
        tools: tools.length ? tools : undefined,
        temperature: 0.2,
      },
      log,
      onUsage,
    );
    await onUsage(result);

    for (;;) {
      const lateSteeringMessages = drainSteeringMessagesIntoHistory(
        sessionId,
        session,
        hasStoredPrompt,
        log,
      );
      if (lateSteeringMessages.length === 0) break;

      await persistSessionToDB(sessionId, session);
      if (
        !consumeSteeringRestart(
          steeringRestartBudget,
          sessionId,
          log,
          'after follow-up model response',
        )
      ) {
        return toolLoopLimitResult(model, STEERING_RESTART_LIMIT_MESSAGE);
      }

      sendSteeringAppliedNotice(send, sessionId, lateSteeringMessages);
      result = await completeWithContextRecovery(
        session,
        sessionId,
        model,
        {
          tools: tools.length ? tools : undefined,
          temperature: 0.2,
        },
        log,
        onUsage,
      );
      await onUsage(result);
    }
  }

  log.info('Finished reasoning and tool calls: ', {
    reason: result.finish_reason,
  });

  return result;
}
