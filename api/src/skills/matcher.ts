/**
 * Skills v1 deterministic keyword matcher (docs/skills-contract.md).
 *
 * Pure and synchronous: no database, model, tool or network access, no
 * user-supplied regular expressions and no host-locale APIs. Shared by the
 * HTTP preview and agent activation, so both strip the routing prefix and
 * apply the active limits identically.
 *
 * Algorithm: input and keywords are canonicalized with the shared
 * `canonicalizeSkillText` (NFKC -> toLowerCase -> collapse \s -> trim). The
 * whole input string is canonicalized at once, so context-sensitive
 * `toLowerCase` rules (e.g. Greek final sigma) see the full input; a keyword
 * is lowercased on its own. The canonical input is then walked in place by
 * code point (`codePointAt` + UTF-16 cursor; no per-input arrays) through a
 * single Aho-Corasick automaton over all distinct canonical keywords. An
 * occurrence counts only if both outer neighbours are start/end of input or
 * a code point outside [\p{L}\p{N}\p{M}_] (format characters such as U+00AD
 * SOFT HYPHEN are therefore boundaries). Work is O(input + total keyword
 * length + occurrences); occurrences per input position are bounded by the
 * number of distinct keyword lengths (<= keywordCodePoints), and are only
 * enumerated when the shared right-hand neighbour is a boundary, so the scan
 * stays linear even for adversarial inputs.
 *
 * Error and warning messages are fixed strings: never names, keywords,
 * instructions or input text.
 */
import {
  SKILL_LIMITS,
  SkillError,
  type SkillMatchResult,
  type SkillSnapshot,
  type SkillWarning,
} from './contracts';
import {
  canonicalizeSkillText,
  codePointLength,
  compareCodePoints,
  validateSkillInstructions,
  validateSkillKeyword,
  validateSkillName,
} from './validation';

/** Fixed, per-code safe texts (also used as terminal/status error messages). */
export const SKILL_MATCH_MESSAGES = Object.freeze({
  ACTIVE_LIMIT_EXCEEDED: 'Too many skills matched. Use fewer keywords or disable some skills.',
  CONTEXT_LIMIT_EXCEEDED:
    'Matched skill instructions exceed the context budget. Shorten or disable skills.',
  /** Identical to the store's warning text so the resolver deduplicates them. */
  INVALID_SKILL_WARNING: 'A saved skill is invalid and was skipped.',
  INVALID_TEXT: 'Text must be a string.',
  INTERNAL_ERROR: 'Skills could not be processed.',
});

const ROUTING_PREFIXES: readonly string[] = Object.freeze(['@omniagent', '@omnikeyai']);
const LEADING_WHITESPACE = /^\s*/u;
const WHITESPACE_CHAR = /^\s$/u;
const WORD_CHAR = /^[\p{L}\p{N}\p{M}_]$/u;

function asciiLower(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : value[i];
  }
  return out;
}

/**
 * Strip ONE leading transport routing token: optional leading whitespace,
 * then ASCII case-insensitive `@omniagent` or `@omnikeyai` followed by
 * whitespace or end of text. Embedded tokens, other prefixes and
 * fullwidth/look-alike forms are left untouched.
 */
export function stripSkillRoutingPrefix(text: string): string {
  const start = LEADING_WHITESPACE.exec(text)![0].length;
  for (const token of ROUTING_PREFIXES) {
    const end = start + token.length;
    if (asciiLower(text.slice(start, end)) !== token) continue;
    if (end === text.length || WHITESPACE_CHAR.test(text[end])) return text.slice(end);
  }
  return text;
}

/**
 * All-or-nothing active budget shared by preview, activation and the
 * accumulated steering union: <= 8 skills and <= 16,000 aggregate instruction
 * code points. Throws SkillError 413; never truncates or selects a subset.
 *
 * Precondition: `snapshots` must already be validated (e.g. returned by
 * `matchSkills`) and deduplicated by id — for a steering union, keep the
 * first snapshot per id. This function counts entries as given and does not
 * revalidate or deduplicate them.
 */
