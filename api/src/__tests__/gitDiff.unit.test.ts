/**
 * Pure Git session-diff units: wire validation, deterministic candidate
 * discovery, transcript propagation, and REAL @pierre/diffs SSR rendering
 * (no mocks of the renderer). No database, network or user files.
 */
import { describe, expect, it } from 'vitest';
import { planShellGitContext } from '../agent/gitDiff/shellContext';
import { createGitRunState } from '../agent/gitDiff/coordinator';
import {
  cleanSessionDiffSummary,
  GIT_DIFF_MAX_PATCH_BYTES,
  scriptInvokesGitCommit,
  validateCommitObservations,
  validateGitDiffResponse,
} from '../agent/gitDiff/contracts';
import {
  CandidateSet,
  literalScriptDirectories,
  projectContextDirectory,
  pwdOutputDirectories,
  userInputDirectories,
} from '../agent/gitDiff/candidates';
import { stripProviderMetadata } from '../agent/gitDiff/providerMetadata';
import {
  clearDiffRenderCacheForTesting,
  renderSessionDiffHtml,
  splitPatchSections,
  classifySection,
} from '../agent/gitDiff/ssrRenderer';
import {
  buildTranscript,
  completedTranscriptRevision,
  paginateTranscript,
  previewTranscript,
} from '../agent/agentServer/transcript';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const ROOT = '/Users/dev/projects/app';

