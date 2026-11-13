import AppKit
import SwiftUI
import Testing
@testable import MarkdownEngine

@MainActor
struct CodeBlockSelectionSnapshotTests {
    private func editor(_ source: String) -> (NativeTextViewCoordinator, NativeTextView) {
        _ = NSApplication.shared
        let coordinator = NativeTextViewCoordinator(text: .constant(source), fontName: "SF Pro", fontSize: 16,
            isWikiLinkActive: .constant(false), onLinkClick: nil, onInlineSelectionChange: nil)
        let view = NativeTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        coordinator.textView = view
        coordinator.rebuildTextStorageAndStyle(view, from: source)
        return (coordinator, view)
    }

    @Test func queuedSelectionAfterSendClearsOldFenceTokens() {
        let fence = String(repeating: "`", count: 3)
        let source = fence + "text\nlong instruction body\n" + fence
        let (coordinator, view) = editor(source)
        let parsed = coordinator.parsedDocument(for: view.string)
        coordinator.cachedCodeBlockTokens = parsed.codeBlockTokensWithIndices
        #expect(!coordinator.cachedCodeBlockTokens.isEmpty)
        var count = -1
        coordinator.onCodeBlockSelectionChange = { count = $0.count }
        view.string = "" // send clears storage before a queued selection callback
        coordinator.updateCodeBlockSelection(textView: view)
        #expect(count == 0)
        #expect(coordinator.cachedCodeBlockTokens.isEmpty)
    }

    @Test func sameLengthReplacementDoesNotReuseOldParse() {
        let fence = String(repeating: "`", count: 3)
        let (coordinator, view) = editor(fence + "swift\nlet x = 1\n" + fence)
        let parsed = coordinator.parsedDocument(for: view.string)
        coordinator.cachedCodeBlockTokens = parsed.codeBlockTokensWithIndices
        coordinator.onCodeBlockSelectionChange = { _ in }
        view.string = String(repeating: "x", count: view.string.utf16.count)
        coordinator.updateCodeBlockSelection(textView: view)
        #expect(coordinator.cachedCodeBlockTokens.isEmpty)
    }

    @Test func invalidRangesNeverReachTextKitOrSubstring() {
        let (coordinator, view) = editor("small")
        var calls = 0
        coordinator.onCodeBlockSelectionChange = { selections in calls += 1; #expect(selections.isEmpty) }
        coordinator.cachedParsedText = view.string
        coordinator.cachedParsedLength = (view.string as NSString).length
        coordinator.cachedCodeBlockTokens = [(0, MarkdownToken(kind: .codeBlock,
            range: NSRange(location: 0, length: 999), contentRange: NSRange(location: 3, length: 990), markerRanges: []))]
        coordinator.updateCodeBlockSelection(textView: view)
        #expect(calls == 1)
    }

    @Test func noSubscriberSkipsOverlayWorkAndClearsCache() {
        let fence = String(repeating: "`", count: 3)
        let (coordinator, view) = editor(fence + "\nx\n" + fence)
        let parsed = coordinator.parsedDocument(for: view.string)
        coordinator.cachedCodeBlockTokens = parsed.codeBlockTokensWithIndices
        view.string = ""
        coordinator.updateCodeBlockSelection(textView: view)
        #expect(coordinator.cachedCodeBlockTokens.isEmpty)
    }
}
