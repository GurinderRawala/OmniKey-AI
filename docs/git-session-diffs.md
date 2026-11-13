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
`supports_diff_recovery` are all `true`:

- no baseline/final/recover `git_diff_request`, no `git_diff_context` on shells and no
  structured `working_directory` parameter, so the native client records no checkpoints;
- reply observations and `diff_recovery_evidence` are ignored, and no write evidence is kept;
- no manifest or reconstruction model call, so no extra AI token cost;
- no Git context is added from user input or the project, and the run's provenance row is the
  same empty row a client without the flags leaves (it only keeps "the immediately previous
  run" exact, so a later enabled run never reuses an older run's commits).

Clients without the flags are unchanged and trigger no extra settings read. A change takes
effect for the next outer run; recursions and steering of a running turn keep its decision.

## Diff recovery (contract v4, `supports_diff_recovery`)

Additive and opt-in. A client that does not send `supports_diff_recovery: true` on its
initial `AgentMessage` (alongside the existing Git flags) sees no change. The capability
only matters for a run that already has Git snapshot support.

**Shell correlation.** For a capable run, every `shell_script` request carries
`git_diff_context: { candidate_paths, turn_id, tool_call_id }` (`candidate_paths` may be
empty). `turn_id` is the outer run id (`grun_…`), and `tool_call_id` is the provider tool call
id of that exact shell. The native client keeps a `DiffRecoveryStore` per run. It may add
optional `diff_recovery_evidence` to the terminal reply of that shell:

```json
{ "turn_id": "grun_…", "omitted": 0,
  "records": [{ "id": "opaque", "toolCallId": "call_1", "root": "/abs/root",
                "paths": ["src/a.ts"], "kind": "git", "before": "<oid>|null",
                "after": "<oid>|null", "complete": true }] }
```

The backend accepts this field only through the outstanding shell's own resolve path, after
the WebSocket layer has proved session, subscription and owning connection. If any of the
following holds, the whole reply is rejected and no records from it are kept:

- `turn_id` is not this run's id.
- A record's `toolCallId` is not the issued tool call.
- The reply has more than 32 records, or a record has more than 50 paths.
- A path is absolute, contains `..`, or has control characters.
- An id repeats.
- `before`/`after` is not a Git OID (`git`) or a 64-hex content hash (`file`), or `null`.

A later record with the same id replaces the earlier metadata. Once the run holds 32 records,
new ids are dropped and counted as omitted. Records hold metadata only: no patch, no file
content, and no script output. The store is runtime-only and is never persisted, so a new
run starts empty. An older run's records can never be selected.

**Structured automatic outcome.** The normal capture now returns
`{ status: captured | no_changes | no_repository | missing_baseline | workspace_unavailable |
capture_failed, summary?, reason? }` (`captureSessionDiffOutcome`).
`captureSessionDiffBeforeFinal` is unchanged for existing callers. A `captured` result is
used exactly as before.

**Fallback trigger.** It runs at most once per outer run, and only when all of these hold:
the run has the v4 capability, the normal outcome is not `captured`, and the run holds at
least one verified record or current-turn write evidence (see the AI-reconstructed fallback
below). With neither, no model call is made. Both the success final and the
failure final go through the same helper (`captureFinalSessionDiff`). The existing steering
recheck still runs after the capture and before history is persisted.

**Restricted manifest call.** This is one `aiClient.complete` call on the run's current model.
It has no tools, a fixed literal system prompt (`DIFF_RECOVERY_SYSTEM_PROMPT`), and
`maxTokens: 1000`. Its input is limited to:

- this run's own user input, trimmed to 2,000 characters;
- `steeringUpdates` (only when present): steering text that was actually applied to this
  run's history, at most 8 entries and 2,000 characters in total. Queued, rejected or
  earlier runs' steering is never included;
- the records' id, toolCallId, kind, root, up to 20 paths, path count and `complete` flag.

It receives no history, script text, terminal output or hashes. The reply must be exactly
`{"evidenceIds":[…]}` (1–6 unique ids from the offered allowlist) or `{"unavailable":true}`.
A single fenced JSON block is tolerated. Anything else is rejected and no snapshot is made.
The model chooses which evidence to use. It never writes a patch, path, OID or command.
Usage is recorded through the existing recorder. That accounting is bounded (≤2 s), a
failure in it is swallowed, and it does not overwrite the run's prompt-size hint.

**Recover control.** `git_diff_request { phase: "recover", candidate_paths: [],
eligible_commits: [], recovery: { turn_id, evidence_ids } }` goes over the run's own
connection. Baseline fields are not used. The native client must answer from its run-local
store with `repositories: [{ root, patch, scope: "working_tree" }]` and
`recovery: { turn_id, evidence_ids, omitted }`. When several records share a root, the client
combines them into one patch without duplicate paths, preferring the latest checkpoint.

The backend checks the reply strictly:

- It requires the exact turn id and the exact selected id set.
- Each root must belong to a selected record, and no root may repeat.
- Repositories may only carry `root`, `patch` and `scope: "working_tree"`. A commit,
  baseline or turn claim is rejected.
- Patches are limited to 2 MiB combined.

**Budget and cancellation.** One 20 s budget covers the AI call and the native request
together. The provider call receives a real `AbortSignal` that is aborted on deadline, cancel
or disconnect, and the backend never waits past that point. After a cancel or deadline,
nothing is attached. A database insert that was already in flight cannot be cancelled and
may still finish, leaving an unattached snapshot row (see below); it is never attached to
the final answer late. The original final answer is never changed, delayed past the
bound, or lost.

**Storage and viewer.** The existing compressed payload is reused and gains
`recovery: { kind: "agent_assisted", turnId, evidenceIds, complete, limitations[] }` and
`displayLimit: 50`. The summary adds `recovered: true` and `recoveryIncomplete`, both of which
survive `cleanSessionDiffSummary` and transcript hydration. `stripProviderMetadata` still
keeps them out of provider requests.

The viewer header reads **Recovered turn changes** and states that the diff was recovered
with agent assistance from per-command checkpoints. Each repository is labelled "recovered
from turn checkpoints". A partial recovery shows an explicit **Partial recovery** warning plus
fixed limitation lines, such as:

- records that were not selected;
- records the native store omitted (reported with shell evidence);
- records over the backend budget;
- records truncated by native limits;
- selected roots that returned no patch.

**Native obligations (summary).** These are owned by the macOS client:

- Inspect candidates deterministically, without `eval`.
- Resolve Git roots and worktrees, and discover new worktrees through a bounded
  `git worktree list` of an already-known repository. Never scan the whole machine.
- Checkpoint known roots before each shell, so a deleted worktree keeps its last verified
  patch.
- Capture the net change with the existing read-only collector flags.
- For non-Git files, only handle explicit quoted absolute paths, with a verified before-image
  and limits of 256 KiB per file and 2 MiB in total.
- Apply `GitSensitivePathPolicy`.
- Keep each hook within 2 s.

### Recovery verification and boundaries

Recovery runs only with current-turn native evidence. A successful empty automatic
capture supersedes older Git checkpoints for the roots it checked. Non-Git files
are hash-checked again before replay; changed/deleted checkpoints are omitted.
Native records keep at most300allowlisted paths (both rename sides included), and
oversized records are explicitly partial. Unsupported C-quoted/ambiguous filenames
fail closed; this is not a general filesystem audit or an exhaustive write tracker.
Read-only shell checkpoints can add up to2seconds before and2seconds after each
command. Supported non-Git files require a reliable before-image or verified absence.
The20second fallback budget covers model selection, native replay and waiting for
persistence. An uninterruptible database insert may finish after timeout and leave
an unattached snapshot row; its result is never attached to the final answer late.

### AI-reconstructed fallback (write evidence, no native records)

Some turns produce no normal snapshot and no native records, even though the agent ran
scripts that wrote files. Examples: a write outside any repository, or a client that has no
checkpoint for that path. For these turns the backend makes one bounded AI reconstruction
attempt. Verified native records always take precedence: if the run holds any records, the
checkpoint path above runs unchanged and the model is never asked to reconstruct files.

**Write evidence.** It is recorded only for a capable run, only for a shell tool call that
was actually issued, and only after the client's real terminal reply. A cancel or disconnect
records nothing. A script is classified by a conservative heuristic
(`writeEvidence.ts`). This is not a shell parser: nothing is executed, expanded or looked
up on any filesystem. Write-like means one of the following:

- `>` or `>>` redirection, except to `/dev/*` or to an fd;
- `tee`, `touch`, `truncate`, `mkdir`, `cp`, `mv`, `install`, `ln`, `rsync`, `rm`,
  `unlink`, `rmdir`, `dd of=`, `curl -o` or `wget -O`;
- `sed -i` or `perl -i`;
- Python `write_text`, `write_bytes` or `open(…, 'w'|'a'|'x'|'+')`, or Node `writeFile*`;
- `patch`, or a writing `git` subcommand (`apply`, `checkout`, `restore`, `reset`, and so
  on).

Read-only scripts never trigger the fallback. Heredoc bodies are skipped. Failed scripts
still count, because they may have written part of their output. A run keeps at most 16
evidence entries. Each holds:

- the tool call id;
- the status (`succeeded`, `failed` or `unknown`);
- the cwd hint;
- the write kinds;
- a redacted excerpt of the script (≤4,000 chars) and of the output (≤1,000 chars);
- literal targets.

Obvious secrets are redacted: private keys, provider tokens, `Authorization`/bearer values,
`*TOKEN|SECRET|PASSWORD|API_KEY*=` assignments, and URL credentials. If a script targets a
sensitive path, its excerpt is withheld entirely. This uses the same policy as the native
`GitSensitivePathPolicy`, plus `.git/` internals.

**Allowlist.** Targets must be literal absolute paths. The heuristic resolves `~`, `$HOME`,
`$PWD`, single literal assignments and relative paths, but only against a known cwd: the
structured `working_directory` or a literal `cd`. `$HOME` is inferred from a
`/Users/<name>` or `/home/<name>` cwd. Paths with dynamic, glob or unusual characters are
dropped. Words whose `$` comes from single quotes are literal text, so they are never
resolved. At most 300 paths are kept. Paths inside roots that the normal capture
authoritatively reported net-empty are removed, so a reverted change can never be brought
back. An empty allowlist does not skip the model call: the one bounded attempt is still
made and must answer `{"unavailable":true}` (see below).

Escaped (`\$PWD`, `"\$PWD"`) and single-quoted `$` references are literal text and are never
expanded; such a target stays unresolved (blocking). A `$` inside an interpreter string
literal (`open('$HOME/x','w')`) is never resolved either, because whether the shell
expanded it first is unknown. Classification reads the client's **raw** terminal output
(the WebSocket layer forwards it separately from the formatted `TERMINAL OUTPUT:` tool
result), so a bare `mktemp` path is recognised in the real flow; tool history still gets the
formatted result. Only interpreter **write** calls count as resolved; a read-only
`open(…, 'r')` never offsets a computed-path write.

**Sensitive operands.** An operand that cannot be resolved (for example `../.env`,
`"$DIR/.ssh/config"` or `~/.config/…` without a known home) is still checked by its literal
components; a sensitive one withholds the script and output excerpts exactly like a resolved
sensitive target. Any dot-prefixed component anywhere below a home directory
(`~/.config/gh/…`, `~/work/.config/gh/hosts.yml`, `~/.zshrc`, repository dot directories such
as `~/project/.github/…`, also of another user's home) is sensitive, matching the native
non-Git policy. The only exceptions are the agent's own top-level `~/.omniAgent` /
`~/.omnikey` component and the exact task metadata entry
`~/.omniAgent|.omnikey/garbage/<id>/.omniagent-owned`; hidden components deeper inside a task
directory (for example `…/worktrees/repo/.config/…`) stay sensitive. An unresolved operand
with any hidden component (`../.config/x`) is sensitive too. Such targets are never offered
to the reconstruction model, and their excerpts are withheld (which blocks the card).

**Python path variables (static, sequential).** `NAME.write_text(…)`, `NAME.write_bytes(…)`
and `open(NAME, 'w'|'a'|'x'|'+')` resolve through a bounded static resolver
(`pythonPaths.ts`); Python is never evaluated. Every binding of `NAME` in the script must be
a top-level, unconditional `NAME = <path expression>` statement. Top-level means no
indentation, no single-line compound header (`if c: …`), and the statement is at the start
of the line, after `;` or right after `-c "`. A use takes the **latest binding textually
before it**, so reassignment (`p = …; p.write_text(); p = …; p.write_text()`) and aliasing
an immutable path (`q = p`) are resolved in order. Path expressions are limited to:

- `Path('<lit>')`, `Path.home()`, `Path(<expr>, '<lit>', …)`, or another resolvable name;
- `<expr> / '<lit>'` and `<expr>.joinpath('<lit>', …)`;
- `os.path.expanduser('~' | '~/<lit>')` and `os.path.join(<expr>, '<lit>', …)`.

`Path.home()` and `~` use the home directory of the known absolute shell cwd
(`/Users/<u>` or `/home/<u>`); the backend never looks up a home of its own. A `HOME=`
assignment, `sudo`/`su`/`doas` or `os.environ`/`os.putenv` anywhere in the script disables
home resolution. A relative result also needs a known cwd that no later `cd` changes. The
result must still pass the safe-path and sensitive-path policy (`..` segments are rejected).
The write stays unknown (and blocking) for any of these:

- an augmented, tuple or walrus binding, or any binding inside a block;
- attribute access other than `joinpath` (`.parent`, `.with_suffix(…)`), a variable or
  computed join part, a ternary, or a call result;
- a `for`, `with … as`, `import`, `del` or `global` binding, or use as a keyword argument;
- a use before any binding;
- `def`, `lambda`, `class`, `exec`/`eval`, `globals()`/`setattr()`/`chdir()` anywhere in the
  script.

**Agent task bookkeeping (`auxiliaryTargets`).** Agent bootstrap and cleanup scripts write
metadata into their own task directory. These writes are recorded separately as
`ShellWriteEvidence.auxiliaryTargets` (`{name, path?, removed}`), not as targets. They need no
diff coverage, so they never make a turn's coverage unknown, and they are never offered to
the reconstruction model. The recognised entries are deliberately narrow. Each must be a
direct child of one task directory `~/.omniAgent/garbage/<id>` or `~/.omnikey/garbage/<id>`:

- the metadata files `summary.md`, `status`, `ledger.tsv` and `.omniagent-owned` (any
  write);
- the scratch directories `prompts`, `logs`, `handoffs` and `tmp` (removal only).

Anything else under a task directory stays a normal target and must be covered. This
includes worktrees, deliverables, `integration*`, arbitrary `.md` files, nested paths, a
scratch name written as a file, and removal of the task directory itself. An explicit user
file that happens to be named `summary.md` directly in a task directory is treated as
bookkeeping by policy.

The task directory is proven either literally from the path shape, or through a shell
variable. A variable proves it only when all of these hold:

- it is assigned exactly once in the script (with no `read`, `for`, `unset`, `local` or
  `${V:=…}` binding);
- the assignment is a whole top-level line before any compound construct (`if`/`for`/`{`/
  `&&` continuation), and it runs before the variable is used;
- its value is either `$HOME/.omniAgent|.omnikey/garbage/<child>` (or a literal
  `/Users/<name>` home), or the bounded current-task lookup
  `$(ls -td "$HOME/.omniAgent/garbage"/<glob> 2>/dev/null | head -1)`.

`<child>` is built only from safe literal characters, `$(date +FMT)` with slash-free
directives, `$RANDOM`, `$$`, `uuidgen`, `openssl rand -hex N`, or another task-id variable
proven the same way. It never starts with `.`. Nothing is executed or looked up. When the
directory is only proven by pattern, `path` is absent.

These rules are bounds, not proof of the filesystem. An empty lookup result names `/status`
etc. at the filesystem root, which a normal user cannot write. The lookup may also pick
another task's directory, but it is still bookkeeping. At most 32 entries are kept; any
overflow is unknown.

A script that mixes bookkeeping with any unknown write is still `unresolved` and blocks.
Bookkeeping is never a blanket exemption for the command. Coverage still treats an
auxiliary entry as a write that may touch what it names: a later `rm -rf "$TASK_DIR/tmp"`
invalidates a checkpoint of a file inside any task's `tmp/`. More generally, a removal
target now invalidates every checkpointed path below it, not only an exact match.

**Creation and deletion.**

- `creationVerified` requires explicit evidence on a script that succeeded and either uses
  `set -e` or is a single command. The accepted evidence is `mkdir` without `-p` around the
  path, a noclobber `>`, or a temp-dir path printed by `mktemp`. Python exclusive open
  (`open(…, 'x')`) is not creation proof.
- `deletionAllowed` requires an `rm`/`unlink` target or an `mv` source.

**Model call.** One `aiClient.complete` call under the same 20 s budget, abort signal and
usage accounting as above, with no tools, the fixed `DIFF_RECONSTRUCTION_SYSTEM_PROMPT` and
`maxTokens: 4096`. Its input is limited to this run's input, the same bounded applied
`steeringUpdates` as the manifest call, the allowlist and this run's write evidence. It gets no history and no earlier turn. The reply must be exactly
`{"files":[{path,before,after}],"limitations":[…]}` or `{"unavailable":true}`; any other
shape yields no snapshot. The backend rejects the whole reply in any of these cases:

- a key is not allowed, or a path is outside the allowlist or repeated;
- `before: null` is given without verified creation (an unknown earlier state is never
  turned into a fake new file);
- `after: null` is given without allowed deletion;
- a NUL byte appears;
- a file exceeds 256 KiB, or all files together exceed 2 MiB or 300 files.

**Diff.** The backend builds the unified diff itself (`buildFilePatch`). It emits one hunk
around the changed region with 3 context lines, correct `\ No newline at end of file`
markers, and new/deleted file headers. A model patch is never accepted or executed. Roots
are deterministic: the longest known shell cwd that contains the path, otherwise the parent
directory, with at most 8 roots. A file whose new content contains a redaction marker is
dropped.

**Storage and viewer.**

- Payload: `recovery.kind: "ai_reconstructed"`, with `evidenceIds: []`, `toolCallIds`,
  `complete: false` (always), and fixed limitation lines. The first line is always "not
  verified against the filesystem". Model notes (≤3) are prefixed `Model note:`.
- Summary: `recovered: true`, `recoveryIncomplete: true`,
  `recoveryMethod: "ai_reconstructed"`. Native checkpoint recoveries now report
  `recoveryMethod: "checkpoint"`. `cleanSessionDiffSummary` keeps only these two values.
- Viewer: the header reads **AI-reconstructed turn changes** and shows an **Unverified**
  notice. Each repository is labelled "AI-reconstructed (unverified)". The verified native
  rendering is unchanged.

An unavailable, invalid, timed-out or cancelled attempt leaves no snapshot and the final
answer is unchanged. Each attempt is logged with counts only (never paths or content).
This fallback does not observe every write: dynamic paths, writes from other processes and
unrecognised commands are not included.

Write-like turns always make the bounded AI attempt when normal capture has no
snapshot, even when no native record or safely resolvable path exists. An empty
path allowlist requires the model to return unavailable; no invented paths or
original content are accepted. The /tmp native checkpoint uses POSIX realpath
for physical parent resolution before component-wise O_NOFOLLOW reads.

AI creation claims are deliberately narrower than write detection: Python exclusive
open is not proof, conditional/pipeline/substitution/function scripts cannot prove
absence, and a later shell cannot claim a file was absent at turn start. These
limits do not suppress the AI attempt; uncertain originals must be reported
unavailable instead of fabricated. The model response is capped at4096tokens, so
large before/after reconstructions may be omitted within the20second deadline.

### Coverage orchestration: no known-partial snapshot is ever attached

This section supersedes earlier statements above that a partial recovery is saved with a
warning, that AI reconstructions are always `complete: false`, and that a turn root without a
baseline is shown as "working tree only".

**No snapshot is saved before its known coverage is checked.** The final-answer capture
(`captureFinalSessionDiff`) now runs the normal capture through
`captureSessionDiffCandidate`. That call validates the reply but does not persist it. The
candidate is then assessed by `coverage.ts` (`coverageAssessment`). Only a candidate with
complete known coverage is saved and attached as before, with no extra model call.
`captureSessionDiffOutcome` keeps its old save-immediately behaviour for other callers.

**Known evidence of a turn:**

- literal write targets of this run's write-like shells (see the allowlist above);
- the root plus relative paths of every verified native record.

A path is **covered** when an actual patch section of a verified repository names it. A
net-empty root is **not** a blanket exemption: Git does not report ignored or otherwise
unobserved files, so a write to `report.txt` ignored by repo A leaves repo A net-empty while
the file changed. A path is **exempt** only with per-path proof: it is named by a native
`git` record of this run (Git observed it) and lies inside a root the automatic capture
reported net-empty. Such records are dropped (never resurrected) and their paths kept as
`revertedPaths`, so a later write target naming the same path stays exempt. Every other
known write target inside a net-empty root is still required and goes to the bounded AI
reconstruction; if that is unavailable, nothing is attached. Net-empty roots are returned with both `no_changes` and `captured`
outcomes: a recorded baseline root (the native collector captures every baselined root of an
`ok` turn final and omits empty patches) or a validated `turn` entry without a non-empty
patch. A working-tree entry never qualifies, and neither does a root that contains, or lies
inside, a changed repository. Git's single trailing TAB on `---`/`+++` names that contain a
space is stripped before comparison (recovery reply validation and coverage).

Paths are compared in normalised absolute form, with the macOS `/private` aliases folded.
Header paths come from `--- a/`, `+++ b/`, `rename from/to` and `copy to`, or from the
unambiguous `diff --git a/P b/P` form. Quoted (C-escaped) headers never count as coverage.
Coverage is never basename-only. Hunk bodies are never parsed as headers.

Verified repositories are:

- `turn`-scoped repositories of the automatic capture;
- legacy working-tree repositories (non-turn mode);
- native checkpoint replays.

In turn mode, a non-`turn` entry (baseline unavailable, "working tree vs HEAD") is **not**
verified evidence.

**Blocking uncertainties.** Each of these means a snapshot is never claimed complete:

- a write target that could not be resolved to a literal path (variables, globs, a relative
  path without a cwd, over-cap targets, or dynamic interpreter writes; see
  `ShellWriteEvidence.unresolved`);
- `git`/`patch` writes whose directory is not inside an authoritative turn root or a
  net-empty root. The directory is the shell cwd at that command after every literal
  `git -C` (a chained relative `-C` resolves against the previous one; nothing is looked up
  on the filesystem), recorded as `ShellWriteEvidence.gitDirs`. A non-literal `-C`
  (`-C "$REPO"`), a relative `-C` without a known cwd, `--git-dir`/`--work-tree`/
  `--namespace` or `patch -d` make the write `unresolved`. A literal `-C` into another
  repository is not covered by a capture of the cwd repository;
- truncated or withheld command evidence. This includes scripts that target sensitive
  paths: sensitive exclusions are policy limits, so the card is withheld rather than asking
  the model about secrets;
- per-run write or record budget overflow, `omitted` counts from the native store, and
  native records with `complete: false`;
- `omitted` in a `recover` reply: selected records the native replay could not reproduce
  (`checkpoint_replay_incomplete`). These are tracked separately from store omissions
  (`native_omitted`) and are never reported as such;
- any native `reason` other than the "Turn baseline unavailable" sentence, for example
  "Excluded N sensitive files";
- a baseline-less root whose uncommitted diff contains files that neither a verified
  checkpoint replay of this turn covers nor this turn's known writes explain. Its
  working-tree patch itself is never saved.

The 300-file viewer cap (`displayLimit`) is a display limit, not a coverage gap. A complete
raw patch of 100 files is attached normally.

**Bounded recovery when coverage is incomplete.** This applies only to v4-capable runs, at
most once per outer run, and under the same single 20 s budget, abort signal and connection.

1. If verified native records are not already covered, the manifest call and one native
   `recover` replay run as before. Replayed file sections already covered by the automatic
   base are removed, so a verified file is never duplicated. Unselected or unreplayed record
   paths simply stay missing.
2. If anything is still missing or blocking, **one** AI reconstruction call is always made
   for the known missing paths only, so there are at most two model calls in total. A
   record path counts as creation or deletion only when it is a `file` record with a `null`
   before or after hash.
3. The reply must address **every** required path exactly once. An entry with identical
   before and after content counts as unchanged. The reply is discarded in any of these
   cases:
   - a subset of the required paths is returned;
   - the model adds any limitation note;
   - any file is dropped or redacted;
   - the repository count or byte bound is exceeded;
   - a blocking uncertainty remains (the attempt is still made, then withheld), unless the
     uncertain-coverage proof gate below accepts it.
4. AI files are merged into the verified base. A file inside a verified root is grouped under
   that root, and each AI entry is marked `reconstructed: true`. Verified files are never
   replaced.

Unavailable, invalid, timed-out, cancelled or late results leave no card. The final answer
is unchanged.

**Truthfulness: unverified is not the same as incomplete.** A saved AI reconstruction has
`recovery.complete: true`, `recoveryIncomplete: false` and
`recoveryMethod: "ai_reconstructed"`. `complete` means the known coverage check passed. It
does not mean the content was verified, and it does not mean every change on disk is shown:
writes by unrecognised scripts cannot be detected, and the limitation lines say so. The
viewer always shows the **Unverified** notice. A merged snapshot is headed **Turn changes
with AI-reconstructed files**, labels only the marked entries "AI-reconstructed
(unverified)", and stores `recovery.base: "automatic" | "checkpoint"`. When every
reconstructed path was reported unchanged, the saved payload has a `base` but no
`reconstructed` entry; the viewer then keeps the verified labels (**Turn changes** /
**Recovered turn changes**, per-repository baseline or checkpoint titles) and only notes that
the model's "unchanged" claim is unverified. Legacy AI payloads without `base` and without
entry markers are still treated as AI-only.

**Older partial snapshots.**

- `GET /api/agent/sessions/:id/diffs/:diffId` answers
  `409 {"error":"Diff incomplete","code":"diff_incomplete"}`, without rendering, for any
  stored payload whose recovery metadata has `complete !== true`. Recovery metadata takes
  precedence: a complete recovery may legitimately mix `turn` entries with checkpoint or
  AI-reconstructed `working_tree` entries and is served. Only when recovery metadata is
  absent is a turn payload (`baselines` present) with a non-`turn` repository rejected.
- Transcript replay drops `session_diff` summaries with `recoveryIncomplete === true` or
  `baselineUnavailable === true`.
- Legacy working-tree payloads without these flags are served as before.

### Uncertain coverage with change proof ("Unverified — coverage uncertain")

Some turns are not known partial but **uncertain**: a write-like command had a target the
backend could not resolve (`write_target_unknown`) or its excerpt was cut
(`write_evidence_truncated`). Withholding every such turn hides real, provable changes, so
`uncertainProof.ts` admits a labelled AI viewer under a strict gate:

1. Every blocking reason must be one of those two. Known gaps and policy limits still
   withhold: `native_exclusion`, `baseline_unavailable`, `records_over_budget`,
   `native_omitted`, `native_record_truncated`, `checkpoint_not_final`,
   `checkpoint_replay_incomplete`, `writes_over_budget`, `too_many_missing_paths`.
2. No uncertain write (truncated, unresolved or Git-like) may carry redacted or withheld
   (sensitive) evidence.
3. The strict known allowlist (`coverage.missing`) is non-empty and is **not widened**:
   unknown writes contribute no path. With no known path nothing is saved.
4. The backend holds independent **current-turn change proof**. A successful write-like
   exit is not proof (`cp`, `mkdir`, `touch` or a no-op may change nothing), and nothing the
   model says is proof. Accepted proof (`recovery.changeProof`):
   - `verified_patch`: a non-empty turn-scoped automatic patch or a native checkpoint
     replay of this turn (a legacy working-tree patch is not turn evidence);
   - `native_record`: a complete native `file` record of exactly one path whose before and
     after hashes differ;
   - `exclusive_create`: a literal target of a succeeded first shell with verified creation
     evidence (`WriteTarget.created`) that no write removes.
5. The model must still address every known path (same strict reply, size and redaction
   rules). If the only proof is `native_record`/`exclusive_create`, at least one proven
   path must appear as a changed AI file; otherwise nothing is saved (`withheld_unproven`).

The usual single AI attempt is made (no extra provider call; still at most two per run).
Saved payload: `recovery.kind: "ai_reconstructed"`, `complete: false`,
`coverage: "uncertain"`, `changeProof`, `uncertainty`, and a first limitation line
starting `Coverage uncertain:`. Verified base files are kept and never replaced. Summary:
`recovered: true`, `recoveryMethod: "ai_reconstructed"`, `recoveryIncomplete: false`,
`recoveryUncertain: true` (kept by `cleanSessionDiffSummary`). The native button keeps its
existing "AI reconstruction · unverified" label; no client change is required. The viewer
heading reads **Turn changes · unverified — coverage uncertain** and shows an explicit
**Unverified — coverage uncertain** notice.

The route serves such a payload only when `isServableUncertainRecovery` holds:
AI-reconstructed, `complete: false`, non-empty known `changeProof`, and non-empty
`uncertainty` limited to the two reasons above. Any other payload carrying `coverage` is
treated as known partial (409). Payloads without `coverage` keep the `complete !== true`
rule.

This gate does not recover writes it cannot see. Contents changed by unrecognised or
computed non-Git writes are still not shown, and a turn with only an unknown write and no
proof still shows no card, unless the agent itself reports changes (next section).

### Agent-reported changes (`[files_changed]`, "Agent reported — not verified, not complete")

Some turns change files in ways the backend cannot see at all: a Python or Node script
that computes its paths, or a tool that writes as a side effect. No static allowlist can
cover every such script, so the agent is asked to report its own changes. This is a
**self-report, never proof**. It only decides that one AI reconstruction may be attempted,
and the result always says so. Implemented in `gitDiff/agentReport.ts`.

**Instruction (ephemeral).** Only when the run has `run.recovery` (v4 client, diff view
enabled, interactive), `completeWithContextRecovery` appends a fixed
`<omnikey_diff_report_instruction>` block to the **request copy** of the latest
`<user_input>` message. `session.history` is never modified, so the instruction is never
persisted, never accumulates, and never reaches a run with the setting off or without the
capability. The agent is asked to end its final answer with the following lines, outside any
code block, and only if it changed files during **this** request:

```text
[files_changed]
<changed_files>["/absolute/path", ...]</changed_files>
```

**Parsing (`parseAgentReport`).** Only the explicit candidate final of the success path is
parsed. Error/failure finals never are. A marker counts only as a standalone line (≤ 3
leading spaces) outside fenced code inside the `<final_answer>` body. Inline, quoted,
escaped, indented-code or fenced markers are ignored and left as written. Markers in user
input, tool output or earlier turns are never read. The manifest is strict: a JSON array of
1–300 unique safe absolute paths (≤ 1024 bytes each, ≤ 64 KiB total). Anything else
degrades to "marker only". A manifest without the marker is ignored. Both the marker and
the manifest are stripped before the final is stored in history or sent live. The report is
passed to the capture as a parameter of **this** candidate and is never stored on the run, so
a candidate superseded by steering cannot leave a stale flag behind. Recovery still runs at
most once per outer run.

**When it applies.** The normal capture is still attempted first and is unchanged. A complete
automatic snapshot is saved with no extra model call, and the independent-proof gate above
is still preferred. The agent report takes over only when (a) it names paths beyond the
known evidence, or (b) the only blockers are gaps it may bypass and no independent proof
exists. Bypassable gaps: `write_target_unknown`, `write_evidence_truncated`,
`baseline_unavailable`, `checkpoint_not_final`, `checkpoint_replay_incomplete`,
`native_record_truncated`, `native_omitted`, `records_over_budget` and `writes_over_budget`.
These **always withhold**: `native_exclusion`, a sensitive reported path, any redacted or
withheld uncertain write, and more than 300 paths. A missing-baseline working-tree patch is
never reused. A stale or partial checkpoint is dropped from the base and its paths are
reconstructed instead. Only verified turn captures and complete checkpoints stay as base.

**Paths the model may address.** With a manifest, the reported paths are required. With
the marker only, the candidates are optional and limited to absolute path literals found in
this turn's own evidence: write targets, native record paths, bounded excerpts of every
executed shell (`recordShellExcerpt`, ≤ 16 entries, script ≤ 4 000 / output ≤ 2 000
chars, secrets redacted, withheld when a sensitive path is named) and the final answer. The
model cannot invent other paths: the strict reply parser rejects the whole reply. Known
missing paths stay required. Excluded: paths already covered by a verified patch,
sensitive paths, and Git-observed paths of a net-empty root (`revertedPaths`). A
net-empty root alone never excludes a reported path, so an ignored file is still asked
about. With no candidate path, no call is made.

**Call.** The reconstruction uses a dedicated fixed system prompt (`AGENT_REPORT_SYSTEM_PROMPT`)
and no tools. Its context is limited to this run: the redacted user input, applied steering,
command excerpts and the final answer (≤ 4 000 chars). It shares the existing 20 s budget
and replaces the normal reconstruction call, so a run still makes at most two calls
(manifest + one reconstruction). The reply parser, size limits, redaction drop and
deterministic patch builder are the same as before. Unavailable, invalid or partial replies,
model-noted gaps, all-unchanged replies, redacted content, cancel and deadline all save
nothing. An empty viewer is never saved.

**Stored and shown.** `recovery.kind: "ai_reconstructed"`, `complete: false`,
`coverage: "uncertain"`, `reportSource: "agent_final"`, `uncertainty` = the bypassed gaps
(possibly empty), and `changeProof` only when independent proof also held. The self-report
is never written into `changeProof`. The first limitation line states that the report is not
verified and that the view may be incomplete. Summary: `recoveryUncertain: true` (legacy
clients keep their existing "AI reconstruction · unverified" button). Viewer heading:
**Turn changes · agent reported, not verified, not complete**. The route serves it only when
`isServableAgentReportedRecovery` holds.

**Tradeoff.** This trades the "proof only" guarantee for visibility of changes the backend
cannot detect. The snapshot is the model's account of what a self-reporting agent did. An
agent that changes files without reporting them, or reports only some of them, still gets
no card or an incomplete one. The label never claims otherwise.
