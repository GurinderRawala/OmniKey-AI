import Darwin
import XCTest
@testable import OmniKeyAI

/// An isolated, visible stand-in for the user's home directory, created in
/// the test process's temporary directory. Recovery stores under test are
/// given this home explicitly; the real home is never read or written.
final class FakeHome {
    struct Directory { let root: String }

    let root: String

    init() throws {
        let tmp = ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()
        guard let resolved = realpath(tmp, nil) else { throw CocoaError(.fileNoSuchFile) }
        defer { free(resolved) }
        root = (String(cString: resolved) as NSString).appendingPathComponent("omnikey-fake-home-\(UUID().uuidString)")
        precondition(root != NSHomeDirectory())
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    deinit {
        // Only ever the directory this instance created.
        if (root as NSString).lastPathComponent.hasPrefix("omnikey-fake-home-") {
            try? FileManager.default.removeItem(atPath: root)
        }
    }

    /// A fresh visible directory below the fake home, optionally `git init`ed.
    func directory(gitInit: Bool = false) throws -> Directory {
        let path = (root as NSString).appendingPathComponent("work-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        if gitInit {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: GitTestRepo.gitPath)
            process.arguments = ["init", "-q", "-b", "main"]
            process.currentDirectoryURL = URL(fileURLWithPath: path)
            process.standardOutput = Pipe()
            process.standardError = Pipe()
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw CocoaError(.fileWriteUnknown) }
        }
        return Directory(root: path)
    }

    /// Writes `contents` at `relative` below the fake home (parents created).
    @discardableResult
    func write(_ relative: String, _ contents: String) throws -> String {
        let path = (root as NSString).appendingPathComponent(relative)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try contents.write(toFile: path, atomically: true, encoding: .utf8)
        return path
    }
}

/// CodeRabbit native findings: hidden-home credential exposure (4555835469)
/// and per-shell full-capture cost (4555835460).
final class NativeReviewTests: XCTestCase {
    private var home: FakeHome!

    override func setUpWithError() throws { home = try FakeHome() }
    override func tearDown() { home = nil }

