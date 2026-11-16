import XCTest
@testable import OmniKeyAI

final class TurnWorktreeDiscoveryTests: XCTestCase {
    func testInventoryRegistersLinkedWorktreeWithoutParsingVariableScript() throws {
        let repo = try GitTestRepo()
        try repo.write("file", "before\n")
        _ = try repo.commitAll()
        let parent = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent("discovery-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let worker = parent.appendingPathComponent("worker with spaces")
        try repo.git("worktree", "add", "--detach", worker.path)
        defer { _ = try? repo.git("worktree", "remove", "--force", worker.path) }
        XCTAssertEqual(TurnWorktreeDiscovery.discover([repo.root], deadline: Date().addingTimeInterval(3)), [], "Unselected sibling worktrees are not authorized")
        let tracker = TurnChangeTracker()
        let request = GitDiffRequestPayload(requestID: "start", candidatePaths: [repo.root, parent.path], phase: .baseline,
            baselineSource: .turnStart, filesystem: true, discoverWorktrees: true)
        let response = TurnWorktreeDiscovery.collect(request, tracker: tracker)
        XCTAssertEqual(response.baselines?.count, 3)
        XCTAssertEqual(response.discoveredWorktrees, [GitDiscoveredWorktree(root: TurnFileReader.physicalPath(worker.path)!, repository: repo.root)])
        try Data("edited without literal cd\n".utf8).write(to: worker.appendingPathComponent("file"))
        let final = tracker.collect(GitDiffRequestPayload(requestID: "final", candidatePaths: [repo.root],
            phase: .final, baselines: response.baselines, filesystem: true))
        XCTAssertTrue(final.repositories.contains { $0.patch.contains("+edited without literal cd") })
        // Reconciliation must echo the original baseline, not rebase edited files.
        let again = TurnWorktreeDiscovery.collect(GitDiffRequestPayload(requestID: "again", candidatePaths: [repo.root, parent.path],
            phase: .baseline, baselineSource: .beforeTool, filesystem: true, discoverWorktrees: true), tracker: tracker)
        XCTAssertEqual(again.baselines, response.baselines)
    }

    func testDiscoveryIsOptInAndDoesNotWidenSelectedSubfolder() throws {
        let repo = try GitTestRepo()
        try repo.write("sub/file", "before\n"); _ = try repo.commitAll()
        let tracker = TurnChangeTracker()
        let response = TurnWorktreeDiscovery.collect(GitDiffRequestPayload(requestID: "old", candidatePaths: [repo.root],
            phase: .baseline, baselineSource: .turnStart, filesystem: true), tracker: tracker)
        XCTAssertNil(response.discoveredWorktrees)
        XCTAssertEqual(TurnWorktreeDiscovery.discover([repo.root + "/sub"], deadline: Date().addingTimeInterval(3)), [])
    }

    func testWorktreeCreatedBetweenToolsGetsLateBaselineBeforeNextEdit() throws {
        let repo = try GitTestRepo()
        try repo.write("file", "initial\n"); _ = try repo.commitAll()
        let tracker = TurnChangeTracker()
        _ = TurnWorktreeDiscovery.collect(GitDiffRequestPayload(requestID: "start", candidatePaths: [repo.root],
            phase: .baseline, baselineSource: .turnStart, filesystem: true, discoverWorktrees: true), tracker: tracker)
        let worker = URL(fileURLWithPath: repo.root).deletingLastPathComponent().appendingPathComponent("late-\(UUID().uuidString)")
        try repo.git("worktree", "add", "--detach", worker.path)
        defer { _ = try? repo.git("worktree", "remove", "--force", worker.path) }
        let late = TurnWorktreeDiscovery.collect(GitDiffRequestPayload(requestID: "later", candidatePaths: [repo.root, worker.path],
            phase: .baseline, baselineSource: .beforeTool, filesystem: true, discoverWorktrees: true), tracker: tracker)
        XCTAssertEqual(late.baselines?.first { $0.root == worker.path }?.source, .beforeTool)
        try Data("next tool edit\n".utf8).write(to: worker.appendingPathComponent("file"))
        XCTAssertTrue(tracker.capture(status: "final").repositories.contains { $0.patch.contains("+next tool edit") })
    }
}

extension TurnWorktreeDiscoveryTests {
    func testDiscoveryRejectsInvalidOriginalRequest() throws {
        let badSource = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(
            #"{"request_id":"bad","candidate_paths":[],"phase":"baseline","baseline_source":"unknown","filesystem":true,"discover_worktrees":true}"#.utf8))
        let tooMany = GitDiffRequestPayload(requestID: "many", candidatePaths: Array(repeating: "/tmp/project", count: 9),
            phase: .baseline, baselineSource: .turnStart, filesystem: true, discoverWorktrees: true)
        for request in [badSource, tooMany] {
            let result = TurnWorktreeDiscovery.collect(request, tracker: TurnChangeTracker())
            XCTAssertEqual(result.status, .unavailable)
            XCTAssertNil(result.baselines)
        }
    }
}

extension TurnWorktreeDiscoveryTests {
    func testSymlinkedSelectedScopeReportsPhysicalContainment() throws {
        let repo = try GitTestRepo()
        try repo.write("file", "before\n"); _ = try repo.commitAll()
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("scope-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let physical = parent.appendingPathComponent("physical")
        let alias = parent.appendingPathComponent("alias")
        try FileManager.default.createDirectory(at: physical, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: physical)
        let worker = physical.appendingPathComponent("worker")
        try repo.git("worktree", "add", "--detach", worker.path)
        defer { _ = try? repo.git("worktree", "remove", "--force", worker.path) }
        let result = TurnWorktreeDiscovery.discover([repo.root, alias.path], deadline: Date().addingTimeInterval(3))
        let discovered = try XCTUnwrap(result.first)
        XCTAssertEqual(discovered.root, TurnFileReader.physicalPath(worker.path))
        XCTAssertEqual(discovered.scope, alias.path)
        XCTAssertEqual(discovered.physicalScope, TurnFileReader.physicalPath(physical.path))
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(discovered)) as? [String: String])
        XCTAssertEqual(wire["physical_scope"], TurnFileReader.physicalPath(physical.path))
        XCTAssertTrue(TurnWorktreeDiscovery.discover([repo.root], deadline: Date().addingTimeInterval(3)).isEmpty)
    }

