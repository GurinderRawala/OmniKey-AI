import SwiftUI
import Textual
import XCTest

@testable import OmniKeyAI

final class CodeBlockLanguageLabelTests: XCTestCase {
    func testFallsBackToGenericLabelForMissingOrEmptyHint() {
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: nil), "code")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: ""), "code")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "   \n "), "code")
    }

    func testNormalisesCaseAndSurroundingWhitespace() {
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "  Swift "), "swift")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "JSON"), "json")
    }

    func testExpandsCommonAliases() {
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "sh"), "shell")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "ts"), "typescript")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "yml"), "yaml")
    }

    func testTreatsPlainTextAliasesAsGenericCode() {
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "plaintext"), "code")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "txt"), "code")
    }

    func testUsesOnlyTheLeadingTokenOfAnInfoString() {
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "swift title=\"Foo.swift\""), "swift")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "js,twoslash"), "javascript")
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "{python}"), "python")
    }

    func testPassesThroughUnknownLanguagesUnchanged() {
        XCTAssertEqual(CodeBlockLanguageLabel.display(for: "mermaid"), "mermaid")
    }
}

final class ChatCodeBlockViewTests: XCTestCase {
    /// A code block whose lines are far wider than the container must not
    /// stretch the block itself — the overflow has to be absorbed by the
    /// horizontal scroll view so the surrounding transcript keeps its width.
    @MainActor
    func testLongLinesDoNotWidenTheBlockBeyondItsContainer() {
        let width: CGFloat = 480
        let hosting = NSHostingView(
            rootView: ChatCodeBlockView(
                language: "swift",
                code: "let value = \"" + String(repeating: "x", count: 600) + "\"",
                baseFontSize: 13
            )
            .frame(width: width)
        )

        let fittingSize = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: fittingSize)
        hosting.layoutSubtreeIfNeeded()

        XCTAssertTrue(fittingSize.width.isFinite)
        XCTAssertTrue(fittingSize.height.isFinite)
        XCTAssertEqual(fittingSize.width, width, accuracy: 1)
        XCTAssertGreaterThan(fittingSize.height, 0)
    }

    /// The header adds a fixed strip above the code body, so a block with a
    /// single short line still has to reserve room for the language label
    /// and the copy button.
    @MainActor
    func testHeaderReservesHeightAboveTheCodeBody() {
        let hosting = NSHostingView(
            rootView: ChatCodeBlockView(language: nil, code: "ls -la", baseFontSize: 13)
                .frame(width: 480)
        )

        let fittingSize = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: fittingSize)
        hosting.layoutSubtreeIfNeeded()

        XCTAssertGreaterThan(fittingSize.height, 40)
        XCTAssertLessThan(fittingSize.height, 200)
    }

    /// The copy action writes the block's exact source — no highlighting
    /// artifacts, no trailing newline normalisation — as plain text.
    @MainActor
    func testCopyWritesTheExactCodeAsPlainText() {
        let pasteboard = NSPasteboard(name: .init("ChatCodeBlockTests.copy"))
        let code = "print(\"hello\")\n  indented\ttabbed"

        ChatCodeBlockPasteboard.write(code, to: pasteboard)

        XCTAssertEqual(pasteboard.string(forType: .string), code)
    }

    /// A second copy must replace the previous contents rather than append
    /// to them, which is what `clearContents()` guarantees.
    @MainActor
    func testRepeatedCopyReplacesPreviousPasteboardContents() {
        let pasteboard = NSPasteboard(name: .init("ChatCodeBlockTests.repeat"))

        ChatCodeBlockPasteboard.write("first", to: pasteboard)
        ChatCodeBlockPasteboard.write("second", to: pasteboard)

        XCTAssertEqual(pasteboard.string(forType: .string), "second")
    }
}

