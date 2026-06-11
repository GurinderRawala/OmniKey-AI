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
  it('removes <project_context> blocks injected by the agent server', () => {
    const input = `<project_context name="OmniKey AI">
Project root: /Users/me/OmniKey-AI.
</project_context>

Hey, please look at /Users/me/NewProj/src/index.ts`;
    const out = stripInjectedWrappers(input);
    expect(out).not.toContain('project_context');
    expect(out).not.toContain('/Users/me/OmniKey-AI');
    expect(out).toContain('/Users/me/NewProj/src/index.ts');
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

  it('strips <project_context> from inside <user_input> so old paths do not leak', () => {
    // This is the regression: on turn 2 of a grouped session, the server
    // prepends a <project_context> block (with the OLD group's path) inside
    // <user_input>. extractUserInputs must not treat that injected text as
    // user-typed content, otherwise the classifier keeps re-picking the old
    // group.
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
    expect(inputs[0]).not.toContain('/Users/me/OldParent');
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
