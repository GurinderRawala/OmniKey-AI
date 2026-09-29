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