final class ChatStructuredTextStyleTests: XCTestCase {
    /// Regression: `.codeBlockStyle(.chat)` was applied outside
    /// `.structuredTextStyle(.gitHub)`, so the preset's bare code slab
    /// shadowed it and final answers rendered without the header or copy
    /// button. The chat chrome adds a header strip, so the rendered block
    /// must be measurably taller than the plain preset's.
    @MainActor
    func testFinalAnswerCodeBlocksUseTheChatChrome() {
        let markdown = "```swift\nlet value = 1\n```"

        let chat = Self.height(of: StructuredText(markdown: markdown).chatStructuredTextStyle())
        let preset = Self.height(of: StructuredText(markdown: markdown).textual.structuredTextStyle(.gitHub))

        XCTAssertGreaterThan(chat, preset + 15, "chat=\(chat) preset=\(preset)")
    }

    @MainActor
    private static func height(of view: some View) -> CGFloat {
        let host = NSHostingView(rootView: view.frame(width: 480))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 400),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.contentView = host
        for _ in 0..<3 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return host.fittingSize.height
    }
}

/// Drives real mouse events through a window at the copy button's
/// location. Layout-only tests can't catch hit-testing bugs such as
/// Textual's selection overlay swallowing clicks on the header.
final class ChatCodeBlockCopyClickTests: XCTestCase {
    private let code = "let marker = 42"

    @MainActor
    func testClickingCopyInFinalAnswerCodeBlockCopiesCode() {
        let pasteboard = privatePasteboard("final-answer")
        let view = StructuredText(markdown: "Intro\n\n```swift\n\(code)\n```\n")
            .chatStructuredTextStyle { _ in
                ChatCodeBlockPasteboard.write(self.code, to: pasteboard)
            }
            .textual.textSelection(.enabled)
        XCTAssertTrue(clickCopyButton(in: view, pasteboard: pasteboard).contains(code))
    }

    @MainActor
    func testClickingCopyInUserMessageCodeBlockCopiesCode() {
        let pasteboard = privatePasteboard("user-code-block")
        let view = ChatCodeBlockView(language: "swift", code: code)
            .chatCodeBlockPasteboard(pasteboard.name)
        XCTAssertTrue(clickCopyButton(in: view, pasteboard: pasteboard).contains(code))
    }

    @MainActor
    func testClickingCopyInsideUserBubbleCopiesCode() {
        let pasteboard = privatePasteboard("user-bubble")
        let view = UserBubbleView(text: "Run this:\n\n```swift\n\(code)\n```")
            .chatCodeBlockPasteboard(pasteboard.name)
        // The bubble's own footer "Copy message" button sits in the same
        // column, so only require that the code block's button copies the code.
        XCTAssertTrue(
            clickCopyButton(in: view, pasteboard: pasteboard, trailingInset: 17 + 14).contains(code)
        )
    }

    /// Clicks down the column where the header's copy button sits and
    /// returns every distinct value any click wrote to the pasteboard.
    @MainActor
    private func clickCopyButton(
        in view: some View,
        pasteboard: NSPasteboard,
        trailingInset: CGFloat = 17
    ) -> Set<String> {
        _ = NSApplication.shared
        let width: CGFloat = 480
        let host = NSHostingView(rootView: view.frame(width: width))
        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: width, height: 300),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.contentView = host
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        for _ in 0..<5 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }

        var copied: Set<String> = []
        // The copy button is 22pt wide with 6pt trailing padding; callers
        // add any padding their container puts around the code block.
        let x = width - trailingInset
        for offset in stride(from: 4.0, to: host.bounds.height, by: 4.0) {
            pasteboard.clearContents()
            let point = host.convert(NSPoint(x: x, y: host.bounds.height - offset), to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let event = NSEvent.mouseEvent(
                    with: type, location: point, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil,
                    eventNumber: 0, clickCount: 1, pressure: 1
                ) else { continue }
                NSApp.sendEvent(event)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            if let value = pasteboard.string(forType: .string) { copied.insert(value) }
        }
        return copied
    }

    private func privatePasteboard(_ suffix: String) -> NSPasteboard {
        NSPasteboard(name: .init("ChatCodeBlockCopyClickTests.\(suffix).\(UUID().uuidString)"))
    }
}
