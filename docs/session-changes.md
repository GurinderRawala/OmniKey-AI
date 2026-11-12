# Session Changes (macOS)

The **Changes** button (±, in the chat header, also `⇧⌘D`) opens a native sheet
showing the net file changes in the folders you chose to track for that chat.
It is also available for a new, unsent chat; tracking is moved to the real
session when you send the first message.

## Scope

- **Opt-in only.** Nothing is scanned until you choose a folder with
  *Track Folder…*. There is no machine-wide or automatic scan.
- **Baseline = the real bytes on disk when tracking starts**, including dirty
  and untracked files. It does not use Git or `HEAD`, and works for non-Git
  folders. If tracking starts after the chat already has turns, the baseline
  is labelled *tracking start*, not *session start*.
- **Net diff.** The sheet shows baseline → latest capture, not a series of
  per-turn patches. Only those two states are kept; intermediate edits are not
  recorded and a file that was changed and reverted shows no change.
- **When captures happen.** Before and after every local shell command run for
  the chat (success, failure or cancellation), at the end of each turn
  (final answer, error, stop), and when you press *Refresh*. The legacy
  `@omniAgent` hotkey flow uses the same hooks for sessions that have tracked
  folders.
- **Not captured.** Remote tools (MCP servers, scheduled/API jobs, the
  backend) are not observed. Shell scripts are never parsed to infer what
  they touched.
- **Attribution is limited.** Each changed file shows whether its last change
  was seen *during a tool run* (may still include concurrent writes by you,
  editors, or background processes) or *observed* between tool runs. The app
  never claims the agent authored a change.
- **Stage / revert are not provided.** The diff is read-only.

## What is shown

- Text (any extension, UTF-8 without NUL bytes): unified diff with old/new line
  numbers, `@@` hunk headers, `+`/`−` markers, Nord semantic colors, selection
  and copy. CRLF line endings are shown with a trailing `␍`; a missing final
  newline is shown as `\ No newline at end of file`. An added empty file has no
  line changes and is labelled as such (distinct from a missing file).
- Binary files, symlinks (never followed; target string only), special files
  and permission-only changes are shown as metadata cards: state, type, size,
  mode, SHA-256 prefix. No line counts are invented.
- Renames are shown as an add plus a delete (no rename inference).
- Large previews are bounded (5,000 rows, 1,000 characters per row) and the
  truncation is disclosed. *Copy Patch* / *Export…* produce the complete,
  exact unified patch from stored content. *Reveal* opens the live file in
  Finder.
- If the edit distance exceeds 512 operations, the changed region is shown
  as a whole replacement and the sheet says so.

## Exclusions and coverage

Never captured: `.git/ .hg/ .svn/ node_modules/ .build/ build/ DerivedData/
dist/ .next/ .nuxt/ .cache/ __pycache__/ .venv/ venv/ .tox/ .mypy_cache/
.pytest_cache/ Pods/ Carthage/ target/ .gradle/ .idea/ .terraform/ .aws/ .ssh/
.gnupg/ .swiftpm/`, `.env`, `.env.*`, `.netrc`, `.npmrc`, `.pypirc`, SSH keys,
`credentials`, `.DS_Store`, and `*.pem *.key *.p12 *.pfx *.keychain *.keystore`.

Each tracked folder lists files seen and how many entries were excluded,
over the size limit, unreadable, symlinks not followed, or skipped because the
storage budget was full. If a scan hits the file-count or byte limit, or a
subdirectory is unreadable, the scan is **partial**: previously recorded files
that were not seen are left unchanged and are **not** reported as deleted.
Files absent from a partial baseline are labelled *Not in partial baseline*
rather than *Added*.

Removing a folder (*Stop Tracking*) pauses it; its baseline is kept. Adding
the same folder again resumes it with the original baseline — root changes
never silently reset a baseline.

## Storage and privacy

- Metadata: SQLite at
  `~/Library/Application Support/OmniKeyAI/SessionChanges/changes.sqlite`
  (system `SQLite3`, WAL). Content: LZFSE-compressed, content-addressed blobs
  (SHA-256) under `.../SessionChanges/blobs/`, shared across sessions so
  identical bytes are stored once. Directories are `0700`, files `0600`.
- This feature does not upload snapshots. They remain local (OS/user backups are outside its control). The store is created
  lazily when a folder is first tracked or storage settings are saved.
- Defaults (gear button): storage budget 1 GiB of compressed content, per-file
  limit 4 MiB, retention 30 days of inactivity, 20,000 directory entries per folder,
  512 MiB read per scan. Files over the per-file limit keep size/mode only.
- When the budget is reached, new content is **not stored** and the file is
  marked accordingly with a warning; existing baselines are never evicted to
  make room.
- Retention removes snapshots of unpinned chats that have been inactive past
  the retention period (not the chat currently open or a chat mid-tool-run).
  Such chats show an *expired* notice. Pinned chats are exempt but still count
  toward the budget.
