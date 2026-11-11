/**
 * Pure helpers for the agent Skills tests (no module mocks here; each test
 * file declares its own hoisted vi.mock block). Everything is in-memory: no
 * database, network, ports or user files.
 */
import { SkillError, type SkillSnapshot, type SkillStore } from '../../skills/contracts';

export const SKILLS_LABEL = 'Applicable Skills (user guidance only)';

export interface FakeSkillRow {
  id: string;
  name: string;
  keyword: string;
  instructions: string;
  revision: number;
  enabled?: boolean;
}

/** Mutable in-memory store: edits are visible to the next resolution. */
export function createFakeSkillStore() {
  const rows: FakeSkillRow[] = [];
  const state = { down: false, calls: 0, beforeList: undefined as undefined | (() => void) };
  const store: SkillStore = {
    async listEnabled() {
      state.calls += 1;
      state.beforeList?.();
      if (state.down) {
        throw new SkillError(503, 'STORE_UNAVAILABLE', 'Skills are temporarily unavailable.');
      }
      const matches: SkillSnapshot[] = rows
        .filter((row) => row.enabled !== false)
        .map(({ id, name, keyword, instructions, revision }) =>
          Object.freeze({ id, name, keyword, instructions, revision }),
        );
      return { matches: Object.freeze(matches), warnings: Object.freeze([]) };
    },
  };
  return { rows, state, store };
}

export interface CapturedRequest {
  model: string;
  history: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools: string[];
}

export function finalAnswer(text: string) {
  const content = `<final_answer>\n${text}\n</final_answer>`;
  return {
    content,
    finish_reason: 'stop',
    model: 'test-model',
    assistantMessage: { role: 'assistant', content },
  };
}

export function toolCalls(calls: Array<{ id: string; name: string; arguments: unknown }>) {
  return {
    content: '',
    finish_reason: 'tool_calls',
    model: 'test-model',
    tool_calls: calls,
    assistantMessage: { role: 'assistant', content: '', tool_calls: calls },
  };
}

/** Every overlay occurrence in a request, as parsed JSON arrays. */
export function overlaysIn(request: CapturedRequest): Array<{
  index: number;
  role: string;
  skills: Array<{
    id: string;
    name: string;
    keyword: string;
    revision: number;
    instructions: string;
  }>;
}> {
  const found: ReturnType<typeof overlaysIn> = [];
  request.history.forEach((message, index) => {
    const content = typeof message.content === 'string' ? message.content : '';
    let from = 0;
    for (;;) {
      const at = content.indexOf(SKILLS_LABEL, from);
      if (at < 0) break;
      const json = content.slice(at + SKILLS_LABEL.length + 1);
      found.push({ index, role: message.role, skills: JSON.parse(json) });
      from = at + SKILLS_LABEL.length;
    }
  });
  return found;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
