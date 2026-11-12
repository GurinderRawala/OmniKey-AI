import Foundation

// MARK: - Bounded, read-only git invocation

/// Runs `git` with an explicit argument array (never through a shell), a
/// fixed working directory, bounded stdout/stderr and a hard deadline.
/// Output overflow or deadline expiry terminates the process and reports a
/// failure — callers must never treat a partial result as complete.
struct GitCommandRunner: Sendable {
    struct Result: Sendable {
        let status: Int32
        let stdout: Data
        let stderr: Data
    }

    enum Failure: Error, Equatable {
        case gitUnavailable
        case launchFailed
        case timedOut
        case outputLimitExceeded
    }

    let gitPath: String
    /// Always the hardening flags in production; overridable only so tests
    /// can exercise the timeout path with a non-git executable.
    let prefixArguments: [String]

    init?(gitPath: String? = nil, prefixArguments: [String] = GitCommandRunner.hardeningArguments) {
        guard let path = gitPath ?? GitCommandRunner.locateGit() else { return nil }
        self.gitPath = path
        self.prefixArguments = prefixArguments
    }

    /// Never launches `/usr/bin/git` when no developer tools are installed:
    /// that shim would open the Command Line Tools installer dialog.
    static func locateGit(fileManager: FileManager = .default) -> String? {
        let direct = [
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/Library/Developer/CommandLineTools/usr/bin/git",
            "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
        ]
        if let path = direct.first(where: { fileManager.isExecutableFile(atPath: $0) }) { return path }
        return nil
    }

    /// Hardening applied to every invocation: no optional index writes, no
    /// fsmonitor hook execution, no pager, no prompts, no repo-config
    /// external diff/textconv programs.
    static let hardeningArguments = [
        "--no-pager",
        "--no-optional-locks",
        "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false",
        "-c", "color.ui=false",
        "-c", "core.quotePath=true",
    ]

    func run(
        _ arguments: [String],
        in directory: String,
        maxStdout: Int,
        maxStderr: Int = 16 * 1024,
        deadline: Date
    ) throws -> Result {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw Failure.timedOut }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: gitPath)
        process.arguments = prefixArguments + arguments
        process.currentDirectoryURL = URL(fileURLWithPath: directory, isDirectory: true)
        var environment = ProcessInfo.processInfo.environment
        for key in environment.keys where key.hasPrefix("GIT_") { environment.removeValue(forKey: key) }
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        environment["GIT_PAGER"] = "cat"
        environment["PAGER"] = "cat"
        environment["LC_ALL"] = "C"
        environment["GIT_CONFIG_NOSYSTEM"] = "1"
        process.environment = environment
        process.standardInput = FileHandle.nullDevice

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        let out = BoundedBuffer(limit: maxStdout)
        let err = BoundedBuffer(limit: maxStderr)
        let finished = DispatchSemaphore(value: 0)
        let drained = DispatchGroup()

        func drain(_ handle: FileHandle, into buffer: BoundedBuffer) {
            drained.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                defer { drained.leave() }
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    if !buffer.append(chunk) {
                        // Overflow: stop the producer; keep draining so it can exit.
                        if process.isRunning { process.terminate() }
                    }
                }
            }
        }

        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            throw Failure.launchFailed
        }
        drain(outPipe.fileHandleForReading, into: out)
        drain(errPipe.fileHandleForReading, into: err)

        if finished.wait(timeout: .now() + remaining) == .timedOut {
            process.terminate()
            if finished.wait(timeout: .now() + 1) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                _ = finished.wait(timeout: .now() + 1)
            }
            _ = drained.wait(timeout: .now() + 1)
            throw Failure.timedOut
        }
        _ = drained.wait(timeout: .now() + max(0.5, deadline.timeIntervalSinceNow))
        if out.overflowed { throw Failure.outputLimitExceeded }
        guard drained.wait(timeout: .now()) == .success else { throw Failure.timedOut }
        return Result(status: process.terminationStatus, stdout: out.data, stderr: err.data)
    }
}

