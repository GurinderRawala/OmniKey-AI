import XCTest
@testable import OmniKeyAI

final class GitShellCommandAnalyzerTests: XCTestCase {
    func testLiteralCdAndGitDashCCommits() {
        let a = GitShellCommandAnalyzer.analyze(
            "cd '/work/my repo' && git add -A && git commit -m \"feat: x; y\"\ngit -C /other commit -qm z",
            initialDirectory: "/start"
        )
        XCTAssertEqual(a.commitDirectories, ["/work/my repo", "/other"])
        XCTAssertTrue(a.canAttribute)
    }

    func testRelativeCdResolvesAgainstKnownDirectoryOnly() {
        XCTAssertEqual(
            GitShellCommandAnalyzer.analyze("cd sub && git commit -m x", initialDirectory: "/repo").commitDirectories,
            ["/repo/sub"]
        )
        let unknown = GitShellCommandAnalyzer.analyze("cd sub && git commit -m x", initialDirectory: nil)
        XCTAssertFalse(unknown.canAttribute)
    }

    func testDisqualifiesExpansionsAndHeadMovingCommands() {
        let cases = [
            "cd $REPO && git commit -m x",
            "GIT_DIR=/elsewhere/.git git commit -m x",
            "export GIT_WORK_TREE=/elsewhere; git commit -m x",
            "git -c core.worktree=/elsewhere commit -m x",
            "git commit -m x && git checkout main",
            "git reset --hard HEAD~1; git commit -m x",
            "git pull && git commit -m x",
            "git commit --amend -m x",
            "git --git-dir=/x/.git commit -m x",
            "xargs git commit -m x",
            "cat <<EOF\nx\nEOF\ngit commit -m x",
            "git commit -m 'unterminated",
            "./commit.sh",
        ]
        for script in cases {
            XCTAssertFalse(GitShellCommandAnalyzer.analyze(script, initialDirectory: "/repo").canAttribute, script)
        }
    }

    func testProseMentioningCommitIsNotAnInvocation() {
        let a = GitShellCommandAnalyzer.analyze("echo 'run git commit later' # git commit", initialDirectory: "/repo")
        XCTAssertTrue(a.commitDirectories.isEmpty)
    }
}

final class GitProvenanceTrackerTests: XCTestCase {
    private func run(_ script: String) {
        _ = runShellCommandWithStatus(script, processRegistrar: { _ in })
    }

    private func quoted(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    private let commitFlags = "-c user.name=T -c user.email=t@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null"

    func testObservedLiteralCommitIsReported() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        let before = try repo.commitAll()
        try repo.write("a.txt", "b\n")
        let script = "cd \(quoted(repo.root)) && git add -A && git \(commitFlags) commit -q -m agent"
        let tracker = GitProvenanceTracker()
        let baseline = tracker.baseline(script: script, context: nil)
        XCTAssertFalse(baseline.isEmpty)
        run(script)
        let observations = tracker.observations(after: baseline)
        let after = try repo.git("rev-parse", "HEAD")
        XCTAssertEqual(observations, [GitCommitObservation(root: repo.root, before: before, after: after)])
    }

    func testUnbornInitialCommitHasNullBefore() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        let script = "git -C \(quoted(repo.root)) add -A && git -C \(quoted(repo.root)) \(commitFlags) commit -q -m init"
        let tracker = GitProvenanceTracker()
        let baseline = tracker.baseline(script: script, context: nil)
        run(script)
        let observations = tracker.observations(after: baseline)
        XCTAssertEqual(observations.count, 1)
        XCTAssertNil(observations.first?.before)
        let encoded = String(decoding: try JSONEncoder().encode(observations[0]), as: UTF8.self)
        XCTAssertTrue(encoded.contains("\"before\":null"))
    }

    func testNoHeadChangeMeansNoAttribution() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        // Nothing to commit: `git commit` fails and HEAD stays put.
        let script = "cd \(quoted(repo.root)) && git \(commitFlags) commit -q -m nothing"
        let tracker = GitProvenanceTracker()
        let baseline = tracker.baseline(script: script, context: nil)
        run(script)
        XCTAssertTrue(tracker.observations(after: baseline).isEmpty)
    }

    func testExternalCheckoutDuringCommitScriptIsNotAttributed() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        try repo.git("checkout", "-q", "-b", "other")
        try repo.write("a.txt", "other\n")
        _ = try repo.commitAll("unrelated user commit")
        try repo.git("checkout", "-q", "main")
        let script = "cd \(quoted(repo.root)) && git \(commitFlags) commit -q -m nothing"
        let tracker = GitProvenanceTracker()
        let baseline = tracker.baseline(script: script, context: nil)
        // HEAD moves by a checkout (descendant), not by the script's commit.
        try repo.git("checkout", "-q", "other")
        run(script)
        XCTAssertTrue(tracker.observations(after: baseline).isEmpty, "reflog shows checkout, not commit")
    }

    func testScriptWithoutLiteralCommitIsNeverInspected() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        let tracker = GitProvenanceTracker()
        XCTAssertTrue(tracker.baseline(script: "cd \(quoted(repo.root)) && ./scripts/release.sh", context: nil).isEmpty)
    }
}

