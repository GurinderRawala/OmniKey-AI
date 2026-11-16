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
