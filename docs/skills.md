# Skills

Skills are reusable user-provided guidance activated by literal keywords in new agent messages or steering. Manage them from **Skills** in the macOS menu, **Skills** in Windows navigation, or `omnikey skills`. Every interface uses authenticated HTTP against the same backend collection; there is no native or CLI skill database.

## Quick start

```sh
omnikey skills add --name "Code review" --keyword "code review" --instructions-file review.md
omnikey skills list --json
omnikey skills match --text "Please code review this change" --json
omnikey skills show <id>
omnikey skills edit <id> --instructions-file revised-review.md
omnikey skills disable <id>
omnikey skills enable <id>
omnikey skills delete <id> --yes
```

`--instructions-file -` reads piped stdin. Missing required inputs prompt only on an interactive terminal; noninteractive commands fail rather than hanging. `match` is a backend-only preview: it does **not** run an agent, tools, or an LLM. The CLI has no new chat runner. Successful `--json` output goes to stdout; diagnostics go to stderr. Exit codes: 0 success, 1 HTTP/auth/network/file failure, 2 local usage failure. Requests and stdin reads have finite timeouts.

## Matching

Comparison is Unicode NFKC normalization, locale-independent lowercase, collapsed Unicode whitespace, and trimming. Whole-token outer boundaries exclude letters, numbers, combining marks, and underscore. `sql` matches `(SQL)` but not `nosql`, `sql2`, or `sql_helper`. `code review` matches `Code   Review!`, not `code-review`. `c++` matches alone, not `c++17`. Accents are not stripped; lowercase is not full case folding (`STRASSE` does not equal `Straße`); Greek sigma follows JavaScript's contextual lowercase rules. CJK uses these same strict boundaries, not linguistic segmentation.

Quoted text and code fences also match. Choose distinctive keywords to avoid accidental activation. Overlapping phrases all apply, once per skill, ordered by first occurrence, longest phrase, then ID. Order is not priority. Canonical duplicate keywords conflict within one identity, even if disabled. Known leading OmniKey routing prefixes are stripped once; embedded text is not rewritten.

Limits: 100 saved skills; name/keyword 80 code points; instructions 8,000 code points and 32 KiB UTF-8; at most 8 active skills and 16,000 aggregate instruction code points per run. Preview input is capped at 100,000 code points/400,000 UTF-8 bytes. Agent input retains its existing limits. Overflow rejects the input rather than silently choosing a subset. Invalid stored rows are skipped with safe warnings; a store outage blocks new genuine inputs even for an empty collection.

## Lifetime, priority and privacy

Only genuine incoming user text and steering activate skills. Tool/terminal/web output, history, summaries, recovery prompts, scheduled jobs and internal grouping do not. Each running turn keeps immutable first snapshots; later edits, disabling or deletion affect subsequent runs, not the active one. Steering adds newly matched snapshots without changing earlier ones. Use **Stop** to end an active run immediately.

Instructions are serialized into a temporary **user-role provider-request copy**, never the system prompt, stored history, transcript, task template or memory. System rules and stored instructions outrank explicit current input/steering, which outrank skill guidance. Skills grant no tools, permissions, browser access or shell sandbox. Hostile instructions remain untrusted task guidance.

Enabled matched instructions are sent to the selected model provider. They are stored in the backend database and backups; do not use skills as a secret store. List/preview/status responses omit instruction bodies. Live notices show applied names or warnings; they are not durable activation history and are not restored as active badges on reopen.

Overlay budgeting uses a conservative UTF-8-byte bound, not an exact provider tokenizer. History/tool schemas use the existing estimator. Small-window models can reject large ASCII skill sets conservatively. An active-skill input is checkpointed after its first successful model response; a crash before that can lose the unanswered input. Completed work remains checkpointed. Context-remaining estimates can remain conservative until the next turn.

## Sharing and conflicts

Sharing requires **the same backend URL and authenticated identity/subscription**. Independent installations do not synchronize. The CLI follows the existing local-daemon port/config conventions; a hosted-configured native app does not automatically share the local CLI collection. Refresh after changes from another client.

Updates/deletes use quoted `If-Match` revisions. A stale revision gets 409 and must be reloaded. Native editors preserve drafts and merge untouched fields from the latest version; conflicts in fields edited on both sides remain explicit. Running snapshots are unaffected. Rejected steering needs a new user send/ID to retry. Failed steering bubbles are live-only and may disappear when server history is reloaded; durable failed-input history is not part of this MVP.

## Compatibility, migration and rollout

Deploy the backend first, then CLI/native clients. Old clients still execute agent turns; only clients explicitly advertising `supports_skill_status` receive nonterminal notices. New clients report an unsupported older backend rather than silently displaying an empty collection.

SQLite startup creates an empty `skills` table and unique owner/keyword index through the existing Sequelize sync/migration architecture; existing templates/sessions are not converted or seeded. Hosted PostgreSQL uses the existing sync/alter path. Back up the DB before upgrade and test migrations in staging. Recheck canonical-key uniqueness before Node/ICU Unicode upgrades. Rollback can disable/delete skills for future turns, or revert code while retaining table data; no destructive downgrade migration is included.

CLI/API versions are bumped together because `cli/**` changes trigger npm publication on merge to main. This PR does not publish, deploy or merge. Native runtime smoke checks and Windows UI validation remain release gates; see [verification notes](skills-verification.md). Existing self-hosted authentication/CORS behavior is unchanged: localhost is not an independent security boundary.

See [the exact v1 contract](skills-contract.md) for DTOs, error codes, events, fixtures and acceptance rules.
