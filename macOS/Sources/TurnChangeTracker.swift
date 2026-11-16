import Foundation

/// Coverage describes the filesystem scope, never authorship. A late-discovered
/// root stays late for the whole run, including steering continuations.
struct TurnRootCoverage: Codable, Equatable, Hashable, Sendable {
    let root: String
    let status: String // complete, partial, late, unavailable
    let reason: String
    let suggestedFix: String
}

struct LiveTurnDiff: Equatable, Sendable {
    let turnID: String
    let revision: Int
    let status: String
    let repositories: [GitDiffRepositoryPatch]
    let coverage: [TurnRootCoverage]
}

/// Owned by one socket run. All methods are called on its serial capture queue.
/// Manifests hold digests only; contents live in a private per-turn
/// `TurnSnapshotStore` (bounded memory plus bounded owned disk blobs), never in
/// Git commits/index entries.
///
/// Retention: live scans update the view while a folder exists but are never
/// retained. Only explicit tool boundaries (`beginTool`/`endTool`) commit a
/// checkpoint. A folder removed/replaced later is shown from its last
/// checkpoint; a scan taken mid-cleanup can never become the retained state.
/// Edits and removal inside the same opaque tool are not recoverable: that
/// interval is reported, not reconstructed.
final class TurnChangeTracker: @unchecked Sendable {
    struct Limits {
        var files = 50_000
        var fileBytes = 1_048_576
        /// Bytes read per root per scan (baseline bytes are stored on disk).
        var rootBytes = 256 * 1_048_576
        var patchBytes = 2 * 1_048_576
        var seconds: TimeInterval = 4
        /// Starting snapshots of large roots may take longer than a live scan.
        var baselineSeconds: TimeInterval = 12
        var patchSeconds: TimeInterval = 4
        var store = TurnSnapshotStore.Limits()
    }
    struct File: Equatable {
        let bytes: Data
        let mode: String
    }
    /// Metadata for one captured file; bytes are loaded lazily from the store.
    struct Entry: Equatable {
        let blob: TurnSnapshotStore.Blob
        let mode: String
    }
    struct Manifest {
        var files: [String: Entry] = [:]
        var unknown: Set<String> = []
        var absent: Set<String> = []
        var limitsReached: Set<String> = []
        var excluded = 0
        var enumerated = true
    }
    struct Root {
        let baseline: GitTurnBaseline
        let manifest: Manifest?
        let identity: TurnFileReader.DirectoryIdentity?
        /// Nested roots whose new paths this root no longer enumerates.
        var excludedSubroots: Set<String> = []
        /// Paths (relative to this root) whose starting bytes an enclosing
        /// root already owns. Never captured here, so never duplicated.
        var delegatedPaths: Set<String> = []
    }
    struct Checkpoint {
        let manifest: Manifest
        let afterTool: Bool
    }
    let turnID = UUID().uuidString
    var limits = Limits()
    var scanNow: () -> Date = Date.init
    private var roots: [String: Root] = [:]
    private var checkpoints: [String: Checkpoint] = [:]
    private var rootOrder: [String] = []
    private var rootAliases: [GitRootAlias] = []
    private var omittedRoots: Set<String> = []
    private var toolDepth = 0
    private var revision = 0
    private var previous: LiveTurnDiff?
    private var timer: DispatchSourceTimer?
    private var observer: TurnRootObserver?
    private var observationQueue: DispatchQueue?
    private var needsScan = true
    private var lastScan = Date.distantPast
    private var storage: TurnSnapshotStore?
    private let fm = FileManager.default
    private let skippedDirectories: Set<String> = [".git", "node_modules", ".build", "DerivedData", ".venv", "__pycache__"]

    /// Created on first use so tests can adjust `limits.store` first.
    var store: TurnSnapshotStore {
        if let storage { return storage }
        let created = TurnSnapshotStore(limits: limits.store)
        storage = created
        return created
    }

