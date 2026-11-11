# Skills v1 contract

Frozen specification for sequential S0–S7; not evidence that implementation gates passed.
Types/limits: `api/src/skills/contracts.ts`. CLI management and backend preview only, no new agent runner. Live feedback only, no durable history. Same backend/identity sharing only; no installation sync. Strict CJK boundaries accepted. Genuine interactive WS messages including Telegram qualify; scheduled/internal inputs do not. Default enabled true. No new tool permissions or sandbox claims.

### Storage and lifecycle contract (v1)

New model `Skill`, table `skills`:

```
id: string                   // server-generated cuid, same convention as other resources
subscriptionId: string       // server-owned; FK; never accepted from request body
name: string                 // trimmed, 1..80 Unicode code points
keyword: string              // display value; trimmed, 1..80 code points
normalizedKeyword: string   // private canonical key
instructions: string        // nonblank plain text/Markdown, <=8,000 code points and <=32 KiB UTF-8
enabled: boolean            // default true
revision: integer           // starts at 1; increment atomically on every mutation
createdAt, updatedAt: dates  // API serializes UTC ISO-8601
```

Strict validated input objects: reject unknown/immutable fields, blank values, NUL, and disallowed controls. Names/keywords disallow line breaks; instructions allow tab/newline. Keywords must contain at least one Unicode letter/number and must remain <=80 code points after normalization. Normalize line endings to LF but preserve instruction layout. Display names need not be unique; normalized keywords must be unique within a subscription, including disabled skills. Create a database UNIQUE(subscription_id, normalized_keyword), not only an application preflight. Maximum 100 skills per subscription, checked transactionally; these are frozen v1 limits.

Atomic optimistic updates/deletes require `If-Match: "<revision>"`; 428 missing and 409 stale. A client reloads and lets the user reconcile rather than losing edits. SQL uniqueness conflicts also return 409 with a distinct error code. Hard delete in MVP, with UI/interactive confirmation and CLI `--yes` support. No automatic template-to-skill migration or seeded enabled skills. Deleting/disabling prevents future activation; it cannot undo already completed tool effects or revoke an in-flight frozen snapshot. Show this in the UI and provide existing Stop guidance for immediate cessation.

### Shared REST/service contract

Proposed files: `api/src/skills/{contracts,skillStore,matcher}.ts`, `api/src/models/skill.ts`, `api/src/skillRoutes.ts`. The API feature owns these; native DTOs mirror JSON rather than importing TypeScript source.

| Endpoint                 | Result                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| GET `/api/skills`        | `{skills: SkillSummary[]}`; stable name/id ordering, no instruction text in list                                 |
| POST `/api/skills`       | 201 `{skill: SkillDTO}` from `{name,keyword,instructions,enabled?}`                                              |
| GET `/api/skills/:id`    | 200 `{skill: SkillDTO}` with full instructions and revision                                                      |
| PATCH `/api/skills/:id`  | validated partial mutable fields, If-Match; 200 `{skill: SkillDTO}`                                              |
| DELETE `/api/skills/:id` | If-Match; 204                                                                                                    |
| POST `/api/skills/match` | `{text}` -> `{matches: AppliedSkillRef[], warnings: SkillWarning[]}`; no LLM/tools and no instruction disclosure |

Register `/match` before parameterized routes where relevant. Every operation uses authenticated subscription ownership; foreign IDs return 404. Structured errors: `{error:{code,message,fields?}}`, no stacks/instruction contents. Distinguish 400 validation, 401/403 auth, 404 missing/unsupported, 409 conflict, 413 input/budget limit, 428 required revision, 503 store unavailable. Do not turn arbitrary 404s into “empty collection.”

Internal interfaces to freeze in S0:

