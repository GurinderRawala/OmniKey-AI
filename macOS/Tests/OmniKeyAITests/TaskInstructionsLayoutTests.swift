import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

@MainActor
final class TaskInstructionsLayoutTests: XCTestCase {
    private func textView(in view: NSView) -> NSTextView? {
        if let textView = view as? NSTextView { return textView }
        return view.subviews.lazy.compactMap { self.textView(in: $0) }.first
    }

    private func settle(_ view: NSView) {
        view.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        view.layoutSubtreeIfNeeded()
    }

    func testWindowSupportsResizingAndNativeFullScreen() throws {
        let controller = TaskInstructionsWindowController(loadTemplatesOnAppear: false)
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        XCTAssertTrue(window.styleMask.contains(.resizable))
        XCTAssertTrue(window.collectionBehavior.contains(.fullScreenPrimary))
        XCTAssertEqual(window.contentMinSize, NSSize(width: 900, height: 640))
        XCTAssertTrue(try XCTUnwrap(window.standardWindowButton(.zoomButton)).isEnabled)
    }

    func testEditorUsesFullWidthAndGrowsWithWindow() throws {
        let host = NSHostingView(rootView: TaskInstructionsView(loadTemplatesOnAppear: false))
        host.frame = NSRect(x: 0, y: 0, width: 1200, height: 820)
        settle(host)
        let editor = try XCTUnwrap(textView(in: host))
        let scroll = try XCTUnwrap(editor.enclosingScrollView)
        let initialWidth = scroll.frame.width
        XCTAssertGreaterThan(initialWidth, 1080)

        host.frame = NSRect(x: 0, y: 0, width: 1600, height: 1000)
        settle(host)
        XCTAssertGreaterThan(scroll.frame.width, 1480)
        XCTAssertEqual(scroll.frame.width - initialWidth, 400, accuracy: 2)
    }
}