export function enforceSkillActiveLimits(snapshots: readonly SkillSnapshot[]): void {
  if (snapshots.length > SKILL_LIMITS.active) {
    throw new SkillError(413, 'ACTIVE_LIMIT_EXCEEDED', SKILL_MATCH_MESSAGES.ACTIVE_LIMIT_EXCEEDED);
  }
  let total = 0;
  for (const snapshot of snapshots) total += codePointLength(snapshot.instructions);
  if (total > SKILL_LIMITS.aggregateInstructionCodePoints) {
    throw new SkillError(
      413,
      'CONTEXT_LIMIT_EXCEEDED',
      SKILL_MATCH_MESSAGES.CONTEXT_LIMIT_EXCEEDED,
    );
  }
}

interface ValidSkill {
  snapshot: SkillSnapshot;
  normalizedKeyword: string;
  /** Small (<= keywordCodePoints) per-keyword array; never built for input. */
  keywordCodePoints: number[];
}

function toCodePoints(value: string): number[] {
  const out: number[] = [];
  for (const ch of value) out.push(ch.codePointAt(0)!);
  return out;
}

function isPositiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

type Classified =
  | { kind: 'valid'; id: string; skill: ValidSkill }
  | { kind: 'disabled'; id: string | undefined }
  | { kind: 'invalid'; id: string | undefined };

/** Defensive revalidation; recomputes the canonical keyword, never trusts stored keys. */
function classify(raw: unknown): Classified {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'invalid', id: undefined };
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' && row.id ? row.id : undefined;
  if (row.enabled === false) return { kind: 'disabled', id };
  if (row.enabled !== undefined && row.enabled !== true) return { kind: 'invalid', id };
  const name = validateSkillName(row.name);
  const keyword = validateSkillKeyword(row.keyword);
  const instructions = validateSkillInstructions(row.instructions);
  if (!id || !name.ok || !keyword.ok || !instructions.ok || !isPositiveRevision(row.revision)) {
    return { kind: 'invalid', id };
  }
  const snapshot: SkillSnapshot = Object.freeze({
    id,
    name: name.value,
    keyword: keyword.value.keyword,
    revision: row.revision,
    instructions: instructions.value,
  });
  return {
    kind: 'valid',
    id,
    skill: {
      snapshot,
      normalizedKeyword: keyword.value.normalizedKeyword,
      keywordCodePoints: toCodePoints(keyword.value.normalizedKeyword),
    },
  };
}

/** Distinct canonical keyword; several ids may share one only in defensive cases. */
interface KeywordGroup {
  /** Canonical keyword length in code points. */
  length: number;
  /** Canonical keyword length in UTF-16 units (keywords never hold lone surrogates). */
  utf16Length: number;
  skills: SkillSnapshot[];
  /** First boundary-valid start, in code points of the canonical input; -1 if none. */
  firstOffset: number;
}

/** Optional instrumentation for bounded-work tests. */
export interface SkillScanStats {
  /**
   * Canonical input code points actually scanned (after prefix strip and
   * canonicalization); fewer than the input when the scan stops early, and 0
   * when no enabled valid skill exists (input is then not canonicalized).
   */
  inputCodePoints: number;
  /** Automaton transitions + failure-link steps + occurrence checks. */
  steps: number;
}

// Static ASCII table; non-ASCII code points use the fixed Unicode property regex.
const ASCII_WORD = new Uint8Array(128);
for (let cp = 0; cp < 128; cp += 1) {
  ASCII_WORD[cp] = WORD_CHAR.test(String.fromCharCode(cp)) ? 1 : 0;
}
const WORD_CACHE_LIMIT = 4_096;

/** Code point ending at UTF-16 index `end` (exclusive), or -1 at start of text. */
function codePointBefore(text: string, end: number): number {
  if (end <= 0) return -1;
  const unit = text.charCodeAt(end - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && end >= 2) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(end - 2)!;
  }
  return unit;
}