```
SkillDTO = { id, name, keyword, instructions, enabled, revision, createdAt, updatedAt }
SkillSummary = Omit<SkillDTO, 'instructions'>
AppliedSkillRef = { id, name, keyword, revision }
SkillWarning = { code, skillId?, message }
SkillSnapshot = AppliedSkillRef & { instructions }
SkillStore.listEnabled(subscriptionId): Promise<SkillMatchResult>
matchSkills(rawText, snapshots): { matches: SkillSnapshot[], warnings: SkillWarning[] }
resolveSkillsForInput(subscriptionId, rawText): Promise<...same result...>
```

`normalizedKeyword`/`subscriptionId` are internal, not mutable DTO properties. No per-client file copies. CLI must use HTTP, not SQLite. Skills live with the database backup, not in config.json or OS preferences. Hosted deployments can share skills for the same subscription on one backend; implementing local-to-local cross-device synchronization, conflict resolution, or cloud replication is **out of scope**.

### Matching specification

- Match only newly accepted raw user message text, before project context or instruction wrapping. Strip only known transport routing annotations through a shared helper; never scan saved history, skill instruction bodies, assistant output, web pages, terminal output, tool results, summaries, or injected recovery messages.
- Canonical comparison: Unicode NFKC -> locale-independent `toLowerCase()` -> collapse Unicode whitespace to one space -> trim. This is not locale-sensitive full case-folding: `STRASSE` does not automatically equal `Straße`. Accent removal/stemming/transliteration are out of scope.
- Literal phrase search with whole-token outer boundaries. Boundary character class: Unicode letter/number/mark or underscore. A match requires start/end of input or a neighboring character outside that class. Do not use ASCII `\b` or accept user regexes.
- Multiword phrases match normalized whitespace (including newlines); punctuation _inside_ the phrase is literal. `code review` matches `Code   Review!`, not `code-review` or `code reviewer`.
- `sql` matches `(SQL)` but not `nosql`, `sql2`, or `sql_helper`. `c++` is allowed; outer-boundary checks prevent matching inside `abc++` or `c++17`. Punctuation-only keywords and reserved OmniKey routing tokens (`@omniagent`, `@omnikeyai`) are rejected. The boundary policy for non-space-separated languages is intentionally strict; document it and revisit if necessary.
- Duplicate canonical keywords conflict even if case/width/whitespace differs or a record is disabled. Different subscriptions may reuse the same keyword.
- Every distinct matching enabled skill activates once. Overlapping phrases all match. Order by first occurrence, then longer normalized phrase, then stable id (compare strings by code point, not host locale). Order is presentation order, not an authority hierarchy.
- Match quoted text and code fences too in MVP: the requirement says a message _containing_ the keyword. Document accidental activation; no natural-language intent classifier or parser heuristics. Prefer distinctive keywords.
- Cap at 8 matching skills and 16,000 aggregate instruction code points per active run. Reject the new input before model/tool work if it exceeds limits; report which limit, never silently truncate or select an arbitrary subset. Reuse that rule for preview and accumulated steering. Include overlay tokens in actual model context budgeting; character caps alone are not a token guarantee.
- Disabled: ignored. Invalid stored row: skip it, emit a safe warning and continue valid matches; never inject malformed instructions. Entire store unavailable: fail closed for the new input before model/tool work and show retry guidance, not silent processing without requested skills. Zero matches: unchanged agent behavior.

### Agent integration and lifetime

