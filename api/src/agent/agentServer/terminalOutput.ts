const TERMINAL_OUTPUT_MAX = 80_000; // max chars kept per terminal message
const TERMINAL_OUTPUT_HEAD = 30_000; // chars kept from the beginning
const TERMINAL_OUTPUT_TAIL = 50_000; // chars kept from the end (errors land here)
const TERMINAL_OUTPUT_PASSTHROUGH_MAX = 12_000;
const TERMINAL_OUTPUT_PASSTHROUGH_LINES = 200;
const TERMINAL_OUTPUT_REFINED_MAX = 24_000;
const TERMINAL_OUTPUT_KEYWORD_CONTEXT_LINES = 2;
const TERMINAL_OUTPUT_SIGNAL_CONTEXT_LINES = 1;
const TERMINAL_OUTPUT_LARGE_HEAD_LINES = 20;
const TERMINAL_OUTPUT_LARGE_TAIL_LINES = 80;
const TERMINAL_OUTPUT_ERROR_HEAD_LINES = 12;
const TERMINAL_OUTPUT_ERROR_TAIL_LINES = 120;
const TERMINAL_OUTPUT_MAX_LINE = 1_200;
const TERMINAL_OUTPUT_MAX_KEYWORDS = 12;
const TERMINAL_OUTPUT_MAX_KEYWORD_LENGTH = 80;

const TERMINAL_OUTPUT_SIGNAL_PATTERN =
  /(error|failed|failure|exception|traceback|fatal|panic|permission denied|not found|no such file|cannot|could not|warning|warn|npm ERR!|yarn error|pnpm ERR!|TypeError|ReferenceError|SyntaxError|AssertionError|TS\d{4}|exit code|segmentation fault|timeout|timed out)/i;

/**
 * Caps large terminal outputs so they don't consume the entire history budget.
 * Keeps the first TERMINAL_OUTPUT_HEAD chars and the last TERMINAL_OUTPUT_TAIL
 * chars, inserting a truncation notice in the middle. The tail is larger because
 * errors and final results appear at the end.
 */
export function truncateTerminalOutput(output: string): string {
  if (output.length <= TERMINAL_OUTPUT_MAX) return output;
  const dropped = output.length - TERMINAL_OUTPUT_HEAD - TERMINAL_OUTPUT_TAIL;
  return (
    output.slice(0, TERMINAL_OUTPUT_HEAD) +
    `\n\n[... ${dropped.toLocaleString()} chars of output omitted — showing first ${TERMINAL_OUTPUT_HEAD.toLocaleString()} and last ${TERMINAL_OUTPUT_TAIL.toLocaleString()} chars ...]\n\n` +
    output.slice(output.length - TERMINAL_OUTPUT_TAIL)
  );
}

export function buildShellToolResult(
  rawOutput: string,
  isError: boolean,
  filterKeywords: string[] = [],
): string {
  const prefix = isError ? 'COMMAND ERROR' : 'TERMINAL OUTPUT';
  return `${prefix}:\n${refineTerminalOutputForAgent(rawOutput, isError, filterKeywords)}`;
}

export function collectShellOutputFilterKeywords(
  args: Record<string, unknown>,
  script: string,
): string[] {
  return normalizeShellOutputKeywords([
    ...keywordsFromUnknown(args.filter_keywords),
    ...keywordsFromUnknown(args.filterKeywords),
    ...keywordsFromUnknown(args.output_keywords),
    ...keywordsFromScriptDirective(script),
  ]);
}

function keywordsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keywordsFromUnknown(item));
  if (typeof value !== 'string') return [];
  return value.split(/[\n,]/);
}

function keywordsFromScriptDirective(script: string): string[] {
  const keywords: string[] = [];
  const directive =
    /(?:^|\n)\s*(?:#|\/\/|--)\s*(?:omni(?:key)?[-_ ]?)?(?:filter|keywords?|required[-_ ]?keywords?)\s*:\s*([^\n]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = directive.exec(script)) !== null) {
    keywords.push(...keywordsFromUnknown(match[1]));
  }

  return keywords;
}

function normalizeShellOutputKeywords(rawKeywords: string[]): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const rawKeyword of rawKeywords) {
    const keyword = rawKeyword
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TERMINAL_OUTPUT_MAX_KEYWORD_LENGTH);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= TERMINAL_OUTPUT_MAX_KEYWORDS) break;
  }

  return keywords;
}

