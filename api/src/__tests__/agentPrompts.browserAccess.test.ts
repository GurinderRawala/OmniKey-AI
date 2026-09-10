import { describe, expect, it } from 'vitest';
import { getAgentPrompt } from '../agent/agentPrompts';
import type { AgentSettingsSnapshot } from '../agentSettingsStore';

function settings(overrides: Partial<AgentSettingsSnapshot> = {}): AgentSettingsSnapshot {
  return {
    id: 'default',
    terminalAccess: 'full',
    webSearchEnabled: true,
    usageRecordingEnabled: true,
    browserAccessEnabled: true,
    browserAccessMethod: null,
    browserDebugPort: null,
    browserDebugBrowserName: null,
    browserDebugExecutable: null,
    browserDebugUserDataDir: null,
    browserJavascriptEventBrowsers: [],
    openaiModel: 'gpt-5.6',
    anthropicModel: 'claude-opus-4-5',
    geminiModel: 'gemini-2.5-pro',
    nemotronModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    ...overrides,
  };
}

describe('agent browser-access prompt', () => {
  it('instructs JavaScript Events agents to try web_fetch before live-tab interaction', () => {
    const prompt = getAgentPrompt(
      'macos',
      false,
      [],
      settings({
        browserAccessMethod: 'javascript-events',
        browserJavascriptEventBrowsers: ['Chrome', 'Safari'],
      }),
    );

    const webFetchInstruction = prompt.indexOf('Always try the built-in `web_fetch` tool first');
    const fallbackInstruction = prompt.indexOf('use `shell_script` with macOS `osascript`');
    expect(webFetchInstruction).toBeGreaterThan(-1);
    expect(fallbackInstruction).toBeGreaterThan(webFetchInstruction);
    expect(prompt).toContain('Chrome, Safari');
    expect(prompt).toContain('Do not launch a debug profile or attempt a CDP connection');
  });

  it('prioritizes web tools before Playwright for the debug-profile method', () => {
    const prompt = getAgentPrompt(
      'macos',
      false,
      [],
      settings({
        browserAccessMethod: 'debug-profile',
        browserDebugPort: 9222,
        browserDebugExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        browserDebugUserDataDir: '/tmp/omnikey-profile',
      }),
    );

    expect(prompt).toContain('Connect to the running browser via CDP at `http://localhost:9222`');
    const webFirst = prompt.indexOf('Always use the built-in web tools first');
    const playwrightFallback = prompt.indexOf(
      'Only use Playwright when the task requires interaction',
    );
    expect(webFirst).toBeGreaterThan(-1);
    expect(playwrightFallback).toBeGreaterThan(webFirst);
    expect(prompt).toContain(
      'Do not run a Playwright script merely to fetch an authenticated page',
    );
    expect(prompt).not.toContain('Authenticated browser access via JavaScript Events');
  });
});