1. At a genuine normal turn in `turnRunner.ts`, authenticate/obtain the subscription and resolve skills from raw text before adding user content or starting the model. A helper `skillContext.ts` should centralize resolution and runtime state. Avoid applying to cron/grouping/internal service work in MVP.
2. Snapshot matched ids, revisions and instructions into runtime-only turn state; record a run/input identifier for idempotence. Do not add instructions to the session's system message, persisted history, template snapshot, project context, or model memory.
3. At `completeWithContextRecovery`, construct an immutable provider-request copy and add a **user-role**, clearly labeled Skills section associated with the latest genuine user input. Do not insert between a tool call and its tool results. Keep original history unchanged. Apply after persistent session-memory summarization, and account for overlay tokens while trimming. Recovery must reconstruct the overlay once from the snapshot after pruning, rather than repeatedly appending or pruning it away. All tool-loop model calls already use this boundary; audit any exceptions.
4. Trusted `agentPrompts.ts` text states existing system rules and stored instructions remain higher priority; Skills are optional user-provided task guidance, below an explicit current user/steering instruction. Proposed order: system > existing stored instructions > explicit current user/steering > applicable skill guidance. Skills never grant tool/network/filesystem permissions. Treat contradictory skill instructions as conflicting guidance, not as a reason to execute both unsafe actions; ask for clarification if not resolved by the explicit request.
5. Use structured serialization (e.g. a JSON array in the user section) rather than interpreting arbitrary instruction text as role delimiters. Escaping prevents structural ambiguity, not semantic prompt injection; do not claim a prompt wrapper guarantees model compliance. Existing server tool allowlists and client execution controls remain authoritative. Existing limited-terminal behavior is partly prompt/tool-description based, so this feature must not claim a new shell sandbox.
6. Steering: preserve synchronous enqueue/deduplication semantics. Resolve each accepted steering input before applying it at a safe point (an async preparation/drain wrapper may be needed). Add newly matched skills to the active run; dedupe by id, preserving the first snapshot for that run. An edit midway through a run affects the next run, not the old snapshot. A failed steering resolution is rejected visibly without corrupting prior active context. Repeated steering ids/retries do not reapply or duplicate notices. Notify about newly applied skills only.
7. Internal continuations and tool results reuse active context without rescanning. Next normal user input starts a new active set. Completion/error/cancel/disconnect clean state at the actual outer run boundary—not each recursive helper call. Test queued messages and simultaneous sessions explicitly. A no-keyword next message must not inherit the overlay. Model outputs can still mention earlier results; that is conversation history, not continued activation.
8. Runtime application feedback: optional `skill_status` on an ordinary agent wire notice: `{input_id,status:'applied'|'warning'|'blocked',skills:AppliedSkillRef[],warnings:SkillWarning[]}` plus backward-compatible plain `content`. No instructions in events. Modern clients render a neutral “Applied: …” status, never as a tool request or final answer; old clients receive no Skills notices unless they opt in. Escape names, dedupe by input id and status, and clear active badges at new input/end.
9. MVP feedback is live only. It is deliberately not a persisted activation/audit transcript; reopening a chat must not imply previously applied skills are active. Persisted provenance is optional follow-up. This avoids unnecessary changes to transcript schema and accidental instruction leakage. If durable badges are promoted to required, define their model/migration before UI tasks.

### UI and CLI

**Native list/detail/editor:** Skills entry next to Task Instructions/MCP; empty-state explanation; name, trigger, enabled state; add/edit form with multiline plain/Markdown editor; view full instructions; switch enable/disable; delete confirmation. Explain literal matching, turn lifetime and provider transmission. Show pending/success/error states; disable duplicate submissions; retain draft after validation/network failure; report server field errors and stale-revision conflicts. Fetch on opening/explicit refresh and after mutations; no polling or push invalidation needed. Test UI list updates from a CLI edit after refresh. Never let a skill edit modify task templates.

**macOS:** new `Skill.swift`, `SkillsView.swift`, `SkillsWindowController.swift`; extend `APIClient.swift`, menu/auth gating in `main.swift`; decode notices in both `ChatSessionRunner.swift` and `AgentRunner.swift`, with focused presentation helpers. Reuse `MarkdownTextEditor.swift` where appropriate. Check cancellation and Swift concurrency isolation.

**Windows:** new `ViewModels/SkillsViewModel.cs`, `Views/Pages/SkillsPage.xaml` and code-behind; extend `ApiClient.cs`, navigation in `Views/MainWindow.xaml`; decode notices in `AgentRunner.cs` and `ChatSessionRunner.cs` and present in `ViewModels/AgentSessionViewModel.cs`/`ChatViewModel.cs` as required after tracing both consumers. Use existing async MVVM, UI-thread dispatch and error patterns. WPF runtime tests require Windows even though cross-target compilation is enabled.

