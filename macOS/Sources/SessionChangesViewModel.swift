import AppKit
import Foundation

/// Main-actor state for the Changes sheet. Every async load carries a
/// generation token; responses for an older generation (session switch,
/// newer selection, newer revision) are dropped.
@MainActor
final class SessionChangesViewModel: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    enum DiffState {
        case none
        case loading
        case loaded(SessionFileDiffContent)
        case failed(String)
    }

    @Published private(set) var sessionKey: String
    @Published private(set) var state: LoadState = .idle
    @Published private(set) var snapshot: SessionChangesSnapshot?
    @Published var selectedChangeID: String?
    @Published private(set) var diffState: DiffState = .none
    @Published var actionError: String?
    @Published private(set) var isBusy = false

    private let tracker: SessionChangeTracker
    private var loadGeneration = 0
    private var diffGeneration = 0
    private var diffTask: Task<Void, Never>?
    /// Bounded LRU of computed diffs keyed by change id + revision.
    private var diffCache: [String: SessionFileDiffContent] = [:]
    private var diffCacheOrder: [String] = []
    static let diffCacheLimit = 4

    init(sessionKey: String, tracker: SessionChangeTracker = .shared) {
        self.sessionKey = sessionKey
        self.tracker = tracker
    }

    var selectedChange: SessionFileChange? {
        snapshot?.changes.first { $0.id == selectedChangeID }
    }

    func switchSession(to key: String) {
        guard key != sessionKey else { return }
        sessionKey = key
        snapshot = nil
        selectedChangeID = nil
        diffTask?.cancel()
        diffGeneration += 1
        actionError = nil
        diffState = .none
        diffCache.removeAll()
        diffCacheOrder.removeAll()
        reload()
    }

    func reload() {
        loadGeneration += 1
        let generation = loadGeneration
        let key = sessionKey
        if snapshot == nil { state = .loading }
        Task { [tracker] in
            do {
                let result = try await tracker.snapshot(sessionID: key)
                guard generation == self.loadGeneration, key == self.sessionKey else { return }
                self.snapshot = result
                self.state = .loaded
                if let selected = self.selectedChangeID, !result.changes.contains(where: { $0.id == selected }) {
                    self.selectedChangeID = nil
                    self.diffState = .none
                } else if self.selectedChangeID != nil {
                    self.loadSelectedDiff()
                }
            } catch {
                guard generation == self.loadGeneration, key == self.sessionKey else { return }
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    func select(_ id: String?) {
        selectedChangeID = id
        loadSelectedDiff()
    }

    private func loadSelectedDiff() {
        diffTask?.cancel()
        diffGeneration += 1
        let generation = diffGeneration
        guard let change = selectedChange else {
            diffState = .none
            return
        }
        let cacheKey = "\(sessionKey)|\(change.id)|\(change.base?.fingerprint ?? "absent")|\(change.latest?.fingerprint ?? "absent")"
        if let cached = diffCache[cacheKey] {
            diffState = .loaded(cached)
            return
        }
        diffState = .loading
        diffTask = Task { [tracker] in
            do {
                let content = try await tracker.loadDiff(for: change)
                guard !Task.isCancelled, generation == self.diffGeneration else { return }
                self.remember(content, for: cacheKey)
                self.diffState = .loaded(content)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, generation == self.diffGeneration else { return }
                self.diffState = .failed(error.localizedDescription)
            }
        }
    }

    private func remember(_ content: SessionFileDiffContent, for key: String) {
        // Bound retained patch bytes, not just entry count.
        if case let .text(_, patch) = content, (patch?.utf8.count ?? 0) > 1_000_000 { return }
        diffCache[key] = content
        diffCacheOrder.removeAll { $0 == key }
        diffCacheOrder.append(key)
        while diffCacheOrder.count > Self.diffCacheLimit {
            diffCache.removeValue(forKey: diffCacheOrder.removeFirst())
        }
    }

    // MARK: Actions

    private func run(_ action: @escaping @Sendable () async throws -> Void) {
        isBusy = true
        actionError = nil
        Task {
            do {
                try await action()
            } catch {
                self.actionError = error.localizedDescription
            }
            self.isBusy = false
            self.reload()
        }
    }

    func chooseFolder(sessionHasTurns: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Track Folder"
        panel.message = "Choose a folder whose changes this chat should track. Only this folder is scanned."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let key = sessionKey
        let tracker = self.tracker
        run { try await tracker.addRoot(sessionID: key, path: url.path, sessionHasTurns: sessionHasTurns) }
    }

    func stopTracking(_ root: SessionRootInfo) {
        let key = sessionKey
        let tracker = self.tracker
        run { try await tracker.deactivateRoot(sessionID: key, rootID: root.id) }
    }

    func refreshCapture() {
        let key = sessionKey
        let tracker = self.tracker
        run { try await tracker.refreshNow(sessionID: key) }
    }

    func setPinned(_ pinned: Bool) {
        let key = sessionKey
        let tracker = self.tracker
        run { try await tracker.setPinned(sessionID: key, pinned: pinned) }
    }

    func deleteSnapshots() {
        let key = sessionKey
        let tracker = self.tracker
        selectedChangeID = nil
        diffState = .none
        run { try await tracker.deleteSnapshots(sessionID: key) }
    }

    func saveSettings(_ settings: SessionChangesSettings) {
        let tracker = self.tracker
        run { try await tracker.updateSettings(settings) }
    }

    func openOriginal(_ change: SessionFileChange) {
        let url = URL(fileURLWithPath: change.rootPath).appendingPathComponent(change.relPath)
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            actionError = "The file no longer exists on disk."
        }
    }

    func exportPatch(_ patch: String, suggestedName: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName + ".patch"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try Data(patch.utf8).write(to: url, options: .atomic)
        } catch {
            actionError = "Export failed: \(error.localizedDescription)"
        }
    }

    func copyPatch(_ patch: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(patch, forType: .string)
    }
}