function scanFirstOccurrences(
  input: string,
  groups: readonly KeywordGroup[],
  keywords: readonly (readonly number[])[],
  stats: SkillScanStats | undefined,
): void {
  // Trie.
  const next: Map<number, number>[] = [new Map()];
  const terminal: number[] = [-1];
  for (let g = 0; g < keywords.length; g += 1) {
    let node = 0;
    for (const cp of keywords[g]) {
      let child = next[node].get(cp);
      if (child === undefined) {
        child = next.length;
        next.push(new Map());
        terminal.push(-1);
        next[node].set(cp, child);
      }
      node = child;
    }
    terminal[node] = g;
  }
  // Failure and dictionary-suffix links (BFS).
  const fail = new Int32Array(next.length);
  const dict = new Int32Array(next.length).fill(-1);
  const queue: number[] = [];
  for (const child of next[0].values()) queue.push(child);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    for (const [cp, child] of next[node]) {
      let f = fail[node];
      while (f !== 0 && !next[f].has(cp)) f = fail[f];
      const target = next[f].get(cp);
      fail[child] = target !== undefined && target !== child ? target : 0;
      dict[child] = terminal[fail[child]] >= 0 ? fail[child] : dict[fail[child]];
      queue.push(child);
    }
  }

  // Bounded per-call cache for non-ASCII classification (memory independent of input size).
  const wordCache = new Map<number, boolean>();
  const isBoundaryCodePoint = (cp: number): boolean => {
    if (cp < 0) return true; // start or end of input
    if (cp < 128) return ASCII_WORD[cp] === 0;
    let word = wordCache.get(cp);
    if (word === undefined) {
      word = WORD_CHAR.test(String.fromCodePoint(cp));
      if (wordCache.size < WORD_CACHE_LIMIT) wordCache.set(cp, word);
    }
    return !word;
  };

  const end16 = input.length;
  let remaining = groups.length;
  let foundSkills = 0;
  let steps = 0;
  let state = 0;
  let cpIndex = 0; // code points consumed so far
  let pos = 0; // UTF-16 cursor just after the current code point
  scan: while (pos < end16 && remaining > 0) {
    // Same pairing as the string iterator: lone surrogates are single units.
    const cp = input.codePointAt(pos)!;
    pos += cp > 0xffff ? 2 : 1;
    cpIndex += 1;
    while (state !== 0 && !next[state].has(cp)) {
      state = fail[state];
      steps += 1;
    }
    state = next[state].get(cp) ?? 0;
    steps += 1;
    let t = terminal[state] >= 0 ? state : dict[state];
    if (t === -1) continue;
    // Every occurrence ending here shares the right-hand neighbour.
    if (!isBoundaryCodePoint(pos < end16 ? input.codePointAt(pos)! : -1)) {
      steps += 1;
      continue;
    }
    for (; t !== -1; t = dict[t]) {
      steps += 1;
      const group = groups[terminal[t]];
      if (group.firstOffset >= 0) continue;
      // Matched code points equal the keyword's, so their UTF-16 width does too.
      if (!isBoundaryCodePoint(codePointBefore(input, pos - group.utf16Length))) continue;
      group.firstOffset = cpIndex - group.length;
      remaining -= 1;
      foundSkills += group.skills.length;
      // The input is rejected regardless of what else matches.
      if (foundSkills > SKILL_LIMITS.active) break scan;
    }
  }
  if (stats) {
    stats.inputCodePoints = cpIndex;
    stats.steps = steps;
  }
}

/**
 * Match enabled skill snapshots against one genuine raw input.
 *
 * - Strips one leading routing prefix itself; callers pass raw text.
 * - No raw-input size cap (the preview route enforces its own limit).
 * - Disabled runtime objects (`enabled: false`) are ignored silently and do
 *   not reserve their id; malformed snapshots are skipped with INVALID_SKILL.
 *   For duplicate ids the first non-disabled row wins even if it is invalid;
 *   later same-id rows are skipped under that id's single warning.
 * - Returns early (before prefix stripping/canonicalization) when no enabled
 *   valid skill remains.
 * - Every distinct matching id appears once, ordered by first normalized
 *   code-point offset, then longer canonical keyword, then id by code point.
 * - Over-limit results throw SkillError (413); no partial matches.
 * - Never mutates `rawText` or `snapshots`; returned arrays/objects are frozen.
 */
export function matchSkills(
  rawText: string,
  snapshots: readonly SkillSnapshot[],
  stats?: SkillScanStats,
): SkillMatchResult {
  const result = matchSkillsUnbudgeted(rawText, snapshots, stats);
  enforceSkillActiveLimits(result.matches);
  return result;
}