// MARK: - Wire, hydration and placement

final class SessionDiffWireTests: XCTestCase {
    func testSummaryDecodeAndLabels() throws {
        let json = #"{"id":"d1","fileCount":3,"repositoryCount":1,"createdAt":"2026-11-12T00:00:00Z","scope":"commit","commit":"0123456789abcdef0123456789abcdef01234567"}"#
        let diff = try JSONDecoder().decode(SavedSessionDiff.self, from: Data(json.utf8))
        XCTAssertEqual(diff.scope, .commit)
        XCTAssertEqual(diff.buttonTitle, "View commit changes")
        XCTAssertTrue(diff.detailText.contains("0123456"))
        let legacy = try JSONDecoder().decode(
            SavedSessionDiff.self,
            from: Data(#"{"id":"d2","fileCount":1,"repositoryCount":1,"createdAt":"x"}"#.utf8)
        )
        XCTAssertEqual(legacy.scope, .workingTree)
        XCTAssertTrue(legacy.detailText.contains("pre-existing"))
        XCTAssertFalse(SavedSessionDiff(id: "../x", fileCount: 1, repositoryCount: 1, createdAt: "").hasSafeID)
    }

    func testMalformedSessionDiffDoesNotDropFinalFrame() throws {
        let json = #"{"session_id":"s","sender":"agent","content":"<final_answer>hi</final_answer>","session_diff":{"id":5}}"#
        let message = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: Data(json.utf8))
        XCTAssertNil(message.sessionDiff)
        XCTAssertEqual(ChatSessionRunner.finalAnswerDisplayText(from: message), "hi")
    }

