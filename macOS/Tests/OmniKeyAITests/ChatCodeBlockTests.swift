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

/// Click the actual control centre, not a sweep of unrelated points. Also
/// enforce that Textual copy controls live outside its inner scroll regions:
/// XCTest alone does not reproduce its running-app hover interception.
final class ChatCodeBlockCopyClickTests: XCTestCase {
    private let code = "let marker = 42"

    private func markdown(_ source: String) -> String {
        let fence = String(repeating: "\u{0060}", count: 3)
        return "\(fence)swift\n\(source)\n\(fence)\n"
    }

    @MainActor
    func testClickingCopyInFinalAnswerCodeBlockCopiesCode() {
        let view = StructuredText(markdown: "Intro\n\n" + markdown(code))
            .chatStructuredTextStyle()
            .textual.textSelection(.enabled)
        XCTAssertEqual(clickCopyButtons(in: view, count: 1), [code])
    }

    @MainActor
    func testClickingCopyInScrolledFinalAnswerCopiesCode() {
        let block = ChatBlock(kind: .finalAnswer, text: "Intro\n\n" + markdown(code))
        let view = ScrollView {
            VStack(spacing: 20) {
                Color.clear.frame(height: 600)
                FinalAnswerView(block: block)
            }
        }
        .defaultScrollAnchor(.bottom)
        XCTAssertEqual(clickCopyButtons(in: view, count: 1, transcriptHeight: 300), [code])
    }

    @MainActor
    func testMultipleCodeBlocksRetainTheirOwnCopyActions() {
        let second = "print(\"second\")\n  indented\ttabbed"
        let view = StructuredText(markdown: markdown(code) + "\nBetween blocks\n\n" + markdown(second))
            .chatStructuredTextStyle()
            .textual.textSelection(.enabled)
        XCTAssertEqual(clickCopyButtons(in: view, count: 2), [code, second])
    }

    @MainActor
    func testCopyControlStaysFixedWhenCodeScrollsHorizontally() {
        let source = "let value = \"" + String(repeating: "x", count: 600) + "\""
        let view = StructuredText(markdown: markdown(source))
            .chatStructuredTextStyle()
            .textual.textSelection(.enabled)
        XCTAssertEqual(clickCopyButtons(in: view, count: 1, scrollCodeHorizontally: true), [source])
    }

    @MainActor
    func testClickingCopyInUserMessageCodeBlockCopiesCode() {
        XCTAssertEqual(clickCopyButtons(in: ChatCodeBlockView(language: "swift", code: code), count: 1), [code])
    }

    @MainActor
    func testClickingCopyInsideUserBubbleCopiesOnlyCode() {
        let view = UserBubbleView(text: "Run this:\n\n" + markdown(code))
        XCTAssertEqual(clickCopyButtons(in: view, count: 1), [code])
    }

    @MainActor
    func testBothRenderersCopyInLongTranscript() {
        let assistant = ChatBlock(kind: .finalAnswer, text:
            String(repeating: "Paragraph before code.\n\n", count: 40) + markdown(code))
        let userCode = "let userMarker = 43"
        let view = ScrollView {
            VStack(spacing: 18) {
                FinalAnswerView(block: assistant)
                UserBubbleView(text: markdown(userCode))
            }
            .padding(.horizontal, 32)
        }
        .defaultScrollAnchor(.bottom)
        XCTAssertEqual(clickCopyButtons(in: view, count: 2, transcriptHeight: 300), [code, userCode])
    }

    @MainActor
    private func clickCopyButtons(
        in view: some View, count: Int, transcriptHeight: CGFloat? = nil,
        scrollCodeHorizontally: Bool = false
    ) -> Set<String> {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view.frame(width: 695))
        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 695, height: 300),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.contentView = host
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        for _ in 0..<10 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }

        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap { descendants($0) }
        }
        let buttons = descendants(host).compactMap { $0 as? NSButton }
            .filter { $0.accessibilityIdentifier() == "chat-code-block-copy" }
        XCTAssertEqual(buttons.count, count)

        if scrollCodeHorizontally {
            let frames = buttons.map { $0.convert($0.bounds, to: host) }
            let overflowing = descendants(host).compactMap { $0 as? NSScrollView }.filter {
                ($0.documentView?.bounds.width ?? 0) > $0.contentView.bounds.width + 1
            }
            XCTAssertFalse(overflowing.isEmpty, "Fixture must contain horizontally overflowing code")
            for scroll in overflowing {
                scroll.contentView.scroll(to: NSPoint(x: 80, y: scroll.contentView.bounds.minY))
                scroll.reflectScrolledClipView(scroll.contentView)
            }
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            XCTAssertEqual(buttons.map { $0.convert($0.bounds, to: host) }, frames,
                "Horizontal code scrolling must not move the copy controls")
        }

        // Textual's proxy writes both plain text and HTML to the general
        // pasteboard. Preserve all pre-existing types/items, not only text.
        let pasteboard = NSPasteboard.general
        let savedItems = (pasteboard.pasteboardItems ?? []).map { item in
            let saved = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { saved.setData(data, forType: type) }
            }
            return saved
        }
        var lastOwnedChange = pasteboard.changeCount
        defer {
            if pasteboard.changeCount == lastOwnedChange {
                pasteboard.clearContents()
                if !savedItems.isEmpty { pasteboard.writeObjects(savedItems) }
            }
        }

        var copied: Set<String> = []
        for button in buttons {
            if let transcriptHeight {
                // A nested header/body Overflow is not an acceptable home
                // for the control even if synthetic XCTest clicks pass.
                XCTAssertGreaterThan(button.enclosingScrollView?.documentView?.bounds.height ?? 0,
                    transcriptHeight, "Copy control must be above Textual's internal scroll/selection layers")
            } else {
                XCTAssertNil(button.enclosingScrollView,
                    "Standalone code-copy control must not be nested in Textual's Overflow")
            }
            let centre = NSPoint(x: button.bounds.midX, y: button.bounds.midY)
            XCTAssertTrue(button.visibleRect.contains(centre), "Copy control must be visible")
            let parentPoint = button.convert(centre, to: host.superview)
            let hit = host.hitTest(parentPoint)
            XCTAssertTrue(hit === button || hit?.isDescendant(of: button) == true,
                "Button centre hit \(String(describing: hit)) instead")

            pasteboard.clearContents()
            let location = button.convert(centre, to: nil)
            let up = NSEvent.mouseEvent(
                with: .leftMouseUp, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: 0)!
            let down = NSEvent.mouseEvent(
                with: .leftMouseDown, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            // NSButton tracks synchronously until mouse-up; enqueue it first.
            NSApp.postEvent(up, atStart: true)
            window.sendEvent(down)
            lastOwnedChange = pasteboard.changeCount
            if let value = pasteboard.string(forType: .string) { copied.insert(value) }
        }
        return copied
    }
}
