import Foundation
import XCTest
@testable import OmniKeyAI

private actor DiscoveryProbe {
    var calls: [String] = []
    var active = 0
    var peak = 0
    private var gates: [CheckedContinuation<Void, Never>] = []
    func discover(_ root: String) async -> SessionGitHubInfo {
        calls.append(root)
        active += 1
        peak = max(peak, active)
        await withCheckedContinuation { gates.append($0) }
        active -= 1
        return SessionGitHubInfo(root: root, repository: "owner/repo", branch: "main", changedFiles: 0, pullRequests: [], pullRequestsLoaded: true)
    }
    func release() { gates.removeFirst().resume() }
    func count() -> Int { calls.count }
}

final class GitHubReviewRegressionTests: XCTestCase {
    @MainActor
    func testMissingWorktreeDoesNotHideRepositoryFromOldSavedCoverage() async throws {
        let repo = try GitTestRepo()
        try repo.git("remote", "add", "origin", "https://github.com/owner/repo.git")
        let missing = repo.root + "/removed-worktree"
        let diff = LiveTurnDiff(turnID: "old", revision: 1, status: "final", repositories: [], coverage: [
            TurnRootCoverage(root: missing, status: "partial", reason: "", suggestedFix: ""),
            TurnRootCoverage(root: repo.root, status: "partial", reason: "", suggestedFix: ""),
        ])
        var message = ChatMessage.assistant()
        message.blocks = [ChatBlock(kind: .sessionDiff, text: "", liveDiff: diff)]
        let paths = SessionGitHubDiscovery.startingPaths(in: [message])
        XCTAssertEqual(paths, [missing, repo.root])
        let suite = "github-fallback-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = SessionGitHubCardModel(defaults: defaults, discovery: { root, old, texts, _ in
            SessionGitHubDiscovery.refresh(path: root, previous: old, texts: texts, loadPullRequests: false)
        })
        await model.refresh(session: "existing", path: paths.first, texts: [], paths: paths)
        XCTAssertEqual(model.info?.repository, "owner/repo")
        XCTAssertEqual(model.info.map { TurnChangeTracker.comparable($0.root) }, TurnChangeTracker.comparable(repo.root))
    }

    func testStructuredDirectorySurvivesHistoryAndDoesNotNeedDiffCoverage() throws {
        let data = Data("""
        [{"id":"answer","role":"assistant","text":"","blocks":[{"id":"shell","kind":"shellCommand","text":"git status","workingDirectory":"/Projects/Repo"}]}]
        """.utf8)
        let entries = try JSONDecoder().decode([SessionHistoryEntry].self, from: data)
        let messages = ChatModel.hydrateTranscript(from: entries)
        XCTAssertEqual(SessionGitHubDiscovery.startingPath(in: messages), "/Projects/Repo")
    }

    func testLinkedPRsComeFirstAndCachedWorkRotates() {
        XCTAssertEqual(SessionGitHubDiscovery.lookupOrder(linked: [9], cached: [1, 2, 3], refreshIndex: 0), [9, 1])
        XCTAssertEqual(SessionGitHubDiscovery.lookupOrder(linked: [9], cached: [1, 2, 3], refreshIndex: 1), [9, 2])
    }

    func testBranchPRIdentityIncludesOwnerAndRepository() throws {
        let data = Data("""
        {"number":4,"title":"Other fork","url":"https://github.com/base/repo/pull/4","state":"OPEN","isDraft":false,"headRepository":{"name":"repo"},"headRepositoryOwner":{"login":"contributor"}}
        """.utf8)
        let pr = try JSONDecoder().decode(SessionGitHubDiscovery.BranchPullRequest.self, from: data)
        XCTAssertEqual(pr.headRepositoryName, "contributor/repo")
        XCTAssertFalse(pr.belongs(to: "base/repo"))
        XCTAssertTrue(pr.belongs(to: "Contributor/Repo"))
        XCTAssertFalse(pr.belongs(to: "contributor/other"))
    }

    @MainActor
    func testRefreshCoalescesAndDoesNotPublishAnOldSession() async throws {
        let probe = DiscoveryProbe()
        let suite = "github-review-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = SessionGitHubCardModel(defaults: defaults, discovery: { root, _, _, _ in await probe.discover(root) })
        let first = Task { await model.refresh(session: "old", path: "/first", texts: []) }
        for _ in 0..<100 where await probe.count() < 1 { try await Task.sleep(for: .milliseconds(5)) }
        let second = Task { await model.refresh(session: "new", path: "/second", texts: []) }
        await Task.yield()
        let third = Task { await model.refresh(session: "new", path: "/third", texts: []) }
        try await Task.sleep(for: .milliseconds(30))
        let before = await probe.count()
        XCTAssertEqual(before, 1)
        await probe.release()
        for _ in 0..<100 where await probe.count() < 2 { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNil(model.info)
        await probe.release()
        await first.value; await second.value; await third.value
        XCTAssertEqual(model.info?.root, "/third")
        let calls = await probe.calls
        let peak = await probe.peak
        XCTAssertEqual(calls, ["/first", "/third"])
        XCTAssertEqual(peak, 1)
        XCTAssertNil(defaults.data(forKey: "sessionGitHub:old"))
    }
}