    func start(queue: DispatchQueue, isActive: @escaping @Sendable () -> Bool,
               publish: @escaping @Sendable (LiveTurnDiff) -> Void) {
        guard timer == nil else { return }
        observationQueue = queue
        observeRoots()
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: .milliseconds(750), leeway: .milliseconds(150))
        source.setEventHandler { [weak self] in
            guard let self else { return }
            guard isActive() else { self.stop(); return }
            self.refresh(force: false, publish: publish)
        }
        timer = source
        source.resume()
    }
    private func observeRoots() {
        guard let queue = observationQueue else { return }
        observer?.cancel()
        let paths = roots.keys.map { root in
            FileManager.default.fileExists(atPath: root) ? root : (root as NSString).deletingLastPathComponent
        }
        observer = TurnRootObserver(paths: paths, queue: queue) { [weak self] in self?.needsScan = true }
        needsScan = true
    }

    func refresh(force: Bool = true, publish: @escaping @Sendable (LiveTurnDiff) -> Void) {
        guard timer != nil else { return }
        // Reconcile periodically even if the OS drops/coalesces an event.
        // If FSEvents cannot start, retain the bounded polling fallback.
        guard force || observer == nil || needsScan || Date().timeIntervalSince(lastScan) >= 5 else { return }
        needsScan = false
        lastScan = Date()
        let update = capture(status: "running")
        if update != previous { previous = update; publish(update) }
    }

    /// Call on the capture queue immediately before a shell runs. Commits a
    /// retention checkpoint for each surviving root; nested calls are counted
    /// and only the outermost boundary checkpoints.
    func beginTool() {
        toolDepth += 1
        if toolDepth == 1 { commitCheckpoints(afterTool: false) }
    }

    /// Call on the capture queue after the shell exits, fails or is cancelled.
    /// Roots removed/replaced during the tool keep their pre-tool checkpoint.
    func endTool(success: Bool = true) {
        guard toolDepth > 0 else { return }
        toolDepth -= 1
        if toolDepth == 0, success { commitCheckpoints(afterTool: true) }
    }

    private func commitCheckpoints(afterTool: Bool) {
        var remaining = limits.seconds
        let active = rootOrder.filter { roots[$0]?.manifest != nil }
        for (index, root) in active.enumerated() {
            guard let entry = roots[root], let identity = entry.identity else { continue }
            let started = Date()
            let deadline = started.addingTimeInterval(remaining / Double(active.count - index))
            // Never checkpoint a missing or replaced folder; keep the older one.
            guard (try? TurnFileReader(root: root))?.directoryIdentity == identity,
                  let scanned = scan(root, entry: entry, deadline: deadline, prioritizing: entry.manifest?.files.keys.sorted() ?? []),
                  (try? TurnFileReader(root: root))?.directoryIdentity == identity else { continue }
            checkpoints[root] = Checkpoint(manifest: scanned, afterTool: afterTool)
            remaining = max(0, remaining - Date().timeIntervalSince(started))
        }
        pruneStore()
    }

    private func pruneStore() {
        var keep = Set<String>()
        for checkpoint in checkpoints.values { for entry in checkpoint.manifest.files.values { keep.insert(entry.blob.digest) } }
        storage?.prune(keeping: keep)
    }

    func collect(_ request: GitDiffRequestPayload) -> GitDiffResponsePayload {
        guard !request.hasUnsupportedPhase, request.candidatePaths.count <= 8 else {
            return GitDiffResponsePayload(requestID: request.requestID, status: .unavailable, reason: "Invalid filesystem capture request.")
        }
        switch request.phase {
        case .baseline: return baseline(request)
        case .final:
            let expected = roots.values.map(\.baseline)
            guard let echoed = request.baselines, echoed.count <= expected.count,
                  echoed.allSatisfy({ other in expected.contains { baseline in
                      Self.comparable(baseline.root) == Self.comparable(other.root) && baseline.head == other.head &&
                      baseline.capturedAt == other.capturedAt && baseline.source == other.source
                  } }) else {
                return GitDiffResponsePayload(requestID: request.requestID, status: .unavailable, reason: "Starting filesystem snapshots do not match this run.")
            }
            return final(request)
        default: return GitDiffResponsePayload(requestID: request.requestID, status: .unavailable, reason: "Unsupported filesystem capture phase.")
        }
    }

    /// Stops live observation only. Stored bytes stay until the tracker is
    /// released, so a final capture after stop still renders.
    func stop() {
        timer?.cancel(); timer = nil
        observer?.cancel(); observer = nil
        observationQueue = nil
    }
    deinit { timer?.cancel(); storage?.removeAll() }

    func baseline(_ request: GitDiffRequestPayload) -> GitDiffResponsePayload {
        let deadline = Date().addingTimeInterval(max(limits.seconds, limits.baselineSeconds))
        let candidates = Array(request.candidatePaths.prefix(8))
        for (index, candidate) in candidates.enumerated() {
            guard candidate.hasPrefix("/"), candidate.utf8.count <= 1024,
                  !candidate.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  !candidate.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { continue }
            let canonical = GitSnapshotCollector.canonicalDirectory(candidate)
            // Respect the selected filesystem scope. Promoting a selected
            // subfolder to the Git top level defeats narrowing a large workspace.
            let root = TurnFileReader.physicalPath(canonical ?? candidate) ?? canonical ?? candidate
            guard root.hasPrefix("/"), root != "/", root != TurnFileReader.physicalPath(NSHomeDirectory()),
                  !root.contains("\0"), !root.split(separator: "/").contains("..") else { continue }
            let identity = (try? TurnFileReader(root: root))?.directoryIdentity
            // Only the same physical directory is an alias; a nested folder is
            // an independent root.
            if let existing = roots.first(where: { $0.key == root || (identity != nil && $0.value.identity == identity) }) {
                if candidate != existing.value.baseline.root, rootAliases.count < 64,
                   !rootAliases.contains(where: { $0.alias == candidate }) {
                    rootAliases.append(GitRootAlias(root: existing.value.baseline.root, alias: candidate))
                }
                continue
            }
            let reported = Self.reportedRoot(root, candidates: request.candidatePaths)
            if roots.count >= 8 {
                if omittedRoots.count < 32 { omittedRoots.insert(reported) }
                continue
            }
            let baseline = GitTurnBaseline(root: reported, head: nil, capturedAt: GitTurnBaseline.timestamp(), source: request.baselineSource ?? .turnStart)
            var entry = Root(baseline: baseline, manifest: nil, identity: identity)
            // Nested roots are independent. An enclosing root keeps the starting
            // bytes it already captured here (original timing, single owner);
            // this root captures everything the enclosing root omitted, with its
            // own honest later timing. Even a "complete" enclosing scan may have
            // skipped ignored/excluded subtrees, so it never implies coverage.
            var outerUpdates: [String] = []
            for outer in rootOrder where root.hasPrefix(outer + "/") {
                guard let enclosing = roots[outer] else { continue }
                // A deeper root the enclosing one already delegated owns this path.
                if enclosing.excludedSubroots.contains(where: { root == $0 || root.hasPrefix($0 + "/") }) { continue }
                let prefix = String(root.dropFirst(outer.count + 1)) + "/"
                for path in enclosing.manifest.map({ Array($0.files.keys) }) ?? [] where path.hasPrefix(prefix) {
                    entry.delegatedPaths.insert(String(path.dropFirst(prefix.count)))
                }
                outerUpdates.append(outer)
            }
            for outer in outerUpdates { roots[outer]?.excludedSubroots.insert(root) }
            // Roots already inside this one own their subtrees.
            for inner in rootOrder where inner.hasPrefix(root + "/") { entry.excludedSubroots.insert(inner) }
            let fairDeadline = Date().addingTimeInterval(max(0, deadline.timeIntervalSinceNow) / Double(candidates.count - index))
            let manifest = Self.sensitive(root) ? nil : scan(root, entry: entry, deadline: fairDeadline, baseline: true)
            entry = Root(baseline: baseline, manifest: manifest, identity: identity, excludedSubroots: entry.excludedSubroots,
                         delegatedPaths: entry.delegatedPaths)
            roots[root] = entry
            rootOrder.append(root)
        }
        observeRoots()
        return GitDiffResponsePayload(requestID: request.requestID, status: .ok,
                                      baselines: rootOrder.compactMap { roots[$0]?.baseline }, rootAliases: rootAliases)
    }

    /// Discovery omissions are diagnostics, not baselines. They must never
    /// consume a slot or be treated as an empty starting directory.
    func noteUncapturedRoots(_ paths: [String]) {
        for path in paths where omittedRoots.count < 32 {
            guard !roots.values.contains(where: { Self.comparable($0.baseline.root) == Self.comparable(path) }) else { continue }
            omittedRoots.insert(path)
        }
    }

    func final(_ request: GitDiffRequestPayload) -> GitDiffResponsePayload {
        let accepted = Set((request.baselines ?? []).map { Self.comparable($0.root) })
        let update = capture(status: "final", acceptedRoots: accepted)
        return GitDiffResponsePayload(requestID: request.requestID, status: .ok,
                                      repositories: update.repositories, coverage: update.coverage)
    }

    func capture(status: String, acceptedRoots: Set<String>? = nil) -> LiveTurnDiff {
        defer { pruneStore() }
        var repositories: [GitDiffRepositoryPatch] = []
        var coverage: [TurnRootCoverage] = []
        var budget = limits.patchBytes
        var scanSecondsRemaining = limits.seconds
        var patchSecondsRemaining = limits.patchSeconds
        // Starting folders are ordered first; every root then receives a fair
        // share of the remaining scan/patch budgets (unused shares carry over).
        let orderedRoots = (rootOrder.filter { roots[$0]?.baseline.source == .turnStart }
            + rootOrder.filter { roots[$0]?.baseline.source != .turnStart })
            .filter { acceptedRoots == nil || acceptedRoots!.contains(Self.comparable(roots[$0]!.baseline.root)) }
        for (index, root) in orderedRoots.enumerated() {
            let entry = roots[root]!
            let share = Double(orderedRoots.count - index)
            let displayRoot = entry.baseline.root
            let late = entry.baseline.source == .beforeTool
            // A missing or replaced folder is shown from its last tool-boundary
            // checkpoint, never from a live scan that may have run mid-cleanup,
            // and never against an imaginary empty directory or a replacement.
            let currentIdentity = (try? TurnFileReader(root: root))?.directoryIdentity
            let removed = entry.identity != nil && currentIdentity == nil && !fm.fileExists(atPath: root)
            let replaced = entry.identity != nil && currentIdentity != entry.identity && !removed
            let retained = removed || replaced ? checkpoints[root] : nil
            let scanStarted = Date()
            let current = removed || replaced ? retained?.manifest
                : scan(root, entry: entry, deadline: scanStarted.addingTimeInterval(scanSecondsRemaining / share),
                       prioritizing: entry.manifest?.files.keys.sorted() ?? [])
            scanSecondsRemaining = max(0, scanSecondsRemaining - Date().timeIntervalSince(scanStarted))
            guard let before = entry.manifest, let after = current else {
                let protected = Self.sensitive(root)
                let reason = protected ? "This root is excluded by the sensitive-path policy."
                    : removed ? "This folder was removed before a tool-boundary checkpoint. Changes seen only by live scans are not retained, because a scan may have run during cleanup."
                    : replaced ? "This folder was replaced before a tool-boundary checkpoint; the replacement is not compared with the original starting files."
                    : "Starting or current files could not be read safely."
                coverage.append(TurnRootCoverage(root: displayRoot, status: "unavailable", reason: reason,
                    suggestedFix: protected ? "Choose a non-sensitive project folder. Sensitive roots are never captured." : "Check access and select this folder before starting a new turn."))
                continue
            }
            var patch = ""
            var limitsReached = before.limitsReached.union(after.limitsReached)
            let rootBudget = budget / max(1, orderedRoots.count - index)
            var rootBudgetLeft = rootBudget
            // Scanning must never consume the time reserved for patch generation.
            let patchStarted = Date()
            let patchDeadline = patchStarted.addingTimeInterval(patchSecondsRemaining / share)
            var incomplete = !before.enumerated || !after.enumerated || !before.unknown.isEmpty || !after.unknown.isEmpty
            var unreadable = 0
            for path in Set(before.files.keys).union(after.files.keys).sorted() {
                guard !before.unknown.contains(path), !after.unknown.contains(path),
                      before.enumerated || before.files[path] != nil,
                      after.enumerated || after.files[path] != nil || after.absent.contains(path) else { incomplete = true; continue }
                let old = before.files[path], new = after.files[path]
                guard old != new else { continue }
                guard Date() < patchDeadline else { incomplete = true; limitsReached.insert("Patch generation time limit reached."); break }
                // Lazily load only changed files. A failed load is unknown,
                // never fabricated empty contents.
                let oldFile: File?, newFile: File?
                do {
                    oldFile = try old.map { File(bytes: try store.data($0.blob), mode: $0.mode) }
                    newFile = try new.map { File(bytes: try store.data($0.blob), mode: $0.mode) }
                } catch { incomplete = true; unreadable += 1; continue }
                do {
                    let section = try Self.patch(path: path, old: oldFile, new: newFile, budget: rootBudgetLeft, deadline: patchDeadline)
                    guard section.utf8.count <= rootBudgetLeft else { incomplete = true; limitsReached.insert("Patch size limit reached."); continue }
                    patch += section
                    rootBudgetLeft -= section.utf8.count
                } catch { incomplete = true; limitsReached.insert("A changed file exceeded the patch size/time limit or could not be rendered.") }
            }
            budget -= rootBudget - rootBudgetLeft
            patchSecondsRemaining = max(0, patchSecondsRemaining - Date().timeIntervalSince(patchStarted))
            if !patch.isEmpty { repositories.append(GitDiffRepositoryPatch(root: displayRoot, patch: patch, baseline: entry.baseline, head: nil)) }
            let excluded = before.excluded + after.excluded
            let state = incomplete ? "partial" : (late || removed || replaced) ? "late" : "complete"
            var notes: [String] = []
            if removed || replaced {
                notes.append("Snapshot retained from the last \(retained!.afterTool ? "after-tool" : "before-tool") checkpoint before this folder was \(removed ? "removed" : "replaced"); it is not the current filesystem state. Edits made by the same tool that \(removed ? "removed" : "replaced") it are not included. Background changes or cleanup may overlap a checkpoint; retained contents are not guaranteed to precede them.")
            }
            if late { notes.append("Baseline captured before a later tool, not at run start. Edits made before registration, including by a creating tool, are not included.") }
            if !entry.delegatedPaths.isEmpty { notes.append("\(entry.delegatedPaths.count) files are compared under an enclosing captured folder from its earlier start.") }
            if incomplete {
                notes.append("Captured \(before.files.count) starting files; compared \(Set(before.files.keys).intersection(after.files.keys).count) existing files.")
                notes += limitsReached.sorted()
                if !before.unknown.isEmpty || !after.unknown.isEmpty { notes.append("\(before.unknown.union(after.unknown).count) files exceeded the per-file/remaining byte or storage limit, changed during reading, or were unreadable.") }
                if unreadable > 0 { notes.append("\(unreadable) stored snapshots could not be read back.") }
                if patch.isEmpty { notes.append("No patch could be produced within this coverage; this does not establish that no files changed.") }
            }
            if excluded > 0 { notes.append("Sensitive paths, dependency/build directories and special files are excluded.") }
            if notes.isEmpty { notes.append("All eligible files in this root were compared with their starting contents.") }
            coverage.append(TurnRootCoverage(root: displayRoot, status: state, reason: notes.joined(separator: " "), suggestedFix: state == "complete" ? "" : "Select the folder before a new turn; narrow large workspaces or fix unreadable files. Excluded sensitive files are never captured."))
        }
        if acceptedRoots == nil {
            coverage += omittedRoots.sorted().map {
                TurnRootCoverage(root: $0, status: "unavailable", reason: "The eight-root capture limit was reached.", suggestedFix: "Start a separate turn with this folder selected to capture its starting contents.")
            }
        }
        // Revisions advance only for a changed view, so idle scans do not reload UI.
        if previous?.repositories != repositories || previous?.coverage != coverage || previous?.status != status { revision += 1 }
        return LiveTurnDiff(turnID: turnID, revision: revision, status: status, repositories: repositories, coverage: coverage)
    }

    private static func reportedRoot(_ root: String, candidates: [String]) -> String {
        for candidate in candidates {
            guard let directory = GitSnapshotCollector.canonicalDirectory(candidate),
                  let canonical = TurnFileReader.physicalPath(directory),
                  canonical == root || canonical.hasPrefix(root + "/") else { continue }
            var original = URL(fileURLWithPath: candidate).standardizedFileURL.path
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: original, isDirectory: &isDirectory), !isDirectory.boolValue {
                original = (original as NSString).deletingLastPathComponent
            }
            let levels = canonical.dropFirst(root.count).split(separator: "/").count
            for _ in 0..<levels { original = (original as NSString).deletingLastPathComponent }
            if original != "/", TurnFileReader.physicalPath(original) == root { return original }
        }
        for candidate in candidates where TurnFileReader.physicalPath(candidate) == root { return candidate }
        return root
    }

    static func comparable(_ path: String) -> String {
        for prefix in ["/private/var", "/private/tmp", "/private/etc"] {
            if path == prefix || path.hasPrefix(prefix + "/") { return String(path.dropFirst(8)) }
        }
        return path
    }

    static func sensitive(_ path: String) -> Bool {
        let parts = path.split(separator: "/").map(String.init)
        if GitSensitivePathPolicy.isSensitive(path) || parts.contains(where: { [".git", ".ssh", ".aws", ".gnupg", ".docker", ".kube"].contains($0.lowercased()) }) { return true }
        let offset: Int?
        if parts.first == "root" { offset = 1 }
        else if parts.first == "Users" || parts.first == "home" { offset = 2 }
        else { offset = nil }
        if let offset, parts.count > offset {
            return parts.dropFirst(offset).enumerated().contains { index, part in
                part.hasPrefix(".") && !(index == 0 && [".omniAgent", ".omnikey"].contains(part))
            }
        }
        return false
    }

    /// Baseline scans pin bytes in the store. Later scans reuse the starting
    /// blob for unchanged files and store only changed bytes (unpinned, pruned
    /// unless a checkpoint references them).
    private func scan(_ root: String, entry: Root, deadline: Date, prioritizing knownPaths: [String] = [], baseline: Bool = false) -> Manifest? {
        guard scanNow() < deadline else { return nil }
        let reader: TurnFileReader
        do { reader = try TurnFileReader(root: root) }
        catch TurnFileReader.Failure.absent { return Manifest() }
        catch { return nil }
        var result = Manifest(), total = 0, count = 0
        // Each file's bytes are released before the next read; without a pool,
        // autoreleased read buffers accumulate across a large scan.
        func read(_ relative: String) -> Bool { autoreleasepool { readOne(relative) } }
        func readOne(_ relative: String) -> Bool {
            // Parent-owned starting files beneath a removed registered child
            // retain their checkpoint rather than becoming cleanup deletions.
            let absolute = (root as NSString).appendingPathComponent(relative)
            if !baseline, entry.excludedSubroots.contains(where: { child in
                guard absolute.hasPrefix(child + "/"), let identity = roots[child]?.identity else { return false }
                return (try? TurnFileReader(root: child))?.directoryIdentity != identity
            }) {
                result.enumerated = false
                result.limitsReached.insert("Nested folder removed or replaced; owned files use the last tool checkpoint, not cleanup observations.")
                if let retained = checkpoints[root]?.manifest.files[relative] { result.files[relative] = retained }
                else { result.unknown.insert(relative) }
                return false
            }
            do {
                switch try reader.read(relative, limit: min(limits.fileBytes, max(0, limits.rootBytes - total))) {
                case .directory: return true
                case .excluded: result.excluded += 1
                case let .file(file):
                    guard scanNow() < deadline else {
                        result.unknown.insert(relative)
                        result.enumerated = false
                        return false
                    }
                    total += file.bytes.count
                    if !baseline, let start = entry.manifest?.files[relative], start.blob.size == file.bytes.count,
                       start.blob.digest == TurnSnapshotStore.digest(file.bytes) {
                        result.files[relative] = Entry(blob: start.blob, mode: file.mode)
                    } else {
                        do { result.files[relative] = Entry(blob: try store.put(file.bytes, pin: baseline), mode: file.mode) }
                        catch {
                            // Never record a path whose bytes could not be kept.
                            result.unknown.insert(relative)
                            result.limitsReached.insert("Snapshot storage limit reached or storage failed.")
                        }
                    }
                }
            } catch TurnFileReader.Failure.absent {
                result.absent.insert(relative)
            } catch TurnFileReader.Failure.tooLarge(let size) {
                result.unknown.insert(relative)
                result.limitsReached.insert(size > limits.fileBytes
                    ? "Per-file size limit reached (\(limits.fileBytes) bytes)."
                    : "Root content budget reached (\(limits.rootBytes) bytes).")
            } catch { result.unknown.insert(relative) }
            return false
        }
        // Revisit every captured baseline path first. A changed enumeration order,
        // added build output, or scan cutoff must not hide an already captured edit.
        for path in knownPaths {
            guard scanNow() < deadline else {
                result.enumerated = false
                result.limitsReached.insert("Filesystem scan time limit reached (\(limits.seconds) seconds).")
                break
            }
            if read(path) { result.unknown.insert(path) } // file became a directory
        }
        let known = Set(knownPaths)
        // Git supplies file eligibility only; starting/current bytes still come
        // from the pinned filesystem reader. Ignore rules keep generated builds,
        // caches and dependencies from consuming the source-content budget.
        if let git = GitCommandRunner(), scanNow() < deadline {
            do {
                let listing = try git.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
                    in: root, maxStdout: 16 * 1024 * 1024, deadline: deadline)
                if listing.status == 0 {
                    var paths = Set<String>()
                    for bytes in listing.stdout.split(separator: 0) {
                        guard scanNow() < deadline, paths.count < limits.files else {
                            result.enumerated = false
                            result.limitsReached.insert("Filesystem entry/time limit reached.")
                            break
                        }
                        guard let relative = String(bytes: bytes, encoding: .utf8) else {
                            result.enumerated = false; continue
                        }
                        paths.insert(relative)
                    }
                    // Keep root manifests ahead of deep trees within the budget.
                    for relative in paths.sorted(by: {
                        let left = $0.split(separator: "/").count, right = $1.split(separator: "/").count
                        return left == right ? $0 < $1 : left < right
                    }) where !known.contains(relative) {
                        guard scanNow() < deadline else { result.enumerated = false; break }
                        if entry.delegatedPaths.contains(relative) { continue }
                        if Self.sensitive(relative) || entry.excludedSubroots.contains(where: { (root as NSString).appendingPathComponent(relative).hasPrefix($0 + "/") }) {
                            result.excluded += 1; continue
                        }
                        if read(relative) { result.excluded += 1 } // submodule/directory, never follow it
                    }
                    guard reader.isStillAtRoot() else { return nil }
                    return result
                }
            } catch {
                // A failed bounded Git listing cannot establish completeness.
                result.enumerated = false
                result.limitsReached.insert("Git file enumeration exceeded its bounds or was unavailable.")
            }
        }
        // Breadth-first, lexical traversal captures root files before descending
        // into a large subtree. Foundation's depth-first order is unspecified.
        var directories = [URL(fileURLWithPath: root)], nextDirectory = 0
        traversal: while nextDirectory < directories.count {
            guard scanNow() < deadline else {
                result.enumerated = false
                result.limitsReached.insert("Filesystem scan time limit reached (\(limits.seconds) seconds).")
                break
            }
            let directory = directories[nextDirectory]
            nextDirectory += 1
            // Collect at most the remaining entry budget, checking time before
            // each lazy read. Never allocate/sort a whole wide directory.
            guard let entries = fm.enumerator(at: directory, includingPropertiesForKeys: nil,
                options: [.skipsSubdirectoryDescendants], errorHandler: { _, _ in
                    result.enumerated = false
                    result.limitsReached.insert("Some directories could not be enumerated.")
                    return false
                }) else {
                result.enumerated = false
                continue
            }
            var children: [URL] = []
            var reachedLimit = false
            while scanNow() < deadline {
                guard let url = entries.nextObject() as? URL else { break }
                guard count < limits.files else {
                    result.enumerated = false
                    result.limitsReached.insert("Filesystem entry limit reached (\(limits.files) entries).")
                    reachedLimit = true
                    break
                }
                count += 1
                children.append(url)
            }
            for url in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                if scanNow() >= deadline {
                    result.enumerated = false
                    result.limitsReached.insert("Filesystem scan time limit reached (\(limits.seconds) seconds).")
                    break traversal
                }
                let itemPath = Self.comparable(url.path), rootPath = Self.comparable(root)
                guard itemPath.hasPrefix(rootPath + "/") else { result.enumerated = false; continue }
                let relative = String(itemPath.dropFirst(rootPath.count + 1))
                if entry.excludedSubroots.contains(where: { Self.comparable($0) == itemPath }) || Self.sensitive(relative) || skippedDirectories.contains(url.lastPathComponent) {
                    result.excluded += 1; continue
                }
                if known.contains(relative) || entry.delegatedPaths.contains(relative) { continue }
                if read(relative) { directories.append(url) }
            }
            if reachedLimit { break }
        }
        if scanNow() >= deadline {
            result.enumerated = false
            result.limitsReached.insert("Filesystem scan time limit reached (\(limits.seconds) seconds).")
        }
        guard reader.isStillAtRoot() else { return nil }
        return result
    }

    static func quoted(_ path: String) -> String {
        if path.utf8.allSatisfy({ $0 > 32 && $0 < 127 && $0 != 34 && $0 != 92 }) { return path }
        return "\"" + path.utf8.map { byte in
            if byte == 34 { return "\\\"" }
            if byte == 92 { return "\\\\" }
            if byte >= 32 && byte < 127 { return String(UnicodeScalar(byte)) }
            return String(format: "\\%03o", byte)
        }.joined() + "\""
    }

    static func patch(path: String, old: File?, new: File?, budget: Int, deadline: Date? = nil) throws -> String {
        let a = quoted("a/" + path), b = quoted("b/" + path)
        var text = "diff --git \(a) \(b)\n"
        if old == nil { text += "new file mode \(new!.mode)\n" }
        else if new == nil { text += "deleted file mode \(old!.mode)\n" }
        else if old!.mode != new!.mode { text += "old mode \(old!.mode)\nnew mode \(new!.mode)\n" }
        let left = old?.bytes ?? Data(), right = new?.bytes ?? Data()
        guard left != right else { return text }
        if left.contains(0) || right.contains(0) || String(data: left, encoding: .utf8) == nil || String(data: right, encoding: .utf8) == nil {
            return text + "Binary files \(old == nil ? "/dev/null" : a) and \(new == nil ? "/dev/null" : b) differ\n"
        }
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("omnikey-turn-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: temp) }
        try left.write(to: temp.appendingPathComponent("before"))
        try right.write(to: temp.appendingPathComponent("after"))
        let runner = GitCommandRunner(gitPath: "/usr/bin/diff", prefixArguments: [])!
        let diff = try runner.run(["-u", "before", "after"], in: temp.path, maxStdout: max(1, budget), deadline: min(deadline ?? .distantFuture, Date().addingTimeInterval(2)))
        guard diff.status == 1 else { throw CocoaError(.fileReadUnknown) }
        let body = String(decoding: diff.stdout, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false).dropFirst(2).joined(separator: "\n")
        return text + "--- \(old == nil ? "/dev/null" : a)\n+++ \(new == nil ? "/dev/null" : b)\n" + body
    }
}