    private func q(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    private func makeStore(_ limits: DiffRecoveryStore.Limits = .init()) -> DiffRecoveryStore {
        DiffRecoveryStore(limits: limits, homeDirectory: home.root)
    }

    @discardableResult
    private func shell(
        _ store: DiffRecoveryStore, _ script: String, candidates: [String] = [], tool: String = "call-1",
        file: StaticString = #filePath, line: UInt = #line, _ action: () throws -> Void = {}
    ) -> DiffRecoveryEvidence? {
        let context = GitDiffContext(candidatePaths: candidates, turnID: "run-1", toolCallID: tool)
        let checkpoint = store.before(script: script, context: context, initialDirectory: nil)
        do { try action() } catch { XCTFail("simulated shell failed: \(error)", file: file, line: line) }
        return checkpoint.flatMap(store.after)
    }

    private func recover(_ store: DiffRecoveryStore, ids: [String]) -> GitDiffResponsePayload {
        store.recover(GitDiffRequestPayload(
            requestID: "r-\(UUID().uuidString)", candidatePaths: [], eligibleCommits: [],
            phase: .recover, recovery: GitDiffRecoveryRequest(turnID: "run-1", evidenceIDs: ids)
        ))
    }

    // MARK: 4555835469 — hidden home paths outside Git

    func testFixtureHomeIsIsolatedAndVisible() {
        XCTAssertNotEqual(home.root, NSHomeDirectory())
        XCTAssertFalse((home.root as NSString).lastPathComponent.hasPrefix("."))
        XCTAssertFalse(DiffRecoveryStore.isHiddenHomePath(home.root + "/work/a.txt", home: home.root))
    }

    func testHomeAndFileUsePhysicalPathsEvenThroughTmpAlias() throws {
        let alias = "/tmp/omnikey-home-alias-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: alias, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: alias) }
        let store = DiffRecoveryStore(homeDirectory: alias)
        XCTAssertTrue(store.homeDirectory.hasPrefix("/private/tmp/"))
        XCTAssertTrue(DiffRecoveryStore.isHiddenHomePath(store.homeDirectory + "/.config/gh/hosts.yml", home: store.homeDirectory))
    }

    func testHiddenHomePathPredicate() {
        let h = "/Users/u"
        XCTAssertTrue(DiffRecoveryStore.isHiddenHomePath("/Users/u/.config/gh/hosts.yml", home: h))
        XCTAssertTrue(DiffRecoveryStore.isHiddenHomePath("/Users/u/.terraform.d/credentials.tfrc.json", home: h))
        XCTAssertTrue(DiffRecoveryStore.isHiddenHomePath("/Users/u/work/.tool/config.json", home: h))
        XCTAssertTrue(DiffRecoveryStore.isHiddenHomePath("/Users/u/work/.toolrc", home: h))
        XCTAssertFalse(DiffRecoveryStore.isHiddenHomePath("/Users/u/work/notes.txt", home: h))
        XCTAssertFalse(DiffRecoveryStore.isHiddenHomePath("/Users/u/work/a.b/c.txt", home: h))
        XCTAssertFalse(DiffRecoveryStore.isHiddenHomePath("/Users/uu/.config/x", home: h), "a sibling is not home")
        XCTAssertFalse(DiffRecoveryStore.isHiddenHomePath("/private/tmp/x/notes.txt", home: h))
        XCTAssertFalse(DiffRecoveryStore.isHiddenHomePath("/x/.y", home: "/"), "a root home never matches")
    }

    func testHiddenHomeCredentialFilesOutsideGitAreNeverObserved() throws {
        let gh = try home.write(".config/gh/hosts.yml", "github.com:\n  oauth_token: gho_secret\n")
        let terraform = try home.write(".terraform.d/credentials.tfrc.json", "{\"token\":\"tf_secret\"}\n")
        let nested = try home.write("work/.tool/config.json", "{\"key\":\"nested_secret\"}\n")
        let dotfile = try home.write("work/.toolrc", "token=dot_secret\n")
        let visible = try home.write("work/notes.txt", "one\n")
        let store = makeStore()
        let script = [
            "sed -i '' 's/gho_secret/gho_new/' \(q(gh))",
            "echo x | tee \(q(terraform))",
            "echo y >> \(q(nested))",
            "printf 'z\\n' > \(q(dotfile))",
            "echo two >> \(q(visible))",
        ].joined(separator: "\n")
        let evidence = try XCTUnwrap(shell(store, script) {
            try "github.com:\n  oauth_token: gho_new\n".write(toFile: gh, atomically: true, encoding: .utf8)
            try "x\n".write(toFile: terraform, atomically: true, encoding: .utf8)
            try "{\"key\":\"nested_secret\"}\ny\n".write(toFile: nested, atomically: true, encoding: .utf8)
            try "z\n".write(toFile: dotfile, atomically: true, encoding: .utf8)
            try "one\ntwo\n".write(toFile: visible, atomically: true, encoding: .utf8)
        })
        XCTAssertEqual(evidence.records.map(\.paths), [["notes.txt"]], "only the visible control file")
        XCTAssertNil(evidence.omitted, "hidden paths are not observed at all, not omitted")
        let patch = recover(store, ids: evidence.records.map(\.id)).repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("+two"))
        for secret in ["gho_", "tf_secret", "nested_secret", "dot_secret", "oauth_token"] {
            XCTAssertFalse(patch.contains(secret), secret)
        }
    }

    func testHiddenComponentInsideKnownRepositoryStillUsesGitPolicy() throws {
        // Repository files are governed by Git evidence, not the home rule:
        // a dot directory inside a registered repository is still captured.
        let repo = try home.directory(gitInit: true)
        let store = makeStore()
        let evidence = try XCTUnwrap(shell(store, "cd \(q(repo.root)) && mkdir .github && touch .github/ci.yml",
                                           candidates: [repo.root]) {
            try FileManager.default.createDirectory(atPath: repo.root + "/.github", withIntermediateDirectories: true)
            try "on: push\n".write(toFile: repo.root + "/.github/ci.yml", atomically: true, encoding: .utf8)
        })
        XCTAssertEqual(evidence.records.first?.kind, .git)
        XCTAssertEqual(evidence.records.first?.paths, [".github/ci.yml"])
    }

}