private final class BoundedBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()
    private var didOverflow = false
    let limit: Int

    init(limit: Int) { self.limit = max(0, limit) }

    /// Returns false once the limit is exceeded; excess bytes are discarded.
    func append(_ chunk: Data) -> Bool {
        lock.withLock {
            guard !didOverflow else { return false }
            if storage.count + chunk.count > limit {
                didOverflow = true
                return false
            }
            storage.append(chunk)
            return true
        }
    }

    var data: Data { lock.withLock { storage } }
    var overflowed: Bool { lock.withLock { didOverflow } }
}

// MARK: - Sensitive path policy

enum GitSensitivePathPolicy {
    private static let deniedDirectoryComponents: Set<String> = [".ssh", ".gnupg", ".aws", ".docker", ".kube"]
    private static let deniedNames: Set<String> = [
        "credentials", "credentials.json", "credentials.yml", "credentials.yaml",
        ".netrc", "_netrc", ".npmrc", ".pypirc", ".htpasswd", ".git-credentials",
        "secrets.json", "secrets.yml", "secrets.yaml", "service-account.json",
        "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts", "authorized_keys",
    ]
    private static let deniedExtensions: Set<String> = [
        "pem", "key", "p12", "pfx", "keystore", "jks", "p8", "ppk", "asc", "gpg", "kdbx",
    ]

    /// `path` is repository-relative, `/`-separated.
    static func isSensitive(_ path: String) -> Bool {
        let components = path.split(separator: "/", omittingEmptySubsequences: true).map { String($0).lowercased() }
        guard let name = components.last else { return false }
        if components.dropLast().contains(where: deniedDirectoryComponents.contains) { return true }
        if name == ".env" || name.hasPrefix(".env.") || name.hasSuffix(".env") { return true }
        if deniedNames.contains(name) { return true }
        if name.hasPrefix("id_rsa") || name.hasPrefix("id_dsa") || name.hasPrefix("id_ecdsa") || name.hasPrefix("id_ed25519") {
            return true
        }
        if name.hasPrefix("service-account") && name.hasSuffix(".json") { return true }
        if let dot = name.lastIndex(of: "."), deniedExtensions.contains(String(name[name.index(after: dot)...])) {
            return true
        }
        return false
    }
}

// MARK: - Snapshot collector

/// Collects an immutable, read-only Git snapshot for the repositories behind
/// a server-chosen set of candidate paths on *this* machine. The working
/// tree (tracked staged + unstaged vs HEAD, plus eligible untracked files)
/// always wins; only a clean tree whose HEAD equals a server-issued eligible
/// agent commit falls back to that commit's patch. Nothing is ever written
/// to the repository, its index or its config.
struct GitSnapshotCollector: Sendable {
    struct Limits: Sendable {
        var maxCandidates = 8
        var maxRepositories = 8
        var maxPatchBytes = 2 * 1024 * 1024
        var maxUntrackedFiles = 200
        var maxTrackedFiles = 2_000
        var maxUntrackedFileBytes = 1 * 1024 * 1024
        var timeout: TimeInterval = 10
    }

    let runner: GitCommandRunner?
    var limits = Limits()
    var homeDirectory: String = NSHomeDirectory()

    init(runner: GitCommandRunner? = GitCommandRunner(), limits: Limits = Limits()) {
        self.runner = runner
        self.limits = limits
    }

    enum CollectionError: Error {
        case unavailable(String)
    }

    private struct RepositoryCapture {
        let root: String
        let patch: String
        let scope: GitSnapshotScope
        let commit: String?
        let excludedCount: Int
    }

