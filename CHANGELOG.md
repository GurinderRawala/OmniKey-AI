# Changelog

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