    func testHydrationPlacesEachCardBeforeItsOwnFinal() throws {
        let json = """
        {"messages":[
          {"id":"u1","role":"user","text":"one"},
          {"id":"a1","role":"assistant","text":"","blocks":[
            {"id":"b1","kind":"shellCommand","text":"ls"},
            {"id":"b2","kind":"finalAnswer","text":"first","sessionDiff":{"id":"diff-1","fileCount":1,"repositoryCount":1,"createdAt":"t","scope":"working_tree"}}]},
          {"id":"u2","role":"user","text":"two"},
          {"id":"a2","role":"assistant","text":"","blocks":[
            {"id":"b3","kind":"finalAnswer","text":"second","sessionDiff":{"id":"diff-2","fileCount":2,"repositoryCount":1,"createdAt":"t","scope":"commit","commit":"0123456789abcdef0123456789abcdef01234567"}}]},
          {"id":"u3","role":"user","text":"three"},
          {"id":"a3","role":"assistant","text":"","blocks":[{"id":"b4","kind":"finalAnswer","text":"third"}]}
        ]}
        """
        let body = try JSONDecoder().decode(SessionHistoryResponse.self, from: Data(json.utf8))
        let messages = ChatModel.hydrateTranscript(from: body.messages)
        let assistants = messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistants.map { $0.blocks.map(\.kind) }, [
            [.shellCommand, .sessionDiff, .finalAnswer],
            [.sessionDiff, .finalAnswer],
            [.finalAnswer],
        ])
        XCTAssertEqual(ChatSessionDiffPlacement.cards(beforeFinalIn: assistants[0].blocks).map { $0.sessionDiff?.id }, ["diff-1"])
        XCTAssertEqual(ChatSessionDiffPlacement.cards(beforeFinalIn: assistants[1].blocks).map { $0.sessionDiff?.id }, ["diff-2"])
        XCTAssertTrue(ChatSessionDiffPlacement.cards(beforeFinalIn: assistants[2].blocks).isEmpty)
    }

    func testLegacyHistoryEntryCarriesItsSnapshot() throws {
        let json = #"{"messages":[{"id":"u","role":"user","text":"q"},{"id":"a","role":"assistant","text":"<final_answer>done</final_answer>","sessionDiff":{"id":"legacy-1","fileCount":1,"repositoryCount":1,"createdAt":"t"}}]}"#
        let body = try JSONDecoder().decode(SessionHistoryResponse.self, from: Data(json.utf8))
        let assistant = try XCTUnwrap(ChatModel.hydrateTranscript(from: body.messages).last)
        XCTAssertEqual(assistant.blocks.map(\.kind), [.sessionDiff, .finalAnswer])
        XCTAssertEqual(assistant.blocks.first?.sessionDiff?.id, "legacy-1")
    }

    func testCardsAfterFinalOrWithoutFinalAreNotShown() {
        let diff = SavedSessionDiff(id: "x", fileCount: 1, repositoryCount: 1, createdAt: "t")
        let blocks = [
            ChatBlock(kind: .finalAnswer, text: "a"),
            ChatBlock(kind: .sessionDiff, text: "", sessionDiff: diff),
        ]
        XCTAssertTrue(ChatSessionDiffPlacement.cards(beforeFinalIn: blocks).isEmpty)
        XCTAssertTrue(ChatSessionDiffPlacement.cards(beforeFinalIn: [blocks[1]]).isEmpty)
    }

    func testCSPIsInsertedFirstInHead() {
        let full = SessionDiffHTMLDocument.prepare("<!DOCTYPE html><html><head data-x=1><style>a{}</style></head><body>x</body></html>")
        XCTAssertTrue(full.hasPrefix("<!DOCTYPE html><html><head data-x=1><meta http-equiv=\"Content-Security-Policy\""))
        let fragment = SessionDiffHTMLDocument.prepare("<div>x</div>")
        XCTAssertTrue(fragment.contains("default-src 'none'"))
        XCTAssertTrue(fragment.contains("script-src 'none'"))
        XCTAssertTrue(fragment.contains("<body><div>x</div></body>"))
    }

    func testNavigationPolicyOnlyAllowsInitialDocument() {
        typealias C = SessionDiffWebView.Coordinator
        XCTAssertTrue(C.allows(URL(string: "about:blank"), navigationType: .other, isMainFrame: true))
        XCTAssertFalse(C.allows(URL(string: "https://example.com"), navigationType: .linkActivated, isMainFrame: true))
        XCTAssertFalse(C.allows(URL(string: "file:///etc/passwd"), navigationType: .other, isMainFrame: true))
        XCTAssertFalse(C.allows(URL(string: "about:blank"), navigationType: .other, isMainFrame: false))
        let configuration = SessionDiffWebView.makeConfiguration()
        XCTAssertFalse(configuration.websiteDataStore.isPersistent)
        XCTAssertFalse(configuration.defaultWebpagePreferences.allowsContentJavaScript)
    }

    func testDiffRequestURLNeverCarriesToken() throws {
        let url = try XCTUnwrap(SessionDiffHTTPFetcher.requestURL(
            baseURL: URL(string: "http://127.0.0.1:7071")!, sessionId: "s 1", diffId: "d-1", theme: .dark
        ))
        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:7071/api/agent/sessions/s%201/diffs/d-1?theme=dark&layout=unified")
    }

    @MainActor
    func testSystemAppearanceAndLayoutRequestIdentity() throws {
        XCTAssertEqual(SessionDiffTheme(.dark), .dark)
        XCTAssertEqual(SessionDiffTheme(.light), .light)
        let url = try XCTUnwrap(SessionDiffHTTPFetcher.requestURL(baseURL: URL(string: "http://localhost:7071")!,
            sessionId: "s", diffId: "d", theme: .light, layout: .split))
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            [URLQueryItem(name: "theme", value: "light"), URLQueryItem(name: "layout", value: "split")])
        let selected = SessionDiffSelection(sessionId: "s", diff: SavedSessionDiff(id: "d", fileCount: 1, repositoryCount: 1, createdAt: "t"))
        XCTAssertNotEqual(SessionDiffInspectorModel.key(selected, theme: .dark, layout: .unified),
                          SessionDiffInspectorModel.key(selected, theme: .dark, layout: .split))
        XCTAssertNotEqual(SessionDiffInspectorModel.key(selected, theme: .dark, layout: .split),
                          SessionDiffInspectorModel.key(selected, theme: .light, layout: .split))
    }

    @MainActor
    func testWebViewFocusKeepsCopyShortcut() {
        let web = WKWebViewProbe.make()
        let child = NSView()
        web.addSubview(child)
        XCTAssertTrue(ChatWindow.isInsideWebView(child))
        XCTAssertFalse(ChatWindow.isInsideWebView(NSTextView()))
    }
}

