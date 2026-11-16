import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

final class SessionChangesUITests: XCTestCase {
    func testCountsDoNotCountHeadersButDoCountHeaderLikeContent() {
        let counts = DiffLineCounts(patches: ["diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n---content\n+++content\ndiff --git a/mode b/mode\nold mode 100644\nnew mode 100755\n"])
        XCTAssertEqual(counts.files, 2)
        XCTAssertEqual(counts.additions, 1)
        XCTAssertEqual(counts.deletions, 1)
        XCTAssertEqual(DiffLineCounts(patches: []).files, 0)
    }

    func testGitHubRemoteDetectionRejectsOtherHostsAndInvalidPaths() {
        XCTAssertEqual(SessionGitHubDiscovery.repository(from: "git@github.com:owner/repo.git"), "owner/repo")
        XCTAssertEqual(SessionGitHubDiscovery.repository(from: "https://github.com/owner/repo.git"), "owner/repo")
        XCTAssertEqual(SessionGitHubDiscovery.repository(from: "ssh://git@github.com/owner/repo.git"), "owner/repo")
        XCTAssertNil(SessionGitHubDiscovery.repository(from: "https://github.com.evil.test/owner/repo"))
        XCTAssertNil(SessionGitHubDiscovery.repository(from: "https://gitlab.com/owner/repo"))
        XCTAssertNil(SessionGitHubDiscovery.repository(from: "https://github.com/owner/repo/extra"))
    }

    func testRelatedPRsAreRestrictedToTheSessionRepository() {
        XCTAssertEqual(SessionGitHubDiscovery.linkedPRs(in: ["Created https://github.com/owner/repo/pull/42 and [PR](https://github.com/owner/repo/pull/43). https://github.com/elsewhere/repo/pull/2"], repository: "owner/repo"), [42, 43])
    }

    @MainActor
    func testNoPreviousTurnPillAndSessionSwitchClosesLiveDrawer() {
        let model = ChatModel(authToken: { nil })
        model.activeSessionId = "first"
        let previous = ChatBlock(kind: .sessionDiff, text: "", sessionDiff: SavedSessionDiff(id: "saved", fileCount: 2, repositoryCount: 1, createdAt: "now"))
        var message = ChatMessage.assistant()
        message.blocks = [previous]
        model.messages = [message]
        XCTAssertEqual(model.currentChangeBlock?.sessionDiff?.fileCount, 2)
        var steering = ChatMessage.user("Also update tests")
        steering.steeringState = .pending
        model.messages.append(steering)
        XCTAssertEqual(model.currentChangeBlock?.sessionDiff?.fileCount, 2)
        model.messages.append(ChatMessage.assistant())
        XCTAssertNil(model.currentChangeBlock)
        model.showsLiveChanges = true
        model.activeSessionId = "second"
        XCTAssertFalse(model.showsLiveChanges)
    }

    @MainActor
    func testCompactUIRenders() throws {
        let model = ChatModel(authToken: { nil })
        let diff = LiveTurnDiff(turnID: "preview", revision: 1, status: "running", repositories: [
            GitDiffRepositoryPatch(root: "/Projects/Example", patch: "diff --git a/settings.swift b/settings.swift\n--- a/settings.swift\n+++ b/settings.swift\n@@ -1 +1,2 @@\n-let liveChanges = false\n+let liveChanges = true\n+let showChangePill = true\n", baseline: GitTurnBaseline(root: "/Projects/Example", head: nil, capturedAt: "now", source: .turnStart), head: nil),
        ], coverage: [TurnRootCoverage(root: "/Projects/Example", status: "partial", reason: "INTERNAL DIAGNOSTIC", suggestedFix: "INTERNAL FIX")])
        var message = ChatMessage.assistant()
        message.blocks = [ChatBlock(kind: .sessionDiff, text: "", liveDiff: diff)]
        model.messages = [message]
        model.isRunning = true
        let info = SessionGitHubInfo(root: "/Projects/Example", repository: "owner/Example", branch: "feature/live-diffs", changedFiles: 2, pullRequests: [SessionPullRequest(number: 83, title: "Add live turn diffs", url: "https://github.com/owner/Example/pull/83", state: "OPEN", isDraft: false)], pullRequestsLoaded: true)
        let content = HStack(spacing: 0) {
            VStack(alignment: .leading) {
                Text("Live changes").font(.headline).padding()
                GitHubRepositoryCard(info: info).frame(maxWidth: .infinity, alignment: .trailing).padding()
                Spacer()
                Text("Updated the diff viewer and added the compact changes control.").padding()
                Spacer()
                TurnChangesPill(model: model).frame(maxWidth: .infinity, alignment: .trailing)
                LandingInputComposer(model: model)
            }.padding().frame(width: 580)
            Divider()
            LiveChangesDrawer(model: model).frame(width: 420)
        }.frame(width: 1001, height: 640).background(Color(nsColor: .windowBackgroundColor))
        let view = NSHostingView(rootView: content)
        view.frame = CGRect(x: 0, y: 0, width: 1001, height: 640)
        view.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(view.fittingSize.height, 100)
        if let path = ProcessInfo.processInfo.environment["OMNIKEY_CHANGES_UI_PREVIEW"] {
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
        }
    }
}


