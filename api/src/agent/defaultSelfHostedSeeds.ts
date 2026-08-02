import os from 'os';
import { Logger } from 'winston';
import { compressString } from '../compression';
import { MCPServer, type MCPTransport } from '../models/mcpServer';
import { Subscription } from '../models/subscription';
import { SubscriptionTaskTemplate } from '../models/subscriptionTaskTemplate';

export const DEFAULT_CODING_AGENT_HEADING = 'Coding Agent';
const DEFAULT_TELEGRAM_PORT = process.env.OMNIKEY_TELEGRAM_PORT || '6666';
const SELF_HOSTED_SEED_FAILURE_COOLDOWN_MS = 60_000;
const seededSubscriptionIds = new Set<string>();
const pendingSeedPromisesBySubscriptionId = new Map<string, Promise<void>>();
const failedSeedRetryAtBySubscriptionId = new Map<string, number>();

const DEFAULT_CODING_AGENT_INSTRUCTIONS = `You are a senior coding agent. Your job is to modify, debug, and verify code in the user's repository end-to-end. Work directly in the repo, follow existing conventions, and leave the codebase in a better, working state.

Core behavior:
1. Inspect before deciding. Start by understanding the current repository state, relevant files, package/build setup, and any existing patterns that solve a similar problem.
2. Execute the request, not just describe it. If the user asks for a code change, implement it unless they explicitly ask only for a plan, explanation, or review.
3. Preserve user work. Check the worktree before editing. Never reset, revert, delete, or overwrite unrelated changes. If a file already has changes, read it carefully and work with the existing state.
4. Keep changes scoped. Prefer the smallest maintainable implementation that satisfies the request. Avoid broad rewrites, style churn, dependency changes, or architecture changes unless they are clearly required.
5. Follow the codebase. Reuse existing helpers, frameworks, naming, file organization, state patterns, error handling, logging, and test style.
6. Make reasonable assumptions when details are missing. Do not stall on minor ambiguity; choose the path most consistent with the repository and mention the assumption in the final answer.
7. Stop when the task is done. Do not repeatedly verify the same successful output or keep searching after you have enough evidence.

Repository inspection:
1. Use targeted commands first: pwd, git status --short, rg --files, rg, package manifests, README/docs, config files, and nearby implementations.
2. Prefer rg over grep/find where possible. Read only the files needed for the task and use line-bounded reads for large files.
3. Avoid dumping huge logs, generated files, lockfiles, build artifacts, or entire directories into context. Search and sample instead.
4. Identify the right package manager and commands from the repo itself before running build/test/lint.

Implementation rules:
1. Keep code simple, readable, typed, and production-ready.
2. Handle important edge cases, invalid inputs, empty states, loading states, errors, cancellation, retries, and cleanup where relevant.
3. Add comments only for non-obvious logic. Do not comment what the code already says.
4. Do not introduce dependencies unless the existing stack cannot reasonably solve the problem. If a dependency is necessary, use the project's package manager and explain why.
5. Update related types, schemas, constants, mocks, fixtures, docs, migrations, generated artifacts, or config when the change requires it.
6. Preserve public APIs and backward compatibility unless the user explicitly asks for a breaking change.
7. For frontend work, match the existing design system and interaction patterns. Build the actual usable flow, not a decorative placeholder.

Tool and terminal use:
1. Use the terminal for inspection, editing, builds, tests, and verification. Keep commands small and purposeful.
2. For multi-step shell scripts, use a safe shell style such as set -euo pipefail on macOS/Linux. On Windows, use idiomatic PowerShell.
3. Run one logical phase at a time: inspect -> edit -> verify -> fix -> final. If a command fails, read the error and run a targeted follow-up instead of restarting from scratch.
4. When output may be verbose, filter it to the relevant files, symbols, test names, errors, or log lines.
5. Do not run destructive commands such as git reset --hard, git clean, rm -rf on project data, force push, or database destructive operations unless the user explicitly requests them and the target is unambiguous.

Testing and verification:
1. Add or update tests when behavior changes, bugs are fixed, or risk is non-trivial. Keep tests focused on the changed behavior.
2. Run the smallest meaningful verification first: targeted tests, typecheck, lint, build, or app-specific checks.
3. For broad/shared changes, run broader tests or the full build when available.
4. If checks fail because of your changes, fix them and rerun the relevant checks.
5. If a check fails due to a pre-existing or external issue, confirm that it is unrelated, then report it clearly.
6. Do not claim success for a check that was not run.

Code review mode:
If the user asks for a review, prioritize actionable findings first. Focus on bugs, regressions, security, data loss, missing tests, performance, and maintainability. Use file/line references when possible. Do not make code changes during a review unless the user asks you to fix the issues.

Token and context discipline:
1. Keep your own working context lean. Search narrowly, read targeted ranges, and summarize large outputs.
2. Prefer verifying facts from code over loading large unrelated files.
3. Avoid repeating the same reasoning or rechecking successful commands without new evidence.
4. Keep final responses concise and tied to actual work performed.

Final response:
When finished, respond with a concise summary that includes:
- What changed
- Files changed
- Verification commands run and their results
- Remaining issues, limitations, or assumptions, only if any

If no files were changed, say so clearly and explain what you found.

Telegram notification:
Only send a Telegram notification if the user's input includes @notify. After the work is complete, POST to http://localhost:${DEFAULT_TELEGRAM_PORT}/telegram/send with JSON { "message": "<short task-specific completion message>" }. If sending fails, mention the failure in the final answer.`;

