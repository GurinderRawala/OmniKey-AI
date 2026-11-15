import AppKit
import WebKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

@MainActor
final class ChangesDrawerTests: XCTestCase {
    private func diff(_ revision: Int) -> LiveTurnDiff {
        LiveTurnDiff(turnID: "turn", revision: revision, status: "running", repositories: [], coverage: [])
    }

    func testPreviewUsesLatestRevisionAndRetainsRenderedContentWhileUpdating() async {
        let fetcher = PreviewFetcher()
        let model = SessionDiffInspectorModel(fetcher: fetcher, previewFetcher: fetcher)
        model.loadPreview(sessionId: "s", diff: diff(1), theme: .dark, layout: .unified)
        await waitFor { fetcher.has(1) }
        fetcher.complete(1)
        await waitFor { if case .loaded = model.phase { return true }; return false }
        model.loadPreview(sessionId: "s", diff: diff(2), theme: .dark, layout: .unified)
        guard case .loaded = model.phase else { return XCTFail("Updating must keep the existing web view mounted") }
        await waitFor { fetcher.has(2) }
        model.loadPreview(sessionId: "s", diff: diff(3), theme: .dark, layout: .split)
        await waitFor { fetcher.has(3) }
        fetcher.complete(3)
        await waitFor { !model.isUpdating }
        fetcher.complete(2)
        try? await Task.sleep(for: .milliseconds(20))
        guard case .loaded(let html) = model.phase else { return XCTFail("Missing latest preview") }
        XCTAssertTrue(html.contains("revision-3"))
        XCTAssertFalse(html.contains("revision-2"))
        model.load(SessionDiffSelection(sessionId: "s", diff: SavedSessionDiff(id: "saved", fileCount: 1, repositoryCount: 1, createdAt: "now")), theme: .dark, preserveContent: true)
        guard case .loaded = model.phase else { return XCTFail("Completion must retain the mounted web view") }
        await waitFor { !model.isUpdating }
        model.reset()
        XCTAssertEqual(model.phase, .idle)
    }

    func testStoppedChangesStayBoundToTheirTurnAndClearOnSessionSwitch() {
        let model = ChatModel(authToken: { nil })
        model.activeSessionId = "one"
        model.inspectCapturedChanges(diff(4))
        XCTAssertEqual(model.inspectedCapturedDiff?.revision, 4)
        XCTAssertEqual(model.changesInspectorSource?.identity, "one:turn")
        model.activeSessionId = "two"
        XCTAssertNil(model.inspectedCapturedDiff)
        XCTAssertNil(model.changesInspectorSource)
    }

    func testContinuousEditsCoalesceWithoutStarvingTheFirstFrame() async {
        let fetcher = PreviewFetcher()
        let model = SessionDiffInspectorModel(previewFetcher: fetcher)
        model.loadPreview(sessionId: "s", diff: diff(1), theme: .dark, layout: .unified)
        await waitFor { fetcher.has(1) }
        model.loadPreview(sessionId: "s", diff: diff(2), theme: .dark, layout: .unified)
        model.loadPreview(sessionId: "s", diff: diff(3), theme: .dark, layout: .unified)
        XCTAssertFalse(fetcher.has(2))
        fetcher.complete(1)
        await waitFor { fetcher.has(3) }
        guard case .loaded(let first) = model.phase else { return XCTFail("Expected a useful first frame") }
        XCTAssertTrue(first.contains("revision-1"))
        fetcher.complete(3)
        await waitFor { !model.isUpdating }
        guard case .loaded(let latest) = model.phase else { return XCTFail("Expected latest frame") }
        XCTAssertTrue(latest.contains("revision-3"))
    }

    func testCompletedCardsKeepIndividualSnapshotsAndOmitEmptyTurns() {
        let first = SavedSessionDiff(id: "one", fileCount: 2, repositoryCount: 1, createdAt: "now")
        let second = SavedSessionDiff(id: "two", fileCount: 1, repositoryCount: 1, createdAt: "now")
        let empty = SavedSessionDiff(id: "empty", fileCount: 0, repositoryCount: 1, createdAt: "now")
        let blocks = [first, first, empty, second].map { ChatBlock(kind: .sessionDiff, text: "", sessionDiff: $0) } + [ChatBlock(kind: .finalAnswer, text: "Done")]
        XCTAssertEqual(ChatSessionDiffPlacement.cards(beforeFinalIn: blocks).compactMap { $0.sessionDiff?.id }, ["one", "two"])
        XCTAssertTrue(ChatSessionDiffPlacement.cards(beforeFinalIn: Array(blocks.dropLast())).isEmpty)
    }