**CLI proposed commands:**

```
omnikey skills add --name "SQL review" --keyword "sql review" --instructions-file ./review.md
omnikey skills list [--json]
omnikey skills show <id> [--json]
omnikey skills edit <id> [--name ...] [--keyword ...] [--instructions-file ...]
omnikey skills enable <id>
omnikey skills disable <id>
omnikey skills delete <id> [--yes]
omnikey skills match --text "Please do a SQL review" [--json]
```

Interactive prompts when required input is absent on a TTY; `--instructions-file -` reads stdin. In non-TTY mode fail clearly rather than hanging or opening an editor. `edit` fetches current revision; all mutations send If-Match. Limit bytes before loading file/stdin; no shell interpolation or execution of instructions. Consistent nonzero exit on API/file/auth errors; JSON goes only to stdout, diagnostics to stderr. Reuse auth/port conventions, finite request timeouts and existing expired-token behavior. Do not log keys or instruction bodies. `skills match` invokes the backend matcher, not a local approximation.

## Exact v1 decisions

- Server cuid IDs, UTC ISO timestamps, revision starts at 1. Every valid nonempty patch increments it, including no-op updates.
- If-Match is exactly one quoted positive safe integer, e.g. `"1"`. Missing: 428 REVISION_REQUIRED; malformed: 400 VALIDATION_ERROR; stale: 409 REVISION_CONFLICT. Foreign IDs: 404 NOT_FOUND. No weak tags or wildcard. DTO revision suffices; Item responses use strong revision ETags.
- Strict create/patch/preview objects reject unknown fields. Instructions normalize CRLF/CR to LF, reject C0/C1 controls except tab/LF. Names/keywords reject C0/C1 including tabs/newlines. Reject NUL everywhere. Unicode whitespace is ECMAScript `\s` with Unicode flag. Reject canonical reserved keywords @omniagent and @omnikeyai.
- Preview-only input limit before normalization: 100,000 code points AND 400,000 UTF-8 bytes. Empty/whitespace input: no matches. Instruction limit: 8,000 code points AND 32,768 bytes. Aggregate active union: eight IDs and 16,000 instruction code points. Never truncate.
- Codes/types in contracts.ts are authoritative. Quota: 409 SKILL_QUOTA_EXCEEDED. Input/active/aggregate limits: 413 INPUT_LIMIT_EXCEEDED / ACTIVE_LIMIT_EXCEEDED / CONTEXT_LIMIT_EXCEEDED. Unavailable store: 503 STORE_UNAVAILABLE. Invalid rows: safe INVALID_SKILL warnings. Skills-owned errors use structured envelope; existing auth middleware may retain legacy auth errors, which clients must handle safely.
- List: name then id by Unicode code point, independent of DB/host locale. Match offsets and phrase lengths use normalized Unicode code points. Tie IDs also compare by code point. No input/snapshot mutation.
- Strip only existing leading transport routing prefix, not arbitrary embedded words or XML-looking text; shared helper for preview/activation.
- Nonterminal status notice has safe plain content and optional skill_status; blocked may include error, applied refs contain only new skills. Never instructions. Dedupe input_id + status. Clear live badges on new input/end/stop/error/disconnect; never persist notices or restore active badges on reopen.
- Runtime context resolves after auth before history/model/tools. Steering enqueue/dedup remains synchronous; async preparation validates union before committing steering/history. Failure preserves prior run, visibly rejects new input. Retain first immutable snapshot per ID. Continuations reuse; only outer lifecycle clears.
- Overlay is a request-copy user-role serialized JSON section outside tool call/result pairs; count real model tokens and reconstruct exactly once after recovery. Never modify system/history/transcripts/memory/templates/static caches. Priority: system > stored instructions > explicit current/steering > skill guidance. Allowlists/native execution controls unchanged.
- Backend-first rollout. List endpoint 404 means upgrade-required, not empty. Item 404 means missing, not necessarily old backend. Old clients receive no Skills notices unless they opt in. Keep table on downgrade; disable/delete affects future runs, Stop ends active run.

