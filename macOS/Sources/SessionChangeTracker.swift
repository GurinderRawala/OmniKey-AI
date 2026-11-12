import Foundation

/// Net status of one file between a root's baseline and its latest capture.
enum SessionChangeStatus: String, Sendable {
    case added
    /// Not in the baseline, but the baseline scan was partial — the file may
    /// have existed already.
    case notInBaseline = "not_in_baseline"
    case deleted
    case modified
    case modeChanged = "mode_changed"
    case typeChanged = "type_changed"
}

struct SessionFileChange: Identifiable, Equatable, Sendable {
    var id: String { "\(rootID):\(relPath)" }
    let rootID: Int64
    let rootPath: String
    let relPath: String
    let status: SessionChangeStatus
    let base: SessionFileRecord?
    let latest: SessionFileRecord?

    var attribution: SessionChangeAttribution { latest?.attribution ?? .observed }

    /// Both sides' content is either captured or definitively absent.
    var contentAvailable: Bool {
        guard status != .notInBaseline else { return false }
        func ok(_ record: SessionFileRecord?) -> Bool {
            guard let record else { return true }
            return record.state == .present || record.state == .missing
        }
        return ok(base) && ok(latest)
    }
}

struct SessionChangesSnapshot: Sendable {
    var sessionID: String
    var info: SessionChangesSessionInfo?
    var roots: [SessionRootInfo]
    var changes: [SessionFileChange]
    var settings: SessionChangesSettings
    var storedBytes: Int64
    var revision: Int64
    var captureError: String? = nil

    var budgetExhausted: Bool { storedBytes >= settings.budgetBytes || roots.contains { $0.coverage.budgetSkipped > 0 } }
}

/// Lazily loaded content for one file change.
enum SessionFileDiffContent: Sendable {
    case text(preview: SessionFileDiff, fullPatch: String?)
    /// Binary/metadata/symlink/unavailable content: honest card only.
    case card(reason: String)
}

private final class SessionDiffCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.withLock { cancelled = true } }
    var isCancelled: Bool { lock.withLock { cancelled } }
}

/// Serial coordinator for capture and storage. All store access happens on
/// `queue`; the main thread never touches SQLite or the filesystem here.
final class SessionChangeTracker: @unchecked Sendable {
    /// The app-wide tracker. Disabled inside test processes so unit tests
    /// can never open or mutate the real user store; tests construct their
    /// own tracker over a temporary directory.
    static let shared = SessionChangeTracker(
        storeRoot: SessionChangesStore.defaultRootDirectory(),
        isEnabled: NSClassFromString("XCTestCase") == nil
    )

    /// Same key `ChatModel` uses for a not-yet-sent chat.
    static let pendingSessionKey = "__pending_new__-" + UUID().uuidString

    private let queue = DispatchQueue(label: "ai.omnikey.session-changes", qos: .userInitiated)
    private let diffQueue = DispatchQueue(label: "ai.omnikey.session-diff", qos: .utility)
    private let storeRoot: URL
    private var store: SessionChangesStore?
    /// Sessions with at least one active root (queue-confined cache).
    private var trackedSessions: [String: Bool] = [:]
    /// Sessions mid tool-run; protected from retention pruning.
    private var inFlight: [String: Int] = [:]
    private var activeTurns: [String: Set<UUID>] = [:]
    private var pendingDeletion: Set<String> = []
    private var captureErrors: [String: String] = [:]
    private let now: @Sendable () -> Date
    let isEnabled: Bool

    init(storeRoot: URL, isEnabled: Bool = true, now: @escaping @Sendable () -> Date = { Date() }) {
        self.storeRoot = storeRoot
        self.isEnabled = isEnabled
        self.now = now
    }

    // MARK: Store access

    /// Opens (creating if `create`) the store. Returns nil when the store
    /// does not exist and creation is not requested — untracked sessions
    /// therefore never create files on disk.
    private func openStore(create: Bool) throws -> SessionChangesStore? {
        if let store { return store }
        guard isEnabled else { throw SessionChangesStoreError.io("Change tracking is disabled in this process.") }
        let candidate = SessionChangesStore(rootDirectory: storeRoot)
        guard create || candidate.existsOnDisk else { return nil }
        try candidate.open()
        try candidate.sweepOrphanBlobs()
        let settings = try candidate.loadSettings()
        _ = try candidate.pruneExpired(retentionDays: settings.retentionDays,
                                      protected: Set(activeTurns.keys).union(inFlight.keys), now: now())
        store = candidate
        return candidate
    }

