import type { AITool } from '../../ai-client';
import {
  acceptDirectoryCandidate,
  literalScriptDirectories,
  pwdOutputDirectories,
} from './candidates';
import {
  GIT_DIFF_MAX_CANDIDATES,
  isSafeAbsolutePath,
  normalizeAbsolutePath,
  validateCommitObservations,
} from './contracts';
import type { GitDiffShellContext } from './contracts';
import { recordCommitObservations, type GitRunState } from './coordinator';

/** Shell tool variant with an optional structured working directory. */
export function withWorkingDirectoryParameter(tool: AITool): AITool {
  const parameters = tool.parameters as {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: {
        ...parameters.properties,
        capture_paths: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string' },
          description:
            'Optional absolute folders to register for turn diffs before this script runs. Use for variable-based worktree paths or additional worker folders; creates no directories. Register after creating a worktree and before editing it.',
        },
        working_directory: {
          type: 'string',
          description:
            'Optional absolute directory on the user machine to run the script in (for example the project root). Prefer this over a leading `cd`.',
        },
      },
    },
  };
}

export interface ShellGitPlan {
  /** Validated structured directory to forward with the shell request. */
  workingDirectory?: string;
  capturePaths?: string[];
  error?: string;
  /** Candidate paths forwarded as `git_diff_context` (bounded). */
  context?: GitDiffShellContext;
}

/**
 * Collect deterministic evidence BEFORE the script is sent: the structured
 * directory and literal `cd`/`git -C` targets. Nothing is executed or
 * evaluated; unknown shapes simply contribute nothing.
 */
export function planShellGitContext(
  run: GitRunState | undefined,
  args: Record<string, unknown>,
  script: string,
): ShellGitPlan {
  if (!run) return {};
  if (
    args.capture_paths !== undefined &&
    (!Array.isArray(args.capture_paths) ||
      args.capture_paths.length > GIT_DIFF_MAX_CANDIDATES ||
      args.capture_paths.some((p) => !acceptDirectoryCandidate(p)))
  ) {
    return { error: 'capture_paths must contain at most eight absolute project folders.' };
  }
  const capturePaths =
    (args.capture_paths as string[] | undefined)?.map(normalizeAbsolutePath) ?? [];
  if (args.working_directory !== undefined && !isSafeAbsolutePath(args.working_directory)) {
    return {
      error:
        'working_directory must be an absolute path without relative segments or control characters.',
    };
  }
  const workingDirectory =
    typeof args.working_directory === 'string'
      ? normalizeAbsolutePath(args.working_directory)
      : undefined;
  run.candidates.addAll(capturePaths, 'working_directory');
  run.candidates.add(acceptDirectoryCandidate(workingDirectory), 'working_directory');
  const literal = literalScriptDirectories(script);
  run.candidates.addAll(literal, 'command');
  // This script's own directories first, then the run's other evidence.
  const candidate = acceptDirectoryCandidate(workingDirectory);
  const ordered = [...(candidate ? [candidate] : []), ...capturePaths, ...literal];
  for (const path of run.candidates.list(GIT_DIFF_MAX_CANDIDATES)) {
    if (!ordered.includes(path)) ordered.push(path);
  }
  const candidatePaths = ordered.slice(0, GIT_DIFF_MAX_CANDIDATES);
  return {
    workingDirectory,
    capturePaths,
    ...(candidatePaths.length ? { context: { candidate_paths: candidatePaths } } : {}),
  };
}

/**
 * Directories a shell demonstrably targets before it runs (structured
 * `working_directory`, literal leading `cd`, literal `git -C`). Discovered
 * `pwd` output is never included: it is only known after the script ran.
 */
export function baselinePathsForShell(plan: ShellGitPlan, script: string): string[] {
  const structured = acceptDirectoryCandidate(plan.workingDirectory);
  return [
    ...(structured ? [structured] : []),
    ...(plan.capturePaths ?? []),
    ...literalScriptDirectories(script),
  ].slice(0, GIT_DIFF_MAX_CANDIDATES);
}

/**
 * Evidence AFTER the outstanding shell reply: `pwd` output lines and HEAD
 * transitions. Observations are accepted only for this exact request's
 * candidates and only when the script literally invoked `git commit`.
 */
export function recordShellGitResult(
  run: GitRunState | undefined,
  plan: ShellGitPlan,
  script: string,
  output: string,
  rawObservations: unknown,
): void {
  if (!run) return;
  run.candidates.addAll(pwdOutputDirectories(script, output), 'pwd');
  const observations = validateCommitObservations(
    rawObservations,
    plan.context?.candidate_paths ?? [],
    script,
  );
  recordCommitObservations(run, observations);
}