## Acceptance fixtures

| Input / keyword or case                                   | Expected                                                |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `(SQL)` / sql                                             | match                                                   |
| nosql sql2 sql_helper / sql                               | none                                                    |
| ＣＯＤＥ　Review! / code review                           | match                                                   |
| code followed by newline/spaces then review / code review | match                                                   |
| code-review code reviewer / code review                   | none                                                    |
| c++ / c++                                                 | match                                                   |
| abc++ c++17 / c++                                         | none                                                    |
| café / café                                               | match NFKC                                              |
| STRASSE / Straße                                          | none (no full case fold)                                |
| 数据库 / 数据                                             | none                                                    |
| 数据 surrounded by spaces / 数据                          | match                                                   |
| quoted/fenced sql / sql                                   | match intentionally                                     |
| code review / code and code review                        | both; longer first at same offset                       |
| repeated keyword                                          | once per id                                             |
| duplicate canonical key including disabled/concurrent     | 409 per owner                                           |
| same keyword different owner                              | allowed, isolated                                       |
| 9 matches or >16,000 aggregate                            | reject entire input before model/tools                  |
| disabled/malformed row/unavailable                        | ignore/warn-skip/block                                  |
| tool/history/web/recovery/cron contains keyword           | no activation                                           |
| same steering ID retry                                    | no duplicate history/overlay/notice                     |
| edit/delete mid-run                                       | immutable first snapshot; next ordinary input refreshes |
| recovery/continuation/model switch                        | exactly one overlay in actual provider request          |
| next no-keyword/stop/error/disconnect                     | no inherited overlay/badge                              |
| malicious role delimiters                                 | serialized user data; unchanged permissions             |

## Ownership and verification

S0 lead contracts; S1 store/HTTP; S2 pure matcher; S3 agent; S4 CLI; S5 macOS; S6 Windows; S7 integrated verification/docs. Each increment independently reviewed and committed sequentially. Lead owns shared contracts/lockfiles/versions/integration. S1 preview may explicitly remain unavailable pending S2; no fake implementation or false completion. Final required gates: isolated SQLite upgrade/restart, PostgreSQL smoke, matcher/agent/steering/API/CLI tests, native builds/tests/runtime, old/new compatibility and packed CLI. Unavailable platform checks must be reported blocked, never waived or claimed passing.

## Independent review resolutions (normative)

These precise decisions supersede less-specific prose above.

### Compatible wire feedback

New ingress capability `supports_skill_status?: boolean` opts in only when literal true. Snapshot it per input/send target, never persist it as a session preference. Send nonterminal Skills notices ONLY to opted-in clients; old hotkey runners interpret plain content as final. Old clients and Telegram still activate skills but do not get Skills notices until upgraded. S5/S6 advertise support only after ALL receiving runners handle skill_status before command/final parsing; render refs as literal plain text and continue receiving. Do not fake web/MCP flags.
Notice content is exactly one of `Skills applied.`, `Some skills were skipped.`, `Skills could not be applied.` Never interpolate names, keywords, instructions or raw errors into content: existing clients parse executable tags. Structured metadata must not pass through HTML/Markdown/command parsing. Names/keywords also reject Unicode Cf and U+2028/U+2029, preventing bidi/zero-width spoofing. Instructions remain arbitrary user data.
Blocked ordinary input emits an opted-in blocked notice, then an existing terminal error frame to ALL clients: fixed final-answer-tag-wrapped `Skills could not be applied. Please retry.` with is_error true. Do not persist blocked text/failure/overlay in history, memory or transcript. Existing session metadata creation is permitted before resolution but no model/title/grouping call on rejection. Steering rejection uses existing rejected acknowledgement with fixed safe reason and optional blocked notice; prior run continues.
Ordinary input_id: server cuid once at acceptance, retained across retries. Steering: normalized steering_id; legacy missing IDs get one server ID but cannot promise transport-retry dedup. S3 explicitly adds per-run ID dedup before enqueue, including pending/applied/rejected IDs. FIFO steering resolves fresh store at drain, validates/commits each input separately; failure rejects only that input. Received then rejected acknowledgement is expected. First snapshot wins. Applied notice contains new refs only; send a separate warning notice when needed. Blocked replaces both for rejected input.