    func testExternalWorktreeRegistrationCommitAndCleanupRetainsOneLineDiff() throws {
        let repo = try GitTestRepo()
        try repo.write("panel.txt", "rounded-base\n"); _ = try repo.commitAll()
        let tracker = TurnChangeTracker()
        let start = GitDiffRequestPayload(requestID: "start", candidatePaths: [repo.root], phase: .baseline,
            baselineSource: .turnStart, filesystem: true, discoverWorktrees: true)
        _ = TurnWorktreeDiscovery.collect(start, tracker: tracker)
        let worker = URL(fileURLWithPath: repo.root).deletingLastPathComponent().appendingPathComponent("external-\(UUID().uuidString)")
        tracker.beginTool()
        try repo.git("worktree", "add", "--detach", worker.path)
        tracker.endTool()
        defer { _ = try? repo.git("worktree", "remove", "--force", worker.path) }
        let registered = TurnWorktreeDiscovery.collect(GitDiffRequestPayload(requestID: "register", candidatePaths: [worker.path, repo.root],
            phase: .baseline, baselineSource: .beforeTool, filesystem: true, discoverWorktrees: true), tracker: tracker)
        tracker.beginTool()
        try Data("rounded-lg\n".utf8).write(to: worker.appendingPathComponent("panel.txt"))
        try repo.git("-C", worker.path, "add", "panel.txt")
        try repo.git("-C", worker.path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Round panel")
        tracker.endTool()
        XCTAssertTrue(tracker.capture(status: "running").repositories.map(\.patch).joined().contains("+rounded-lg"))
        tracker.beginTool()
        try repo.git("worktree", "remove", worker.path)
        tracker.endTool()
        let final = tracker.collect(GitDiffRequestPayload(requestID: "final", candidatePaths: [repo.root], phase: .final,
            baselines: registered.baselines, filesystem: true))
        let patch = final.repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("-rounded-base\n+rounded-lg"), patch)
        XCTAssertEqual(patch.components(separatedBy: "diff --git").count - 1, 1)
    }
}
