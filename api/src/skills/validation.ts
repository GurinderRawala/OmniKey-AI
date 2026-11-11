/**
 * Skills v1 canonicalization and input validation (docs/skills-contract.md).
 *
 * Pure, locale-independent helpers shared by the store/routes (S1) and the
 * matcher (S2). Error messages are fixed strings: they never echo names,
 * keywords or instruction text back to callers or logs.
 */
import { SKILL_LIMITS } from './contracts';

export const RESERVED_SKILL_KEYWORDS: readonly string[] = Object.freeze([
  '@omniagent',
  '@omnikeyai',
]);

export type SkillField = 'name' | 'keyword' | 'instructions' | 'enabled' | 'body';
export type SkillFieldErrors = Partial<Record<SkillField, string>>;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fields: Record<string, string> };

/** Validated, normalized values ready for persistence. */
export interface NormalizedSkillFields {
  name: string;
  keyword: string;
  normalizedKeyword: string;
  instructions: string;
  enabled: boolean;
}

export type NormalizedSkillPatch = Partial<NormalizedSkillFields>;

const WHITESPACE_RUN = /\s+/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
// Controls (C0, DEL, C1), format characters (bidi/zero-width), line/paragraph
// separators and lone surrogates are not allowed in single-line labels.
const LABEL_DISALLOWED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
// Instructions allow tab and LF (after CR normalization) but no other controls.
const INSTRUCTION_DISALLOWED = /[^\P{Cc}\t\n]|\p{Cs}/u;
const IF_MATCH = /^"([1-9][0-9]*)"$/;

/** Number of Unicode code points (not UTF-16 code units). */
export function codePointLength(value: string): number {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) count += 1;
  return count;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Canonical comparison form: NFKC -> locale-independent lowercase ->
 * collapse ECMAScript Unicode whitespace runs to one space -> trim.
 * Used for keywords and (by the matcher) for raw input text.
 */
export function canonicalizeSkillText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(WHITESPACE_RUN, ' ').trim();
}

export const canonicalizeKeyword = canonicalizeSkillText;

/** Compare strings by Unicode code point, independent of host locale. */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done || r.done) return l.done === r.done ? 0 : l.done ? -1 : 1;
    const diff = l.value.codePointAt(0)! - r.value.codePointAt(0)!;
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function validateSkillName(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return fail('name', 'Name must be a string.');
  const value = raw.trim();
  if (!value) return fail('name', 'Name is required.');
  if (LABEL_DISALLOWED.test(value)) return fail('name', 'Name contains unsupported characters.');
  if (codePointLength(value) > SKILL_LIMITS.nameCodePoints) {
    return fail('name', `Name must be at most ${SKILL_LIMITS.nameCodePoints} characters.`);
  }
  return { ok: true, value };
}

export function validateSkillKeyword(
  raw: unknown,
): ValidationResult<{ keyword: string; normalizedKeyword: string }> {
  if (typeof raw !== 'string') return fail('keyword', 'Keyword must be a string.');
  const keyword = raw.trim();
  if (!keyword) return fail('keyword', 'Keyword is required.');
  if (LABEL_DISALLOWED.test(keyword)) {
    return fail('keyword', 'Keyword contains unsupported characters.');
  }
  const limit = SKILL_LIMITS.keywordCodePoints;
  if (codePointLength(keyword) > limit) {
    return fail('keyword', `Keyword must be at most ${limit} characters.`);
  }
  const normalizedKeyword = canonicalizeKeyword(keyword);
  if (!normalizedKeyword || codePointLength(normalizedKeyword) > limit) {
    return fail('keyword', `Keyword must be at most ${limit} characters after normalization.`);
  }
  if (!LETTER_OR_NUMBER.test(normalizedKeyword)) {
    return fail('keyword', 'Keyword must contain at least one letter or number.');
  }
  if (RESERVED_SKILL_KEYWORDS.includes(normalizedKeyword)) {
    return fail('keyword', 'Keyword is reserved.');
  }
  return { ok: true, value: { keyword, normalizedKeyword } };
}

