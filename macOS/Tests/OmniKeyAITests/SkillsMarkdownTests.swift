import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

@MainActor
final class SkillsMarkdownTests: XCTestCase {
    func testSavedMarkdownRendersCodeBlockChromeWithoutChangingSource() {
        let source = "# Design rules\n\n**Important** instructions.\n\n```swift\nlet spacing = 8\n```"
        let preview = SkillInstructionsPreview(instructions: source)
        let host = NSHostingView(rootView: preview.frame(width: 500, height: 400))
        host.frame = NSRect(x: 0, y: 0, width: 500, height: 400)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        host.layoutSubtreeIfNeeded()
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        XCTAssertTrue(descendants(host).contains { $0.accessibilityIdentifier() == "chat-code-block-copy" },
                      "Saved fenced code must render through the actual Markdown/code-block renderer, not plain Text")
        XCTAssertEqual(preview.instructions, source)
        XCTAssertEqual(host.frame.width, 500, accuracy: 1)
        XCTAssertGreaterThan(host.frame.height, 50)
    }
}