    private func perform<T: Sendable>(create: Bool = true, _ body: @escaping @Sendable (SessionChangesStore?) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let store = try self.openStore(create: create)
                    continuation.resume(returning: try body(store))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Synchronous variant for the tool hook (called off the main thread).
    private func performSync<T>(sessionID: String, _ body: (SessionChangesStore) throws -> T) -> T? {
        guard isEnabled else { return nil }
        // Tool hooks run on shell worker threads. Never trap in production;
        // a main-thread caller is a bug worth logging, not crashing for.
        if Thread.isMainThread {
            print("[SessionChanges] warning: synchronous capture requested on the main thread")
        }
        return queue.sync {
            do {
                guard let store = try openStore(create: false) else { return nil }
                return try body(store)
            } catch {
                captureErrors[sessionID] = error.localizedDescription
                try? store?.setCaptureError(sessionID, message: error.localizedDescription)
                notify(sessionID)
                return nil
            }
        }
    }

    private func isTrackedLocked(_ sessionID: String, store: SessionChangesStore) throws -> Bool {
        if let cached = trackedSessions[sessionID] { return cached }
        let tracked = try store.roots(for: sessionID).contains { $0.active }
        trackedSessions[sessionID] = tracked
        return tracked
    }

    // MARK: Tool lifecycle hooks (synchronous, off-main)

    /// Capture before a local shell tool runs. Changes found here happened
    /// between tool runs and are labelled `observed` (not agent-attributed).
    @discardableResult
    func beginTurn(sessionID: String) -> UUID {
        let token = UUID()
        queue.async { self.activeTurns[sessionID, default: []].insert(token) }
        return token
    }

    func beforeTool(sessionID: String) {
        _ = performSync(sessionID: sessionID) { store in
            // Count each paired boundary even when tracking is enabled while
            // a command is already executing; untracked hooks cannot decrement
            // another tool's protection.
            inFlight[sessionID, default: 0] += 1
            guard try isTrackedLocked(sessionID, store: store) else { return }
            try captureLocked(sessionID: sessionID, attribution: .observed, store: store)
        }
    }

    /// Capture after the tool returns — success, failure or cancellation.
    /// Changes are labelled `tool_window`: they happened while the tool ran
    /// and may include concurrent external writes.
    func afterTool(sessionID: String) {
        _ = performSync(sessionID: sessionID) { store in
            defer {
                inFlight[sessionID, default: 1] -= 1
                if inFlight[sessionID] == 0 { inFlight.removeValue(forKey: sessionID) }
                if pendingDeletion.contains(sessionID), inFlight[sessionID] == nil {
                    try? store.deleteSnapshots(sessionID: sessionID)
                    pendingDeletion.remove(sessionID)
                    trackedSessions.removeValue(forKey: sessionID)
                }
            }
            guard try isTrackedLocked(sessionID, store: store) else { return }
            try captureLocked(sessionID: sessionID, attribution: .toolWindow, store: store)
        }
    }

    /// End-of-turn reconcile (final answer, error, or cancel). Async.
    func reconcileEndOfTurn(sessionID: String, turnID: UUID? = nil) {
        queue.async {
            do {
                defer {
                    if let turnID {
                        self.activeTurns[sessionID]?.remove(turnID)
                        if self.activeTurns[sessionID]?.isEmpty == true {
                            self.activeTurns.removeValue(forKey: sessionID)
                        }
                    } else { self.activeTurns.removeValue(forKey: sessionID) }
                }
                guard let store = try self.openStore(create: false),
                      try self.isTrackedLocked(sessionID, store: store) else { return }
                try self.captureLocked(sessionID: sessionID, attribution: .observed, store: store)
            } catch {
                self.captureErrors[sessionID] = error.localizedDescription
                try? self.store?.setCaptureError(sessionID, message: error.localizedDescription)
                self.notify(sessionID)
            }
        }
    }

    /// Wait for queued work; tests use this to observe async reconciles.
    func drain() { queue.sync {} }

    // MARK: Capture

    private func captureLocked(sessionID: String, attribution: SessionChangeAttribution, store: SessionChangesStore) throws {
        let settings = try store.loadSettings()
        for root in try store.roots(for: sessionID) where root.active {
            let previous = try store.files(rootID: root.id, side: "latest")
            let scanner = SessionChangesScanner(limits: .init(settings: settings))
            var budgetSkipped = 0
            let result: SessionChangesScanner.Result
            do {
                result = try scanner.scan(root: URL(fileURLWithPath: root.path), consume: { entry in
                    try self.persist(entry, store: store, settings: settings, budgetSkipped: &budgetSkipped)
                })
            } catch {
                try? store.sweepOrphanBlobs()
                throw error
            }
            var coverage = result.coverage
            coverage.budgetSkipped += budgetSkipped
            var changed: [SessionFileRecord] = []
            for entry in result.entries.values {
                var record = entry.record
                if let old = previous[record.relPath], old.fingerprint == record.fingerprint {
                    if old.mtime != record.mtime {
                        var refreshed = old
                        refreshed.mtime = record.mtime
                        changed.append(refreshed)
                    }
                    continue
                }
                record.attribution = attribution
                changed.append(record)
            }
            // Deletions only from a complete scan; partial scans keep the
            // previous record untouched rather than inventing a deletion.
            if !coverage.isPartial {
                for (path, old) in previous where result.entries[path] == nil && old.state != .missing {
                    changed.append(SessionFileRecord(relPath: path, state: .missing, kind: old.kind, size: 0, mode: 0,
                                                     hash: nil, linkTarget: nil, attribution: attribution))
                }
            }
            do {
                try store.updateLatest(rootID: root.id, sessionID: sessionID, changed: changed,
                                       coverage: coverage, now: now())
            } catch {
                try? store.sweepOrphanBlobs()
                throw error
            }
        }
        try store.sweepOrphanBlobs()
        captureErrors.removeValue(forKey: sessionID)
        try store.setCaptureError(sessionID, message: nil)
        notify(sessionID)
    }

    private func persist(_ entry: SessionChangesScanner.Entry, store: SessionChangesStore,
                         settings: SessionChangesSettings, budgetSkipped: inout Int) throws -> SessionChangesScanner.Entry {
        var record = entry.record
        if let content = entry.content, let hash = record.hash {
            do { _ = try store.putBlob(hash: hash, content: content, budgetBytes: settings.budgetBytes) }
            catch is SessionChangesStore.BudgetExceeded {
                record.state = .budgetExceeded
                budgetSkipped += 1
            }
        }
        return .init(record: record, content: nil)
    }

    static let didChange = Notification.Name("SessionChangesDidChange")
    private func notify(_ sessionID: String) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.didChange, object: sessionID)
        }
    }

    // MARK: UI operations (async)

    func snapshot(sessionID: String) async throws -> SessionChangesSnapshot {
        let protectedIDs: Set<String> = [sessionID]
        let now = self.now()
        return try await perform(create: false) { store in
            guard let store else {
                return SessionChangesSnapshot(sessionID: sessionID, info: nil, roots: [], changes: [],
                                              settings: .default, storedBytes: 0, revision: 0)
            }
            let settings = try store.loadSettings()
            _ = try? store.pruneExpired(retentionDays: settings.retentionDays,
                                        protected: protectedIDs.union(self.inFlight.keys).union(self.activeTurns.keys), now: now)
            self.trackedSessions.removeAll()
            let roots = try store.roots(for: sessionID)
            var changes: [SessionFileChange] = []
            for root in roots {
                let base = try store.files(rootID: root.id, side: "base")
                let latest = try store.files(rootID: root.id, side: "latest")
                changes += Self.computeChanges(root: root, base: base, latest: latest)
            }
            return SessionChangesSnapshot(
                sessionID: sessionID, info: try store.sessionInfo(sessionID), roots: roots,
                changes: changes.sorted { ($0.rootPath, $0.relPath) < ($1.rootPath, $1.relPath) },
                settings: settings, storedBytes: try store.storedBytes(),
                revision: try store.sessionRevision(sessionID), captureError: try self.captureErrors[sessionID] ?? store.captureError(sessionID)
            )
        }
    }

    static func computeChanges(root: SessionRootInfo, base: [String: SessionFileRecord],
                               latest: [String: SessionFileRecord]) -> [SessionFileChange] {
        var result: [SessionFileChange] = []
        for path in Set(base.keys).union(latest.keys) {
            let b = base[path]
            let l = latest[path]
            let status: SessionChangeStatus
            let baseExists = b != nil && b?.state != .missing
            let latestExists = l != nil && l?.state != .missing
            switch (baseExists, latestExists) {
            case (false, false): continue
            case (false, true): status = (b == nil && root.baselinePartial) ? .notInBaseline : .added
            case (true, false):
                // No latest row means the file was never seen again only if
                // latest is partial; base rows always have a latest twin.
                guard l != nil else { continue }
                status = .deleted
            case (true, true):
                guard let b, let l, b.fingerprint != l.fingerprint else { continue }
                if b.kind != l.kind { status = .typeChanged }
                else if b.hash == l.hash, b.state == l.state, b.size == l.size, b.linkTarget == l.linkTarget, b.mode != l.mode {
                    status = .modeChanged
                } else { status = .modified }
            }
            result.append(SessionFileChange(rootID: root.id, rootPath: root.path, relPath: path, status: status,
                                            base: baseExists ? b : nil, latest: latestExists ? l : nil))
        }
        return result
    }

    /// Adds (or re-activates) a tracking root. A root already tracked for
    /// this session keeps its original baseline — it is never reset.
    func addRoot(sessionID: String, path: String, sessionHasTurns: Bool) async throws {
        let label: SessionBaselineLabel = sessionHasTurns ? .trackingStart : .sessionStart
        guard let resolved = realpath(path, nil) else {
            throw SessionChangesStoreError.io("The selected folder is not accessible.")
        }
        let standardized = String(cString: resolved)
        free(resolved)
        let now = self.now()
        try await perform { store in
            guard let store else { return }
            self.trackedSessions[sessionID] = nil
            if try store.reactivateRoot(sessionID: sessionID, path: standardized) != nil { return }
            let settings = try store.loadSettings()
            let scanner = SessionChangesScanner(limits: .init(settings: settings))
            var budgetSkipped = 0
            let result: SessionChangesScanner.Result
            do {
                result = try scanner.scan(root: URL(fileURLWithPath: standardized), consume: { entry in
                    try self.persist(entry, store: store, settings: settings, budgetSkipped: &budgetSkipped)
                })
            } catch {
                try? store.sweepOrphanBlobs()
                throw error
            }
            if result.coverage.rootMissing {
                throw SessionChangesStoreError.io("The folder is not accessible.")
            }
            var coverage = result.coverage
            coverage.budgetSkipped += budgetSkipped
            let records = result.entries.values.map { entry in
                var record = entry.record
                record.attribution = .baseline
                return record
            }
            do {
                _ = try store.insertRoot(sessionID: sessionID, path: standardized, label: label,
                                         records: records, coverage: coverage, now: now)
            } catch {
                try? store.sweepOrphanBlobs()
                throw error
            }
        }
    }

    /// Stops capturing a root. Its baseline and latest are kept.
    func deactivateRoot(sessionID: String, rootID: Int64) async throws {
        try await perform(create: false) { store in
            try store?.setRootActive(rootID, active: false)
            try store?.bumpRevision(sessionID)
            self.trackedSessions[sessionID] = nil
        }
    }

    func refreshNow(sessionID: String) async throws {
        try await perform(create: false) { store in
            guard let store, try self.isTrackedLocked(sessionID, store: store) else { return }
            try self.captureLocked(sessionID: sessionID, attribution: .observed, store: store)
        }
    }

    func setPinned(sessionID: String, pinned: Bool) async throws {
        try await perform(create: false) { store in try store?.setPinned(sessionID, pinned: pinned) }
    }

    func deleteSnapshots(sessionID: String) async throws {
        try await perform(create: false) { store in
            guard self.inFlight[sessionID] == nil, self.activeTurns[sessionID] == nil else {
                throw SessionChangesStoreError.io("Snapshots are protected while a turn is running.")
            }
            try store?.deleteSnapshots(sessionID: sessionID)
            self.trackedSessions[sessionID] = nil
        }
    }

    /// A confirmed chat deletion also removes retained local content. If a
    /// cancelled shell is still exiting, wait for its final capture first.
    func deleteAfterChatRemoval(sessionID: String) {
        queue.async {
            do {
                self.activeTurns.removeValue(forKey: sessionID)
                if self.inFlight[sessionID] != nil {
                    self.pendingDeletion.insert(sessionID)
                    return
                }
                try self.openStore(create: false)?.deleteSnapshots(sessionID: sessionID)
                self.trackedSessions.removeValue(forKey: sessionID)
            } catch {
                self.captureErrors[sessionID] = error.localizedDescription
                try? self.store?.setCaptureError(sessionID, message: error.localizedDescription)
                self.notify(sessionID)
            }
        }
    }

    func updateSettings(_ settings: SessionChangesSettings) async throws {
        try await perform { store in try store?.saveSettings(settings) }
    }

    /// Moves a pending chat's tracking to the real session ID.
    func migratePending(to sessionID: String) {
        queue.async {
            do {
                guard let store = try self.openStore(create: false) else { return }
                try store.migrateSession(from: Self.pendingSessionKey, to: sessionID)
                self.trackedSessions.removeAll()
            } catch {
                print("[SessionChanges] pending migration failed: \(error.localizedDescription)")
            }
        }
    }

    /// Discards a pending chat's tracking when it is replaced unsent.
    func discardPending() {
        queue.async {
            guard let store = try? self.openStore(create: false) else { return }
            try? store.deleteSnapshots(sessionID: Self.pendingSessionKey)
            self.trackedSessions[Self.pendingSessionKey] = nil
        }
    }

    // MARK: Diff loading

    /// Reads both blobs on the store queue, then diffs off-queue so captures
    /// are not blocked by large diffs.
    func loadDiff(for change: SessionFileChange) async throws -> SessionFileDiffContent {
        if !change.contentAvailable {
            return .card(reason: Self.unavailableReason(change))
        }
        if change.base?.kind == .symlink || change.latest?.kind == .symlink
            || change.base?.kind == .other || change.latest?.kind == .other {
            return .card(reason: "Symlinks and special files are compared by metadata only; links are never followed.")
        }
        let (oldData, newData) = try await perform(create: false) { store -> (Data?, Data?) in
            guard let store else { throw SessionChangesStoreError.io("Snapshot storage is unavailable.") }
            let old = try change.base?.hash.map { try store.readBlob($0) }
            let new = try change.latest?.hash.map { try store.readBlob($0) }
            return (old, new)
        }
        try Task.checkCancellation()
        let oldText = oldData.map(SessionTextDecoding.text(from:))
        let newText = newData.map(SessionTextDecoding.text(from:))
        if oldText == .some(nil) || newText == .some(nil) {
            return .card(reason: "Binary or non-UTF-8 content — no line diff is shown.")
        }
        let old = oldText ?? nil, new = newText ?? nil
        let lineLimit = 100_000
        if [old, new].compactMap({ $0 }).contains(where: { text in
            text.utf8.lazy.filter { $0 == 10 }.prefix(lineLimit + 1).count > lineLimit
        }) {
            return .card(reason: "Snapshot saved, but this file exceeds the 100,000-line text-diff safety limit. No lines are silently omitted.")
        }
        let cancellation = SessionDiffCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                diffQueue.async {
                    guard !cancellation.isCancelled else {
                        continuation.resume(throwing: CancellationError()); return
                    }
                    let full = SessionDiffEngine.diff(old: oldText ?? nil, new: newText ?? nil,
                                                      isCancelled: { cancellation.isCancelled })
                    guard !cancellation.isCancelled else {
                        continuation.resume(throwing: CancellationError()); return
                    }
                    let patch = SessionDiffEngine.unifiedPatch(path: change.relPath, diff: full,
                        oldExists: change.base != nil && change.base?.state != .missing,
                        newExists: change.latest != nil && change.latest?.state != .missing)
                    let safePath = !change.relPath.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
                    let exportable = !full.lines.isEmpty && safePath
                    continuation.resume(returning: .text(preview: SessionDiffEngine.preview(full), fullPatch: exportable ? patch : nil))
                }
            }
        } onCancel: { cancellation.cancel() }
    }

    static func unavailableReason(_ change: SessionFileChange) -> String {
        if change.status == .notInBaseline { return "The baseline scan was incomplete. Original contents are unknown; an exact diff is unavailable." }
        let states = [change.base?.state, change.latest?.state].compactMap { $0 }
        if states.contains(.budgetExceeded) { return "Content was not stored because the storage budget was exhausted." }
        if states.contains(.oversize) { return "Content exceeds the per-file capture limit; only size and mode were recorded." }
        if states.contains(.unreadable) { return "Content could not be read (permissions or the file changed during capture)." }
        return "Content is unavailable."
    }
}
