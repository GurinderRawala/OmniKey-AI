# Turn changes: capture scope and limits

The Diff view compares starting filesystem bytes with later observations for **one turn**, not the full pull request or cumulative session. Pre-existing dirty bytes form the baseline; unchanged pre-existing edits are not counted again. Steering continues that baseline. Other processes' writes within selected folders can appear; this is not an authorship claim.

## Register folders before editing

Structured `working_directory`, literal leading `cd`/`git -C`, and `capture_paths` register folders before shell execution. Inert shebang/comment/`set -euo pipefail` preambles are supported. Arbitrary variables, command substitutions and script bodies are never evaluated to discover paths.

Use `capture_paths: ["/absolute/task/worktree"]` on the shell call that first edits a dynamic folder. It does not change execution directory or create folders. Create a worktree first, then register it before editing. A baseline captured after a script has edited a folder cannot recover its original contents.

Native linked-worktree inventory uses bounded `git worktree list --porcelain -z` and verifies the common Git directory. Only worktrees inside selected/registered scopes are admitted. Sibling worktrees belonging to other sessions are not implicitly captured: register their exact path or intentionally select their task parent. Selecting a repository subfolder never expands to its repository parent. Discovery is opt-in on the wire; older clients continue without it. Final snapshots require acknowledged baselines.

Nested roots are independent even under a partial parent. Each file has one owner: the parent keeps starting bytes it captured and verifiable additions observed before registration, and the child captures omitted files with its later timing. Ownership is preserved through deeper nesting. Coverage is independent. Removed registered children do not become mass deletions in the parent; intentional deletions verified before cleanup remain in the retained diff.

## Checkpoints and cleanup

Live scans continue during tools. Retention uses explicit pre-tool and successful-post-tool checkpoints, not the latest poll. Failed/cancelled tools do not promote intermediate scans. Removed/replaced folders retain a checkpoint with timing explained; without a checkpoint capture is unavailable, not an imaginary empty folder.

Edits and removal in the **same opaque tool** may be missing. Background processes can overlap tool boundaries, so retained contents are not guaranteed to precede external cleanup; coverage discloses this. Captures are not atomic filesystem transactions. Finish and checkpoint worker edits before releasing folders; retaining worktrees until review remains useful.

## Bounded storage

A private content-addressed store uses 0700 directories, 0600 blobs, digest verification, pinned descriptors and sensitive-path exclusions. A deduplicated 16 MiB inline cache spills to disk; disk is bounded at 1 GiB per turn and per application process. Transient blobs are pruned. Normal release removes only owned blobs. Startup cleanup of version-marked abandoned stores uses advisory locks to preserve live stores, including those in other processes; it never recursively deletes unknown content.

Defaults: 50,000 entries and 256 MiB per root scan; 1 MiB per file; eight roots; 12-second baseline budget plus bounded discovery; four-second live scan and patch-generation budgets; 2 MiB aggregate patch output. Roots receive fair time/patch shares. Discovery admission requests are bounded to 128 per turn, with a separate reserved native request slot for the final capture. Render caps remain separate.

Limits remain safety controls, not a promise of arbitrary workspace completeness. Excluded/unreadable files, disk failures and exhausted budgets produce partial/unavailable coverage, never invented original bytes or deletions.

## UI and tests

Shared live/saved presentation distinguishes complete-empty (no changes detected in captured folders), incomplete-empty, late/checkpoint, and genuinely unavailable states. The visible title is Turn changes; a PR may include earlier turns.

`swift test --package-path macOS` covers real linked worktrees, nested ownership in both orders, staged 46k-line cleanup, failed and nested cleanup, socket/timer integration, storage corruption/quota/lease cleanup, UI states, and a >10k-file/>32MiB fixture with edits beyond old limits.

`pnpm --filter omnikey-ai-api test` covers admission/alias validation, legacy fallback, no rebasing, explicit registration and safe preamble parsing. Neither needs a daemon restart or app installation.

Symlinked selected scopes carry their native-resolved physical scope in discovery responses; the API validates worktree containment against that scope without resolving execution-host paths on the server. A retained baseline from a timed-out request may be acknowledged in a later reply only when its source and path match an issued request. Already acknowledged baselines cannot be replaced.