export function validateSkillInstructions(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return fail('instructions', 'Instructions must be a string.');
  const value = normalizeLineEndings(raw);
  if (!value.trim()) return fail('instructions', 'Instructions are required.');
  if (INSTRUCTION_DISALLOWED.test(value)) {
    return fail('instructions', 'Instructions contain unsupported control characters.');
  }
  if (
    codePointLength(value) > SKILL_LIMITS.instructionCodePoints ||
    utf8ByteLength(value) > SKILL_LIMITS.instructionBytes
  ) {
    return fail(
      'instructions',
      `Instructions must be at most ${SKILL_LIMITS.instructionCodePoints} characters and ${SKILL_LIMITS.instructionBytes} bytes.`,
    );
  }
  return { ok: true, value };
}

const CREATE_KEYS = new Set(['name', 'keyword', 'instructions', 'enabled']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectFields(
  body: Record<string, unknown>,
  required: boolean,
): ValidationResult<NormalizedSkillPatch> {
  const fields: SkillFieldErrors = {};
  const out: NormalizedSkillPatch = {};
  const unknown = Object.keys(body).filter((key) => !CREATE_KEYS.has(key));
  if (unknown.length > 0) fields.body = 'Request contains unsupported fields.';

  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  if (has('name') || required) {
    const r = validateSkillName(body.name);
    if (r.ok) out.name = r.value;
    else Object.assign(fields, r.fields);
  }
  if (has('keyword') || required) {
    const r = validateSkillKeyword(body.keyword);
    if (r.ok) Object.assign(out, r.value);
    else Object.assign(fields, r.fields);
  }
  if (has('instructions') || required) {
    const r = validateSkillInstructions(body.instructions);
    if (r.ok) out.instructions = r.value;
    else Object.assign(fields, r.fields);
  }
  if (has('enabled')) {
    if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
    else fields.enabled = 'Enabled must be a boolean.';
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: out };
}

/** Strict create body: name/keyword/instructions required, enabled optional (default true). */
export function parseSkillCreate(body: unknown): ValidationResult<NormalizedSkillFields> {
  if (!isPlainObject(body)) return fail('body', 'Request body must be a JSON object.');
  const r = collectFields(body, true);
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      ...(r.value as Omit<NormalizedSkillFields, 'enabled'>),
      enabled: r.value.enabled ?? true,
    },
  };
}

/** Strict partial patch; at least one mutable field is required. */
export function parseSkillPatch(body: unknown): ValidationResult<NormalizedSkillPatch> {
  if (!isPlainObject(body)) return fail('body', 'Request body must be a JSON object.');
  if (Object.keys(body).length === 0) return fail('body', 'At least one field is required.');
  return collectFields(body, false);
}

export type PreviewTextResult =
  | { ok: true; value: string }
  | { ok: false; tooLarge: true }
  | { ok: false; tooLarge?: false; fields: Record<string, string> };

/** Strict preview body `{text}` with the HTTP-preview-only size limits. */
export function parseSkillPreview(body: unknown): PreviewTextResult {
  if (!isPlainObject(body)) return fail('body', 'Request body must be a JSON object.');
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'text'))
    return fail('body', 'Request contains unsupported fields.');
  const text = body.text;
  if (typeof text !== 'string') return fail('text', 'Text must be a string.');
  if (
    codePointLength(text) > SKILL_LIMITS.previewInputCodePoints ||
    utf8ByteLength(text) > SKILL_LIMITS.previewInputBytes
  ) {
    return { ok: false, tooLarge: true };
  }
  if (text.includes('\u0000')) return fail('text', 'Text contains unsupported characters.');
  return { ok: true, value: text };
}

/**
 * Parse a strong If-Match revision: exactly one quoted positive safe integer
 * without leading zeros. Returns `missing` when absent, `invalid` otherwise.
 */
export function parseIfMatchRevision(
  header: string | string[] | undefined,
): { ok: true; revision: number } | { ok: false; reason: 'missing' | 'invalid' } {
  if (header === undefined) return { ok: false, reason: 'missing' };
  if (Array.isArray(header) || typeof header !== 'string') return { ok: false, reason: 'invalid' };
  const match = IF_MATCH.exec(header);
  if (!match) return { ok: false, reason: 'invalid' };
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) return { ok: false, reason: 'invalid' };
  return { ok: true, revision };
}

export function revisionETag(revision: number): string {
  return `"${revision}"`;
}

function fail(field: string, message: string): { ok: false; fields: Record<string, string> } {
  return { ok: false, fields: { [field]: message } };
}
