# Changelog

## macOS 1.9.18 (build 78) · CLI/API 1.8.20 — 2026-11-13

### Added
- Agent chat settings gear beside the context controls opens Agent Access settings directly.
- Persistent Diff view toggle explains that recovery may consume extra AI tokens. Disabling it stops new-turn Git capture, native checkpoints and AI recovery—not just the display. Running turns retain their start-time setting.
- Missing-diff recovery uses current-turn checkpoints and bounded AI reconstruction, clearly distinguishing unverified content. Known partial snapshots are withheld and checked against all known turn evidence.
- Raised the viewer and recovery file cap to 300 while preserving byte and time limits.

### Fixed
- Python literal Path bindings and narrowly recognized task bookkeeping no longer hide complete repository-plus-temporary-file snapshots.
- Protected non-Git credential/configuration paths, sensitive unresolved write targets, raw terminal evidence, applied steering, normalized history filtering, and mixed changed/unchanged repository coverage.
- Corrected temporary-directory aliases, rename paths, stale replay handling, and macOS CI physical-path assertions.

### Validation and scope
- Non-E2E regression coverage includes persistent settings, actual diff-cost opt-out, narrow composer layout and CodeRabbit findings. No app/E2E launch performed.
- Signed, notarized universal macOS package; Windows unchanged. The separate per-shell fingerprint cache proposal is deferred until cache invalidation covers Git configuration, attributes and concurrent writers safely.

## macOS 1.9.17 (build 77) · CLI/API 1.8.19 — 2026-11-12

### Fixed
- Saved turn-wide Git diffs retain a fresh baseline HEAD per user input, combine all commits in that turn with current uncommitted/untracked changes, and reset the baseline on the next turn. Existing final-answer snapshots remain immutable.
- Diff display is capped at50file panels with a clear omitted-file count. Late-discovered repositories disclose their later baseline; missing baselines never guess commit history.
- New chats retain the cached task instruction while refreshing; stale task/model responses no longer overwrite newer selections. Unsent drafts restore their project/model choices, and existing sessions no longer inherit another chat's project.
- Task, project and model names stay visible in a compact single-row composer. Full names and task-instruction excerpts are available in help text, and custom model labels retain their version identifiers.
- First sends wait for pending task-default changes to finish, preserving the draft rather than starting with mismatched instructions.
- Commit detection skips heredoc data and recognizes literal commits outside supported heredocs, including Python staged-file verification. Decoy commits inside heredoc data, unsafe expansions and malformed delimiters do not grant commit eligibility.
- Clearer hover hints on management refresh/default controls.

### Release and validation
- macOS 15+, universal Apple Silicon/Intel; CLI/API 1.8.19, Node 22+. Windows artifacts unchanged.
- Local new-session regression tests cover task/project/model changes, outgoing selection values, draft restore, asynchronous response ordering and narrow composer sizing. Real temporary Git repositories exercise heredoc commit capture. Live app/VoiceOver acceptance is not claimed by automated tests.
- Previously missed historical snapshots are not fabricated or backfilled; the heredoc fix applies to future executions.

## macOS 1.9.16 (build 76) · CLI/API 1.8.18 — 2026-11-12

### Added
- Automatic Git repository snapshots saved with each agent answer, compressed and restored with session history. No folder selection is required; non-Git work has no diff button.
- Right-hand diff inspector powered by Pierre server-side rendering, with Unified and Side-by-side layouts and automatic system appearance.
- Clean repositories can show the latest commit when it matches observed agent execution in the current or immediately previous session run; unrelated user commits are not inferred from author or time.

### Fixed
- Backend-bound authentication snapshots prevent credential/URL races; commit detection avoids exponential regex backtracking and provenance persistence has a bounded deadline.
- Compact chat composer menus remain usable beside the diff inspector; symlinked project roots retain verifiable identities across client/server capture.
- Side-by-side horizontal scrolling stays inside the old/new code panes instead of moving the page into blank space. Diff banners match the message column width.
- Git capture honors validated execution directories, includes staged/unstaged and eligible untracked changes, and preserves each final answer's immutable snapshot identity.
- Rendering runs in bounded, terminable workers so syntax highlighting cannot stall the API event loop. Authenticated snapshots are owner/session scoped, script-free, and isolated in the macOS WebView.

### Release scope and compatibility
- macOS 15+, universal Apple Silicon/Intel distribution. CLI and API are 1.8.18 and require Node 22+; Pierre is installed in both runtime packages.
- Windows version and artifact remain unchanged. Working-tree snapshots may include pre-existing edits; binary content and sensitive filename patterns are excluded or summarized. Commit attribution is conservative under concurrent writers.
- No app/E2E launch was performed by the release agent; the user handles UI acceptance. See docs/git-session-diffs.md for capture and rendering limits.

## macOS 1.9.15 (build 75) · CLI/API 1.8.17 — 2026-11-11

### Added
- Backend-owned Skills with authenticated management, deterministic Unicode keyword matching, match preview, and shared SQLite/PostgreSQL persistence.
- macOS Skills management with enabled/disabled state, revision-safe edits and deletes, and live application feedback.
- CLI `skills` commands for management and preview; no new CLI agent runner.

### Fixed
- Skills apply through temporary user-level context only; running turns retain immutable snapshots. Tool permissions and persisted history are unchanged.
- Saved skill instructions render as Markdown. Draft navigation offers Save, Discard or Cancel; editor sessions have isolated undo history.
- Compact, screen-bounded Skills windows and scrollable fields keep Save/Cancel reachable on small displays.
- Authentication refreshes and queued chat connections stay bound to their subscription and backend; stale activations cannot restore cleared credentials.
- Session ownership is checked before admission, and persistence is subscription-scoped. Steering acknowledgements reach their sender; applied notices wait for provider acceptance.
- Removed redundant bold headings from progress milestones and duplicate VoiceOver prefixes.

### Release scope and compatibility
- **macOS app only:** universal Apple Silicon/Intel build, Developer ID signed, notarized and stapled. Requires macOS 15 or later, matching the existing Swift package deployment target; bundle/appcast metadata now declares that minimum accurately.
- **Windows:** existing source changes are retained, but no Windows version bump or new Windows artifact is released. The previously published Windows 1.21.2 ZIP remains unchanged; Windows runtime validation is still outstanding.
- CLI/API versions remain 1.8.17. CLI publication to npm and macOS CLI tarballs/Homebrew are included in this release.
- Skills sharing requires the same backend and identity. Keywords are literal phrases, not comma-separated alternatives. Independent installations do not synchronize.
- Back up databases before upgrade. Keep Skills table data when rolling code back. Conservative context budgeting can reject large skills on small-context models.

### Validation
- Prior integrated validation: 700 API tests (2 optional PostgreSQL tests skipped locally), 41 CLI tests, 258 Swift tests, 161 Windows platform-neutral tests; Windows cross-build only.
- The user tested the pre-release macOS app from this source branch. The signed 1.9.15 bundle was verified for signature, notarization, architectures and metadata without launching a second app instance. Windows runtime testing is not claimed.

Earlier release history: https://omnikeyai.ca/changelog