import WebKit

@MainActor
enum WKWebViewProbe {
    static func make() -> WKWebView { WKWebView(frame: .zero) }
}

// MARK: - Inspector stale fetch handling

private final class ScriptedDiffFetcher: SessionDiffFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [String: CheckedContinuation<SessionDiffHTMLResponse, Error>] = [:]
    private var waiting: [String: XCTestExpectation] = [:]
    var overrideID: String?

    func expectRequest(_ diffId: String) -> XCTestExpectation {
        let e = XCTestExpectation(description: diffId)
        lock.withLock { waiting[diffId] = e }
        return e
    }

    func fetch(sessionId: String, diffId: String, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse {
        try await withCheckedThrowingContinuation { continuation in
            let e = lock.withLock { () -> XCTestExpectation? in
                continuations[diffId] = continuation
                return waiting[diffId]
            }
            e?.fulfill()
        }
    }

    func complete(_ diffId: String, html: String) {
        let c = lock.withLock { continuations.removeValue(forKey: diffId) }
        c?.resume(returning: SessionDiffHTMLResponse(id: overrideID ?? diffId, html: html))
    }
}

final class SessionDiffInspectorModelTests: XCTestCase {
    @MainActor
    func testLateResultForPreviousSnapshotIsDiscarded() async {
        let fetcher = ScriptedDiffFetcher()
        let model = SessionDiffInspectorModel(fetcher: fetcher)
        let first = SessionDiffSelection(sessionId: "s", diff: SavedSessionDiff(id: "one", fileCount: 1, repositoryCount: 1, createdAt: "t"))
        let second = SessionDiffSelection(sessionId: "s", diff: SavedSessionDiff(id: "two", fileCount: 1, repositoryCount: 1, createdAt: "t"))
        let firstRequested = fetcher.expectRequest("one")
        let secondRequested = fetcher.expectRequest("two")
        model.load(first, theme: .dark)
        await fulfillment(of: [firstRequested], timeout: 2)
        model.load(second, theme: .dark)
        await fulfillment(of: [secondRequested], timeout: 2)
        fetcher.complete("one", html: "<p>stale</p>")
        fetcher.complete("two", html: "<p>fresh</p>")
        for _ in 0..<50 where model.phase == .loading { try? await Task.sleep(nanoseconds: 10_000_000) }
        guard case let .loaded(html) = model.phase else { return XCTFail("not loaded: \(model.phase)") }
        XCTAssertTrue(html.contains("fresh"))
        XCTAssertFalse(html.contains("stale"))
    }

    @MainActor
    func testMismatchedSnapshotIDFails() async {
        let fetcher = ScriptedDiffFetcher()
        fetcher.overrideID = "someone-else"
        let model = SessionDiffInspectorModel(fetcher: fetcher)
        let requested = fetcher.expectRequest("one")
        model.load(SessionDiffSelection(sessionId: "s", diff: SavedSessionDiff(id: "one", fileCount: 1, repositoryCount: 1, createdAt: "t")), theme: .light)
        await fulfillment(of: [requested], timeout: 2)
        fetcher.complete("one", html: "<p>x</p>")
        for _ in 0..<50 where model.phase == .loading { try? await Task.sleep(nanoseconds: 10_000_000) }
        guard case .failed = model.phase else { return XCTFail("expected failure: \(model.phase)") }
    }
}