function refineTerminalOutputForAgent(
  rawOutput: string,
  isError: boolean,
  filterKeywords: string[],
): string {
  const output = stripTerminalResultPrefix(stripAnsi(String(rawOutput ?? ''))).trim();
  if (!output) return '(no output)';

  const normalized = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const keywords = normalizeShellOutputKeywords(filterKeywords);
  const hasKeywords = keywords.length > 0;

  if (
    !hasKeywords &&
    normalized.length <= TERMINAL_OUTPUT_PASSTHROUGH_MAX &&
    lines.length <= TERMINAL_OUTPUT_PASSTHROUGH_LINES
  ) {
    return normalized;
  }

  const kept = new Set<number>();
  const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase());

  if (hasKeywords) {
    lines.forEach((line, index) => {
      const lowerLine = line.toLowerCase();
      if (lowerKeywords.some((keyword) => lowerLine.includes(keyword))) {
        addLineRange(
          kept,
          index - TERMINAL_OUTPUT_KEYWORD_CONTEXT_LINES,
          index + TERMINAL_OUTPUT_KEYWORD_CONTEXT_LINES,
          lines.length,
        );
      }
    });
  }

  lines.forEach((line, index) => {
    if (TERMINAL_OUTPUT_SIGNAL_PATTERN.test(line)) {
      addLineRange(
        kept,
        index - TERMINAL_OUTPUT_SIGNAL_CONTEXT_LINES,
        index + TERMINAL_OUTPUT_SIGNAL_CONTEXT_LINES,
        lines.length,
      );
    }
  });

  if (!hasKeywords || isError || kept.size === 0) {
    const headLines = isError ? TERMINAL_OUTPUT_ERROR_HEAD_LINES : TERMINAL_OUTPUT_LARGE_HEAD_LINES;
    const tailLines = isError ? TERMINAL_OUTPUT_ERROR_TAIL_LINES : TERMINAL_OUTPUT_LARGE_TAIL_LINES;
    addLineRange(kept, 0, headLines - 1, lines.length);
    addLineRange(kept, lines.length - tailLines, lines.length - 1, lines.length);
  }

  const ordered = Array.from(kept).sort((a, b) => a - b);
  if (!ordered.length) return truncateTerminalOutput(normalized);

  const rendered = renderSelectedTerminalLines(lines, ordered, keywords);
  const matchingSummary = hasKeywords
    ? `; keywords: ${keywords.map((k) => `"${k}"`).join(', ')}`
    : '';
  const header =
    `[terminal output refined: kept ${ordered.length.toLocaleString()} of ${lines.length.toLocaleString()} lines; ` +
    `original ${normalized.length.toLocaleString()} chars${matchingSummary}]`;
  return truncateRefinedTerminalOutput(`${header}\n${rendered}`);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function stripTerminalResultPrefix(text: string): string {
  return text.replace(/^\s*(?:TERMINAL OUTPUT|COMMAND ERROR):\s*/i, '');
}

function addLineRange(target: Set<number>, start: number, end: number, totalLines: number): void {
  const first = Math.max(0, start);
  const last = Math.min(totalLines - 1, end);
  for (let index = first; index <= last; index++) {
    target.add(index);
  }
}

function renderSelectedTerminalLines(
  lines: string[],
  selectedIndexes: number[],
  keywords: string[],
): string {
  const rendered: string[] = [];
  let previousIndex = -1;

  for (const index of selectedIndexes) {
    if (index > previousIndex + 1) {
      rendered.push(`[... ${index - previousIndex - 1} lines omitted ...]`);
    }
    rendered.push(compactTerminalLine(lines[index], keywords));
    previousIndex = index;
  }

  if (previousIndex < lines.length - 1) {
    rendered.push(`[... ${lines.length - previousIndex - 1} lines omitted ...]`);
  }

  return rendered.join('\n');
}

function compactTerminalLine(line: string, keywords: string[]): string {
  if (line.length <= TERMINAL_OUTPUT_MAX_LINE) return line;

  const lowerLine = line.toLowerCase();
  const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const matchIndex = lowerKeywords.reduce<number>((best, keyword) => {
    const index = lowerLine.indexOf(keyword);
    if (index < 0) return best;
    return best < 0 || index < best ? index : best;
  }, -1);

  if (matchIndex >= 0) {
    const halfWindow = Math.floor(TERMINAL_OUTPUT_MAX_LINE / 2);
    const start = Math.max(0, matchIndex - halfWindow);
    const end = Math.min(line.length, start + TERMINAL_OUTPUT_MAX_LINE);
    return [
      start > 0 ? '[... line prefix omitted ...]' : '',
      line.slice(start, end),
      end < line.length ? '[... line suffix omitted ...]' : '',
    ]
      .filter(Boolean)
      .join('');
  }

  const head = Math.floor(TERMINAL_OUTPUT_MAX_LINE * 0.45);
  const tail = TERMINAL_OUTPUT_MAX_LINE - head;
  return `${line.slice(0, head)}[... ${line.length - TERMINAL_OUTPUT_MAX_LINE} chars omitted from line ...]${line.slice(line.length - tail)}`;
}

function truncateRefinedTerminalOutput(output: string): string {
  if (output.length <= TERMINAL_OUTPUT_REFINED_MAX) return output;
  const head = Math.floor(TERMINAL_OUTPUT_REFINED_MAX * 0.45);
  const tail = TERMINAL_OUTPUT_REFINED_MAX - head - 160;
  const dropped = output.length - head - tail;
  return (
    output.slice(0, head) +
    `\n\n[... ${dropped.toLocaleString()} chars omitted from refined terminal output ...]\n\n` +
    output.slice(output.length - tail)
  );
}
