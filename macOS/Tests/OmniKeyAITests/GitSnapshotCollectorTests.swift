import XCTest
@testable import OmniKeyAI

/// Temporary repositories driven by the real `git` binary.
final class GitTestRepo {
    let root: String
    static let gitPath = GitCommandRunner.locateGit() ?? "/usr/bin/git"

    init(initialize: Bool = true) throws {
        let base = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).resolvingSymlinksInPath()
            .appendingPathComponent("git-snapshot-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        root = base.path
        if initialize { try git("init", "-q", "-b", "main") }
    }

    deinit { try? FileManager.default.removeItem(atPath: root) }

    @discardableResult
    func git(_ args: String..., in directory: String? = nil) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: Self.gitPath)
        process.arguments = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                             "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"] + args
        process.currentDirectoryURL = URL(fileURLWithPath: directory ?? root)
        var env = ProcessInfo.processInfo.environment
        for key in env.keys where key.hasPrefix("GIT_") { env.removeValue(forKey: key) }
        process.environment = env
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "GitTestRepo", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: args.joined(separator: " ")])
        }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func write(_ relative: String, _ contents: String) throws {
        try write(relative, Data(contents.utf8))
    }

    func write(_ relative: String, _ data: Data) throws {
        let url = URL(fileURLWithPath: root).appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    func commitAll(_ message: String = "commit") throws -> String {
        try git("add", "-A")
        try git("commit", "-q", "-m", message)
        return try git("rev-parse", "HEAD")
    }

    func indexFingerprint() throws -> Data? {
        FileManager.default.contents(atPath: root + "/.git/index")
    }
}

final class GitSnapshotCollectorTests: XCTestCase {
    private func collect(
        _ paths: [String], eligible: [GitEligibleCommit] = [],
        limits: GitSnapshotCollector.Limits = .init()
    ) -> GitDiffResponsePayload {
        GitSnapshotCollector(limits: limits).collect(
            GitDiffRequestPayload(requestID: "req-1", candidatePaths: paths, eligibleCommits: eligible)
        )
    }

    func testCapturesStagedUnstagedAndUntrackedWithoutTouchingIndex() throws {
        let repo = try GitTestRepo()
        try repo.write("tracked.txt", "one\n")
        try repo.write("staged.txt", "a\n")
        _ = try repo.commitAll()
        try repo.write("tracked.txt", "one\ntwo unstaged\n")
        try repo.write("staged.txt", "a\nb staged\n")
        try repo.git("add", "staged.txt")
        try repo.write("new file.txt", "brand new\n")
        try repo.write("ignored.log", "secret-ish\n")
        try repo.write(".gitignore", "*.log\n")
        let indexBefore = try repo.indexFingerprint()
        let statusBefore = try repo.git("status", "--porcelain=v1")

        let response = collect([repo.root + "/subdir/../"])
        XCTAssertEqual(response.status, .ok, response.reason ?? "")
        XCTAssertEqual(response.requestID, "req-1")
        XCTAssertEqual(response.repositories.count, 1)
        let patch = try XCTUnwrap(response.repositories.first)
        XCTAssertEqual(patch.root, repo.root)
        XCTAssertEqual(patch.scope, .workingTree)
        XCTAssertNil(patch.commit)
        XCTAssertTrue(patch.patch.contains("+two unstaged"))
        XCTAssertTrue(patch.patch.contains("+b staged"))
        XCTAssertTrue(patch.patch.contains("+brand new"))
        XCTAssertTrue(patch.patch.contains("new file.txt"))
        XCTAssertFalse(patch.patch.contains("secret-ish"), "ignored files are never captured")

        XCTAssertEqual(try repo.indexFingerprint(), indexBefore, "index bytes must be untouched")
        XCTAssertEqual(try repo.git("status", "--porcelain=v1"), statusBefore)
        XCTAssertEqual(try repo.git("diff", "--cached", "--name-only"), "staged.txt")
    }

    func testRenameAndBinaryAreSummarisedWithoutBinaryPayload() throws {
        let repo = try GitTestRepo()
        try repo.write("old-name.txt", String(repeating: "line\n", count: 20))
        try repo.write("image.bin", Data([0, 1, 2, 3, 0, 255]))
        _ = try repo.commitAll()
        try repo.git("mv", "old-name.txt", "new-name.txt")
        try repo.write("image.bin", Data([0, 9, 9, 9, 0, 254, 0]))
        try repo.write("fresh.bin", Data([0, 0, 0, 1]))

        let response = collect([repo.root])
        XCTAssertEqual(response.status, .ok, response.reason ?? "")
        let patch = try XCTUnwrap(response.repositories.first?.patch)
        XCTAssertTrue(patch.contains("rename from old-name.txt"))
        XCTAssertTrue(patch.contains("rename to new-name.txt"))
        XCTAssertTrue(patch.contains("Binary files"))
        XCTAssertFalse(patch.contains("GIT binary patch"))
    }

