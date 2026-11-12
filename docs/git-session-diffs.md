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
- Limits: 50 file panels across all repositories (files past the cap get no DOM; one
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

**Final phase**: `{ phase: "final", baselines: [recorded…], display_limit: 50,
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
least one verified record. No records means no model call. Both the success final and the
failure final go through the same helper (`captureFinalSessionDiff`). The existing steering
recheck still runs after the capture and before history is persisted.

**Restricted manifest call.** This is one `aiClient.complete` call on the run's current model.
It has no tools, a fixed literal system prompt (`DIFF_RECOVERY_SYSTEM_PROMPT`), and
`maxTokens: 1000`. Its input is limited to:

- this run's own user input, trimmed to 2,000 characters;
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
nothing is stored or attached. The original final answer is never changed, delayed past the
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
- records the native store omitted;
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
Native records keep at most50allowlisted paths (both rename sides included), and
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
dropped. At most 50 paths are kept. Paths inside roots that the normal capture
authoritatively reported net-empty are removed, so a reverted change can never be brought
back. If nothing is left, no model call is made.

**Creation and deletion.**

- `creationVerified` requires explicit evidence on a script that succeeded and either uses
  `set -e` or is a single command. The accepted evidence is exclusive creation
  (`open(…,'x')`), `mkdir` without `-p` around the path, a noclobber `>`, or a temp-dir path
  printed by `mktemp`.
- `deletionAllowed` requires an `rm`/`unlink` target or an `mv` source.

**Model call.** One `aiClient.complete` call under the same 20 s budget, abort signal and
usage accounting as above, with no tools, the fixed `DIFF_RECONSTRUCTION_SYSTEM_PROMPT` and
`maxTokens: 4096`. Its input is limited to this run's input, the allowlist and this run's
write evidence. It gets no history and no earlier turn. The reply must be exactly
`{"files":[{path,before,after}],"limitations":[…]}` or `{"unavailable":true}`; any other
shape yields no snapshot. The backend rejects the whole reply in any of these cases:

- a key is not allowed, or a path is outside the allowlist or repeated;
- `before: null` is given without verified creation (an unknown earlier state is never
  turned into a fake new file);
- `after: null` is given without allowed deletion;
- a NUL byte appears;
- a file exceeds 256 KiB, or all files together exceed 2 MiB or 50 files.

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
