/**
 * Skills v1 matcher fixtures (docs/skills-contract.md). Pure: no DB, model or
 * network. Non-ASCII characters are written as \u{...} escapes on purpose so
 * composed/decomposed and invisible characters are unambiguous in source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SKILL_LIMITS,
  SkillError,
  type MatchSkills,
  type SkillSnapshot,
} from '../skills/contracts';
import {
  SKILL_MATCH_MESSAGES,
  enforceSkillActiveLimits,
  matchSkills,
  stripSkillRoutingPrefix,
  type SkillScanStats,
} from '../skills/matcher';
import { SKILL_ERROR_MESSAGES } from '../skills/skillStore';

const E_ACUTE = '\u{E9}';
const FULLWIDTH_CODE = '\u{FF23}\u{FF2F}\u{FF24}\u{FF25}';
const FULLWIDTH_SQL = '\u{FF33}\u{FF31}\u{FF2C}';
const IDEOGRAPHIC_SPACE = '\u{3000}';
const FULLWIDTH_AT = '\u{FF20}';
const SHUJU = '\u{6570}\u{636E}'; // "data"
const EMOJI = '\u{1F600}';

let seq = 0;
function skill(keyword: string, overrides: Partial<Record<string, unknown>> = {}): SkillSnapshot {
  seq += 1;
  return {
    id: `s${String(seq).padStart(4, '0')}`,
    name: `Skill ${seq}`,
    keyword,
    revision: 1,
    instructions: 'Do the thing.',
    ...overrides,
  } as SkillSnapshot;
}

const ids = (text: string, snapshots: readonly SkillSnapshot[]) =>
  matchSkills(text, snapshots).matches.map((m) => m.id);
const matchesKeyword = (text: string, keyword: string) =>
  matchSkills(text, [skill(keyword)]).matches.length === 1;

function expectSkillError(fn: () => unknown, code: string, status: number): SkillError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SkillError);
    expect((err as SkillError).code).toBe(code);
    expect((err as SkillError).status).toBe(status);
    return err as SkillError;
  }
  throw new Error('expected SkillError');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contract acceptance fixtures', () => {
  it.each([
    ['(SQL)', 'sql', true],
    ['nosql sql2 sql_helper', 'sql', false],
    [`${FULLWIDTH_CODE}${IDEOGRAPHIC_SPACE}Review!`, 'code review', true],
    ['code\n   \t review', 'code review', true],
    ['code-review code reviewer', 'code review', false],
    ['c++', 'c++', true],
    ['I use c++ daily', 'C++', true],
    ['abc++ c++17', 'c++', false],
    [`caf${E_ACUTE}`, `caf${E_ACUTE}`, true],
    ['cafe\u{301}', `caf${E_ACUTE}`, true], // decomposed input, composed keyword
    [`caf${E_ACUTE}`, 'cafe\u{301}', true], // composed input, decomposed keyword
    ['cafe\u{301}', 'cafe', false],
    ['STRASSE', 'Stra\u{DF}e', false], // no full case folding
    [`${SHUJU}\u{5E93}`, SHUJU, false], // strict CJK boundaries
    [`\u{770B} ${SHUJU} \u{5427}`, SHUJU, true],
    ['"sql" and ```\nsql\n```', 'sql', true],
    ['\u{130}', 'i', false], // U+0130 lowercases to i + combining dot above
    ['\u{FB01}le', 'file', true], // fi ligature via NFKC
    ['sql\u{301}', 'sql', false], // combining mark after keyword
    ['sql\u{300} x', 'sql', false],
    ['sql at start', 'sql', true],
    ['ends with sql', 'sql', true],
    ['sql', 'sql', true],
    ['sql_', 'sql', false],
    ['_sql', 'sql', false],
    ['sql1', 'sql', false],
    ['1sql', 'sql', false],
    ['sql.', 'sql', true],
    ['a.b', 'a.b', true],
    ['axb', 'a.b', false],
    ['aab', 'a+b', false],
    ['NoSQL', 'sql', false],
  ])('%j with keyword %j -> %s', (text, keyword, expected) => {
    expect(matchesKeyword(text, keyword)).toBe(expected);
  });

  it('overlapping phrases all match; longer first at the same offset', () => {
    const code = skill('code', { id: 'a-code' });
    const review = skill('code review', { id: 'z-review' });
    const rev = skill('review', { id: 'b-review' });
    expect(ids('please code review now', [code, rev, review])).toEqual([
      'z-review',
      'a-code',
      'b-review',
    ]);
  });

  it('orders by first occurrence offset, not snapshot order', () => {
    const late = skill('zeta', { id: 'a' });
    const early = skill('alpha', { id: 'b' });
    expect(ids('alpha then zeta then alpha', [late, early])).toEqual(['b', 'a']);
    expect(ids('zeta alpha', [late, early])).toEqual(['a', 'b']);
  });

  it('uses the first boundary-valid occurrence for ordering', () => {
    const sql = skill('sql', { id: 'a' });
    const go = skill('go', { id: 'b' });
    // nosql/sql2 occurrences before "go" are not valid matches.
    expect(ids('nosql sql2 go sql', [sql, go])).toEqual(['b', 'a']);
  });

  it('repeated keyword activates once per id', () => {
    const result = matchSkills('sql sql SQL (sql)', [skill('sql')]);
    expect(result.matches).toHaveLength(1);
  });

  it('ties at the same offset/length order by id code point, not UTF-16 units', () => {
    // U+FF61 < U+1F600 by code point; UTF-16 sorts the surrogate (0xD83D) first.
    const bmpId = '\u{FF61}';
    const bmp = skill('same', { id: bmpId });
    const astral = skill('same', { id: EMOJI });
    expect([EMOJI, bmpId].sort()).toEqual([EMOJI, bmpId]);
    expect(ids('same', [astral, bmp])).toEqual([bmpId, EMOJI]);
    expect(ids('same', [bmp, astral])).toEqual([bmpId, EMOJI]);
  });

  it('handles astral characters as single code points at boundaries', () => {
    expect(matchesKeyword(`${EMOJI}sql${EMOJI}`, 'sql')).toBe(true); // emoji is not a word char
    expect(matchesKeyword('\u{10428}sql', 'sql')).toBe(false); // Deseret letter is a word char
    expect(matchesKeyword('sql\u{10428}', 'sql')).toBe(false);
    expect(matchesKeyword('x \u{10400}\u{10428} y', '\u{10428}\u{10428}')).toBe(true);
    const a = skill(`${EMOJI} sql`, { id: 'a' });
    const b = skill('sql', { id: 'b' });
    expect(ids(`x ${EMOJI} sql`, [b, a])).toEqual(['a', 'b']);
  });

  it('lone surrogates in input do not break scanning', () => {
    expect(matchesKeyword('\u{D800} sql \u{DC00}', 'sql')).toBe(true);
    // Lone surrogates directly adjacent are non-word neighbours.
    expect(matchesKeyword('\u{DC00}sql\u{D800}', 'sql')).toBe(true);
    expect(matchesKeyword('\u{D801}\u{D801}\u{DC28}sql', 'sql')).toBe(false); // lone high + Deseret letter
    expect(matchesKeyword('\u{DC28}\u{DC28}sql', 'sql')).toBe(true); // two lone lows, no pair
  });

  describe('Greek final sigma follows whole-input String#toLowerCase exactly', () => {
    // Input is lowercased as one string, so U+03A3 becomes final U+03C2 only
    // when not followed (past case-ignorables such as ' or U+00AD) by a cased
    // letter. A keyword is lowercased alone, so a trailing capital sigma is
    // final. No extra folding is applied: sigma forms stay distinct.
    const ODOS_UPPER = '\u{39F}\u{394}\u{39F}\u{3A3}';
    const ODOS_FINAL = '\u{3BF}\u{3B4}\u{3BF}\u{3C2}';
    const ODOS_MEDIAL = '\u{3BF}\u{3B4}\u{3BF}\u{3C3}';
    it.each([
      [ODOS_UPPER, ODOS_UPPER, true],
      [`${ODOS_UPPER} x`, ODOS_FINAL, true],
      [ODOS_UPPER, ODOS_MEDIAL, false],
      [`${ODOS_UPPER}'\u{391}`, ODOS_UPPER, false], // input sigma becomes medial
      [`${ODOS_UPPER}'\u{391}`, ODOS_MEDIAL, true],
      [`${ODOS_UPPER}\u{AD}\u{391}`, ODOS_UPPER, false], // soft hyphen is case-ignorable
    ])('%j with keyword %j -> %s', (text, keyword, expected) => {
      expect(matchesKeyword(text, keyword)).toBe(expected);
    });
  });

  it('U+00AD SOFT HYPHEN is a boundary (Cf, not L/N/M/_) and is rejected in keywords', () => {
    expect(matchesKeyword('sql\u{AD}x', 'sql')).toBe(true);
    expect(matchesKeyword('x\u{AD}sql', 'sql')).toBe(true);
    expect(matchesKeyword('co\u{AD}de', 'code')).toBe(false); // not removed by NFKC
    const result = matchSkills('code', [skill('co\u{AD}de', { id: 'shy' })]);
    expect(result.matches).toEqual([]);
    expect(result.warnings.map((w) => w.skillId)).toEqual(['shy']);
  });
});

describe('routing prefix', () => {
  it.each([
    ['@omniagent sql', ' sql'],
    ['  @OmniAgent\tsql', '\tsql'],
    ['@OMNIKEYAI', ''],
    [`@omnikeyai${IDEOGRAPHIC_SPACE}x`, `${IDEOGRAPHIC_SPACE}x`],
    ['@omniagentsql', '@omniagentsql'],
    ['hi @omniagent sql', 'hi @omniagent sql'],
    [`${FULLWIDTH_AT}omniagent sql`, `${FULLWIDTH_AT}omniagent sql`],
    ['@omn\u{131}agent sql', '@omn\u{131}agent sql'], // dotless i is not ASCII
    ['@omniagent @omnikeyai x', ' @omnikeyai x'],
    ['', ''],
  ])('stripSkillRoutingPrefix(%j) -> %j', (input, expected) => {
    expect(stripSkillRoutingPrefix(input)).toBe(expected);
  });

  it('matcher strips the leading prefix itself but not embedded tokens', () => {
    const omni = skill('omniagent');
    expect(matchSkills('@omniagent please help', [omni]).matches).toHaveLength(0);
    expect(matchSkills('@omniagent ask omniagent', [omni]).matches).toHaveLength(1);
    expect(matchSkills('hi @omniagent', [omni]).matches).toHaveLength(1);
  });
});

describe('empty input and snapshots', () => {
  it.each(['', '   ', `\n\t${IDEOGRAPHIC_SPACE}`, '@omniagent', '  @omniagent  '])(
    'empty/whitespace input %j has no matches',
    (text) => {
      expect(matchSkills(text, [skill('sql')]).matches).toEqual([]);
    },
  );

  it('no snapshots gives an empty, frozen result', () => {
    const result = matchSkills('sql', []);
    expect(result).toEqual({ matches: [], warnings: [] });
    expect(Object.isFrozen(result.matches)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
  });

  it('returns before prefix stripping/canonicalization when no enabled valid skill exists', () => {
    const big = `@omniagent ${'Caf\u{E9} SQL '.repeat(50_000)}`;
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const stats: SkillScanStats = { inputCodePoints: -1, steps: -1 };
    const empty = matchSkills(big, [], stats);
    const disabledOnly = matchSkills(big, [skill('sql', { enabled: false })]);
    expect(normalize).not.toHaveBeenCalled();
    // Invalid rows still get keyword validation, but the input is never normalized.
    const invalidOnly = matchSkills(big, [skill('!!!', { id: 'bad' })]);
    expect(normalize.mock.contexts.some((ctx) => String(ctx) === big)).toBe(false);
    normalize.mockRestore();
    expect(empty).toEqual({ matches: [], warnings: [] });
    expect(Object.isFrozen(empty.matches)).toBe(true);
    expect(Object.isFrozen(empty.warnings)).toBe(true);
    expect(stats).toEqual({ inputCodePoints: 0, steps: 0 });
    expect(disabledOnly).toEqual({ matches: [], warnings: [] });
    expect(invalidOnly.matches).toEqual([]);
    expect(invalidOnly.warnings.map((w) => w.skillId)).toEqual(['bad']);
  });

  it('rejects non-string text and non-array snapshots with safe SkillErrors', () => {
    expectSkillError(
      () => matchSkills(undefined as unknown as string, []),
      'VALIDATION_ERROR',
      400,
    );
    expectSkillError(
      () => matchSkills('x', null as unknown as SkillSnapshot[]),
      'INTERNAL_ERROR',
      500,
    );
  });

  it('does not cap raw agent input (preview cap is route-only)', () => {
    const big = `${'x '.repeat(SKILL_LIMITS.previewInputCodePoints)}sql`;
    expect(matchSkills(big, [skill('sql')]).matches).toHaveLength(1);
  });
});

describe('disabled, invalid and duplicate snapshots', () => {
  it('ignores runtime objects with enabled=false silently', () => {
    const off = skill('sql', { enabled: false });
    const on = skill('go', { enabled: true });
    const result = matchSkills('sql go', [off, on]);
    expect(result.matches.map((m) => m.id)).toEqual([on.id]);
    expect(result.warnings).toEqual([]);
  });

  it('warn-skips malformed rows and continues valid matches', () => {
    const good = skill('sql', { id: 'good' });
    const bad: unknown[] = [
      skill('sql', { id: 'bad-name', name: '' }),
      skill('', { id: 'bad-keyword' }),
      skill('!!!', { id: 'punct-keyword' }),
      skill('@omniagent', { id: 'reserved' }),
      skill(`${FULLWIDTH_AT}omniagent`, { id: 'reserved-fullwidth' }),
      skill(EMOJI, { id: 'emoji-only' }),
      skill('sql', { id: 'blank-instr', instructions: '   ' }),
      skill('sql', { id: 'ctrl-instr', instructions: 'a\u{7}b' }),
      skill('sql', { id: 'long-instr', instructions: 'x'.repeat(8_001) }),
      skill('sql', { id: 'rev0', revision: 0 }),
      skill('sql', { id: 'rev-frac', revision: 1.5 }),
      skill('sql', { id: 'rev-str', revision: '1' }),
      skill('sql', { id: 'enabled-str', enabled: 'false' }),
      skill('sql', { id: 'nl-keyword', keyword: 'sq\nl' }),
      skill('sql', { id: 'bidi-name', name: 'a\u{202E}b' }), // RIGHT-TO-LEFT OVERRIDE
      skill('k'.repeat(81), { id: 'long-keyword' }),
      skill('sql', { id: '' }),
      skill('sql', { id: 42 }),
      null,
      'sql',
      ['sql'],
    ];
    const result = matchSkills('sql', [...(bad as SkillSnapshot[]), good]);
    expect(result.matches.map((m) => m.id)).toEqual(['good']);
    expect(result.warnings.map((w) => w.skillId)).toEqual([
      undefined,
      'bad-keyword',
      'bad-name',
      'bidi-name',
      'blank-instr',
      'ctrl-instr',
      'emoji-only',
      'enabled-str',
      'long-instr',
      'long-keyword',
      'nl-keyword',
      'punct-keyword',
      'reserved',
      'reserved-fullwidth',
      'rev-frac',
      'rev-str',
      'rev0',
    ]);
    for (const w of result.warnings) {
      expect(w.code).toBe('INVALID_SKILL');
      expect(w.message).toBe(SKILL_ERROR_MESSAGES.INVALID_SKILL_WARNING);
      expect(Object.isFrozen(w)).toBe(true);
    }
    // Warnings never echo keywords/instructions.
    expect(JSON.stringify(result.warnings)).not.toMatch(/sql|Do the thing/);
  });

  it('accepts instruction cap edges and CRLF input', () => {
    const exact = skill('sql', { instructions: E_ACUTE.repeat(8_000) });
    expect(matchSkills('sql', [exact]).matches).toHaveLength(1);
    const crlf = skill('go', { instructions: 'a\r\nb\rc' });
    expect(matchSkills('go', [crlf]).matches[0].instructions).toBe('a\nb\nc');
    expect(crlf.instructions).toBe('a\r\nb\rc');
    // 8,000 four-byte code points = 32,000 bytes: within both caps.
    const astral = skill('x0', { instructions: EMOJI.repeat(8_000) });
    expect(matchSkills('x0', [astral]).matches).toHaveLength(1);
    const tooLong = skill('x1', { instructions: EMOJI.repeat(8_001) });
    expect(matchSkills('x1', [tooLong]).warnings).toHaveLength(1);
  });

  it('deduplicates ids: first occurrence wins, later duplicates warn once', () => {
    const first = skill('sql', { id: 'dup', name: 'First' });
    const second = skill('go', { id: 'dup', name: 'Second' });
    const third = skill('go', { id: 'dup', name: 'Third' });
    const result = matchSkills('sql go', [first, second, third]);
    expect(result.matches.map((m) => m.name)).toEqual(['First']);
    expect(result.warnings).toEqual([
      {
        code: 'INVALID_SKILL',
        skillId: 'dup',
        message: SKILL_MATCH_MESSAGES.INVALID_SKILL_WARNING,
      },
    ]);
  });

  it('disabled rows neither warn nor reserve their id', () => {
    const offFirst = skill('sql', { id: 'dup', enabled: false, name: 'Off' });
    const on = skill('go', { id: 'dup', name: 'On' });
    const offLater = skill('go', { id: 'dup', enabled: false, name: 'Off later' });
    for (const order of [
      [offFirst, on],
      [on, offLater],
      [offFirst, on, offLater],
    ]) {
      const result = matchSkills('sql go', order);
      expect(result.matches.map((m) => m.name)).toEqual(['On']);
      expect(result.warnings).toEqual([]);
    }
    // Disabled + malformed is still just disabled (silent).
    expect(matchSkills('sql', [skill('', { id: 'x', enabled: false })]).warnings).toEqual([]);
  });

  it('documented first-wins: an earlier invalid row keeps its id reserved', () => {
    const invalid = skill('sql', { id: 'dup', revision: 0 });
    const valid = skill('sql', { id: 'dup' });
    const blocked = matchSkills('sql', [invalid, valid]);
    expect(blocked.matches).toEqual([]);
    expect(blocked.warnings.map((w) => w.skillId)).toEqual(['dup']);
    const kept = matchSkills('sql', [valid, invalid]);
    expect(kept.matches.map((m) => m.id)).toEqual(['dup']);
    expect(kept.warnings.map((w) => w.skillId)).toEqual(['dup']);
  });

  it('recomputes canonical keywords and ignores any stored normalizedKeyword', () => {
    const s = skill(`  ${FULLWIDTH_SQL}  `, { normalizedKeyword: 'something-else' });
    const result = matchSkills('sql', [s]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({
      id: s.id,
      name: s.name,
      keyword: FULLWIDTH_SQL,
      revision: 1,
      instructions: 'Do the thing.',
    });
  });

  it('distinct ids with the same canonical keyword all match (defensive)', () => {
    const a = skill('Code Review', { id: 'b' });
    const b = skill('code  review', { id: 'a' });
    const c = skill(`${FULLWIDTH_CODE} review`, { id: 'c' });
    expect(ids('code review', [a, b, c])).toEqual(['a', 'b', 'c']);
  });

  it('warnings are emitted even when nothing matches', () => {
    const result = matchSkills('', [skill('', { id: 'bad' })]);
    expect(result.warnings.map((w) => w.skillId)).toEqual(['bad']);
  });
});

describe('active limits', () => {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];

  it('accepts exactly 8 matches and exactly 16,000 aggregate code points', () => {
    const eight = words.slice(0, 8).map((w) => skill(w, { instructions: E_ACUTE.repeat(2_000) }));
    expect(matchSkills(words.join(' '), eight).matches).toHaveLength(8);
  });

  it('rejects 9 matches entirely (ACTIVE_LIMIT_EXCEEDED)', () => {
    const nine = words.map((w) => skill(w));
    const err = expectSkillError(
      () => matchSkills(words.join(' '), nine),
      'ACTIVE_LIMIT_EXCEEDED',
      413,
    );
    expect(err.message).toBe('Too many skills matched. Use fewer keywords or disable some skills.');
  });

  it('nine saved but only eight in input is fine', () => {
    const nine = words.map((w) => skill(w));
    expect(matchSkills(words.slice(0, 8).join(' '), nine).matches).toHaveLength(8);
  });

  it('rejects aggregate > 16,000 code points (CONTEXT_LIMIT_EXCEEDED)', () => {
    const three = [
      skill('alpha', { instructions: 'x'.repeat(8_000) }),
      skill('bravo', { instructions: 'x'.repeat(8_000) }),
      skill('charlie', { instructions: 'x' }),
    ];
    expect(matchSkills('alpha bravo', three).matches).toHaveLength(2);
    const err = expectSkillError(
      () => matchSkills('alpha bravo charlie', three),
      'CONTEXT_LIMIT_EXCEEDED',
      413,
    );
    expect(err.message).toBe(
      'Matched skill instructions exceed the context budget. Shorten or disable skills.',
    );
  });

  it('counts aggregate in code points, not UTF-16 units', () => {
    const astral = [
      skill('alpha', { instructions: EMOJI.repeat(8_000) }),
      skill('bravo', { instructions: EMOJI.repeat(8_000) }),
    ];
    // 16,000 code points = 32,000 UTF-16 units; must be accepted.
    expect(matchSkills('alpha bravo', astral).matches).toHaveLength(2);
  });

  it('active limit takes precedence over context limit', () => {
    const nine = words.map((w) => skill(w, { instructions: 'x'.repeat(8_000) }));
    expectSkillError(() => matchSkills(words.join(' '), nine), 'ACTIVE_LIMIT_EXCEEDED', 413);
  });

  it('duplicate-id snapshots count once toward limits', () => {
    const s = skill('alpha', { id: 'x', instructions: 'x'.repeat(8_000) });
    expect(matchSkills('alpha', [s, s, s]).matches).toHaveLength(1);
  });

  it('enforceSkillActiveLimits is reusable for a steering union', () => {
    const snaps = words.slice(0, 8).map((w) => skill(w, { instructions: E_ACUTE.repeat(2_000) }));
    expect(() => enforceSkillActiveLimits(snaps)).not.toThrow();
    expectSkillError(
      () => enforceSkillActiveLimits([...snaps, skill('india')]),
      'ACTIVE_LIMIT_EXCEEDED',
      413,
    );
    expectSkillError(
      () =>
        enforceSkillActiveLimits([
          ...snaps.slice(0, 7),
          skill('india', { instructions: E_ACUTE.repeat(2_001) }),
        ]),
      'CONTEXT_LIMIT_EXCEEDED',
      413,
    );
  });
});

describe('immutability and determinism', () => {
  it('never mutates input snapshots or text, returns new frozen snapshots', () => {
    const snapshots = [
      skill('code review', { id: 'b', instructions: 'a\r\nb' }),
      skill('code', { id: 'a', extra: 'kept-out' }),
    ];
    const before = structuredClone(snapshots);
    const text = '@omniagent  Code Review please';
    const result = matchSkills(text, snapshots);
    expect(snapshots).toEqual(before);
    expect(text).toBe('@omniagent  Code Review please');
    expect(result.matches.map((m) => m.id)).toEqual(['b', 'a']);
    for (const m of result.matches) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(snapshots).not.toContain(m);
      expect(Object.keys(m)).toEqual(['id', 'name', 'keyword', 'revision', 'instructions']);
    }
    expect(Object.isFrozen(result.matches)).toBe(true);
    expect(() => (result.matches as SkillSnapshot[]).push(snapshots[0])).toThrow();
  });

  it('works with deeply frozen inputs', () => {
    const snaps = Object.freeze([Object.freeze(skill('sql'))]);
    expect(matchSkills('sql', snaps).matches).toHaveLength(1);
  });

  it('same fixtures yield identical results across snapshot permutations', () => {
    const snaps = [
      skill('code review', { id: 'm' }),
      skill('code', { id: 'z' }),
      skill('review', { id: 'a' }),
      skill('sql', { id: 'q' }),
      skill('c++', { id: 'c' }),
    ];
    const text = 'Do a SQL code review in c++ then code again';
    const expected = ids(text, snaps);
    expect(expected).toEqual(['q', 'm', 'z', 'a', 'c']);
    const perms = [snaps.slice().reverse(), [snaps[2], snaps[4], snaps[0], snaps[3], snaps[1]]];
    for (const p of perms) expect(ids(text, p)).toEqual(expected);
  });

  it('does not use locale-sensitive APIs or compile regular expressions', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare used');
    });
    const toLocaleLowerCase = vi
      .spyOn(String.prototype, 'toLocaleLowerCase')
      .mockImplementation(() => {
        throw new Error('toLocaleLowerCase used');
      });
    const OriginalRegExp = RegExp;
    let compiled = 0;
    const RegExpSpy = function (...args: ConstructorParameters<typeof RegExp>) {
      compiled += 1;
      return new OriginalRegExp(...args);
    } as unknown as RegExpConstructor;
    const snaps = [
      skill('a.*b', { id: '1' }),
      skill('(x+)+$', { id: '2' }),
      skill('sql', { id: '3' }),
    ];
    let hit: string[];
    let miss: string[];
    globalThis.RegExp = RegExpSpy;
    try {
      hit = ids('a.*b aXb (x+)+$ xxxx sql', snaps);
      miss = ids('aXXb xxxx', snaps);
    } finally {
      globalThis.RegExp = OriginalRegExp;
    }
    const localeCalls = localeCompare.mock.calls.length + toLocaleLowerCase.mock.calls.length;
    vi.restoreAllMocks();
    expect(hit).toEqual(['1', '2', '3']);
    expect(miss).toEqual([]);
    expect(compiled).toBe(0);
    expect(localeCalls).toBe(0);
  });

  it('is assignable to the frozen MatchSkills contract', () => {
    const fn: MatchSkills = matchSkills;
    expect(fn('sql', [skill('sql')]).matches).toHaveLength(1);
  });
});

describe('bounded work', () => {
  function hundredSkills(): SkillSnapshot[] {
    // 80 nested self-overlapping keywords (a, aa, ..., a*80) plus 20 others:
    // every input position produces up to 80 occurrences that all fail the
    // boundary check, the worst case for occurrence reporting.
    const snaps: SkillSnapshot[] = [];
    for (let k = 1; k <= 80; k += 1) snaps.push(skill('a'.repeat(k), { id: `a${k}` }));
    for (let k = 0; k < 20; k += 1) {
      snaps.push(skill(`${'ab'.repeat(39)}z${k}`.slice(0, 80), { id: `b${k}` }));
    }
    expect(snaps).toHaveLength(SKILL_LIMITS.saved);
    return snaps;
  }

  it('adversarial periodic input stays linear for 100 skills', () => {
    const snaps = hundredSkills();
    for (const input of [
      'a'.repeat(200_000),
      'ab'.repeat(100_000),
      `${'a'.repeat(79)}_`.repeat(2_500),
    ]) {
      const stats: SkillScanStats = { inputCodePoints: 0, steps: 0 };
      const started = performance.now();
      const result = matchSkills(input, snaps, stats);
      const elapsed = performance.now() - started;
      expect(result.matches).toEqual([]);
      expect(stats.inputCodePoints).toBe(200_000);
      // goto + amortized failure links (<= 2n) + occurrences (<= 80 distinct lengths per position).
      expect(stats.steps).toBeLessThanOrEqual(
        (2 + SKILL_LIMITS.keywordCodePoints) * stats.inputCodePoints,
      );
      expect(elapsed).toBeLessThan(5_000);
    }
  });

  it('long input with no near-matches costs about one step per code point', () => {
    const snaps = hundredSkills();
    const stats: SkillScanStats = { inputCodePoints: 0, steps: 0 };
    matchSkills('the quick brown fox '.repeat(50_000), snaps, stats);
    expect(stats.inputCodePoints).toBe(1_000_000 - 1); // trailing space trimmed
    expect(stats.steps).toBeLessThanOrEqual(2 * stats.inputCodePoints);
  });

  it('stops scanning early once every keyword is found', () => {
    const stats: SkillScanStats = { inputCodePoints: 0, steps: 0 };
    const result = matchSkills(`sql ${'x'.repeat(500_000)}`, [skill('sql')], stats);
    expect(result.matches).toHaveLength(1);
    expect(stats.inputCodePoints).toBe(3);
    expect(stats.steps).toBeLessThan(10);
  });

  it('large astral input: counts code points, not UTF-16 units, and stays linear', () => {
    const DESERET = '\u{10428}'; // astral lowercase letter (word character)
    const snaps: SkillSnapshot[] = [];
    for (let k = 1; k <= 80; k += 1) snaps.push(skill(DESERET.repeat(k), { id: `d${k}` }));
    snaps.push(skill('sql', { id: 'sql' }));
    const stats: SkillScanStats = { inputCodePoints: 0, steps: 0 };
    const started = performance.now();
    const result = matchSkills(DESERET.repeat(200_000), snaps, stats);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.matches).toEqual([]);
    expect(stats.inputCodePoints).toBe(200_000);
    expect(stats.steps).toBeLessThanOrEqual(
      (2 + SKILL_LIMITS.keywordCodePoints) * stats.inputCodePoints,
    );
    // Matches after a long astral prefix; ordering by first code-point offset.
    const tail = `${EMOJI.repeat(300_000)} sql ${DESERET.repeat(80)}${EMOJI}`;
    expect(ids(tail, snaps)).toEqual(['sql', 'd80']);
    expect(ids(`${DESERET.repeat(100_000)} ${DESERET.repeat(80)}`, snaps)).toEqual(['d80']);
    expect(ids(`${DESERET} ${EMOJI.repeat(100_000)} sql`, snaps)).toEqual(['d1', 'sql']);
  });

  it('finds a match at the very end of a long adversarial input', () => {
    const snaps = hundredSkills();
    const input = `${'a'.repeat(100_000)} ${'a'.repeat(80)}`;
    expect(ids(input, snaps)).toEqual(['a80']);
  });
});