/**
 * Same deterministic matching as `matchSkills` WITHOUT the active limits.
 * Only for callers that validate a larger union themselves before use (agent
 * steering: the first snapshot already active in a run must count, not the
 * current stored revision). Callers must run `enforceSkillActiveLimits` on
 * the deduplicated union before applying anything.
 */
export function matchSkillsUnbudgeted(
  rawText: string,
  snapshots: readonly SkillSnapshot[],
  stats?: SkillScanStats,
): SkillMatchResult {
  if (typeof rawText !== 'string') {
    throw new SkillError(400, 'VALIDATION_ERROR', SKILL_MATCH_MESSAGES.INVALID_TEXT, {
      text: SKILL_MATCH_MESSAGES.INVALID_TEXT,
    });
  }
  if (!Array.isArray(snapshots)) {
    throw new SkillError(500, 'INTERNAL_ERROR', SKILL_MATCH_MESSAGES.INTERNAL_ERROR);
  }

  const seenIds = new Set<string>();
  const warnedIds = new Set<string>();
  let warnedAnonymous = false;
  const warnings: SkillWarning[] = [];
  const warn = (id: string | undefined): void => {
    if (id === undefined ? warnedAnonymous : warnedIds.has(id)) return;
    if (id === undefined) warnedAnonymous = true;
    else warnedIds.add(id);
    warnings.push(
      Object.freeze({
        code: 'INVALID_SKILL' as const,
        ...(id !== undefined ? { skillId: id } : {}),
        message: SKILL_MATCH_MESSAGES.INVALID_SKILL_WARNING,
      }),
    );
  };

  const groupByKeyword = new Map<string, number>();
  const groups: KeywordGroup[] = [];
  const keywords: number[][] = [];
  for (const raw of snapshots) {
    const result = classify(raw);
    // Disabled rows are invisible: they neither warn nor reserve their id.
    if (result.kind === 'disabled') continue;
    // First non-disabled row per id wins, valid or not: an earlier invalid row
    // keeps its id reserved, so a later same-id row is skipped (one warning).
    if (result.id !== undefined) {
      if (seenIds.has(result.id)) {
        warn(result.id);
        continue;
      }
      seenIds.add(result.id);
    }
    if (result.kind === 'invalid') {
      warn(result.id);
      continue;
    }
    const { snapshot, normalizedKeyword, keywordCodePoints } = result.skill;
    let index = groupByKeyword.get(normalizedKeyword);
    if (index === undefined) {
      index = groups.length;
      groupByKeyword.set(normalizedKeyword, index);
      groups.push({
        length: keywordCodePoints.length,
        utf16Length: normalizedKeyword.length,
        skills: [],
        firstOffset: -1,
      });
      keywords.push(keywordCodePoints);
    }
    groups[index].skills.push(snapshot);
  }
  warnings.sort((a, b) => compareCodePoints(a.skillId ?? '', b.skillId ?? ''));
  const frozenWarnings = Object.freeze(warnings);

  if (stats) {
    stats.inputCodePoints = 0;
    stats.steps = 0;
  }
  // Nothing can match: skip prefix stripping and canonicalization of the input.
  if (groups.length === 0) {
    return { matches: Object.freeze([]), warnings: frozenWarnings };
  }

  const canonical = canonicalizeSkillText(stripSkillRoutingPrefix(rawText));
  if (canonical.length > 0) scanFirstOccurrences(canonical, groups, keywords, stats);

  const matched: { snapshot: SkillSnapshot; offset: number; length: number }[] = [];
  for (const group of groups) {
    if (group.firstOffset < 0) continue;
    for (const snapshot of group.skills) {
      matched.push({ snapshot, offset: group.firstOffset, length: group.length });
    }
  }
  matched.sort(
    (a, b) =>
      a.offset - b.offset || b.length - a.length || compareCodePoints(a.snapshot.id, b.snapshot.id),
  );
  const matches = matched.map((entry) => entry.snapshot);
  return { matches: Object.freeze(matches), warnings: frozenWarnings };
}
