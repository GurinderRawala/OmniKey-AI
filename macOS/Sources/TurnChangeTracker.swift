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
/// Contents are private in-memory snapshots, not Git commits/index entries.
final class TurnChangeTracker: @unchecked Sendable {
    struct Limits {
        var files = 10_000
        var fileBytes = 1_048_576
        var rootBytes = 32 * 1_048_576
        var patchBytes = 2 * 1_048_576
        var seconds: TimeInterval = 4
    }
    struct File: Equatable {
        let bytes: Data
        let mode: String
    }
    struct Manifest {
        var files: [String: File] = [:]
        var unknown: Set<String> = []
        var excluded = 0
        var enumerated = true
    }
    struct Root {
        let baseline: GitTurnBaseline
        let manifest: Manifest?
    }
    let turnID = UUID().uuidString
    var limits = Limits()
    private var roots: [String: Root] = [:]
    private var omittedRoots: Set<String> = []
    private var revision = 0
    private var previous: LiveTurnDiff?
    private var timer: DispatchSourceTimer?
    private var observer: TurnRootObserver?
    private var observationQueue: DispatchQueue?
    private var needsScan = true
    private var lastScan = Date.distantPast
    private let fm = FileManager.default
    private let skippedDirectories: Set<String> = [".git", "node_modules", ".build", "DerivedData", ".venv", "__pycache__"]

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

    func stop() {
        timer?.cancel(); timer = nil
        observer?.cancel(); observer = nil
        observationQueue = nil
    }
    deinit { timer?.cancel() }

    func baseline(_ request: GitDiffRequestPayload) -> GitDiffResponsePayload {
        let deadline = Date().addingTimeInterval(limits.seconds)
        for candidate in request.candidatePaths.prefix(8) {
            guard candidate.hasPrefix("/"), candidate.utf8.count <= 1024,
                  !candidate.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  !candidate.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { continue }
            let canonical = GitSnapshotCollector.canonicalDirectory(candidate)
            var root = canonical ?? candidate
            if Date() < deadline, let canonical, let runner = GitCommandRunner(),
               let gitRoot = try? GitSnapshotCollector.repositoryRoot(of: canonical, runner: runner, deadline: min(deadline, Date().addingTimeInterval(0.5))) {
                root = gitRoot
            }
            root = TurnFileReader.physicalPath(root) ?? root
            guard root.hasPrefix("/"), root != "/", root != TurnFileReader.physicalPath(NSHomeDirectory()),
                  !root.contains("\0"), !root.split(separator: "/").contains("..") else { continue }
            if roots[root] != nil || roots.keys.contains(where: { root.hasPrefix($0 + "/") }) { continue }
            let reported = Self.reportedRoot(root, candidates: request.candidatePaths)
            if roots.count >= 8 {
                if omittedRoots.count < 32 { omittedRoots.insert(reported) }
                continue
            }
            let baseline = GitTurnBaseline(root: reported, head: nil, capturedAt: GitTurnBaseline.timestamp(), source: request.baselineSource ?? .turnStart)
            let manifest = Self.sensitive(root) ? nil : scan(root, deadline: deadline)
            roots[root] = Root(baseline: baseline, manifest: manifest)
        }
        observeRoots()
        return GitDiffResponsePayload(requestID: request.requestID, status: .ok,
                                      baselines: roots.values.map(\.baseline).sorted { $0.root < $1.root })
    }

    func final(_ request: GitDiffRequestPayload) -> GitDiffResponsePayload {
        let accepted = Set((request.baselines ?? []).map { Self.comparable($0.root) })
        let update = capture(status: "final", acceptedRoots: accepted)
        return GitDiffResponsePayload(requestID: request.requestID, status: .ok,
                                      repositories: update.repositories, coverage: update.coverage)
    }