    func testNoRepositoryAndInvalidCandidates() throws {
        let plain = try GitTestRepo(initialize: false)
        XCTAssertEqual(collect([plain.root]).status, .notRepository)
        XCTAssertEqual(collect(["relative/path", "", "/does/not/exist-\(UUID().uuidString)"]).status, .notRepository)
        XCTAssertEqual(collect([]).status, .notRepository)
        let many = Array(repeating: plain.root, count: 9)
        XCTAssertEqual(collect(many).status, .unavailable)
    }

    func testCleanRepositoryWithoutEligibleCommitHasNoPatch() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        let response = collect([repo.root])
        XCTAssertEqual(response.status, .ok)
        XCTAssertTrue(response.repositories.isEmpty)
    }

    func testUnbornRepositoryCapturesStagedAndUntracked() throws {
        let repo = try GitTestRepo()
        try repo.write("staged.txt", "first\n")
        try repo.git("add", "staged.txt")
        try repo.write("loose.txt", "loose\n")
        let response = collect([repo.root])
        XCTAssertEqual(response.status, .ok, response.reason ?? "")
        let patch = try XCTUnwrap(response.repositories.first?.patch)
        XCTAssertTrue(patch.contains("+first"))
        XCTAssertTrue(patch.contains("+loose"))
    }

    func testAwkwardPathNamesAreHandledLiterally() throws {
        let repo = try GitTestRepo()
        try repo.write("base.txt", "x\n")
        _ = try repo.commitAll()
        try repo.write("-leading-hyphen.txt", "hyphen\n")
        try repo.write("with space/and\nnewline.txt", "newline\n")
        try repo.write("glob*[x].txt", "glob\n")
        let response = collect([repo.root])
        XCTAssertEqual(response.status, .ok, response.reason ?? "")
        let patch = try XCTUnwrap(response.repositories.first?.patch)
        XCTAssertTrue(patch.contains("+hyphen"))
        XCTAssertTrue(patch.contains("+newline"))
        XCTAssertTrue(patch.contains("+glob"))
    }

    func testSensitiveFilesAreExcludedBeforeContentAndDisclosed() throws {
        let repo = try GitTestRepo()
        try repo.write("app.txt", "app\n")
        try repo.write("config/id_rsa", "PRIVATE-TRACKED\n")
        _ = try repo.commitAll()
        try repo.write("config/id_rsa", "PRIVATE-TRACKED-CHANGED\n")
        try repo.write(".env", "TOKEN=UNTRACKED-SECRET\n")
        try repo.write(".env.local", "TOKEN=UNTRACKED-SECRET2\n")
        try repo.write("certs/server.pem", "PEM-SECRET\n")
        try repo.write("app.txt", "app changed\n")

        let response = collect([repo.root])
        XCTAssertEqual(response.status, .ok, response.reason ?? "")
        let patch = try XCTUnwrap(response.repositories.first?.patch)
        XCTAssertTrue(patch.contains("+app changed"))
        for secret in ["PRIVATE-TRACKED", "UNTRACKED-SECRET", "PEM-SECRET", "id_rsa", ".env"] {
            XCTAssertFalse(patch.contains(secret), secret)
        }
        XCTAssertEqual(response.reason, "Excluded 4 sensitive files from the snapshot.")
    }

    func testSensitivePolicy() {
        for path in [".env", "a/.env.production", "x/id_ed25519.pub", "k.pem", "home/.ssh/config", "credentials.json", "service-account-prod.json"] {
            XCTAssertTrue(GitSensitivePathPolicy.isSensitive(path), path)
        }
        for path in ["README.md", "src/environment.swift", "keys.swift", "docs/credentials.md"] {
            XCTAssertFalse(GitSensitivePathPolicy.isSensitive(path), path)
        }
    }

    func testLimitsReportUnavailableInsteadOfTruncating() throws {
        let repo = try GitTestRepo()
        try repo.write("base.txt", "x\n")
        _ = try repo.commitAll()
        for i in 0..<4 { try repo.write("u\(i).txt", "u\(i)\n") }

        var fewFiles = GitSnapshotCollector.Limits()
        fewFiles.maxUntrackedFiles = 3
        let tooMany = collect([repo.root], limits: fewFiles)
        XCTAssertEqual(tooMany.status, .unavailable)
        XCTAssertTrue(tooMany.repositories.isEmpty)

        var tinyPatch = GitSnapshotCollector.Limits()
        tinyPatch.maxPatchBytes = 64
        let tooLarge = collect([repo.root], limits: tinyPatch)
        XCTAssertEqual(tooLarge.status, .unavailable)
        XCTAssertTrue(tooLarge.repositories.isEmpty)

        var instant = GitSnapshotCollector.Limits()
        instant.timeout = 0
        XCTAssertEqual(collect([repo.root], limits: instant).status, .unavailable)
    }

    func testRunnerTimeoutKillsLongProcess() throws {
        let runner = try XCTUnwrap(GitCommandRunner(gitPath: "/bin/sleep", prefixArguments: []))
        let started = Date()
        XCTAssertThrowsError(try runner.run(["5"], in: "/", maxStdout: 10, deadline: Date().addingTimeInterval(0.3))) {
            XCTAssertEqual($0 as? GitCommandRunner.Failure, .timedOut)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    }

    func testMultipleCandidatesDeduplicateToCanonicalRoot() throws {
        let repo = try GitTestRepo()
        try repo.write("sub/dir/file.txt", "x\n")
        _ = try repo.commitAll()
        try repo.write("sub/dir/file.txt", "y\n")
        let link = repo.root + "-link"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: repo.root)
        defer { try? FileManager.default.removeItem(atPath: link) }
        let response = collect([repo.root, repo.root + "/sub/dir", link + "/sub", repo.root + "/sub/dir/file.txt"])
        XCTAssertEqual(response.status, .ok)
        XCTAssertEqual(response.repositories.map(\.root), [repo.root])
    }

    func testWorktreeIsItsOwnRoot() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        let worktree = repo.root + "-wt"
        try repo.git("worktree", "add", "-q", worktree, "-b", "side")
        defer { try? FileManager.default.removeItem(atPath: worktree) }
        try "changed\n".write(toFile: worktree + "/a.txt", atomically: true, encoding: .utf8)
        let response = collect([worktree])
        XCTAssertEqual(response.status, .ok)
        XCTAssertEqual(response.repositories.first?.root, worktree)
        XCTAssertTrue(response.repositories.first?.patch.contains("+changed") ?? false)
    }

    // MARK: Commit fallback (v2)

    func testCleanTreeFallsBackOnlyToEligibleCurrentHead() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        let first = try repo.commitAll("first")
        try repo.write("a.txt", "a\nagent line\n")
        let agentCommit = try repo.commitAll("agent")

        let ok = collect([repo.root], eligible: [GitEligibleCommit(root: repo.root, commit: agentCommit)])
        XCTAssertEqual(ok.status, .ok)
        let patch = try XCTUnwrap(ok.repositories.first)
        XCTAssertEqual(patch.scope, .commit)
        XCTAssertEqual(patch.commit, agentCommit)
        XCTAssertTrue(patch.patch.contains("+agent line"))

        // An older or unrelated eligible OID that is not HEAD shows nothing.
        let stale = collect([repo.root], eligible: [GitEligibleCommit(root: repo.root, commit: first)])
        XCTAssertTrue(stale.repositories.isEmpty)
        let bogus = collect([repo.root], eligible: [GitEligibleCommit(root: repo.root, commit: "not-an-oid")])
        XCTAssertTrue(bogus.repositories.isEmpty)
        let otherRoot = collect([repo.root], eligible: [GitEligibleCommit(root: "/tmp", commit: agentCommit)])
        XCTAssertTrue(otherRoot.repositories.isEmpty)
    }

    func testDirtyTreeTakesPrecedenceOverEligibleCommit() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        let head = try repo.commitAll()
        try repo.write("a.txt", "dirty\n")
        let response = collect([repo.root], eligible: [GitEligibleCommit(root: repo.root, commit: head)])
        XCTAssertEqual(response.repositories.first?.scope, .workingTree)
        XCTAssertNil(response.repositories.first?.commit)
    }

    func testStagedAndUnstagedCancellationDoesNotPretendTreeIsClean() throws {
        let repo = try GitTestRepo()
        try repo.write("file.txt", "base\n")
        let oid = try repo.commitAll()
        try repo.write("file.txt", "staged\n")
        try repo.git("add", "file.txt")
        try repo.write("file.txt", "base\n")
        let response = collect([repo.root], eligible: [GitEligibleCommit(root: repo.root, commit: oid)])
        XCTAssertEqual(response.status, .ok)
        XCTAssertTrue(response.repositories.isEmpty, "non-clean index must suppress commit fallback")
    }

    func testRootCommitFallback() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "root content\n")
        let root = try repo.commitAll("root")
        let response = collect([repo.root], eligible: [GitEligibleCommit(root: repo.root, commit: root)])
        XCTAssertEqual(response.repositories.first?.scope, .commit)
        XCTAssertTrue(response.repositories.first?.patch.contains("+root content") ?? false)
    }
}