- *Delete Snapshots…* (with confirmation, disabled while a turn is running)
  removes a chat's baselines, captures and tracked folders. Files on disk are
  never touched. Blobs no longer referenced by any chat are removed; orphaned
  blobs left by a failed write are swept when the store opens.

## Implementation map

- `SessionChangesStore.swift` — SQLite schema, blob store, budget, retention,
  orphan sweep.
- `SessionChangesScanner.swift` — bounded, symlink-safe scan with exclusions.
- `SessionChangeTracker.swift` — serial capture queue, tool/turn hooks,
  change computation, diff loading.
- `SessionChangesDiff.swift` — Myers line diff, hunks, preview bounds, patch.
- `SessionChangesViewModel.swift`, `SessionChangesView.swift` — sheet UI;
  diff text uses [CodeEditTextView](https://github.com/CodeEditApp/CodeEditTextView)
  0.9.1 (MIT), read-only and selectable.
- Hooks: `ChatSessionRunner.startAgentWebSocketSession` (`changeTracker`
  parameter), `AgentRunner` legacy shell path, `ChatModel` (pending
  migration, end-of-turn reconcile).

## Known limitations

- Captures are synchronous on the shell worker thread before/after each
  command; very large folders add latency up to the scan limits.
- Capture uses pinned directory descriptors and `openat`/`O_NOFOLLOW`, rehashes
  contents even when size and timestamps match, and checks identity/type before
  reading. A scan is still a rolling observation, not an atomic filesystem snapshot.
- Hard-linked regular files are captured as files inside the approved root;
  exclusions are a best-effort filename policy, not a secret detector.
- Diff text copies include the line-number gutter; use *Copy Patch* for a
  clean patch.

## Manual UI checks (not yet performed)

1. New chat → Changes → Track Folder… on a dirty non-Git folder; baseline
   label says *session start*; send a message that edits a file; diff appears.
2. Existing chat with turns → track folder; label says *tracking start*.
3. Edit a file in an editor between turns → row labelled *observed*.
4. Binary file, `chmod +x`, symlink to outside the folder → metadata cards.
5. Long file → truncation notice and full text patch export where supported;
   files above 100,000 lines show an explicit saved-but-not-rendered card.
6. Lower per-file limit / budget in settings → oversize / budget warnings.
7. Pin, Delete Snapshots… confirmation, Stop Tracking and re-add (baseline kept).
8. Resize the chat window to its minimum; sheet remains usable; VoiceOver
   reads file rows with status.
9. Quit and relaunch; reopen the chat; changes reload without the live files.

## Implementation safeguards and v1 boundaries

- File contents are persisted one bounded file at a time; a scan does not hold
  the whole workspace in memory. Per-file capture is configurable up to 16 MiB.
  Full reads of approved files prioritize correctness over metadata-only shortcuts.
- Descriptor-relative enumeration counts directories and excluded entries toward
  the traversal budget. Read/listing failures never invent deletions. A root
  missing or inaccessible after tracking retains its last endpoint with a warning.
- Intermediate latest blobs are reclaimed after successful captures. Storage
  budget applies to compressed blob payloads; SQLite/index metadata is additional.
  Low disk (<256 MiB plus the next blob) pauses capture with an explicit error.
- Expiration runs when storage opens and when the panel loads. Active turns and
  tools and pinned snapshots are protected. The currently viewed session is
  protected during panel refresh; initial storage-open expiry still applies. It is not a background
  timer. Chat deletion also deletes its local snapshots after active tools exit.
- Pending capture has a per-app-launch identity, so an old unsent chat's baseline
  cannot attach to an unrelated new chat. Abandoned pending snapshots expire normally.
- Diff computations are serialized off-main, cancellation-aware during Myers search,
  with a 512-edit-distance coarse-but-content-exact fallback. Files over 100,000 lines
  remain saved but show an explicit diff-unavailable card to bound allocations. Preview is bounded;
  cache holds at most four entries and skips full patches over 1 MB.
- Export is a single-file **text-content unified diff**, not a full Git changeset:
  it does not encode mode changes, renames, or empty-file creation/deletion. Such
  changes remain visible as metadata; empty and control-character-path exports
  are disabled. File contents can still be reviewed without Git.
- CodeEditTextView 0.9.1 is pinned (MIT). Its SwiftLint build-tool plugin is a
  transitive build-time dependency, not a web/runtime dependency.
- No syntax highlighting, split mode, filesystem watcher, or full mutation history
  in v1. Captures occur at shell boundaries/end-of-turn/manual refresh; arbitrary
  background writers and remote effects are not guaranteed to be attributed.
- Full-width native tint overlays supplement +/- markers; selecting diff text
  includes its printed line-number gutter. Copy Patch omits that gutter.

Per-file unreadable/changing content is recorded as an unavailable file, not an
incomplete directory enumeration. Only traversal failures/limits suppress
inferred additions and deletions for unseen paths. The current implementation
performs a full orphan sweep after capture; this is bounded by stored content but
can add tool-boundary latency for many retained files.
