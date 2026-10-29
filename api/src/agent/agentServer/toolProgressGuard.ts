import { createHash } from 'crypto';
import type { AIToolCall } from '../../ai-client';

const MAX_REPEATED_ROUNDS = 8;
const OBSERVATION_WINDOW = 32;
const MAX_EVIDENCE_LINES = 256;
const RECOVERY_COOLDOWN = 12;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidenceLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(
      (line) =>
        line.length >= 20 &&
        !/^(?:TERMINAL OUTPUT:|COMMAND ERROR:|\[terminal output refined:|\[\.\.\.)/.test(line),
    )
    .slice(0, MAX_EVIDENCE_LINES);
}

/** Invocation-local evidence, shared by recovery and steering restarts. */
export class ToolProgressGuard {
  private rounds = 0;
  private repeatedRounds = 0;
  private lastRecoveryRound = -RECOVERY_COOLDOWN;
  private recoveryPrompt: string | undefined;
  private readonly observations: { keys: string[]; lines: Set<string> }[] = [];
  private readonly similarRounds: boolean[] = [];

  afterRound(calls: AIToolCall[], results: { result: string }[]): string | undefined {
    this.rounds++;
    const seenKeys = new Set(this.observations.flatMap((item) => item.keys));
    const seenLines = new Set(this.observations.flatMap((item) => [...item.lines]));
    const keys = calls.map((call, index) => {
      const output = results[index].result.trim();
      // A hard stop requires identical actions as well as results. Distinct
      // edits/tests can produce identical output of any length.
      return digest([call.name, call.arguments, output]);
    });
    const repeated = keys.length > 0 && keys.every((key) => seenKeys.has(key));
    this.repeatedRounds = repeated ? this.repeatedRounds + 1 : 0;

    const lines = results.flatMap(({ result }) => evidenceLines(result));
    const fingerprints = lines.map((line) => digest(line));
    const totalChars = lines.reduce((total, line) => total + line.length, 0);
    const knownChars = lines.reduce(
      (total, line, index) => total + (seenLines.has(fingerprints[index]) ? line.length : 0),
      0,
    );
    this.similarRounds.push(repeated || (totalChars >= 400 && knownChars / totalChars >= 0.7));
    if (this.similarRounds.length > 8) this.similarRounds.shift();
    this.observations.push({ keys, lines: new Set(fingerprints) });
    if (this.observations.length > OBSERVATION_WINDOW) this.observations.shift();

    // Give the model a chance to recover before the exact-repetition stop. Near
    // duplicates only trigger advice: similar build/test output can be progress.
    if (
      this.rounds - this.lastRecoveryRound >= RECOVERY_COOLDOWN &&
      (this.repeatedRounds >= 4 || this.similarRounds.filter(Boolean).length >= 5)
    ) {
      this.lastRecoveryRound = this.rounds;
      this.recoveryPrompt =
        'Agent progress checkpoint: Recent tool results substantially repeat evidence already inspected. ' +
        'Use the latest findings and progress notes to identify the next unfinished action. ' +
        'Do not restart repository instruction discovery or reread unchanged files without a specific missing fact. ' +
        'For an implementation request, proceed with the smallest justified edit and focused validation once the cause is established. ' +
        'If another inspection is necessary, explain what new fact it will resolve. If genuinely blocked, report the concrete blocker honestly. ' +
        'Continue the authorized task; this checkpoint does not require user confirmation.';
    }
    if (this.repeatedRounds >= MAX_REPEATED_ROUNDS) {
      return `Paused because the last ${MAX_REPEATED_ROUNDS} tool steps returned evidence already seen in this turn despite a progress checkpoint. Completed tool results have been saved. Review the repeated results and send a more specific next step to continue.`;
    }
    return undefined;
  }

  takeRecoveryPrompt(): string | undefined {
    const prompt = this.recoveryPrompt;
    this.recoveryPrompt = undefined;
    return prompt;
  }
}