    func testUnavailableCaptureRemainsAccessibleAfterFinalAnswer() throws {
        let data = Data("""
        {"id":"missing","fileCount":0,"repositoryCount":0,"createdAt":"now","filesystem":true,"coverage":[{"root":"/removed","status":"unavailable","reason":"Removed","suggestedFix":""}]}
        """.utf8)
        let missing = try JSONDecoder().decode(SavedSessionDiff.self, from: data)
        XCTAssertTrue(missing.captureUnavailable)
        let blocks = [ChatBlock(kind: .sessionDiff, text: "", sessionDiff: missing), ChatBlock(kind: .finalAnswer, text: "Done")]
        XCTAssertEqual(ChatSessionDiffPlacement.cards(beforeFinalIn: blocks).count, 1)
    }

    func testIsolatedNativeScriptsPreserveScrollAndFileDisclosuresWithoutPageScripts() async throws {
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 500, height: 300), configuration: SessionDiffWebView.makeConfiguration())
        let coordinator = SessionDiffWebView.Coordinator()
        web.navigationDelegate = coordinator
        func html(_ marker: String) -> String {
            SessionDiffHTMLDocument.prepare("<html><head><style>.file{display:block}</style></head><body style='height:5000px'><details class='file' data-file-key='a' open><summary>a.swift</summary>file</details><details class='file' data-file-key='b' open><summary>b.swift</summary><div class='diffs-host'><template shadowrootmode='open'><pre style='width:200px;overflow:auto'><code style='display:block;width:1000px'>wide content</code></pre></template></div></details><div id='marker'>\(marker)</div></body></html>")
        }
        coordinator.load(html("first"), identity: "turn", into: web)
        try await waitForPage(web, marker: "first")
        _ = try await web.callAsyncJavaScript("document.querySelector('details').open = false; document.querySelector('.diffs-host').shadowRoot.querySelector('pre').scrollLeft = 77; window.scrollTo(0, 400); return true;", arguments: [:], in: nil, contentWorld: .defaultClient)
        coordinator.load(html("second"), identity: "turn", into: web)
        try await waitForPage(web, marker: "second")
        try? await Task.sleep(for: .milliseconds(100))
        let state = try await web.callAsyncJavaScript(SessionDiffWebView.Coordinator.captureState, arguments: [:], in: nil, contentWorld: .defaultClient) as? [String: Any]
        XCTAssertEqual((state?["files"] as? [[String: Any]])?.first?["open"] as? Bool, false)
        XCTAssertEqual((state?["y"] as? NSNumber)?.intValue, 400)
        let horizontal = (state?["files"] as? [[String: Any]])?[1]["scroll"] as? [NSNumber]
        XCTAssertEqual(horizontal?.first?.intValue, 77)
        coordinator.disclose(1, in: web)
        try? await Task.sleep(for: .milliseconds(50))
        let expanded = try await web.callAsyncJavaScript("return document.querySelector('details').open;", arguments: [:], in: nil, contentWorld: .defaultClient) as? Bool
        XCTAssertEqual(expanded, true)
        coordinator.filter("missing-file", in: web)
        try? await Task.sleep(for: .milliseconds(50))
        let hidden = try await web.callAsyncJavaScript("return getComputedStyle(document.querySelector('details')).display === 'none';", arguments: [:], in: nil, contentWorld: .defaultClient) as? Bool
        XCTAssertEqual(hidden, true)
        coordinator.filter("a", in: web)
        try? await Task.sleep(for: .milliseconds(50))
        let visible = try await web.callAsyncJavaScript("return !document.querySelector('details').hidden;", arguments: [:], in: nil, contentWorld: .defaultClient) as? Bool
        XCTAssertEqual(visible, true)
        XCTAssertFalse(web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
    }

    private func waitForPage(_ web: WKWebView, marker: String) async throws {
        for _ in 0..<100 {
            let value = try? await web.callAsyncJavaScript("return document.getElementById('marker')?.textContent;", arguments: [:], in: nil, contentWorld: .defaultClient) as? String
            if value == marker, !web.isLoading { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTFail("Web view did not load")
    }
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Expected renderer state")
    }
}