describe('validateGitDiffResponse', () => {
  const request = { request_id: 'req1', eligible_commits: [{ root: ROOT, commit: OID_A }] };

  it('accepts a bounded working-tree capture and defaults scope', () => {
    const result = validateGitDiffResponse(
      { request_id: 'req1', status: 'ok', repositories: [{ root: ROOT + '/', patch: 'x' }] },
      request,
    );
    expect(result.repositories).toEqual([{ root: ROOT, patch: 'x', scope: 'working_tree' }]);
  });

  it('rejects mismatched ids, partial failure patches, duplicates and oversize', () => {
    expect(() =>
      validateGitDiffResponse({ request_id: 'other', status: 'ok', repositories: [] }, request),
    ).toThrow();
    expect(() =>
      validateGitDiffResponse(
        { request_id: 'req1', status: 'unavailable', repositories: [{ root: ROOT, patch: 'x' }] },
        request,
      ),
    ).toThrow(/patch on failure/);
    expect(() =>
      validateGitDiffResponse(
        {
          request_id: 'req1',
          status: 'ok',
          repositories: [
            { root: ROOT, patch: 'a' },
            { root: ROOT + '/', patch: 'b' },
          ],
        },
        request,
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      validateGitDiffResponse(
        {
          request_id: 'req1',
          status: 'ok',
          repositories: [{ root: ROOT, patch: 'x'.repeat(GIT_DIFF_MAX_PATCH_BYTES + 1) }],
        },
        request,
      ),
    ).toThrow(/too large/);
    expect(() =>
      validateGitDiffResponse(
        { request_id: 'req1', status: 'ok', repositories: [{ root: '../etc', patch: 'x' }] },
        request,
      ),
    ).toThrow(/root/);
    expect(() =>
      validateGitDiffResponse(
        {
          request_id: 'req1',
          status: 'ok',
          repositories: Array.from({ length: 9 }, (_, i) => ({ root: `${ROOT}${i}`, patch: '' })),
        },
        request,
      ),
    ).toThrow(/too many/);
  });

  it('accepts a commit snapshot only for an issued eligible OID', () => {
    const ok = validateGitDiffResponse(
      {
        request_id: 'req1',
        status: 'ok',
        repositories: [{ root: ROOT, patch: 'p', scope: 'commit', commit: OID_A }],
      },
      request,
    );
    expect(ok.repositories[0]).toMatchObject({ scope: 'commit', commit: OID_A });
    expect(() =>
      validateGitDiffResponse(
        {
          request_id: 'req1',
          status: 'ok',
          repositories: [{ root: ROOT, patch: 'p', scope: 'commit', commit: OID_B }],
        },
        request,
      ),
    ).toThrow(/not eligible/);
    expect(() =>
      validateGitDiffResponse(
        {
          request_id: 'req1',
          status: 'ok',
          repositories: [{ root: '/Users/dev/other', patch: 'p', scope: 'commit', commit: OID_A }],
        },
        request,
      ),
    ).toThrow(/not eligible/);
  });
});

describe('commit provenance validation', () => {
  it('detects only literal direct git commit invocations', () => {
    expect(scriptInvokesGitCommit('git commit -m "x"')).toBe(true);
    expect(scriptInvokesGitCommit('cd /a && git -C "/Users/dev/app" commit -am x')).toBe(true);
    expect(scriptInvokesGitCommit('git add . ; git commit')).toBe(true);
    expect(scriptInvokesGitCommit('./scripts/release.sh')).toBe(false);
    expect(scriptInvokesGitCommit('echo "git commit"')).toBe(false);
    expect(scriptInvokesGitCommit('git checkout main')).toBe(false);
    expect(scriptInvokesGitCommit('git reset --hard HEAD~1')).toBe(false);
    expect(scriptInvokesGitCommit('git cherry-pick abc')).toBe(false);
    expect(scriptInvokesGitCommit('git pull')).toBe(false);
  });

  it('accepts HEAD transitions only for issued candidates after a git commit', () => {
    const raw = [{ root: ROOT, before: OID_A, after: OID_B }];
    expect(validateCommitObservations(raw, [ROOT + '/src'], 'git commit -m x')).toEqual(raw);
    // Unborn HEAD -> first commit.
    expect(
      validateCommitObservations(
        [{ root: ROOT, before: null, after: OID_B }],
        [ROOT],
        'git commit',
      ),
    ).toHaveLength(1);
    // Not a commit invocation (checkout/reset/scripted) -> no attribution.
    expect(validateCommitObservations(raw, [ROOT], 'git checkout other')).toEqual([]);
    expect(validateCommitObservations(raw, [ROOT], 'bash ./commit.sh')).toEqual([]);
    // No HEAD change -> no attribution.
    expect(
      validateCommitObservations(
        [{ root: ROOT, before: OID_A, after: OID_A }],
        [ROOT],
        'git commit',
      ),
    ).toEqual([]);
    // Unrelated root / invalid OID / oversize -> rejected.
    expect(validateCommitObservations(raw, ['/Users/dev/other'], 'git commit')).toEqual([]);
    expect(
      validateCommitObservations(
        [{ root: ROOT, before: null, after: 'HEAD' }],
        [ROOT],
        'git commit',
      ),
    ).toEqual([]);
    expect(
      validateCommitObservations(
        Array.from({ length: 9 }, () => raw[0]),
        [ROOT],
        'git commit',
      ),
    ).toEqual([]);
    expect(validateCommitObservations(raw, [], 'git commit')).toEqual([]);
  });
});

describe('deterministic candidates', () => {
  it('reads literal cd / git -C targets without evaluating the script', () => {
    expect(literalScriptDirectories(`cd ${ROOT} && npm test`)).toEqual([ROOT]);
    expect(literalScriptDirectories(`cd "${ROOT}"; ls`)).toEqual([ROOT]);
    expect(literalScriptDirectories(`git -C '${ROOT}' status`)).toEqual([ROOT]);
    expect(literalScriptDirectories('cd "$PROJECT" && ls')).toEqual([]);
    expect(literalScriptDirectories('cd $(pwd)/x')).toEqual([]);
    expect(literalScriptDirectories('cd ~/app')).toEqual([]);
    expect(literalScriptDirectories('cd /Users/dev')).toEqual([]); // bare home
    expect(literalScriptDirectories('echo hi; cd /Users/dev/projects/app')).toEqual([]); // not leading
  });

  it('accepts pwd output only when the script ran pwd', () => {
    expect(pwdOutputDirectories('pwd', `TERMINAL OUTPUT:\n${ROOT}\n`)).toEqual([ROOT]);
    expect(pwdOutputDirectories('ls', `${ROOT}\n`)).toEqual([]);
  });

  it('reads user-typed absolute paths and the project context directory', () => {
    expect(userInputDirectories(`Fix the bug in ${ROOT}/src/index.ts please`)).toEqual([ROOT]);
    expect(userInputDirectories('see https://example.com/Users/x/y and ~/code/app')).toEqual([]);
    expect(
      projectContextDirectory(
        `<project_context name="app">\nWorking directory: ${ROOT}\nConfidence: high\n</project_context>`,
      ),
    ).toBe(ROOT);
  });

  it('orders, de-duplicates and bounds candidates', () => {
    const set = new CandidateSet();
    set.add('/Users/dev/projects/p', 'project');
    set.add(ROOT, 'user_input');
    set.add('/private/tmp/work/repo', 'command');
    set.add('/tmp/work/repo', 'working_directory');
    for (let i = 0; i < 50; i += 1) set.add(`/Users/dev/projects/x${i}`, 'user_input');
    const list = set.list();
    expect(list[0]).toBe('/private/tmp/work/repo');
    expect(list).toHaveLength(8);
    expect(list).not.toContain('/tmp/work/repo');
  });
});

describe('history metadata', () => {
  const diffA = {
    id: 'sdiff_aaaaaaaaaaaa',
    fileCount: 1,
    repositoryCount: 1,
    createdAt: '2026-11-12T00:00:00.000Z',
    scope: 'working_tree' as const,
  };
  const diffB = { ...diffA, id: 'sdiff_bbbbbbbbbbbb', scope: 'commit' as const, commit: OID_B };

  it('strips session_diff from provider requests', () => {
    const history = [
      { role: 'user' as const, content: 'q' },
      {
        role: 'assistant' as const,
        content: '<final_answer>a</final_answer>',
        session_diff: diffA,
      },
    ];
    const stripped = stripProviderMetadata(history);
    expect(stripped[1]).toEqual({ role: 'assistant', content: '<final_answer>a</final_answer>' });
    expect(history[1].session_diff).toBe(diffA);
  });

  it('keeps each final answer bound to its own snapshot through preview and paging', () => {
    const raw = [
      { role: 'user', content: '<user_input>one</user_input>' },
      { role: 'assistant', content: '<final_answer>first</final_answer>', session_diff: diffA },
      { role: 'user', content: '<user_input>two</user_input>' },
      { role: 'assistant', content: 'second plain', session_diff: diffB },
      { role: 'user', content: '<user_input>three</user_input>' },
      { role: 'assistant', content: '<final_answer>third</final_answer>' },
      { role: 'user', content: '<user_input>four</user_input>' },
      {
        role: 'assistant',
        content: '<final_answer>bad</final_answer>',
        session_diff: { id: '<script>', fileCount: 1 },
      },
    ];
    const transcript = buildTranscript(raw);
    const finals = transcript
      .filter((m) => m.role === 'assistant')
      .map((m) => m.blocks?.find((b) => b.kind === 'finalAnswer')?.sessionDiff);
    expect(finals).toEqual([diffA, diffB, undefined, undefined]);
    const page = paginateTranscript(previewTranscript(transcript), 's1', 2);
    expect(page.messages[0].blocks?.[0].sessionDiff).toBeUndefined();
    const older = paginateTranscript(
      previewTranscript(transcript),
      's1',
      6,
      page.pageInfo.startCursor,
    );
    expect(older.messages[1].blocks?.[0].sessionDiff?.id).toBe(diffA.id);
    expect(older.messages[3].blocks?.[0].sessionDiff?.commit).toBe(OID_B);
    // The snapshot reference is part of the transcript revision.
    const withoutRef = buildTranscript(raw.map(({ session_diff: _d, ...m }) => m));
    expect(completedTranscriptRevision(transcript)).not.toBe(
      completedTranscriptRevision(withoutRef),
    );
    expect(cleanSessionDiffSummary({ ...diffA, extra: 'x' })).toEqual(diffA);
  });
});

const MALICIOUS_PATCH = [
  'diff --git a/src/"><img src=x onerror=alert(1)>.ts b/src/"><img src=x onerror=alert(1)>.ts',
  'index 1111111..2222222 100644',
  '--- a/src/"><img src=x onerror=alert(1)>.ts',
  '+++ b/src/"><img src=x onerror=alert(1)>.ts',
  '@@ -1,2 +1,2 @@',
  ' const keep = 1;',
  '-const old = "</template></div><script>alert(1)</script>";',
  '+const fresh = 2;',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..3333333',
  'Binary files /dev/null and b/logo.png differ',
  'diff --git a/old.txt b/new.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to new.txt',
  'diff --git a/added.md b/added.md',
  'new file mode 100644',
  'index 0000000..4444444',
  '--- /dev/null',
  '+++ b/added.md',
  '@@ -0,0 +1 @@',
  '+# hello',
  'diff --git a/gone.py b/gone.py',
  'deleted file mode 100644',
  'index 5555555..0000000',
  '--- a/gone.py',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-print("bye")',
  '',
].join('\n');

describe('Pierre SSR rendering (real @pierre/diffs)', () => {
  it('classifies binary, added, deleted, renamed and modified sections', () => {
    const kinds = splitPatchSections(MALICIOUS_PATCH).map((s) => classifySection(s));
    expect(kinds).toEqual(['modified', 'binary', 'renamed', 'added', 'deleted']);
  });

  it('renders highlighted, escaped, script-free HTML with a strict CSP', async () => {
    clearDiffRenderCacheForTesting();
    const html = await renderSessionDiffHtml(
      'sdiff_test',
      {
        version: 1,
        repositories: [
          {
            root: '/Users/dev/<b>repo</b>',
            patch: MALICIOUS_PATCH,
            scope: 'commit',
            commit: OID_A,
          },
        ],
        notice: '2 files excluded <i>secret</i>',
      },
      'dark',
    );
    // Real Pierre output: declarative shadow roots, core + theme CSS, token colors.
    expect(html).toContain('<template shadowrootmode="open">');
    expect(html).toContain('data-core-css');
    expect(html).toMatch(/--diffs-token-dark:#[0-9A-Fa-f]{6}/);
    expect(html).toContain("default-src 'none'");
    // Nothing executable, nothing remote, no injected markup.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain('<b>repo</b>');
    expect(html).toContain('&lt;b&gt;repo&lt;/b&gt;');
    expect(html).not.toContain('<i>secret</i>');
    // Only our own wrapper closes templates: one per non-binary file
    // (modified, renamed, added, deleted); the injected `</template>` is text.
    expect((html.match(/<\/template>/g) ?? []).length).toBe(4);
    expect(html).toContain('Binary file changed');
    expect(html).toContain('old.txt → new.txt');
    expect(html).toContain('commit <code class="oid">aaaaaaaaaaaa</code>');
    expect(html).toContain('Commit changes');
  });

  it('caches per immutable id and theme', async () => {
    clearDiffRenderCacheForTesting();
    const payload = {
      version: 1 as const,
      repositories: [{ root: ROOT, patch: MALICIOUS_PATCH, scope: 'working_tree' as const }],
    };
    const dark = await renderSessionDiffHtml('sdiff_cache', payload, 'dark');
    const light = await renderSessionDiffHtml('sdiff_cache', payload, 'light');
    expect(dark).toContain('data-theme="dark"');
    expect(light).toContain('data-theme="light"');
    expect(
      await renderSessionDiffHtml('sdiff_cache', { ...payload, repositories: [] }, 'dark'),
    ).toBe(dark);
  });
});

describe('Git snapshot integration regressions', () => {
  it('separates execution directories from candidate safety filters', () => {
    for (const directory of ['/Users/alice', '/tmp', '/workspace/proj']) {
      const run = createGitRunState({ sessionId: 's', subscriptionId: 'u', send: () => {} });
      const plan = planShellGitContext(run, { working_directory: directory }, 'pwd');
      expect(plan.workingDirectory).toBe(directory);
      expect(plan.error).toBeUndefined();
    }
    for (const directory of ['relative', '/Users/alice/../other', '/tmp/line\nnext']) {
      const run = createGitRunState({ sessionId: 's', subscriptionId: 'u', send: () => {} });
      const plan = planShellGitContext(run, { working_directory: directory }, 'touch never');
      expect(plan.error).toBeTruthy();
      expect(plan.workingDirectory).toBeUndefined();
    }
  });

  it('rejects an unrelated response repository', () => {
    expect(() =>
      validateGitDiffResponse(
        {
          request_id: 'r',
          status: 'ok',
          repositories: [{ root: '/Users/other/private', patch: 'x', scope: 'working_tree' }],
        },
        { request_id: 'r', candidate_paths: [ROOT], eligible_commits: [] },
      ),
    ).toThrow(/related/);
  });

  it('keeps new high-priority evidence when candidates reach their cap', () => {
    const candidates = new CandidateSet();
    for (let i = 0; i < 40; i++) candidates.add(`/Users/dev/project${i}`, 'previous_run');
    candidates.add('/Users/dev/current', 'working_directory');
    expect(candidates.list()[0]).toBe('/Users/dev/current');
  });
});

describe('saved diff layout rendering', () => {
  it('renders real unified and split markup without cache collisions', async () => {
    clearDiffRenderCacheForTesting();
    const payload = {
      version: 1 as const,
      repositories: [{ root: ROOT, patch: MALICIOUS_PATCH, scope: 'working_tree' as const }],
    };
    const unified = await renderSessionDiffHtml('layout-check', payload, 'light');
    const split = await renderSessionDiffHtml('layout-check', payload, 'light', undefined, 'split');
    expect(unified).toContain('data-layout="unified"');
    expect(unified).toContain('data-diff-type="single"');
    expect(split).toContain('data-layout="split"');
    expect(split).toContain('data-diff-type="split"');
    expect(split).not.toEqual(unified);
    expect(await renderSessionDiffHtml('layout-check', payload, 'light')).toEqual(unified);
    expect(
      await renderSessionDiffHtml('layout-check', payload, 'light', undefined, 'split'),
    ).toEqual(split);
  });
});

describe('unhydrated split scroll containment', () => {
  it('keeps long lines inside separate code scrollports, not the document wrapper', async () => {
    const oldLine = 'left_' + 'x'.repeat(4000);
    const newLine = 'right_' + 'y'.repeat(5000);
    const patch = [
      'diff --git a/long.txt b/long.txt',
      '--- a/long.txt',
      '+++ b/long.txt',
      '@@ -1,2 +1,3 @@',
      '-' + oldLine,
      '+' + newLine,
      '+extra',
      ' context',
      '',
    ].join('\n');
    for (const theme of ['light', 'dark'] as const) {
      const html = await renderSessionDiffHtml(
        'long-scroll-' + theme,
        {
          version: 1,
          repositories: [{ root: ROOT, patch, scope: 'working_tree' }],
        },
        theme,
        undefined,
        'split',
      );
      expect(html).toContain(oldLine);
      expect(html).toContain(newLine);
      // Inspect the app's CSS override in the real Pierre shadow-root HTML,
      // not the library's original dehydrated rules which deliberately clip.
      const shadow = html.slice(html.indexOf('<template shadowrootmode="open">'));
      expect(shadow).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
      expect(shadow).toContain(
        'display:grid;grid-template-columns:max-content minmax(max-content,1fr)',
      );
      expect(shadow).toContain('overflow-x:auto;overflow-y:hidden');
      expect(shadow).toContain('grid-column:2;min-width:max-content;overflow:visible');
      expect(shadow).toContain('>[data-code]>[data-gutter]{grid-column:1}');
      expect(html).toContain('html,body{width:100%;max-width:100%;min-width:0;overflow-x:clip}');
      expect(html).toContain('data-content-buffer');
      expect(html).not.toMatch(/<script[\s>]/i);
    }
  });
});