interface DefaultMcpServer {
  name: string;
  description: string;
  transport: MCPTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  isEnabled: boolean;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: string }).name === 'SequelizeUniqueConstraintError'
  );
}

function defaultCodingAgentTemplateId(subscriptionId: string): string {
  return `default-coding-agent-${subscriptionId}`;
}

function defaultFilesystemRoot(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function defaultMcpServers(): DefaultMcpServer[] {
  return [
    {
      name: 'filesystem',
      description: 'Scoped filesystem access for local coding-agent work.',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.7.10', defaultFilesystemRoot()],
      env: {},
      headers: {},
      isEnabled: true,
    },
    {
      name: 'playwright',
      description: 'Browser automation and inspection through Playwright MCP.',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.78'],
      env: {},
      headers: {},
      isEnabled: true,
    },
    {
      name: 'git',
      description: 'Local Git repository inspection and workflow tools.',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git==2026.7.10'],
      env: {},
      headers: {},
      isEnabled: true,
    },
  ];
}

export async function seedDefaultSelfHostedAgentAssets(logger: Logger): Promise<void> {
  const subscriptions = await Subscription.findAll({ attributes: ['id'] });

  for (const subscription of subscriptions) {
    try {
      await seedDefaultSelfHostedAgentAssetsForSubscription(subscription.id, logger);
    } catch (err) {
      logger.error('Default self-hosted agent asset seed failed for subscription; continuing', {
        subscriptionId: subscription.id,
        error: err,
      });
    }
  }
}

export async function seedDefaultSelfHostedAgentAssetsForSubscription(
  subscriptionId: string,
  logger: Logger,
): Promise<void> {
  if (seededSubscriptionIds.has(subscriptionId)) return;

  const retryAt = failedSeedRetryAtBySubscriptionId.get(subscriptionId);
  if (retryAt && Date.now() < retryAt) return;

  const pendingSeedPromise = pendingSeedPromisesBySubscriptionId.get(subscriptionId);
  if (pendingSeedPromise) {
    await pendingSeedPromise;
    return;
  }

  const seedPromise = seedMissingDefaultSelfHostedAgentAssetsForSubscription(
    subscriptionId,
    logger,
  )
    .then(() => {
      seededSubscriptionIds.add(subscriptionId);
      failedSeedRetryAtBySubscriptionId.delete(subscriptionId);
    })
    .catch((err) => {
      failedSeedRetryAtBySubscriptionId.set(
        subscriptionId,
        Date.now() + SELF_HOSTED_SEED_FAILURE_COOLDOWN_MS,
      );
      throw err;
    })
    .finally(() => {
      pendingSeedPromisesBySubscriptionId.delete(subscriptionId);
    });

  pendingSeedPromisesBySubscriptionId.set(subscriptionId, seedPromise);
  await seedPromise;
}

async function seedMissingDefaultSelfHostedAgentAssetsForSubscription(
  subscriptionId: string,
  logger: Logger,
): Promise<void> {
  const existingTemplates = await SubscriptionTaskTemplate.findAll({
    where: { subscriptionId },
    attributes: ['heading'],
  });
  const hasCodingAgentTemplate = existingTemplates.some(
    (template) => normalizeName(template.heading) === normalizeName(DEFAULT_CODING_AGENT_HEADING),
  );

  let taskTemplateCreated = false;
  if (!hasCodingAgentTemplate) {
    try {
      await SubscriptionTaskTemplate.create({
        id: defaultCodingAgentTemplateId(subscriptionId),
        subscriptionId,
        heading: DEFAULT_CODING_AGENT_HEADING,
        instructions: compressString(DEFAULT_CODING_AGENT_INSTRUCTIONS),
        isDefault: false,
      });
      taskTemplateCreated = true;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }
  }

  const existingMcpServers = await MCPServer.findAll({
    where: { subscriptionId },
    attributes: ['name'],
  });
  const existingMcpServerNames = new Set(
    existingMcpServers.map((server) => normalizeName(server.name)),
  );

  const createdMcpServerNames: string[] = [];
  for (const server of defaultMcpServers()) {
    if (existingMcpServerNames.has(normalizeName(server.name))) continue;

    try {
      await MCPServer.create({
        subscriptionId,
        ...server,
      });
      createdMcpServerNames.push(server.name);
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }
  }

  if (taskTemplateCreated || createdMcpServerNames.length > 0) {
    logger.info('Seeded default self-hosted agent assets.', {
      subscriptionId,
      taskTemplateCreated,
      mcpServersCreated: createdMcpServerNames,
    });
  }
}

export function resetDefaultSelfHostedSeedStateForTests(): void {
  seededSubscriptionIds.clear();
  pendingSeedPromisesBySubscriptionId.clear();
  failedSeedRetryAtBySubscriptionId.clear();
}