### Limits, errors and parser

The raw-text size limit applies ONLY to HTTP preview. Agent matching preserves existing accepted message sizes and processes the entire genuine raw input; it never silently truncates or skips matching. Active skill/instruction budgets apply identically to preview and agent. Internal/tool feedback is not scanned. Store outage blocks genuine input even if owner has no skills; document availability tradeoff.
S1 installs a Skills-specific parser/error boundary BEFORE global express.json, leaving unrelated route limits intact. Serialized JSON cap 2,500,000 bytes accommodates escaping; decoded cap stays 400,000 bytes/100,000 code points. Invalid JSON: structured 400; oversized body: structured 413 INPUT_LIMIT_EXCEEDED. Auth legacy string errors are accepted by clients alongside structured errors; never log raw bodies. Missing subscription after middleware: 401 UNAUTHENTICATED. Known storage failures: safe 503; unexpected nonstorage failures: safe 500 INTERNAL_ERROR.

### Services and runtime

Store validates all enabled rows and returns valid snapshots in matches plus safe INVALID_SKILL warnings for every malformed enabled row on each resolution. Matcher defensively validates snapshots and recomputes keyword, never trusts persisted normalizedKeyword. Audit persisted uniqueness before upgrading Node/ICU Unicode versions. Limits throw SkillError; failed preview is only SkillErrorBody, no partial refs. Resolver deduplicates combined warnings. Snapshot omits enabled since store filters it; defensive matcher ignores runtime objects with enabled=false.
Append overlay to the latest genuine user message in a deep request copy AFTER session memory. If pruned away, insert one user message at a safe boundary after complete tool-result pairs. Track input association; reserve overlay tokens before trimming; reconstruct once on every retry; ensureSessionMemory never sees it.
Eligibility: accepted interactive queue/steering message, sender client, not terminal/error/web feedback, not isCronJob/internal options. Scheduler/regroup excluded. Late terminal output starting another run never activates. Shared routing helper strips one leading ASCII case-insensitive @omniagent or @omnikeyai followed by whitespace/end after leading whitespace, not embedded tokens; do not reuse createUserContent's broader replacement.

### Validation and fixtures

Instruction caps after CRLF/CR→LF conversion; reject blank but preserve other layout. Names/keywords trimmed first; canonical keyword also <=80. NBSP/ideographic spaces allowed, line separators forbidden. Empty patch: 400. If-Match rejects weak tags, wildcard, zero, leading zero, unquoted values, lists, unsafe integers. Item responses set strong ETag from revision (avoid Express auto weak tags).
Additional fixtures: cafe\u0301 vs caf\u00e9; İ→i+combining dot (keyword i alone does not match); ﬁ→fi; fullwidth ＠omniagent rejected; emoji-only keywords rejected; combining mark after sql blocks; start/end matches; exactly 8/16,000 accepted; instruction cap edges; ID code-point order differs from UTF-16. Tag-looking names never enter content or dispatch tools.
CLI --json success equals endpoint envelope; delete returns {"deleted":true}. Exit 0 success, 1 API/auth/conflict/network/file failure, 2 usage/validation/missing non-TTY args. Diagnostics stderr; stdout success JSON only.

### Concrete API and event fixtures