    func capture(status: String, acceptedRoots: Set<String>? = nil) -> LiveTurnDiff {
        var repositories: [GitDiffRepositoryPatch] = []
        var coverage: [TurnRootCoverage] = []
        var budget = limits.patchBytes
        let deadline = Date().addingTimeInterval(limits.seconds)
        for root in roots.keys.sorted() {
            let entry = roots[root]!
            let displayRoot = entry.baseline.root
            if let acceptedRoots, !acceptedRoots.contains(Self.comparable(displayRoot)) { continue }
            guard let before = entry.manifest, let after = scan(root, deadline: deadline) else {
                let protected = Self.sensitive(root)
                coverage.append(TurnRootCoverage(root: displayRoot, status: "unavailable",
                    reason: protected ? "This root is excluded by the sensitive-path policy." : "Starting or current files could not be read safely.",
                    suggestedFix: protected ? "Choose a non-sensitive project folder. Sensitive roots are never captured." : "Check access and select this folder before starting a new turn."))
                continue
            }
            var patch = ""
            var incomplete = !before.enumerated || !after.enumerated || !before.unknown.isEmpty || !after.unknown.isEmpty
            for path in Set(before.files.keys).union(after.files.keys).sorted() {
                guard !before.unknown.contains(path), !after.unknown.contains(path),
                      before.enumerated || before.files[path] != nil,
                      after.enumerated || after.files[path] != nil else { incomplete = true; continue }
                let old = before.files[path], new = after.files[path]
                guard old != new else { continue }
                guard Date() < deadline else { incomplete = true; break }
                do {
                    let section = try Self.patch(path: path, old: old, new: new, budget: budget)
                    guard section.utf8.count <= budget else { incomplete = true; continue }
                    patch += section
                    budget -= section.utf8.count
                } catch { incomplete = true }
            }
            if !patch.isEmpty { repositories.append(GitDiffRepositoryPatch(root: displayRoot, patch: patch, baseline: entry.baseline, head: nil)) }
            let excluded = before.excluded + after.excluded
            let late = entry.baseline.source == .beforeTool
            let state = incomplete ? "partial" : late ? "late" : "complete"
            var notes: [String] = []
            if late { notes.append("Baseline captured before the first tool in this folder, not at run start.") }
            if incomplete { notes.append("Some files exceeded capture limits, changed during reading, or were unreadable.") }
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

    private func scan(_ root: String, deadline: Date) -> Manifest? {
        guard Date() < deadline else { return nil }
        let reader: TurnFileReader
        do { reader = try TurnFileReader(root: root) }
        catch TurnFileReader.Failure.absent { return Manifest() }
        catch { return nil }
        var enumerationFailed = false
        var directory: ObjCBool = false
        guard fm.fileExists(atPath: root, isDirectory: &directory), directory.boolValue,
              let walker = fm.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil,
                                         errorHandler: { _, _ in enumerationFailed = true; return false }) else { return nil }
        var result = Manifest(), total = 0, count = 0
        while let url = walker.nextObject() as? URL {
            count += 1
            if count > limits.files || Date() > deadline { result.enumerated = false; break }
            // Foundation enumeration can return /private/var URLs for a /var
            // root (and vice versa). Never slice by an unchecked string length.
            let itemPath = Self.comparable(url.path), rootPath = Self.comparable(root)
            guard itemPath.hasPrefix(rootPath + "/") else { result.enumerated = false; continue }
            let relative = String(itemPath.dropFirst(rootPath.count + 1))
            if roots.keys.contains(where: { Self.comparable($0) == itemPath }) || Self.sensitive(relative) || skippedDirectories.contains(url.lastPathComponent) {
                walker.skipDescendants(); result.excluded += 1; continue
            }
            do {
                switch try reader.read(relative, limit: min(limits.fileBytes, max(0, limits.rootBytes - total))) {
                case .directory: continue
                case .excluded: result.excluded += 1
                case let .file(file):
                    guard Date() < deadline else {
                        result.unknown.insert(relative); result.enumerated = false
                        continue
                    }
                    total += file.bytes.count
                    result.files[relative] = file
                }
            } catch { result.unknown.insert(relative) }
        }
        if enumerationFailed { result.enumerated = false }
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

    static func patch(path: String, old: File?, new: File?, budget: Int) throws -> String {
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
        let diff = try runner.run(["-u", "before", "after"], in: temp.path, maxStdout: max(1, budget), deadline: Date().addingTimeInterval(2))
        guard diff.status == 1 else { throw CocoaError(.fileReadUnknown) }
        let body = String(decoding: diff.stdout, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false).dropFirst(2).joined(separator: "\n")
        return text + "--- \(old == nil ? "/dev/null" : a)\n+++ \(new == nil ? "/dev/null" : b)\n" + body
    }
}