    func collect(_ request: GitDiffRequestPayload) -> GitDiffResponsePayload {
        let requestID = request.requestID
        guard let runner else {
            return GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: "Git is not installed.")
        }
        guard request.candidatePaths.count <= limits.maxCandidates else {
            return GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: "Too many candidate paths.")
        }
        let deadline = Date().addingTimeInterval(limits.timeout)

        do {
            let roots = try resolveRoots(request.candidatePaths, runner: runner, deadline: deadline)
            guard !roots.isEmpty else {
                return GitDiffResponsePayload(requestID: requestID, status: .notRepository)
            }
            guard roots.count <= limits.maxRepositories else {
                return GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: "Too many repositories.")
            }
            let eligible = Self.eligibleMap(request.eligibleCommits ?? [])
            var budget = limits.maxPatchBytes
            var captures: [RepositoryCapture] = []
            for root in roots {
                let capture = try captureRepository(
                    root: root, eligibleCommits: eligible[root] ?? [], runner: runner,
                    budget: &budget, deadline: deadline
                )
                captures.append(capture)
            }
            let excluded = captures.reduce(0) { $0 + $1.excludedCount }
            let repositories = captures.filter { !$0.patch.isEmpty }.map {
                GitDiffRepositoryPatch(root: $0.root, patch: $0.patch, scope: $0.scope, commit: $0.commit)
            }
            let reason = excluded > 0
                ? "Excluded \(excluded) sensitive \(excluded == 1 ? "file" : "files") from the snapshot."
                : nil
            return GitDiffResponsePayload(requestID: requestID, status: .ok, repositories: repositories, reason: reason)
        } catch let CollectionError.unavailable(reason) {
            return GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: reason)
        } catch GitCommandRunner.Failure.timedOut {
            return GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: "Git snapshot timed out.")
        } catch GitCommandRunner.Failure.outputLimitExceeded {
            return GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: "Changes exceed the snapshot size limit.")
        } catch {
            return GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: "Git snapshot failed.")
        }
    }

    // MARK: Roots

    static func eligibleMap(_ commits: [GitEligibleCommit]) -> [String: Set<String>] {
        var map: [String: Set<String>] = [:]
        for item in commits.prefix(16) where GitOID.isValid(item.commit) {
            guard let canonical = canonicalDirectory(item.root) else { continue }
            map[canonical, default: []].insert(item.commit)
        }
        return map
    }

    /// Absolute, existing, symlink-resolved directory (a file maps to its
    /// parent). Relative or malformed input is rejected, never resolved
    /// against this process's cwd.
    static func canonicalDirectory(_ raw: String) -> String? {
        guard raw.hasPrefix("/"), !raw.contains("\0"), raw.utf8.count <= 4096 else { return nil }
        let resolved = URL(fileURLWithPath: raw).standardizedFileURL.resolvingSymlinksInPath().path
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: resolved, isDirectory: &isDirectory) else { return nil }
        if isDirectory.boolValue { return resolved }
        return (resolved as NSString).deletingLastPathComponent
    }

    func resolveRoots(_ candidates: [String], runner: GitCommandRunner, deadline: Date) throws -> [String] {
        var seen = Set<String>()
        var roots: [String] = []
        for candidate in candidates {
            guard let directory = Self.canonicalDirectory(candidate) else { continue }
            guard let root = try Self.repositoryRoot(of: directory, runner: runner, deadline: deadline) else { continue }
            // Never snapshot a whole home directory or filesystem root.
            let home = URL(fileURLWithPath: homeDirectory).resolvingSymlinksInPath().path
            guard root != "/", root != home else { continue }
            if seen.insert(root).inserted { roots.append(root) }
        }
        return roots
    }

    static func repositoryRoot(of directory: String, runner: GitCommandRunner, deadline: Date) throws -> String? {
        let result = try runner.run(["rev-parse", "--show-toplevel"], in: directory, maxStdout: 8192, deadline: deadline)
        guard result.status == 0,
              let text = String(data: result.stdout, encoding: .utf8)?
                .trimmingCharacters(in: .newlines),
              text.hasPrefix("/")
        else { return nil }
        return URL(fileURLWithPath: text).resolvingSymlinksInPath().path
    }

    /// Current HEAD object name, or nil for an unborn branch.
    static func headOID(root: String, runner: GitCommandRunner, deadline: Date) throws -> String? {
        let result = try runner.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], in: root, maxStdout: 256, deadline: deadline)
        guard result.status == 0,
              let oid = String(data: result.stdout, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              GitOID.isValid(oid)
        else { return nil }
        return oid
    }

    // MARK: Capture

    private func captureRepository(
        root: String,
        eligibleCommits: Set<String>,
        runner: GitCommandRunner,
        budget: inout Int,
        deadline: Date
    ) throws -> RepositoryCapture {
        let head = try Self.headOID(root: root, runner: runner, deadline: deadline)
        let base: String
        if let head {
            base = head
        } else {
            base = try emptyTree(root: root, runner: runner, deadline: deadline)
        }

        // Tracked: index + working tree vs HEAD (or the empty tree if unborn).
        let changed = try changedPaths(
            ["diff", base, "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv"],
            root: root, runner: runner, deadline: deadline
        )
        guard changed.allowed.count + changed.excluded <= limits.maxTrackedFiles else {
            throw CollectionError.unavailable("Too many changed files.")
        }

        let untracked = try untrackedFiles(root: root, runner: runner, deadline: deadline)
        // HEAD->worktree can be empty while staged and unstaged edits cancel
        // each other. Such a repository is not clean and must not fall back
        // to an older commit snapshot.
        let status = try runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                                    in: root, maxStdout: 4 * 1024 * 1024, deadline: deadline)
        guard status.status == 0 else { throw CollectionError.unavailable("Could not verify repository status.") }
        let isDirty = !status.stdout.isEmpty || !changed.allowed.isEmpty || changed.excluded > 0 || !untracked.isEmpty
        var excluded = changed.excluded

        if isDirty {
            var patch = ""
            if !changed.allowed.isEmpty {
                patch += try diffText(
                    ["--literal-pathspecs", "diff", base, "-M", "--no-ext-diff", "--no-textconv", "--no-color",
                     "--submodule=short", "--"] + changed.allowed,
                    root: root, runner: runner, budget: &budget, deadline: deadline,
                    acceptedStatuses: [0]
                )
            }
            let eligibleUntracked = untracked.filter { !GitSensitivePathPolicy.isSensitive($0) }
            excluded += untracked.count - eligibleUntracked.count
            for path in eligibleUntracked {
                patch += try untrackedPatch(path, root: root, runner: runner, budget: &budget, deadline: deadline)
            }
            return RepositoryCapture(root: root, patch: patch, scope: .workingTree, commit: nil, excludedCount: excluded)
        }

        // Clean tree: only the exact server-eligible, still-current agent commit.
        guard let head, eligibleCommits.contains(head) else {
            return RepositoryCapture(root: root, patch: "", scope: .workingTree, commit: nil, excludedCount: 0)
        }
        let committed = try changedPaths(
            ["show", "--format=", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", head],
            root: root, runner: runner, deadline: deadline
        )
        guard committed.allowed.count + committed.excluded <= limits.maxTrackedFiles else {
            throw CollectionError.unavailable("Too many changed files.")
        }
        var patch = ""
        if !committed.allowed.isEmpty {
            patch = try diffText(
                ["--literal-pathspecs", "show", "--format=", "-M", "--no-ext-diff", "--no-textconv", "--no-color",
                 "--submodule=short", head, "--"] + committed.allowed,
                root: root, runner: runner, budget: &budget, deadline: deadline, acceptedStatuses: [0]
            )
        }
        return RepositoryCapture(root: root, patch: patch, scope: .commit, commit: head, excludedCount: committed.excluded)
    }

    private func emptyTree(root: String, runner: GitCommandRunner, deadline: Date) throws -> String {
        // Hashes (without writing) the empty tree in this repo's object format.
        let result = try runner.run(["hash-object", "-t", "tree", "--stdin"], in: root, maxStdout: 256, deadline: deadline)
        guard result.status == 0,
              let oid = String(data: result.stdout, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              GitOID.isValid(oid)
        else { throw CollectionError.unavailable("Could not read the repository.") }
        return oid
    }

    /// Parses `--name-status -z` output. A rename/copy with any sensitive
    /// side excludes both sides.
    private func changedPaths(
        _ arguments: [String], root: String, runner: GitCommandRunner, deadline: Date
    ) throws -> (allowed: [String], excluded: Int) {
        let result = try runner.run(arguments, in: root, maxStdout: 4 * 1024 * 1024, deadline: deadline)
        guard result.status == 0 else { throw CollectionError.unavailable("Could not list changes.") }
        let fields = result.stdout.split(separator: 0, omittingEmptySubsequences: false).map {
            String(decoding: $0, as: UTF8.self)
        }
        var allowed: [String] = []
        var excluded = 0
        var index = 0
        while index < fields.count {
            let status = fields[index]
            index += 1
            guard let code = status.first else { continue }
            let pathCount = (code == "R" || code == "C") ? 2 : 1
            guard index + pathCount <= fields.count else { break }
            let paths = Array(fields[index ..< index + pathCount])
            index += pathCount
            if paths.contains(where: GitSensitivePathPolicy.isSensitive) {
                excluded += 1
            } else {
                allowed.append(contentsOf: paths)
            }
        }
        return (allowed, excluded)
    }

    private func untrackedFiles(root: String, runner: GitCommandRunner, deadline: Date) throws -> [String] {
        let result = try runner.run(
            ["ls-files", "--others", "--exclude-standard", "-z"],
            in: root, maxStdout: 1024 * 1024, deadline: deadline
        )
        guard result.status == 0 else { throw CollectionError.unavailable("Could not list untracked files.") }
        // Nested repositories are reported as `dir/` and never descended into.
        let files = result.stdout.split(separator: 0)
            .map { String(decoding: $0, as: UTF8.self) }
            .filter { !$0.hasSuffix("/") }
        guard files.count <= limits.maxUntrackedFiles else {
            throw CollectionError.unavailable("Too many untracked files.")
        }
        return files
    }

    private func untrackedPatch(
        _ path: String, root: String, runner: GitCommandRunner, budget: inout Int, deadline: Date
    ) throws -> String {
        let absolute = (root as NSString).appendingPathComponent(path)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: absolute) else {
            throw CollectionError.unavailable("An untracked file changed or became unreadable during capture.")
        }
        let type = attributes[.type] as? FileAttributeType
        // Regular files and symlinks only (a symlink diff shows its target
        // string, never the pointee's contents). Sockets/FIFOs are skipped.
        guard type == .typeRegular || type == .typeSymbolicLink else {
            throw CollectionError.unavailable("An untracked special file cannot be represented safely.")
        }
        if type == .typeRegular, let size = attributes[.size] as? Int, size > limits.maxUntrackedFileBytes {
            throw CollectionError.unavailable("An untracked file exceeds the snapshot size limit.")
        }
        // `--no-index` exits 1 when files differ; that is the success case.
        return try diffText(
            ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", path],
            root: root, runner: runner, budget: &budget, deadline: deadline, acceptedStatuses: [0, 1]
        )
    }

    private func diffText(
        _ arguments: [String],
        root: String,
        runner: GitCommandRunner,
        budget: inout Int,
        deadline: Date,
        acceptedStatuses: Set<Int32>
    ) throws -> String {
        guard budget > 0 else { throw GitCommandRunner.Failure.outputLimitExceeded }
        let result = try runner.run(arguments, in: root, maxStdout: budget, deadline: deadline)
        guard acceptedStatuses.contains(result.status) else {
            throw CollectionError.unavailable("Git could not produce the diff.")
        }
        // Lossy decoding keeps non-UTF-8 text readable; size is accounted in
        // re-encoded UTF-8 bytes, which is what the server limit measures.
        let text = String(decoding: result.stdout, as: UTF8.self)
        let bytes = text.utf8.count
        guard bytes <= budget else { throw GitCommandRunner.Failure.outputLimitExceeded }
        budget -= bytes
        return text
    }
}
