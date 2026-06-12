/**
 * Unit tests for the pure helpers inside ../agent/sessionGrouping.
 *
 * These cover the regression where new sessions were being grouped under the
 * PARENT project (e.g. the OmniKey-AI repo root) even when the user was
 * clearly working in a sibling/child project. The root cause was two-fold:
 *
 * 1. extractUserInputs was returning the inner text of <user_input>...</user_input>
 *    WITHOUT stripping the <project_context> block that the agent server
 *    prepends to every turn of an already-grouped session. That meant the old
 *    group's path was fed back into the classifier on every subsequent turn,
 *    making the wrong grouping sticky forever.
 *
 * 2. extractProjectPath rolled scores up to every ancestor and broke ties by
 *    picking the DEEPEST path, which let unrelated siblings like
 *    /Users/<name>/src or even the bare /Users/<name> beat the real project
 *    root.
 *
 * These tests pin both behaviours.
 */

import { describe, it, expect, vi } from 'vitest';

// The module pulls in ai-client, sequelize models, and a logger at import
// time. Stub all of them so the pure helpers can be exercised in isolation.
vi.mock('../ai-client', () => ({
  aiClient: { complete: vi.fn(), streamComplete: vi.fn() },
  getDefaultModel: vi.fn(() => 'test-model'),
}));

vi.mock('../models/agentSession', () => ({
  AgentSession: { findAll: vi.fn(), findOne: vi.fn(), update: vi.fn(), count: vi.fn() },
}));

vi.mock('../models/subscription', () => ({
  Subscription: { findAll: vi.fn() },
}));