private final class PreviewFetcher: SessionDiffPreviewFetching, SessionDiffFetching, @unchecked Sendable {
    func fetch(sessionId: String, diffId: String, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse {
        SessionDiffHTMLResponse(id: diffId, html: "<p>Saved changes</p>")
    }
    private let lock = NSLock()
    private var pending: [Int: CheckedContinuation<SessionDiffHTMLResponse, Error>] = [:]
    func preview(sessionId: String, diff: LiveTurnDiff, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse {
        try await withCheckedThrowingContinuation { c in lock.withLock { pending[diff.revision] = c } }
    }
    func has(_ revision: Int) -> Bool { lock.withLock { pending[revision] != nil } }
    func complete(_ revision: Int) {
        lock.withLock { pending.removeValue(forKey: revision) }?.resume(returning: SessionDiffHTMLResponse(id: "preview_test", html: "<p>revision-\(revision)</p>"))
    }
}

extension ChangesDrawerTests {
    func testRenderedDrawerPreview() async throws {
        guard let directory = ProcessInfo.processInfo.environment["OMNIKEY_DRAWER_PREVIEW"] else { return }
        for theme in ["dark", "light"] {
            let html = try String(contentsOfFile: directory + "/omnikey-drawer-\(theme).html", encoding: .utf8)
            let model = ChatModel(authToken: { nil })
            var saved = SavedSessionDiff(id: "preview-saved", fileCount: 2, repositoryCount: 1, createdAt: "now")
            saved.additions = 4; saved.deletions = 2
            let patch = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1,2 @@\n-old\n+new\n+added\n"
            var message = ChatMessage.assistant()
            message.blocks = [ChatBlock(kind: .sessionDiff, text: "", liveDiff: LiveTurnDiff(turnID: "turn", revision: 1, status: "running", repositories: [GitDiffRepositoryPatch(root: "/Projects/Example", patch: patch, baseline: GitTurnBaseline(root: "/Projects/Example", head: nil, capturedAt: "now", source: .turnStart), head: nil)], coverage: []))]
            model.messages = [message]; model.isRunning = true
            let content = HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Preferences update").font(.headline)
                    Spacer().frame(height: 24)
                    Text("Update the preferences and document the new view.").foregroundStyle(.secondary)
                    SessionDiffCardView(diff: saved)
                    Text("Updated preferences and documentation. The changes are ready to review.").font(.callout)
                    Spacer()
                    Text("Adjusting the remaining preferences…").font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    TurnChangesPill(model: model).frame(maxWidth: .infinity, alignment: .trailing)
                    LandingInputComposer(model: model)
                }.padding(24).frame(width: 510)
                Divider()
                VStack(spacing: 0) {
                    ChangesDrawerHeader(files: 2, additions: 4, deletions: 2, isUpdating: false, layout: .constant(.unified), filter: .constant(""), expand: {}, collapse: {}, close: {})
                    Divider()
                    SessionDiffWebView(html: SessionDiffHTMLDocument.prepare(html), identity: theme)
                }.frame(width: 530)
            }.frame(width: 1041, height: 720)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, theme == "dark" ? .dark : .light)
            let host = NSHostingView(rootView: content)
            let window = NSWindow(contentRect: NSRect(x: -5000, y: 0, width: 1041, height: 720), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
            window.contentView = host
            window.orderFront(nil)
            defer { window.orderOut(nil) }
            host.layoutSubtreeIfNeeded()
            func webView(_ view: NSView) -> WKWebView? {
                if let web = view as? WKWebView { return web }
                return view.subviews.compactMap(webView).first
            }
            let web = try XCTUnwrap(webView(host))
            for _ in 0..<100 {
                let count = try? await web.callAsyncJavaScript("return document.querySelectorAll('details.file').length;", arguments: [:], in: nil, contentWorld: .defaultClient) as? Int
                if count == 2, !web.isLoading { break }
                try await Task.sleep(for: .milliseconds(30))
            }
            try await Task.sleep(for: .milliseconds(150))
            host.displayIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: directory + "/omnikey-drawer-\(theme).png"))
        }
    }
}
