# Agent token controls

CLI 1.8.4 introduces cost-oriented budgets independent of provider context size.
These apply to interactive and scheduled agent runs, including recursive
recovery, steering restarts, and memory-helper calls. Existing settings migrate
automatically through the defaults; no database migration is needed.

| Environment / local config key | Default | Purpose                                                                                             |
| ------------------------------ | ------: | --------------------------------------------------------------------------------------------------- |
| `AGENT_MEMORY_TRIGGER_TOKENS`  |   32000 | Summarize at this estimated request size, or half the model input budget if smaller.                |
| `AGENT_MAX_MODEL_CALLS`        |     100 | Maximum application-level model attempts per external run, including summaries and context retries. |
| `AGENT_MAX_RUN_TOKENS`         | 2000000 | Cumulative input plus output tokens per run, including cached tokens.                               |
| `AGENT_MAX_OUTPUT_TOKENS`      |    8192 | Output ceiling for each main-agent completion. Memory helpers use 1400.                             |

Values must be positive integers. Configure them via environment variables or
`~/.omnikey/config.json`, then restart the daemon. These are deployment/local
configuration settings, not new desktop preference controls. Provider SDK
transport retries are not separate application-level calls.

The run token guard checks recorded usage plus estimated next input before a
call. Estimates are approximate, and the final response can exceed the remaining
budget; this is a between-call guard, not a billing hard cap. A usage-limit pause
saves a visible checkpoint. A new user follow-up starts a fresh budget and keeps
the prior work. Automated runs stop rather than automatically resetting limits.

Memory compaction preserves the static instructions, latest two real user
messages, and at least four recent complete tool rounds. It can compact within
one lengthy user task without breaking call/result pairs. A minimum 8000-token
eligible batch avoids excessive summarization. Once memory exists it remains in
use even after switching to a larger model. Failed/empty summaries back off for
60 seconds. Full persisted transcripts are not replaced by summaries.

Tool results sent to models are capped at approximately 16000 characters with
head/tail excerpts and an explicit truncation notice. This includes MCP, web,
shell and internal custom tools. The agent can request narrower results when
necessary. Request trimming includes estimated tool-schema overhead and protects
stored instructions, session memory and the latest user request. Prompt caching
remains enabled.

Monitor input, output, cache reads/writes, calls per task, and limit pauses after
deployment. A high cache hit rate does not mean low token volume or zero cost.
The defaults are starting points: adjust for workload while preserving adequate
context and output space for correct coding work.
