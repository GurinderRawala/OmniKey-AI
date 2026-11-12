import AppKit
import SwiftUI
import XCTest

@testable import OmniKeyAI

@MainActor
final class SessionDiffLayoutTests: XCTestCase {
    func testBannerFillsAvailableMessageColumn() {
        let diff = SavedSessionDiff(id: "d1", fileCount: 2, repositoryCount: 1, createdAt: "t")
        for width: CGFloat in [360, 700] {
            let probe = NSView()
            let host = NSHostingView(rootView:
                VStack(alignment: .leading) {
                    SessionDiffCardView(diff: diff).background(WidthProbe(view: probe))
                    Text("Final answer").frame(maxWidth: .infinity, alignment: .leading)
                }.frame(width: width)
            )
            host.frame = NSRect(x: 0, y: 0, width: width, height: 160)
            host.layoutSubtreeIfNeeded()
            XCTAssertEqual(probe.frame.width, width, accuracy: 1, "card should share the final answer column")
        }
    }

    func testSameSnapshotLayoutAndAppearanceChangesRejectLateResults() async {
        let fetcher = LayoutFetcher()
        let model = SessionDiffInspectorModel(fetcher: fetcher)
        let selection = SessionDiffSelection(sessionId: "s", diff: SavedSessionDiff(id: "d", fileCount: 1, repositoryCount: 1, createdAt: "t"))
        model.load(selection, theme: .dark, layout: .unified)
        await waitFor { fetcher.has("dark:unified") }
        model.load(selection, theme: .dark, layout: .split)
        await waitFor { fetcher.has("dark:split") }
        model.load(selection, theme: .light, layout: .split)
        await waitFor { fetcher.has("light:split") }
        fetcher.complete("dark:unified")
        fetcher.complete("dark:split")
        fetcher.complete("light:split")
        await waitFor { if case .loaded = model.phase { return true }; return false }
        guard case let .loaded(html) = model.phase else { return XCTFail("no result") }
        XCTAssertTrue(html.contains("light:split"))
        XCTAssertFalse(html.contains("dark:unified"))
        XCTAssertFalse(html.contains("dark:split"))
    }

    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("expected condition not reached")
    }
}

private struct WidthProbe: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

private final class LayoutFetcher: SessionDiffFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [String: CheckedContinuation<SessionDiffHTMLResponse, Error>] = [:]
    func fetch(sessionId: String, diffId: String, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock { pending["\(theme.rawValue):\(layout.rawValue)"] = continuation }
        }
    }
    func has(_ key: String) -> Bool { lock.withLock { pending[key] != nil } }
    func complete(_ key: String) {
        let continuation = lock.withLock { pending.removeValue(forKey: key) }
        continuation?.resume(returning: SessionDiffHTMLResponse(id: "d", html: "<p>\(key)</p>"))
    }
}
