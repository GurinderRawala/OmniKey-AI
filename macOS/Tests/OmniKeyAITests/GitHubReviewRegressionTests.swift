import Foundation
import AppKit
import SwiftUI
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

    @MainActor
    func testMountedEmptyChatDiscoversRepositoryAfterHistoryHydrates() async throws {
        let repo = try GitTestRepo()
        try repo.git("remote", "add", "origin", "https://github.com/owner/repo.git")
        let suite = "github-mounted-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let card = SessionGitHubCardModel(defaults: defaults, discovery: { root, old, texts, _ in
            SessionGitHubDiscovery.refresh(path: root, previous: old, texts: texts, loadPullRequests: false)
        })
        let model = ChatModel(authToken: { nil })
        let host = NSHostingView(rootView: SessionGitHubCard(model: model, card: card).frame(width: 500))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 500, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderBack(nil)
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(50))
        model.activeSessionId = "hydrated"
        var message = ChatMessage.assistant()
        message.blocks = [ChatBlock(kind: .shellCommand, text: "git status", workingDirectory: repo.root)]
        model.messages = [message]
        for _ in 0..<100 {
            if card.info != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(card.info?.repository, "owner/repo")
    }

    @MainActor
    func testMountedSavedChatDiscoversRepositoryWithoutPlaceholder() async throws {
        let repo = try GitTestRepo()
        try repo.git("remote", "add", "origin", "https://github.com/owner/repo.git")
        let suite = "github-mounted-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let card = SessionGitHubCardModel(defaults: defaults, discovery: { root, old, texts, _ in
            SessionGitHubDiscovery.refresh(path: root, previous: old, texts: texts, loadPullRequests: false)
        })
        let model = ChatModel(authToken: { nil })
        model.activeSessionId = "hydrated"
        var message = ChatMessage.assistant()
        message.blocks = [ChatBlock(kind: .shellCommand, text: "git status", workingDirectory: repo.root)]
        model.messages = [message]
        let host = NSHostingView(rootView: SessionGitHubCard(model: model, card: card).frame(width: 500))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 500, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderBack(nil)
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(50))
        for _ in 0..<100 {
            if card.info != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(card.info?.repository, "owner/repo")
    }

    func testStructuredDirectorySurvivesHistoryAndDoesNotNeedDiffCoverage() throws {
        let data = Data("""
        [{"id":"answer","role":"assistant","text":"","blocks":[{"id":"shell","kind":"shellCommand","text":"git status","workingDirectory":"/Projects/Repo"}]}]
        """.utf8)
        let entries = try JSONDecoder().decode([SessionHistoryEntry].self, from: data)
        let messages = ChatModel.hydrateTranscript(from: entries)
        XCTAssertEqual(SessionGitHubDiscovery.startingPath(in: messages), "/Projects/Repo")
    }

    func testLegacyBranchPRIsRemovedFromSessionResults() throws {
        let repo = try GitTestRepo()
        try repo.git("remote", "add", "origin", "https://github.com/owner/repo.git")
        let unrelated = SessionPullRequest(number: 83, title: "Other task", url: "https://github.com/owner/repo/pull/83", state: "OPEN", isDraft: false)
        let related = SessionPullRequest(number: 84, title: "This task", url: "https://github.com/owner/repo/pull/84", state: "OPEN", isDraft: false)
        let cached = SessionGitHubInfo(root: repo.root, repository: "owner/repo", branch: "other-task", changedFiles: 0, pullRequests: [unrelated, related], pullRequestsLoaded: true)
        let texts = ["Created https://github.com/owner/repo/pull/84"]
        let linked = SessionGitHubDiscovery.linkedPRs(in: texts, repository: cached.repository)
        XCTAssertEqual(SessionGitHubDiscovery.scoped(cached, linked: linked).pullRequests.map(\.number), [84])
        let refreshed = try XCTUnwrap(SessionGitHubDiscovery.refresh(path: repo.root, previous: cached, texts: texts, loadPullRequests: false))
        XCTAssertEqual(refreshed.pullRequests.map(\.number), [84])
        XCTAssertTrue(SessionGitHubDiscovery.scoped(cached, linked: []).pullRequests.isEmpty)
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
