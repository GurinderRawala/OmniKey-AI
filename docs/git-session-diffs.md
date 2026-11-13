# Git session diffs

After an agent run, the macOS app can show a **View changes** card right before each final
answer. The card opens a right-hand inspector that renders a server-generated
[`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) HTML view of an immutable
Git snapshot. The snapshot is taken on the machine that executed the run's shell scripts,
at the moment the answer was produced.

This document describes the backend side (`api/src/agent/gitDiff/`) and the wire contract
(v2) shared with the native collector.

## What a snapshot is (and is not)

- It shows the repository **working tree vs `HEAD`** when the answer was produced:
  staged and unstaged tracked changes, plus eligible non-ignored untracked text files.
- If the working tree is **clean**, it may instead show the **latest commit**, but only
  when that commit was observed being created by this run or by the immediately previous
  run of the same session (see [Commit provenance](#commit-provenance)).
- It is **not** an exact record of what the assistant changed. It can include edits that
  already existed or that the user made. The viewer header says so.
- Each final answer gets its own snapshot with a unique id. A later run never overwrites an
  earlier snapshot, so every historical card opens exactly the snapshot taken for it.
- Nothing is shown when no Git repository can be verified, the tree is clean and no
  eligible commit exists, capture fails, or the client does not support the feature.

## Who participates

| Client                                   | Behaviour                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| macOS app with `supports_git_diff: true` | Full flow.                                                                    |
| Older macOS, Windows, CLI, Telegram      | Nothing changes. No requests are sent and the shell tool schema is unchanged. |
| Scheduled (cron) runs                    | Never captured.                                                               |

The backend never runs Git and never inspects its own working directory or `HOME` on a
client's behalf. Collection always happens on the client's execution host.

## Repository candidates

At most 8 absolute directories, chosen in this order from deterministic evidence in the
current run:

1. The structured `working_directory` argument of `shell_script`. It is only added to the
   tool schema for capable clients and forwarded on the shell request.
2. A literal leading `cd <absolute path>` or `git -C <absolute path>` in a script.
3. `pwd` output lines that consist of exactly one absolute path, and only when the script
   ran `pwd`.
4. Absolute paths the user typed in this run. URLs are stripped and the path is trimmed to
   a project root.
5. The server-built `<project_context>` working directory.
6. The candidates recorded for the session's immediately previous run.

Never used: `~` expansion, server cwd/`HOME`, recursive search, quoted or expanded shell
fragments (`$VAR`, `$(…)`, globs), model-generated patches, or running a script to work
out a path. Bare home, volume and top-level directories are rejected. The native collector
re-verifies every candidate with Git (worktrees and subdirectories are supported) and
de-duplicates canonical roots.

## Wire contract (v2)

All frames travel over the run's own authenticated `/ws/omni-agent` connection.

**Capability** (initial client input): `supports_git_diff: true`, as a literal boolean.

**Shell request** (server → client, only for capable clients):

```json
{
  "content": "<shell_script>…</shell_script>",
  "working_directory": "/abs/dir",
  "git_diff_context": { "candidate_paths": ["/abs/dir"] }
}
```

**Terminal reply** (client → server, only on the outstanding shell reply):

```json
{
  "is_terminal_output": true,
  "content": "…",
  "git_commit_observations": [{ "root": "/abs/repo", "before": "<oid>|null", "after": "<oid>" }]
}
```

**Capture request** (server → client, before the final answer is persisted and sent). This
is a control frame. It is never a model, tool or transcript message.

```json
{
  "session_id": "…",
  "sender": "agent",
  "content": "",
  "git_diff_request": {
    "request_id": "…",
    "candidate_paths": ["…"],
    "eligible_commits": [{ "root": "/abs/repo", "commit": "<oid>" }]
  }
}
```

**Capture reply** (client → server):

```json
{
  "session_id": "…",
  "sender": "client",
  "content": "",
  "git_diff_response": {
    "request_id": "…",
    "status": "ok|not_repository|unavailable",
    "repositories": [
      {
        "root": "/abs/repo",
        "patch": "…",
        "scope": "working_tree|commit",
        "commit": "<oid, commit scope only>"
      }
    ],
    "reason": "optional disclosure, e.g. exclusion counts"
  }
}
```

**Final answer** (server → client) carries `session_diff`:

```json
{
  "id": "sdiff_…",
  "fileCount": 3,
  "repositoryCount": 1,
  "createdAt": "ISO-8601",
  "scope": "working_tree|commit|mixed",
  "commit": "<oid, single-repo commit only>"
}
```

The same summary is stored on the final assistant history message (`session_diff`) and
exposed on the transcript `finalAnswer` block as `sessionDiff`, in both legacy and paged
history. Clients insert the card immediately **before** the block that carries it.

### Backend validation

- A reply settles only the outstanding request with the same request id, session,
  subscription **and** connection. Unexpected or stale replies are consumed and ignored,
  and they never start a turn.
- `ok` must be a complete capture: at most 8 repositories, at most 2 MiB of combined UTF-8
  patch, safe absolute roots, and no duplicate roots. A non-`ok` reply that carries any
  patch is rejected. Partial or truncated patches are never accepted as success.
- A `commit` repository is accepted only for a `(root, commit)` pair that was issued in
  `eligible_commits` for that request.
- The backend waits at most 12 s (the native collector budget is 10 s). Timeout, cancel or
  disconnect settle immediately with no snapshot. The final answer is always delivered.

### Native collector obligations (macOS)

These are summarized here because the backend relies on them. They are not enforced by
the backend.

- Read-only Git only, with explicit cwd arguments and no shell interpolation. Always pass
  `--no-ext-diff --no-textconv --no-color`. Never use `--binary`; binary changes keep Git's
  summary line.
- Working tree vs `HEAD` covers staged and unstaged tracked changes. Untracked non-ignored
  text files are included through `git diff --no-index /dev/null <file>`, with at most 200
  untracked files. Handle an unborn `HEAD`.
- Before reading content, skip ignored files and obvious secrets (`.env*`, credentials,
  private keys). Disclose exclusion counts in `reason`.
- If the tree is dirty, always send the working-tree snapshot. Only a clean tree whose
  `HEAD` equals an eligible OID may send
  `git show --format= --no-ext-diff --no-textconv --no-color HEAD`. Root commits are
  supported.
- If a limit is exceeded or anything fails, send `unavailable` with no patch.

## Commit provenance

The macOS client records `HEAD` (and the root) before and after each shell script, for the
backend-supplied candidates. It reports a transition only when the script literally
invokes `git commit`, and only after checking that the new `HEAD`'s parent chain contains
the prior `HEAD`.

The backend accepts `git_commit_observations` only on the outstanding shell reply of the
owning connection. It drops every observation unless all of these hold:

- the script itself literally invokes `git commit` (the backend checks this independently);
- the root is related to that request's candidates;
- the OIDs are valid hex;
- `before` differs from `after`;
- there are at most 8 observations.

Checkouts, resets, cherry-picks, pulls, scripted or aliased commits, commits made outside
a shell, and author/time/message matching are **never** attributed.

Each outer run attempts to store one `agent_session_git_runs` row, even when the row is empty. Eligible
commits for a capture are the current run's observations plus those of the **immediately
previous** saved run only. Failed writes can leave a missing barrier after restart (see the failure policy below). This records observed
agent execution. It is not proof of authorship if something else writes to the repository
at the same time.

## Storage

- `agent_session_diffs`: one immutable row per snapshot. It holds `id` (`sdiff_…`),
  `session_id` (foreign key with `ON DELETE CASCADE`), `subscription_id`, `run_id`,
  `scope`, `commit_oid`, counts, and `payload`. The payload is
  `compressString(JSON.stringify({ version: 1, repositories, notice? }))`. Rows are never
  updated.
- `agent_session_git_runs`: per-run provenance (`commits_json`, `candidates_json`). It keeps
  the newest 10 rows per session and also cascades with the session.
- Both tables are created by `sequelize.sync()`. Neither needs a column migration. Runs from clients without Git capture support leave an empty provenance barrier, so an intervening run cannot revive an older commit.

Patch content is never logged, never added to provider requests (`session_diff` is
stripped by `stripProviderMetadata` before every agent completion), and never sent to any
external service.

## Viewer endpoint

`GET /api/agent/sessions/:sessionId/diffs/:diffId?theme=dark|light` returns
`{ id, html }`.

- It is authenticated. Both the session and the snapshot must belong to the caller.
  Anything else returns 404, and a malformed id or theme returns 400. The response is sent
  with `Cache-Control: private, no-store`.
- Rendering uses the real `@pierre/diffs/ssr` (`parsePatchFiles` + `preloadPatchFile`),
  pinned to the exact version `1.6.4`. Each file is a native `<details>` element holding a
  declarative shadow root (`<template shadowrootmode="open">`, supported by macOS 15
  WebKit) with Pierre's own core and theme CSS. Added, deleted, renamed, modified and
  binary files are labelled. Binary content is never shown.
- The document sets `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; img-src data:; …`. It has no scripts, network access, forms, frames or
  CDN assets. Pierre escapes code and file names, and every root, path, notice and OID that
  the backend adds is escaped too.
- Limits: 300 file panels across all repositories (files past the cap get no DOM; one
  `Showing 50 of N files.` line reports them, and `fileCount` stays exact), 512 KiB per file section, about 16 MiB of HTML, and 15 s
  wall time (the route returns 503 when it is exceeded). Renders run in an isolated worker thread (one active, at most two waiting).
  Queue time counts against the deadline, and timed-out workers are terminated.
  Identical in-flight requests are deduplicated. An LRU cache keyed by `id:theme` (8 entries, 48 MiB) serves repeats. Files beyond a limit
  within the 50 panels get an honest per-file notice instead of content.
- The API compiles to CommonJS, so the ESM-only package is loaded with a real dynamic
  `import()` that TypeScript does not rewrite. This needs Node ≥ 22.

Client requirements: fetch the HTML with the bearer token through the API client, then
call `WKWebView.loadHTMLString`. Never navigate a web view to the API URL. Block
navigation, new windows and external resources, and keep JavaScript disabled.

## Recovery and failure modes

| Situation                                                               | Result                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| No candidates, no Git repository, or clean tree with no eligible commit | No card; the final is sent as usual.                                                |
| Collector timeout, disconnect or cancel                                 | No card. Settles within the bound and the final is never lost.                      |
| Invalid, oversized, stale or foreign reply                              | Ignored or rejected, and logged without content. No card.                           |
| Database write failure                                                  | No card. Provenance loss only affects the next run's fallback.                      |
| Session deleted                                                         | Snapshots and provenance are deleted by cascade.                                    |
| Renderer timeout or failure                                             | 503 or 500 from the endpoint. The stored snapshot is unaffected and can be retried. |

## Replacement and compatibility

This supersedes the unmerged native snapshot/folder-picker PR. There is no local
CAS database, folder opt-in, CodeEditTextView dependency or native diff renderer.
Existing native snapshot files from a previously run development build are not
read by this workflow and are not automatically deleted.

The API and bundled CLI runtime require Node 22+ for Pierre/Shiki SSR and include
`@pierre/diffs` as an exact production dependency. API/CLI versions move together
at 1.8.18. Rebuild both daemon and macOS client to test the new capability; this
implementation does not restart or replace either running process.

Automatic discovery is conservative: explicit project context, literal absolute
`cd`/`git -C`, structured `working_directory`, and bounded pwd evidence. A relative
or opaque script without verifiable context can yield no button. The collector
runs on the Mac because that is the execution host; the backend coordinates,
validates, compresses, saves and renders snapshots.

A dirty tree containing only excluded sensitive paths does not fall back to a
commit; it produces no visible patch. This prevents a commit being presented as
though the repository were clean. Git's configured clean filters (for example
Git LFS) may run during ordinary Git worktree comparison; external diff/textconv
and fsmonitor are disabled, and execution/output are bounded. No perfect
attribution is claimed for concurrent external commits. Indirect/scripted
commits and amended histories fail closed rather than guessing authorship.

## Local verification and provenance boundaries

Automated validation used local checks, not live app/daemon or E2E testing. Live UI acceptance remains with the user. Local tests create temporary
Git repositories and isolated in-memory SQLite databases. The SSR tests exercise
real Pierre rendering, main-thread timer responsiveness, queue limits and worker
termination, plus compiled API/CLI module layouts.

Working-tree snapshots are the net HEAD-to-filesystem view plus eligible untracked
files; staged/unstaged cancellation is not treated as a clean tree for commit
fallback. Safe execution directories are validated separately from conservative
repository candidate selection. Invalid execution paths return a tool error and
never silently run in another directory. Git environment overrides and opaque
commit scripts fail closed for attribution.

## Diff appearance and layout

The macOS inspector follows the app/system light or dark appearance automatically;
there is no separate theme picker or persisted theme override. The **Diff layout**
menu offers **Unified** (default) and **Side-by-side** (old and new in parallel
columns separated vertically). This is a rendering preference, not a new capture:
the same saved snapshot ID is fetched with `layout=unified|split`. Server validation,
worker rendering, request deduplication and HTML caches include the layout; omitted
layout remains unified for older clients. The native request identity also includes
theme and layout so late responses cannot replace a newer selection. Diff banners
fill the same available transcript column as the final answer.

Side-by-side horizontal scrolling is owned by the two code panes, not the outer
WebView document. Because the viewer intentionally does not hydrate Pierre with
JavaScript, a scoped shadow-root CSS override restores bounded scroll containers
in its dehydrated split markup. Long lines scroll within their old/new pane;
line-number gutters remain sticky, and the page wrapper cannot pan into blank
space. Hunk/buffer row metadata is preserved. No client-side scripts are enabled.

Provenance writes are best-effort with a two-second deadline. A failed/timed-out
write disables previous-run commit fallback for that session for the rest of the
API process lifetime; current-run observations still work. After restart only
persisted barriers are available; an unpersisted run cannot be reconstructed.

## Heredoc commit detection (1.9.17)

The native literal-command scanner skips supported heredoc bodies and can observe
`git commit` after a Python verification heredoc, or a quoted heredoc used as a
commit-message argument. Body text is never treated as a shell command. Delimiters
must be literal; missing/CRLF delimiters, unsafe unquoted expansion and opaque
Git invocation remain fail-closed. The unchanged HEAD/reflog/ancestry checks are
still required. This does not retrospectively assign provenance to older sessions.

Heredoc bodies that feed shell/interpreter Git commands fail closed. The staged-file
Python verifier is recognized narrowly (`git diff --cached --name-only` literal
arguments). Commit observations require a direct parent match to the captured HEAD,
so a hidden pull/merge followed by a commit cannot borrow the earlier baseline.

## Per-turn diffs (contract v3, `supports_git_turn_diff`)

A client that sends `supports_git_turn_diff: true` (as a literal boolean, in addition to
`supports_git_diff: true`) gets **turn** snapshots: every net change from the HEAD
recorded at the start of the outer run to the working tree when the answer is produced.
Committed (any number of commits), staged, unstaged and eligible untracked changes appear
as one patch. Clients without the flag keep the v2 flow byte-for-byte (no `phase`, legacy
eligible-commit fallback).

**Run boundary.** One `GitRunState` per outer user input. Recursion, tool continuations and
steering reuse it; baselines are never reset, rebased or overwritten within the run. The
next input on the same session starts a new run and requests a fresh HEAD; a previous
baseline is never reused. The boundary is "the user input was accepted, before any agent
action". It is not the click time, and external writers between acceptance and the
baseline read cannot be excluded atomically.

**Baseline phase** (server → client, same control path, owner/session/connection/request
correlation as v2):

```json
{ "git_diff_request": { "request_id": "…", "phase": "baseline", "baseline_source": "turn_start|before_tool",
  "candidate_paths": ["/abs"], "eligible_commits": [], "baselines": [] } }
```

Reply: `{ request_id, status, repositories: [], baselines: [{ root, head: "<oid>"|null,
capturedAt: "ISO-8601", source }] }`. The backend rejects the whole reply unless: no
repositories/patch; at most 8 baselines; safe roots related to the requested candidates;
`head` a valid OID or `null` (unborn); `source` equal to the requested `baseline_source`;
`capturedAt` parseable ISO-8601 within the run start/now (±5 min skew); no duplicate roots.
The first verified baseline per canonical root wins (`/private/tmp` aliases merged); at most
8 per run.

- `turn_start`: sent once, after the session ownership check and before the first model
  request or tool, for the project-context directory, absolute paths the user typed, and
  the immediately previous run's candidates.
- `before_tool`: before a shell is forwarded, for a newly seen structured
  `working_directory`, literal leading `cd` or literal `git -C` directory. The shell waits
  for it (bounded, 6 s). A path is attempted at most once per run, so repeated shells never
  rebase. `pwd` output is only known afterwards and is never baselined retroactively.
- A timeout, invalid/foreign/stale reply or `unavailable` marks the attempt failed; it is
  never retried or captured late.

**Final phase**: `{ phase: "final", baselines: [recorded…], display_limit: 300,
eligible_commits: [] }`; baseline roots lead `candidate_paths`. A root with a recorded
baseline may only be reported as `scope: "turn"` echoing exactly `baselineHead`,
`baselineCapturedAt` and `baselineSource`, plus the endpoint `head` (an OID, or `null` only
if the baseline was unborn). A root without a baseline may only be `working_tree`
(current uncommitted changes), and the snapshot carries a "Turn baseline unavailable"
notice. History is never guessed, and `commit` scope is never accepted in this mode. Any
violation rejects the reply (no card; the final is still delivered).

**Summary/storage.** `scope` is `turn` (all repositories baselined), `working_tree` (none),
or `mixed`, and includes `displayLimit: 50`. The compressed immutable payload stores the
repositories with their baseline/endpoint fields plus every recorded baseline. No new tables
or columns are added. The viewer is titled **Turn changes** and shows
`<baseline> → <head> + working tree` per repository. It makes no latest-commit claim.

**Collector obligations (macOS).** Baseline: resolve at most 8 roots, read HEAD/unborn,
never mutate the index, echo `baseline_source`. Final: `git diff <BASE>` against the working
tree (empty tree when unborn) with `--no-ext-diff --no-textconv --no-color` (never
`--binary`) plus eligible untracked files, even when the tree is clean. Verify that BASE
exists and is an ancestor of (or equal to) the current HEAD; detached HEAD is fine. On
reset/divergence or a HEAD that moves during capture, report `unavailable` and do not fall
back. The patch stays within the existing 2 MiB budget.

## Persisted diff view setting (`diffViewEnabled`)

The agent settings store persists `diffViewEnabled` (boolean, default `true`). It is
authoritative over the client flags: `runAgentTurn` reads it once per outer run, before any
Git run state is created, and only for an input that would otherwise get Git support
(interactive, `supports_git_diff` or `supports_git_turn_diff`, no cron/internal tools).

When it is `false`, or the setting cannot be read (fail closed), the run behaves exactly like
a client without the Git flags, even if `supports_git_diff`, `supports_git_turn_diff` and
`supports_agent_patches` are all `true`:

- no baseline/final `git_diff_request`, no `git_diff_context` on shells and no structured
  `working_directory` parameter;
- reply observations are ignored;
- no agent-patch instruction is added to provider requests and finals are not parsed or
  stripped;
- no Git context is added from user input or the project, and the run's provenance row is the
  same empty row a client without the flags leaves (it only keeps "the immediately previous
  run" exact, so a later enabled run never reuses an older run's commits).

Clients without the flags are unchanged and trigger no extra settings read. A change takes
effect for the next outer run; recursions and steering of a running turn keep its decision.

## Agent patches (`supports_agent_patches`)

Additive and opt-in. It replaces the earlier contract v4 recovery (native checkpoints,
`phase: "recover"`, the manifest and AI reconstruction model calls, write-evidence script
classification and coverage/proof orchestration), which no longer runs. The final diff is
**Git first, with the editing agent's own unified patches as a per-file fallback**.

**Capability.** A client sends `supports_agent_patches: true` (literal true) on its initial
`AgentMessage`, alongside `supports_git_diff` / `supports_git_turn_diff`. The backend maps it
to `AgentTurnOptions.supportsAgentPatches` and the run's `GitRunState.agentPatches`. It is
independent of `supports_diff_recovery`, which is now ignored (a client may advertise
`supports_diff_recovery: false` and still get agent patches). Without the flag, or with
`diffViewEnabled: false` (no `GitRunState` at all), there is no instruction, no parsing and
no stripping: normal Git capture only, exactly as before. Legacy `diff_recovery_evidence` on
shell replies is ignored, and shell requests carry only `candidate_paths` in
`git_diff_context` (no `turn_id` / `tool_call_id`).

**Instruction.** Every provider request of an agent-patch run carries one fixed instruction
appended to the request copy of the latest `<user_input>` message (never to
`session.history`, so it is never persisted, never accumulates and never describes an older
request). It asks the agent, only if it changed files while handling **this** request, to end
its final answer, inside `<final_answer>` and outside any code block, with:

```text
[files_changed]
<file_patches>{"files":[{"path":"/absolute/file","patch":"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n"}]}</file_patches>
```

Each entry is `{ "path": string, "oldPath"?: string, "patch": string }`. No other fields are
accepted. No extra model call is ever made: a marker with no valid patches produces nothing.

**Parsing (agentPatch.ts).** Only standalone lines outside fenced code inside the
`<final_answer>` body count; quoted, inline, indented or fenced protocol text is left as is.
For an agent-patch run, `[files_changed]`, `<file_patches>…</file_patches>` and the legacy
`<changed_files>…</changed_files>` are always stripped from what is shown, stored and sent,
including malformed blocks. An unclosed block strips the rest of the body, so a truncated
patch never leaks into the answer. Patches are used only when the marker and exactly one
well-formed block are present, and only for that candidate final (a steering restart parses
its own new final). Error finals never parse a report.

**Validation (fail closed, whole batch).** The block must be the JSON object `{"files":[…]}`
with 1 to 300 entries (`AGENT_PATCH_MAX_FILES`), at most 256 KiB of patch text per file
(`AGENT_PATCH_MAX_FILE_BYTES`) and 2 MiB in total (`GIT_DIFF_MAX_PATCH_BYTES`). Any invalid
entry rejects every entry of the report:

- `path` / `oldPath` are safe absolute paths (no `.`/`..`, control characters, `"` or `\`),
  normalized, unique across the batch, and not sensitive (`pathPolicy.ts`: `.ssh`, `.aws`,
  `.git`, `.env*`, keys/certificates, credential files, and any hidden component below a home
  directory except the agent's own top-level `~/.omniAgent` / `~/.omnikey`).
- `patch` is exactly one git-style file diff: the first line is
  `diff --git a/<old> b/<new>`, where each name is a trailing path suffix of `oldPath ?? path`
  / `path` (the basename is enough). Only these extended header lines are allowed:
  `index`, `new file mode`, `deleted file mode`, `old mode`/`new mode`, `similarity index`,
  `rename from`/`rename to` (names checked the same way), and a final
  `Binary files … differ` summary. `GIT binary patch` literals and `copy` are rejected.
- `---`/`+++` lines must name the same file (or `/dev/null`) and be followed by hunks; every
  `@@ -a,b +c,d @@` hunk must have exactly `b` old and `d` new lines, hunks must not overlap,
  and `\ No newline at end of file` may only follow a content line. A context line whose
  single leading space was dropped is accepted as an empty context line.
- A new file uses `--- /dev/null` (and/or `new file mode`) with one `-0,0` hunk or none (empty
  file); a deletion uses `+++ /dev/null` with one `+0,0` hunk or none and no `oldPath`; a
  rename requires `oldPath` and both `rename` lines, and vice versa. A section with no change
  at all is rejected.

The backend never applies or executes a patch, never reads the filesystem and never infers
file names from scripts, shell output or earlier turns. A valid entry is re-emitted with
backend-built headers relative to its display root (agent `index` lines are dropped).

**Merge (finalDiff.ts).**

1. The normal native capture runs first (no model call). Its valid repositories are
   authoritative. In turn mode only `scope: "turn"` roots (verified baseline) are kept. A
   baseline-less root's `working_tree` patch cannot be attributed to this turn, so it is
   omitted and the omission is stated in the notice. This changes the earlier rule, which
   hid the whole snapshot (`baselineUnavailable`). Native disclosure text such as sensitive
   exclusion counts is kept in the notice instead of withholding the snapshot.
2. An agent file whose `path` or `oldPath` is already covered by a Git file section
   (including rename sides and C-quoted names) is ignored: Git is never replaced. Other agent
   files are added, including ignored files inside a Git root and files in a root Git
   reported as net-empty. A net-empty root never exempts a reported file.
3. Agent files are grouped under the deepest Git root (captured or baselined) containing them,
   else under their own directory. If that exceeds 8 distinct roots, loose files are grouped
   under their common directory. If that is still too many (or the common directory is `/`),
   the agent batch is ignored and Git alone is saved.

**Storage and summary.** A Git-only result is saved exactly like a normal snapshot. With at
least one agent file, the payload has the Git entries first, then one entry per agent root
with `scope: "working_tree"` and `reconstructed: true`, `displayLimit: 300`, the turn
`baselines` when any Git entry is turn-scoped, and:

```json
"recovery": { "kind": "agent_patch", "turnId": "grun_…", "evidenceIds": [],
              "complete": false, "reportSource": "agent_final",
              "base": "automatic", "limitations": ["…"] }
```

`base` is present only when Git entries exist. The summary has `recovered: true`,
`recoveryMethod: "ai_reconstructed"` (the existing value, so current clients need no new
enum), `recoveryUncertain: true` and `recoveryIncomplete: false`. `complete: false` never
hides the card. `repositoryCount` counts distinct roots (a Git and an agent entry of the same
root count once), and `fileCount` counts file sections.

**Viewer.** `isKnownPartialPayload` serves `agent_patch` only in the exact form above (at
least one `reconstructed` entry). The title is "Turn changes with AI-generated patches".
Agent entries are labelled "AI-generated patch (agent reported, unverified)". A note states
that they come from the agent's final answer, were not read from disk and may be incomplete,
followed by the stored limitation lines. Git entries keep their normal turn labels.

### Legacy recovered payloads

Snapshots stored by earlier releases keep their old decode and serving rules unchanged:
`agent_assisted` (checkpoint replay), `ai_reconstructed` (complete, uncertain-with-proof, and
agent-reported `[files_changed]` forms) render with their original labels, and known-partial
payloads (`complete: false` without a servable uncertain form, or a turn snapshot with a
baseline-less root) still return 409 and are hidden from transcript replay. The legacy
provenance types and `isServable*` helpers in `contracts.ts` exist only for this. No code path
creates such payloads any more.

### Removed (no active calls)

`recovery.ts`, `aiReconstruction.ts`, `coverage.ts`, `uncertainProof.ts`, `writeEvidence.ts`,
`pythonPaths.ts` and `agentReport.ts` were deleted. The v4 wire validators
(`validateDiffRecoveryEvidence`, `validateGitRecoveryResponse`), `phase: "recover"`, the
`git_diff_context.turn_id` / `tool_call_id` correlation and the recovery `onUsage` accounting
path are gone. Normal provider usage accounting is unchanged.