extension SessionChangesUITests {
    func testGitHubCardRequiresGitHubRemoteAndHandlesUpstreamOnlyRemote() throws {
        let repo = try GitTestRepo()
        XCTAssertNil(SessionGitHubDiscovery.refresh(path: repo.root, previous: nil, texts: [], loadPullRequests: false))
        try repo.git("remote", "add", "upstream", "git@github.com:owner/repo.git")
        var info = try XCTUnwrap(SessionGitHubDiscovery.refresh(path: repo.root, previous: nil, texts: [], loadPullRequests: false))
        XCTAssertEqual(info.repository, "owner/repo")
        XCTAssertEqual(info.changedFiles, 0)
        info.pullRequests = [SessionPullRequest(number: 42, title: "Earlier work", url: "https://github.com/owner/repo/pull/42", state: "OPEN", isDraft: false)]
        try repo.git("checkout", "-b", "next-task")
        let next = try XCTUnwrap(SessionGitHubDiscovery.refresh(path: repo.root, previous: info, texts: [], loadPullRequests: false))
        XCTAssertEqual(next.branch, "next-task")
        XCTAssertTrue(next.pullRequests.isEmpty)
        let linked = try XCTUnwrap(SessionGitHubDiscovery.refresh(path: repo.root, previous: info,
            texts: ["https://github.com/owner/repo/pull/42"], loadPullRequests: false))
        XCTAssertEqual(linked.pullRequests.map(\.number), [42])
        try repo.git("remote", "set-url", "upstream", "https://gitlab.com/owner/repo.git")
        XCTAssertNil(SessionGitHubDiscovery.refresh(path: repo.root, previous: info, texts: [], loadPullRequests: false))
    }

    @MainActor
    func testSessionGitHubCacheDoesNotLeakAcrossSessions() throws {
        let suite = "SessionGitHub.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let saved = SessionGitHubInfo(root: "/tmp/repo", repository: "owner/repo", branch: "main", changedFiles: 0, pullRequests: [], pullRequestsLoaded: true)
        defaults.set(try JSONEncoder().encode(saved), forKey: "sessionGitHub:first")
        let model = SessionGitHubCardModel(defaults: defaults)
        model.load(session: "first")
        XCTAssertEqual(model.info?.repository, "owner/repo")
        model.load(session: "second")
        XCTAssertNil(model.info)
    }
}

extension SessionChangesUITests {
    func testOnlyUserInputAndFinalAnswersAssociatePRs() {
        let url = "https://github.com/owner/repo/pull/"
        var user = ChatMessage.user("Review [PR](\(url)1)")
        user.blocks = [ChatBlock(kind: .terminalOutput, text: url + "99")]
        var assistant = ChatMessage.assistant()
        assistant.text = url + "98"
        assistant.blocks = [
            ChatBlock(kind: .terminalOutput, text: (10...64).map { url + String($0) }.joined(separator: "\n")),
            ChatBlock(kind: .shellCommand, text: "gh pr view " + url + "97"),
            ChatBlock(kind: .agentReasoning, text: url + "96"),
            ChatBlock(kind: .finalAnswer, text: "Created \(url)2; also \(url)1."),
        ]
        let system = ChatMessage(id: "system", role: .system, text: url + "95", blocks: [ChatBlock(kind: .finalAnswer, text: url + "94")])
        let messages = [user, assistant, system, ChatMessage.user("Also check \(url)3", steeringState: .pending)]
        let texts = SessionGitHubDiscovery.associationTexts(in: messages)
        XCTAssertEqual(SessionGitHubDiscovery.linkedPRs(in: texts, repository: "owner/repo"), [1, 2, 3])
        let cached = SessionGitHubInfo(root: "/missing", repository: "owner/repo", branch: "main", pullRequests: (1...64).map {
            SessionPullRequest(number: $0, title: "PR", url: url + String($0), state: "OPEN", isDraft: false)
        }, pullRequestsLoaded: true)
        XCTAssertEqual(SessionGitHubDiscovery.scoped(cached, linked: SessionGitHubDiscovery.linkedPRs(in: texts, repository: cached.repository)).pullRequests.map(\.number), [1, 2, 3])
    }

    @MainActor
    func testLegacyPRCacheIsPrunedBeforeOfflineDiscovery() async throws {
        let suite = "PRCacheMigration.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cached = SessionGitHubInfo(root: "/missing", repository: "owner/repo", branch: "main", pullRequests: [1, 47].map {
            SessionPullRequest(number: $0, title: "PR", url: "https://github.com/owner/repo/pull/\($0)", state: "OPEN", isDraft: false)
        }, pullRequestsLoaded: true)
        defaults.set(try JSONEncoder().encode(cached), forKey: "sessionGitHub:session")
        let model = SessionGitHubCardModel(defaults: defaults, discovery: { _, old, _, _ in
            XCTAssertEqual(old?.pullRequests.map(\.number), [1])
            return old
        })
        await model.refresh(session: "session", path: nil, texts: ["https://github.com/owner/repo/pull/1"])
        XCTAssertEqual(model.info?.pullRequests.map(\.number), [1])
        let persisted = try JSONDecoder().decode(SessionGitHubInfo.self, from: XCTUnwrap(defaults.data(forKey: "sessionGitHub:session")))
        XCTAssertEqual(persisted.pullRequests.map(\.number), [1])
    }
}

extension SessionChangesUITests {
    func testHydratedTranscriptUsesTheSamePRPolicy() throws {
        let json = #"[{"id":"user","role":"user","text":"Review https://github.com/owner/repo/pull/7"},{"id":"agent","role":"assistant","text":"https://github.com/owner/repo/pull/99","blocks":[{"id":"terminal","kind":"terminalOutput","text":"Queue: https://github.com/owner/repo/pull/47"},{"id":"final","kind":"finalAnswer","text":"Updated https://github.com/owner/repo/pull/8"}]}]"#
        let entries = try JSONDecoder().decode([SessionHistoryEntry].self, from: Data(json.utf8))
        let messages = ChatModel.hydrateTranscript(from: entries)
        XCTAssertEqual(SessionGitHubDiscovery.linkedPRs(in: SessionGitHubDiscovery.associationTexts(in: messages), repository: "owner/repo"), [7, 8])
    }
}
