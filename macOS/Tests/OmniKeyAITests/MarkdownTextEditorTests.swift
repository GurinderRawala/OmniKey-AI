import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

@MainActor
final class MarkdownTextEditorTests: XCTestCase {
    private final class Document {
        var text: String
        init(_ text: String) { self.text = text }
    }

    private func findTextView(in view: NSView) -> NSTextView? {
        if let textView = view as? NSTextView { return textView }
        return view.subviews.lazy.compactMap { self.findTextView(in: $0) }.first
    }

    private func settle() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.08))
    }

    func testDocumentEditorPreservesMarkdownAndAllowsNewlines() throws {
        let source = "# Instructions\n\n- **Keep formatting**\n\n```swift\nlet value = 1\n```"
        let document = Document(source)
        let editor = MarkdownTextEditor(
            text: Binding(get: { document.text }, set: { document.text = $0 }),
            sessionKey: "task-template-test",
            colorScheme: .light,
            editorLabel: "Task instructions"
        )
        XCTAssertNil(editor.onSend)
        XCTAssertFalse(editor.onRecallHistory())
        let host = NSHostingView(rootView: editor)
        host.frame = NSRect(x: 0, y: 0, width: 600, height: 280)
        host.layoutSubtreeIfNeeded()
        settle()
        let textView = try XCTUnwrap(findTextView(in: host))
        XCTAssertEqual(textView.string, source)
        XCTAssertEqual(document.text, source)
        XCTAssertTrue(textView.isEditable)
        XCTAssertFalse(textView.drawsBackground)
        textView.setSelectedRange(NSRange(location: (source as NSString).length, length: 0))
        textView.insertText("\nAnother paragraph", replacementRange: textView.selectedRange())
        settle()
        XCTAssertEqual(document.text, source + "\nAnother paragraph")
    }

    func testSwitchingDocumentsLoadsTheNewMarkdownSource() throws {
        let first = Document("# First\n\n**Task instructions**")
        let second = Document("## Scheduled job\n\n| Name | Value |\n| --- | --- |\n| A | B |")
        func editor(_ document: Document, key: String) -> MarkdownTextEditor {
            MarkdownTextEditor(
                text: Binding(get: { document.text }, set: { document.text = $0 }),
                sessionKey: key,
                colorScheme: .dark
            )
        }
        let host = NSHostingView(rootView: editor(first, key: "first"))
        host.frame = NSRect(x: 0, y: 0, width: 600, height: 280)
        host.layoutSubtreeIfNeeded()
        settle()
        XCTAssertEqual(try XCTUnwrap(findTextView(in: host)).string, first.text)
        host.rootView = editor(second, key: "second")
        host.layoutSubtreeIfNeeded()
        settle()
        XCTAssertEqual(try XCTUnwrap(findTextView(in: host)).string, second.text)
        XCTAssertEqual(first.text, "# First\n\n**Task instructions**")
    }

    /// Repro attempt for "a message starting with a code fence breaks the
    /// app": type a leading fence + long instruction paragraph + closing fence
    /// keystroke-by-keystroke into the real MarkdownEngine editor, then clear
    /// the binding exactly as sending does.
    func testTypingLeadingFenceThenClearingAfterSendResetsComposer() throws {
        let fence = String(repeating: "\u{0060}", count: 3)
        let document = Document("")
        func editor() -> MarkdownTextEditor {
            MarkdownTextEditor(
                text: Binding(get: { document.text }, set: { document.text = $0 }),
                sessionKey: "chat", isFocused: .constant(true), colorScheme: .dark, onSend: {})
        }
        let host = NSHostingView(rootView: editor())
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 280),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        settle()
        let textView = try XCTUnwrap(findTextView(in: host))
        window.makeFirstResponder(textView)
        let paragraph = "Please review the following instructions and " + String(repeating: "follow them carefully ", count: 10)
        let typed = fence + "\n" + paragraph + "\n\nSecond paragraph.\n" + fence
        for character in typed {
            textView.insertText(String(character), replacementRange: textView.selectedRange())
        }
        settle()
        // Chat prompts must retain exactly what was typed, with no extra
        // auto-generated closing fence after sending.
        XCTAssertEqual(document.text, typed)
        XCTAssertEqual(textView.string, document.text)

        document.text = ""
        host.rootView = editor()
        host.layoutSubtreeIfNeeded()
        settle()
        XCTAssertEqual(textView.string, "")
        XCTAssertEqual(document.text, "")
        textView.insertText("next", replacementRange: textView.selectedRange())
        settle()
        XCTAssertEqual(document.text, "next")
    }

    func testEditorLookupSkipsNeighboringTextFieldEditor() {
        let container = NSView()
        let fieldEditor = NSTextView()
        fieldEditor.isFieldEditor = true
        let markdownEditor = NSTextView()
        container.addSubview(fieldEditor)
        container.addSubview(markdownEditor)
        let introspector = MarkdownEditorIntrospector(onResolve: { _ in })
        XCTAssertTrue(introspector.findTextView(in: container) === markdownEditor)
    }

    func testChatStillOptsIntoSendAndHistoryCallbacks() {
        var sends = 0
        var recalls = 0
        let editor = MarkdownTextEditor(
            text: .constant(""), sessionKey: "chat", isFocused: .constant(true),
            colorScheme: .light,
            onSend: { sends += 1 },
            onRecallHistory: { recalls += 1; return true }
        )
        editor.onSend?()
        XCTAssertTrue(editor.onRecallHistory())
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(recalls, 1)
    }
}
