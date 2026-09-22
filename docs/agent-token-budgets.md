# Continuous agent context management

CLI 1.8.5 removes the cumulative token and model-call cutoffs introduced in
1.8.4. Interactive and scheduled tasks no longer stop just because they have
used two million tokens or made 100 model calls. Old `AGENT_MAX_RUN_TOKENS` and
`AGENT_MAX_MODEL_CALLS` settings are ignored. Usage accounting (including cache
reads/writes) remains enabled independently; there is no hard spending cap.

## Automatic compaction

| Environment / local config key | Default | Purpose                                                                              |
| ------------------------------ | ------: | ------------------------------------------------------------------------------------ |
| `AGENT_MEMORY_TRIGGER_TOKENS`  |   24000 | Summarize at this estimated history size, or half the model input budget if smaller. |
| `AGENT_MAX_OUTPUT_TOKENS`      |    8192 | Output ceiling per main-agent completion. Memory helpers use 1400.                   |

Values must be positive integers. Configure through environment variables or
`~/.omnikey/config.json`, then restart the daemon. Existing explicit compaction
settings remain respected; the new default applies when no override is set.

The daemon summarizes older completed work and automatically continues the
same task with compact memory plus recent history. During intra-task compaction,
it retains two recent complete tool rounds and the latest two real user messages;
static instructions remain intact. A minimum 8000-token eligible batch avoids
summarizing every step. Full stored transcripts remain available to the UI.
Failed or empty summaries back off for 60 seconds rather than interrupting work.

## Markdown recovery checkpoints

Every successful compaction also saves a readable Markdown checkpoint on the
daemon host, normally at:

`~/.omnikey/session-context/<account-hash>/<session-hash>.md`

If `OMNIKEY_CONFIG_PATH` is customized, the `session-context` directory is next
to that configuration file. Hosted deployments write on the server, not on a
remote desktop client. Account and session names are hashed to prevent path
traversal and account collisions. Files are atomically replaced with owner-only
permissions (mode 0600 on Unix, an explicitly verified owner-only DACL on
Windows). Windows permissions are applied to an empty temporary file before
any context is written; if enforcement or verification fails, no checkpoint is
published and execution continues using database memory. Checkpoints may contain
sensitive session context and should stay private.

The file records the goal, established findings, changes/validation, open work
and the next action, plus metadata tying it to the exact summarized transcript
prefix. It covers the summarized portion, not the latest unsummarized steps.
The database remains authoritative. When database memory is absent, the daemon
can recover a matching checkpoint before the next model request. Corrupt,
mismatched, symlinked or oversized files are ignored. Missing/unwritable files
never stop execution. Deleting/pruning a session also attempts to remove its
checkpoint; transient grouping helpers do not get files.

Only the compact summary is inserted into requests, never the whole Markdown
file plus a duplicate transcript. A checkpoint is recovery context, not new
instructions or authorization. A file alone does not reduce tokens: replacing
old request history with its summary is what saves tokens.

## Remaining protections

Tool output remains bounded and schema overhead is included in context estimates.
Prompt caching remains enabled. Existing safeguards for repeated provider
context errors, output truncation, failed web fallback, and invalid responses
remain in place, as does user cancellation. These handle actual failures, not
cumulative usage. Provider outages, filesystem/tool failures, and provider
context limits can still interrupt a task; this release removes the artificial
usage-limit interruption, not those external constraints.
