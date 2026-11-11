# Skills MVP verification and release gates

Local verification on macOS (2026-11-11). These are implementation results, not the planning baseline. No deployment, merge or publication was performed.

## Completed checks

| Check | Result |
|---|---|
| Integrated `yarn test` | API: 38 files, **670 passed**, including opt-in PostgreSQL; CLI: **40 passed**; Telegram script explicitly has no tests |
| API `tsc --noEmit` | Passed |
| CLI `tsc --noEmit` and `yarn workspace omnikey-cli run test:types` | Passed; production excludes test files, test source checked separately |
| `yarn lint` | Passed, zero errors; 261 API + 23 CLI + 1 Telegram warnings (28 added API test `any` warnings) |
| CI TypeScript Prettier check | Passed |
| `yarn build` | Passed in a disposable checkout to avoid overwriting the running application's build outputs |
| CLI package inspection | Version 1.8.17 includes Skills commands, model, routes, matcher and resolver; bundled backend files match fresh API output byte-for-byte |
| Built CLI process checks | Help exit 0; unknown command, missing non-TTY confirmation and excess delete arguments exit 2; closed-port daemon exit 1 with empty stdout |
| CLI HTTP lifecycle smoke | Unit smoke uses injected auth; additional built CLI + bundled API smoke passed full add/list/edit/toggle/delete/preview using real subscription activation/JWT middleware on disposable SQLite and ephemeral loopback HTTP |
| SQLite upgrade/restart | Existing schema/templates/session+memory preserved; empty new table/index, restart durability, quota/uniqueness/CAS races tested |
| PostgreSQL 18.6 | Disposable private Unix-socket instance, unique schema: hosted CRUD, sync/alter, ownership, revisions, canonical conflict and concurrent quota tests passed |
| macOS full build and `swift test` | Passed in isolated scratch/cache; **165 tests**, zero failures, including 65 new Skills-related cases |
| Windows `dotnet build` | Cross-build on macOS: zero errors and warnings |
| Windows `dotnet test windows.Tests/OmniKey.Windows.Tests.csproj` | **127 passed**; links production platform-neutral code, not the WPF runtime |
| `git diff --check` | Passed at each increment; repeated before PR |

Agent tests capture actual mocked provider payloads through ingress/turn/tool/steering/recovery code, not only matched IDs. They cover user-role overlays, permission invariance, persistence exclusion, immutable snapshots, FIFO steering union, cancellation/disconnect, TTL, blocked limits, context recovery, multiple sessions and subscription isolation. Native tests cover early notice interception before shell/final parsing, including malformed/null/adversarial frames. Old clients receive no notices unless they opt in; old-backend error tests do not assume a 404 is an empty collection.

## Independent local Claude review outcomes

Every increment S0–S6 received a fresh read-only Claude CLI review; substantive fixes received fresh re-review before their focused commits. Resolved findings included legacy-client notice termination/execution hazards, SQL logging exposure, matcher memory amplification, steering first-snapshot budgets/TTL/cancellation, active-session subscription isolation, CLI excess arguments/auth status mismatch, macOS conflict overwrite and hotkey error-paste behavior, and Windows delete revision/steering text loss/late callbacks. Lead independently inspected diffs and reran integrated checks. S7 documentation/CI/PostgreSQL tests received independent review and re-review with no remaining blockers. Complete-branch review is recorded in the PR after completion; reviewer claims alone were not treated as validation.

## Blocked or unperformed release gates

- **Windows runtime/UI:** no Windows host. Cross-compilation and linked-source tests do not prove WPF rendering, bindings, focus, keyboard/Narrator or live chat behavior. Test CRUD, refresh during delete confirmation, same-daemon CLI interoperability, steering rejection while typing/multiple pending/background sessions, Stop then immediate new turn, and neutral notices on Windows before release.
- **macOS manual UI/live backend:** intentionally not launched/restarted because this agent runs inside OmniKey. Full build/tests pass, but manual CRUD/editor rendering, keyboard/VoiceOver, actual hotkey document integration, live provider chat/steering and CLI-to-native refresh remain unperformed.
- **Same-daemon native interoperability and live provider payloads:** transport contracts/mocked payloads are tested; no claim of manually exercising both native apps against one disposable daemon or contacting a real model provider.
- **Interactive terminal/editor path:** injected prompt tests pass; real terminal editor/confirmation UX is not manually verified.
- **CI remote results:** local checks do not imply GitHub Actions have passed. Windows CI now requests .NET 10 and runs the new test project; confirm CI after opening the PR.

## Known limits and rollout notes

Overlay token reservation is conservative, not exact provider tokenization; history/tools retain existing estimation. Initial active-skill input checkpoints wait for the first successful model response, with the documented crash window. Context-remaining hints may stay conservative until the next turn. Failed steering bubbles and application feedback are live-only; reopening from server history can discard failed-input presentation. Existing self-hosted CORS/auth behavior and unrelated untagged hotkey-error behavior are not redesigned.

Backend first, then CLI/native releases. API and CLI move to 1.8.17 together; merging CLI changes to main triggers publication. Back up DBs, audit canonical keywords before Unicode-runtime changes, retain table data on rollback. Native application versions are not bumped here: no native release or packaging publication is authorized. See [Skills guide](skills.md) and [contract](skills-contract.md).