vi.mock('../config', () => ({
  config: { aiProvider: 'openai' },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { __testing__ } from '../agent/sessionGrouping';

const { extractUserInputs, extractProjectPath, stripInjectedWrappers, trimToProjectRoot } =
  __testing__;

// ---------------------------------------------------------------------------
// stripInjectedWrappers
// ---------------------------------------------------------------------------
describe('stripInjectedWrappers', () => {
  it('strips <project_context> tags but preserves the Project root: path as a [context root] line', () => {
    // The <project_context> block must not be re-fed verbatim (its prose
    // about purpose/language would bias the LLM), but its declared project
    // root is the only deterministic signal we have when the user types a
    // path-free message like "continue" or "what about the cron?". So we
    // keep the path as a single tagged line that contributes exactly one
    // vote to extractProjectPath but never appears in the LLM prompt as if
    // the user typed it.
    const input = `<project_context name="OmniKey AI">
Project root: /Users/me/OmniKey-AI.
</project_context>

Hey, please look at /Users/me/NewProj/src/index.ts`;
    const out = stripInjectedWrappers(input);
    expect(out).not.toContain('project_context');
    expect(out).not.toContain('Project root:');
    expect(out).toContain('[context root] /Users/me/OmniKey-AI');
    expect(out).toContain('/Users/me/NewProj/src/index.ts');
  });

  it('drops the context-root line entirely when the block has no Project root: sentence', () => {
    const out = stripInjectedWrappers(
      '<project_context name="Misc">Just some prose.</project_context>\nhello',
    );
    expect(out).toBe('hello');
  });

  it('removes <stored_instructions> blocks', () => {
    const out = stripInjectedWrappers(
      '<stored_instructions>do X</stored_instructions> the actual ask',
    );
    expect(out).toBe('the actual ask');
  });

  it('unwraps <user_input> tags without losing their content', () => {
    const out = stripInjectedWrappers('<user_input>fix the bug</user_input>');
    expect(out).toBe('fix the bug');
  });

  it('strips @omniagent mentions case-insensitively', () => {
    expect(stripInjectedWrappers('@omniAgent help me')).toBe('help me');
    expect(stripInjectedWrappers('@OMNIAGENT please')).toBe('please');
  });
});

// ---------------------------------------------------------------------------
// extractUserInputs
// ---------------------------------------------------------------------------
describe('extractUserInputs', () => {
  it('returns plain user inputs in order', () => {
    const history = JSON.stringify([
      { role: 'user', content: '<user_input>first message about /Users/me/AppA</user_input>' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '<user_input>second message about /Users/me/AppA</user_input>' },
    ]);
    expect(extractUserInputs(history)).toEqual([
      'first message about /Users/me/AppA',
      'second message about /Users/me/AppA',
    ]);
  });

  it('skips terminal output and command error feedback messages', () => {
    const history = JSON.stringify([
      { role: 'user', content: '<user_input>fix /Users/me/AppA/index.ts</user_input>' },
      { role: 'user', content: 'TERMINAL OUTPUT:\nsome long output' },
      { role: 'user', content: 'COMMAND ERROR:\nstack trace' },
    ]);
    expect(extractUserInputs(history)).toEqual(['fix /Users/me/AppA/index.ts']);
  });

  it('extracts <project_context> Project root: as a low-weight [context root] line', () => {
    // On turn 2 of a grouped session, the server prepends a <project_context>
    // block (with the previously stored group's path) inside <user_input>.
    // We keep that path as a low-weight "[context root]" line — one vote —
    // and let any path the user actually types this turn outvote it.
    const history = JSON.stringify([
      {
        role: 'user',
        content: [
          '<user_input>',
          '<project_context name="OldParent">',
          'Project root: /Users/me/OldParent.',
          '</project_context>',
          '',
          'Now actually I am working on /Users/me/NewProj — please fix /Users/me/NewProj/main.ts',
          '</user_input>',
        ].join('\n'),
      },
    ]);

    const inputs = extractUserInputs(history);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toContain('project_context');
    expect(inputs[0]).toContain('[context root] /Users/me/OldParent');
    expect(inputs[0]).toContain('/Users/me/NewProj');
  });

  it('returns [] for malformed history JSON', () => {
    expect(extractUserInputs('not json')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// trimToProjectRoot
// ---------------------------------------------------------------------------
describe('trimToProjectRoot', () => {
  it('strips a trailing file segment with an extension', () => {
    expect(trimToProjectRoot('/Users/me/App/src/index.ts')).toBe('/Users/me/App');
  });

  it('walks up through non-root subdirs (src, lib, dist, tests, ...)', () => {
    expect(trimToProjectRoot('/Users/me/App/src/components/Button.tsx')).toBe('/Users/me/App');
    expect(trimToProjectRoot('/Users/me/App/dist/main.js')).toBe('/Users/me/App');
    expect(trimToProjectRoot('/Users/me/App/__tests__/foo.test.ts')).toBe('/Users/me/App');
  });

  it('returns null for a bare home directory', () => {
    expect(trimToProjectRoot('/Users/me')).toBeNull();
    expect(trimToProjectRoot('/home/alice')).toBeNull();
  });

  it('skips Documents/Desktop/projects-style containers', () => {
    expect(trimToProjectRoot('/Users/me/Documents')).toBeNull();
    expect(trimToProjectRoot('/Users/me/Documents/projects/Real/src/x.ts')).toBe(
      '/Users/me/Documents/projects/Real',
    );
  });

  it('handles linux paths', () => {
    expect(trimToProjectRoot('/home/alice/projects/Cool/src/main.go')).toBe(
      '/home/alice/projects/Cool',
    );
  });

  it('preserves paths outside home roots (e.g. /opt/myapp/src/x.ts)', () => {
    expect(trimToProjectRoot('/opt/myapp/src/x.ts')).toBe('/opt/myapp');
  });
});

// ---------------------------------------------------------------------------
// extractProjectPath — end-to-end on realistic input mixes
// ---------------------------------------------------------------------------
describe('extractProjectPath', () => {
  it('returns null when no absolute paths are present', () => {
    expect(extractProjectPath(['hello world', 'how are you'])).toBeNull();
  });

  it('returns null when the only path is the user home', () => {
    expect(extractProjectPath(['home is /Users/gurindersingh'])).toBeNull();
  });

  it('picks the child project when the parent is mentioned once and the child many times', () => {
    // This is the user-reported regression: an old <project_context> leaks
    // ONE mention of the parent OmniKey-AI repo, but the user is clearly
    // working in a different/child project. The child must win.
    const got = extractProjectPath([
      'old context /Users/gurindersingh/OmniKey-AI',
      'fix /Users/gurindersingh/Subproject/a.ts',
      'fix /Users/gurindersingh/Subproject/b.ts',
      'fix /Users/gurindersingh/Subproject/c.ts',
      'fix /Users/gurindersingh/Subproject/d.ts',
    ]);
    expect(got).toBe('/Users/gurindersingh/Subproject');
  });

  it('does not promote a bare home directory above an actual project', () => {
    // Pre-fix, /Users/gurindersingh would score 4 (one ancestor vote per
    // child path) and tie-break to depth 2, beating the real project.
    const got = extractProjectPath([
      'Please fix /Users/gurindersingh/MyOtherApp/src/index.ts',
      'Also check /Users/gurindersingh/MyOtherApp/package.json',
      'And /Users/gurindersingh/MyOtherApp/src/utils.ts',
    ]);
    expect(got).toBe('/Users/gurindersingh/MyOtherApp');
  });

  it('does not return a src/ or lib/ subdirectory', () => {
    const got = extractProjectPath([
      'fix /Users/x/MyApp/src/components/Button.tsx',
      'and /Users/x/MyApp/src/components/Card.tsx',
    ]);
    expect(got).toBe('/Users/x/MyApp');
  });

  it('does not return an individual file path', () => {
    const got = extractProjectPath(['edit /Users/me/Solo/index.ts']);
    expect(got).toBe('/Users/me/Solo');
  });

  it('picks the deeper of two siblings when they tie on direct mentions', () => {
    // When the same depth tie is between a true ancestor and its descendant
    // (no other sibling), the descendant is the most-specific common
    // reference and is more likely the project root the user means.
    const got = extractProjectPath([
      'Edit /Users/me/OmniKey-AI',
      'Edit /Users/me/OmniKey-AI/cli',
      'Edit /Users/me/OmniKey-AI/cli',
    ]);
    expect(got).toBe('/Users/me/OmniKey-AI/cli');
  });

  it('strips trailing sentence punctuation', () => {
    const got = extractProjectPath([
      'see /Users/me/MyApp/cli, please edit /Users/me/MyApp/cli/main.ts',
    ]);
    expect(got).toBe('/Users/me/MyApp/cli');
  });

  it('handles linux project paths', () => {
    const got = extractProjectPath([
      'fix /home/alice/projects/CoolApp/src/main.go',
      'check /home/alice/projects/CoolApp/go.mod',
    ]);
    expect(got).toBe('/home/alice/projects/CoolApp');
  });

  it('regression: parent path leaked via <project_context> does not override child', () => {
    // Realistic simulation of the bug the user reported. The agent server
    // prepended <project_context> with the parent OmniKey-AI path, and the
    // user typed a brand new request about a child project. With the old
    // implementation the parent path would dominate via ancestor-rollup; the
    // new implementation must pick the child.
    const userTurnInsideHistory = [
      '<project_context name="OmniKey AI">',
      'Project root: /Users/me/OmniKey-AI. Purpose: parent. Primary language: TypeScript.',
      '</project_context>',
      '',
      'Actually, please look at /Users/me/OmniKey-AI/cli and refactor /Users/me/OmniKey-AI/cli/src/main.ts',
    ].join('\n');

    const history = JSON.stringify([
      { role: 'user', content: `<user_input>${userTurnInsideHistory}</user_input>` },
    ]);
    const inputs = extractUserInputs(history);
    expect(inputs[0]).not.toContain('/Users/me/OmniKey-AI.');
    const got = extractProjectPath(inputs);
    expect(got).toBe('/Users/me/OmniKey-AI/cli');
  });
});

// ---------------------------------------------------------------------------
// Production-observed bug scenarios — these mirror the actual session
// histories we found in sqlite after the cron rewrote descriptions with
// hallucinated paths. They pin two specific protections:
//   (a) URL-shaped "absolute paths" never become a project root.
//   (b) When the user's typed turn has no path, the <project_context>
//       fallback prevents the LLM from being fed an empty path slate.
// ---------------------------------------------------------------------------
describe('production-observed regressions', () => {
  const { trimToProjectRoot, extractProjectPath, extractUserInputs } = __testing__;

  it('rejects URL-shaped pseudo-paths (github.com, linear.app, console.cloud.google.com)', () => {
    expect(trimToProjectRoot('/github.com/coderabbitai/grafana/pull/220')).toBeNull();
    expect(trimToProjectRoot('/linear.app/coderabbit/issue/REV-19/programmable-access')).toBeNull();
    expect(
      trimToProjectRoot('/console.cloud.google.com/run/worker-pools/details/us-central1'),
    ).toBeNull();
    expect(trimToProjectRoot('/localhost:5173/dashboard/summary')).toBeNull();
    expect(trimToProjectRoot('/apps.apple.com/ca/app/bhabi/id6475659322')).toBeNull();
  });

  it('still accepts legitimate filesystem paths next to URL-shaped tokens', () => {
    // Mixed text with both a URL-shaped pseudo-path and a real path — only
    // the real path should win.
    const got = extractProjectPath([
      'see https://github.com/coderabbitai/grafana/pull/220 (rendered as /github.com/coderabbitai/grafana/pull/220)',
      'and edit /Users/me/RealRepo/src/main.ts',
      'and /Users/me/RealRepo/package.json',
    ]);
    expect(got).toBe('/Users/me/RealRepo');
  });

  it('falls back to <project_context> path when the user types nothing path-shaped', () => {
    // Simulates: turn 1 grouped the session under "My App" with stored path
    // /Users/me/MyApp. On turn 2 the user types a path-free question like
    // "continue working". Without the fallback, extractProjectPath would
    // return null and the LLM would be free to invent. With the fallback,
    // it returns the previously stored path so safety nets can compare.
    const history = JSON.stringify([
      {
        role: 'user',
        content: [
          '<user_input>',
          '<project_context name="My App">',
          'Project root: /Users/me/MyApp. Purpose: x. Primary language: TypeScript.',
          '</project_context>',
          '',
          'continue working on the task',
          '</user_input>',
        ].join('\n'),
      },
    ]);
    const inputs = extractUserInputs(history);
    const got = extractProjectPath(inputs);
    expect(got).toBe('/Users/me/MyApp');
  });

  it('user-typed path still beats a stale <project_context> fallback path', () => {
    // The original parent/child regression, expressed at the extractProjectPath
    // layer end-to-end: <project_context> claims /Users/me/OldParent (one
    // [context root] vote), user types /Users/me/NewProj three times.
    const history = JSON.stringify([
      {
        role: 'user',
        content: [
          '<user_input>',
          '<project_context name="OldParent">',
          'Project root: /Users/me/OldParent. Purpose: x. Primary language: y.',
          '</project_context>',
          '',
          'fix /Users/me/NewProj/a.ts',
          'and /Users/me/NewProj/b.ts',
          'and /Users/me/NewProj/c.ts',
          '</user_input>',
        ].join('\n'),
      },
    ]);
    const inputs = extractUserInputs(history);
    const got = extractProjectPath(inputs);
    expect(got).toBe('/Users/me/NewProj');
  });
});

// ---------------------------------------------------------------------------
// extractStoredProjectPath
// ---------------------------------------------------------------------------
describe('extractStoredProjectPath', () => {
  const { extractStoredProjectPath } = __testing__;

  it('returns null for empty / missing descriptions', () => {
    expect(extractStoredProjectPath(null)).toBeNull();
    expect(extractStoredProjectPath(undefined)).toBeNull();
    expect(extractStoredProjectPath('')).toBeNull();
  });

  it('returns null when description has no "Project root:" sentence', () => {
    expect(extractStoredProjectPath('Some general group about chatting.')).toBeNull();
  });

  it('extracts an absolute path from a standard description', () => {
    const desc =
      'Project root: /Users/me/MyApp. Purpose: build a thing. Primary language: TypeScript.';
    expect(extractStoredProjectPath(desc)).toBe('/Users/me/MyApp');
  });

  it('walks the extracted path up through src/ subdirs', () => {
    const desc = 'Project root: /Users/me/MyApp/src. Purpose: thing. Primary language: TS.';
    expect(extractStoredProjectPath(desc)).toBe('/Users/me/MyApp');
  });

  it('is case-insensitive on the label', () => {
    expect(
      extractStoredProjectPath('project root: /opt/thing. Purpose: x. Primary language: Go.'),
    ).toBe('/opt/thing');
  });

  it('returns null when the stored "path" is actually a URL', () => {
    // Existing descriptions in production were written before URL rejection.
    // We must treat them as "no stored path" so the LLM gets a chance to
    // rewrite the description with a real root instead of locking the
    // session forever to a bad URL-shaped pseudo-root.
    expect(
      extractStoredProjectPath(
        'Project root: /github.com/coderabbitai/grafana/pull/220. Purpose: x.',
      ),
    ).toBeNull();
    expect(
      extractStoredProjectPath('Project root: /linear.app/coderabbit/issue/REV-19. Purpose: x.'),
    ).toBeNull();
    expect(extractStoredProjectPath('Project root: /localhost:5173/dashboard.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findGroupByExactPath
// ---------------------------------------------------------------------------
describe('findGroupByExactPath', () => {
  const { findGroupByExactPath } = __testing__;

  const groups = [
    {
      groupName: 'OmniKey AI',
      groupDescription:
        'Project root: /Users/me/OmniKey-AI. Purpose: parent. Primary language: TypeScript.',
    },
    {
      groupName: 'OmniKey CLI',
      groupDescription:
        'Project root: /Users/me/OmniKey-AI/cli. Purpose: cli. Primary language: TypeScript.',
    },
    {
      groupName: 'General',
      groupDescription:
        'Project root: not specified. Purpose: misc. Primary language: not applicable.',
    },
  ];

  it('returns null when currentPath is null', () => {
    expect(findGroupByExactPath(null, groups)).toBeNull();
  });

  it('returns the group whose stored path matches exactly', () => {
    const got = findGroupByExactPath('/Users/me/OmniKey-AI/cli', groups);
    expect(got?.groupName).toBe('OmniKey CLI');
  });

  it('does NOT return the ancestor group when current is a child', () => {
    // The original regression: matching /Users/me/OmniKey-AI/cli against the
    // OmniKey-AI parent group must be a miss, not a hit.
    const got = findGroupByExactPath('/Users/me/OmniKey-AI/cli/src/x.ts', [groups[0]]);
    expect(got).toBeNull();
  });

  it('returns null when no stored path matches', () => {
    expect(findGroupByExactPath('/Users/me/Unrelated', groups)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyGroup (LLM pipeline)
// ---------------------------------------------------------------------------
describe('classifyGroup', () => {
  const { classifyGroup } = __testing__;

  // Helper to grab the mocked aiClient.complete and configure it per test.
  // The module is mocked at the top of this file, so we reach into the mock
  // dynamically here to avoid a stale reference across describe blocks.
  async function withMockedLLM<T>(
    response: { groupName: string; groupDescription: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const aiClientMod = await import('../ai-client');
    const complete = (
      aiClientMod as unknown as { aiClient: { complete: ReturnType<typeof vi.fn> } }
    ).aiClient.complete;
    complete.mockResolvedValueOnce({ content: JSON.stringify(response) });
    return run();
  }

  it('short-circuits on exact path match without calling the LLM', async () => {
    const aiClientMod = await import('../ai-client');
    const complete = (
      aiClientMod as unknown as { aiClient: { complete: ReturnType<typeof vi.fn> } }
    ).aiClient.complete;
    complete.mockClear();

    const existing = [
      {
        groupName: 'My App',
        groupDescription:
          'Project root: /Users/me/MyApp. Purpose: ship it. Primary language: TypeScript.',
      },
    ];
    const inputs = ['fix /Users/me/MyApp/src/index.ts'];

    const result = await classifyGroup(inputs, existing);
    expect(result?.groupName).toBe('My App');
    expect(result?.groupDescription).toContain('/Users/me/MyApp');
    expect(complete).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit to the parent project when user is in a child', async () => {
    // The original user-reported bug. Parent group exists with root
    // /Users/me/Repo. User is in /Users/me/Repo/cli. The LLM should be
    // consulted (no exact-path match) and must NOT re-use the parent's name.
    const existing = [
      {
        groupName: 'Repo',
        groupDescription:
          'Project root: /Users/me/Repo. Purpose: parent. Primary language: TypeScript.',
      },
    ];
    const inputs = ['edit /Users/me/Repo/cli/src/main.ts', 'and /Users/me/Repo/cli/package.json'];

    const result = await withMockedLLM(
      // Even if the LLM hallucinated the parent name, the post-validation
      // step should reject it because stored path != current path.
      {
        groupName: 'Repo',
        groupDescription:
          'Project root: /Users/me/Repo/cli. Purpose: cli. Primary language: TypeScript.',
      },
      () => classifyGroup(inputs, existing),
    );

    expect(result?.groupName).not.toBe('Repo');
    // The derived name should come from the deepest path segment.
    expect(result?.groupName?.toLowerCase()).toContain('cli');
    expect(result?.groupDescription).toContain('/Users/me/Repo/cli');
    expect(result?.groupDescription).not.toMatch(/Project root:\s*\/Users\/me\/Repo\b(?!\/cli)/);
  });

  it('overrides LLM choice with exact-path match to a different existing group', async () => {
    // The LLM invents a fresh name ("Brand New") but the deterministic path
    // already belongs to an existing group. Path equality must win.
    const existing = [
      {
        groupName: 'Canonical Name',
        groupDescription:
          'Project root: /Users/me/Real. Purpose: thing. Primary language: TypeScript.',
      },
    ];
    const inputs = ['fix /Users/me/Real/src/a.ts', 'and /Users/me/Real/src/b.ts'];

    // Because the exact-path short-circuit fires BEFORE the LLM, this test
    // also implicitly proves the short-circuit beats LLM hallucination.
    const result = await classifyGroup(inputs, existing);
    expect(result?.groupName).toBe('Canonical Name');
  });

  it('replaces a hallucinated path in the LLM description with the extracted path', async () => {
    const inputs = ['work in /Users/me/Actual/src/index.ts'];
    const result = await withMockedLLM(
      {
        groupName: 'Actual',
        groupDescription:
          'Project root: /Users/me/SomethingElse. Purpose: x. Primary language: TypeScript.',
      },
      () => classifyGroup(inputs, []),
    );

    expect(result?.groupDescription).toContain('/Users/me/Actual');
    expect(result?.groupDescription).not.toContain('/Users/me/SomethingElse');
  });

  it('returns null when there are no user inputs', async () => {
    const result = await classifyGroup([], []);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runWithConcurrency
// ---------------------------------------------------------------------------
describe('runWithConcurrency', () => {
  const { runWithConcurrency } = __testing__;

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('continues draining the queue when one item throws', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 3]);
  });

  it('treats a concurrency limit < 1 as 1', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 0, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('returns immediately for an empty input', async () => {
    let called = false;
    await runWithConcurrency([], 5, async () => {
      called = true;
    });
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshGroupDescription — skip-if-idle gating
// ---------------------------------------------------------------------------
describe('refreshGroupDescription', () => {
  const { refreshGroupDescription, lastRefreshedAt } = __testing__;

  // Reach into the same mocks we set up at the top of this file.
  async function getMocks() {
    const aiClientMod = await import('../ai-client');
    const agentSessionMod = await import('../models/agentSession');
    return {
      complete: (aiClientMod as unknown as { aiClient: { complete: ReturnType<typeof vi.fn> } })
        .aiClient.complete,
      findAll: (
        agentSessionMod as unknown as { AgentSession: { findAll: ReturnType<typeof vi.fn> } }
      ).AgentSession.findAll,
      findOne: (
        agentSessionMod as unknown as { AgentSession: { findOne: ReturnType<typeof vi.fn> } }
      ).AgentSession.findOne,
      update: (agentSessionMod as unknown as { AgentSession: { update: ReturnType<typeof vi.fn> } })
        .AgentSession.update,
    };
  }

  it('returns silently when the group has no sessions', async () => {
    const { findOne, complete, update } = await getMocks();
    findOne.mockResolvedValueOnce(null);
    complete.mockClear();
    update.mockClear();

    await refreshGroupDescription('sub-1', 'Empty Group', 'old description');

    expect(complete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('skips the LLM when there has been no activity since last refresh', async () => {
    const { findOne, findAll, complete, update } = await getMocks();
    lastRefreshedAt.clear();

    const lastActive = new Date('2024-01-01T00:00:00Z');
    findOne.mockResolvedValueOnce({ lastActiveAt: lastActive });
    // Seed the in-memory marker as if we refreshed AFTER the newest activity.
    lastRefreshedAt.set('sub-1::My App', new Date('2024-01-02T00:00:00Z'));

    findAll.mockClear();
    complete.mockClear();
    update.mockClear();

    await refreshGroupDescription('sub-1', 'My App', 'desc');

    // findOne was called to get lastActiveAt; nothing else should happen.
    expect(findAll).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('runs the LLM and updates when a session has been active since last refresh', async () => {
    const { findOne, findAll, complete, update } = await getMocks();
    lastRefreshedAt.clear();

    const lastActive = new Date('2024-02-01T00:00:00Z');
    findOne.mockResolvedValueOnce({ lastActiveAt: lastActive });
    // No prior refresh marker → must run.
    findAll.mockResolvedValueOnce([
      {
        historyJson: JSON.stringify([
          { role: 'user', content: '<user_input>fix /Users/me/MyApp/index.ts</user_input>' },
        ]),
      },
    ]);
    complete.mockResolvedValueOnce({
      content: JSON.stringify({
        groupDescription:
          'Project root: /Users/me/MyApp. Purpose: x. Primary language: TypeScript.',
      }),
    });
    update.mockClear();

    await refreshGroupDescription('sub-1', 'My App', 'old desc');

    expect(complete).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(lastRefreshedAt.get('sub-1::My App')).toBeInstanceOf(Date);
  });
});