Create: POST /api/skills `{"name":"Review","keyword":"code review","instructions":"Check edge cases.","enabled":true}`.
201: `{"skill":{"id":"cskill1","name":"Review","keyword":"code review","instructions":"Check edge cases.","enabled":true,"revision":1,"createdAt":"2026-11-11T00:00:00.000Z","updatedAt":"2026-11-11T00:00:00.000Z"}}`, strong ETag `"1"`.
Patch: If-Match `"1"`, `{"enabled":false}` gives revision 2.
428: `{"error":{"code":"REVISION_REQUIRED","message":"A revision is required."}}`.
409: `{"error":{"code":"REVISION_CONFLICT","message":"Skill changed. Reload before retrying."}}`.
Preview request `{"text":"Please code review"}` response `{"matches":[{"id":"cskill1","name":"Review","keyword":"code review","revision":1}],"warnings":[]}`.
Opted-in frame: `{"session_id":"s1","sender":"agent","content":"Skills applied.","skill_status":{"input_id":"i1","status":"applied","skills":[{"id":"cskill1","name":"Review","keyword":"code review","revision":1}],"warnings":[]}}`.

### Final S0 clarification

S6 ownership explicitly includes windows/ChatSessionRunner.cs. It sends stable steering_id on new steering messages. Notice capability belongs to the connection RECEIVING the frame (turn owner for applied steering); never infer it from another connection. Legacy steering correlation is best-effort if no ID was supplied.
Create/patch over-length or invalid fields return 400 VALIDATION_ERROR with fields keys name/keyword/instructions/enabled (or body for object-level failures). CLI local usage/validation is exit 2; ALL HTTP failures, including server validation, exit 1. Skills auth runs before its scoped JSON parser; mounting before global parser also requires necessary logger/auth context before it. Old backend detection is by list HTTP 404 status, regardless of HTML body.
Blocked terminal text is fixed by error code, with no user-controlled interpolation: STORE_UNAVAILABLE = `Skills are temporarily unavailable. Please retry.`; ACTIVE_LIMIT_EXCEEDED = `Too many skills matched. Use fewer keywords or disable some skills.`; CONTEXT_LIMIT_EXCEEDED = `Matched skill instructions exceed the context budget. Shorten or disable skills.`; INPUT_LIMIT_EXCEEDED (preview only) = `Preview text is too long. Use a shorter sample.`; other errors = `Skills could not be applied. Check settings and try again.` Wrap the selected safe text using the existing terminal error envelope. This replaces the generic retry message above.
Overlay label is `Applicable Skills (user guidance only)` followed by JSON.stringify of an array of objects with id, name, keyword, revision, instructions in that key order. No hand-built role delimiters. Provider fixtures compare this content, placement, roles and unchanged tools; serialization escapes structural content but is not a semantic injection guarantee.

Final wire details: notice is_terminal_output=false and is_error=false, including blocked notices; terminal error is a separate frame. S3 owns adding supports_skill_status to AgentMessage. Status error.message uses the same fixed per-code terminal text. Clients key HTTP errors on code, not message wording; FORBIDDEN is reserved for structured auth adapters. Overlay separator is two LF characters before the label and one LF between label and JSON.

## Implemented budgeting and checkpoint policy

Skill overlay tokens use a conservative UTF-8-byte reservation plus message overhead; the repository has no exact provider tokenizer. History and tool schemas retain the existing estimator. This can over-reject large ASCII skills on small-context models; it is not an exact-token guarantee. Irreducible/unknown budgets fail closed, and provider context errors retry with one reconstructed overlay before a fixed context-limit error. For active-skill inputs, the unanswered input checkpoint is deferred until the first successful provider response: a crash during that call can lose that unanswered input. Completed tool work remains checkpointed. Context-remaining estimates may stay conservative until the next turn. Steering first-snapshot unions are budgeted after deduplication, not against edited rows. Quota takes precedence over duplicate-key errors when already at 100 saved skills.
