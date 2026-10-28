import { createHash } from 'crypto';
import type { AIToolCall } from '../../ai-client';

const MAX_TOOL_ROUNDS = 120;
const MAX_REPEATED_ROUNDS = 8;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** One budget per user invocation, shared by recovery and steering restarts. */
export class ToolProgressGuard {
  private rounds = 0;
  private repeatedRounds = 0;
  private readonly observations = new Set<string>();

  beforeRound(): string | undefined {
    if (this.rounds >= MAX_TOOL_ROUNDS) {
      return `Paused after ${MAX_TOOL_ROUNDS} tool steps to prevent an unbounded run. Completed tool results have been saved. Review the work so far and send a follow-up to continue.`;
    }
    this.rounds++;
    return undefined;
  }

  afterRound(calls: AIToolCall[], results: { result: string }[]): string | undefined {
    // Long identical outputs are repeated evidence even if the model rewrites
    // its inspection script. Short acknowledgements also require identical
    // arguments, so separate edits returning "OK" are not mistaken for a loop.
    const keys = calls.map((call, index) => {
      const output = results[index].result.trim();
      return digest([call.name, output.length >= 80 ? null : call.arguments, output]);
    });
    const repeated = keys.length > 0 && keys.every((key) => this.observations.has(key));
    keys.forEach((key) => this.observations.add(key));
    this.repeatedRounds = repeated ? this.repeatedRounds + 1 : 0;
    if (this.repeatedRounds >= MAX_REPEATED_ROUNDS) {
      return `Paused because the last ${MAX_REPEATED_ROUNDS} tool steps returned evidence already seen in this turn. Completed tool results have been saved. Review the repeated results and send a more specific next step to continue.`;
    }
    return undefined;
  }
}
