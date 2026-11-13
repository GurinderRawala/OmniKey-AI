import AppKit
import XCTest

@testable import OmniKeyAI

/// Pure AppKit checks of the code-scroller probe: it reacts to document /
/// clip geometry without any SwiftUI update, touches only its first
/// horizontal-only ancestor scroll view, restores the replaced policy when
/// the code fits again, and stops observing once detached.
final class ChatCodeScrollAffordanceTests: XCTestCase {
    private struct Fixture {
        let window: NSWindow
        let outer: NSScrollView
        let scroll: NSScrollView
        let document: NSView
        let probe: ChatCodeScrollAffordance.Probe
    }

    @MainActor
    private func makeFixture(documentWidth: CGFloat, viewportWidth: CGFloat = 300) -> Fixture {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 600, height: 400),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false

        // Outer vertical "transcript" scroll view that must never change.
        let outer = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        outer.hasVerticalScroller = true
        outer.hasHorizontalScroller = false
        outer.autohidesScrollers = true
        outer.scrollerStyle = .overlay
        let outerDocument = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 1200))
        outer.documentView = outerDocument

        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: viewportWidth, height: 80))
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        let document = NSView(frame: NSRect(x: 0, y: 0, width: documentWidth, height: 60))
        scroll.documentView = document
        outerDocument.addSubview(scroll)

        window.contentView = outer
        let probe = ChatCodeScrollAffordance.Probe(frame: document.bounds)
        document.addSubview(probe)
        settle()
        return Fixture(window: window, outer: outer, scroll: scroll, document: document, probe: probe)
    }

    @MainActor
    private func settle() {
        for _ in 0..<3 { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    }

    @MainActor
    func testNarrowContentKeepsOverlayPolicyAndOuterViewUntouched() {
        let f = makeFixture(documentWidth: 200)
        defer { f.window.close() }
        XCTAssertTrue(f.scroll.autohidesScrollers)
        XCTAssertEqual(f.scroll.scrollerStyle, .overlay)
        XCTAssertTrue(f.outer.autohidesScrollers)
        XCTAssertEqual(f.outer.scrollerStyle, .overlay)
    }

    @MainActor
    func testWideContentForcesVisibleScrollerOnFirstAncestorOnly() {
        let f = makeFixture(documentWidth: 900)
        defer { f.window.close() }
        XCTAssertFalse(f.scroll.autohidesScrollers)
        XCTAssertEqual(f.scroll.scrollerStyle, .legacy)
        XCTAssertTrue(f.outer.autohidesScrollers, "outer transcript must not change")
        XCTAssertEqual(f.outer.scrollerStyle, .overlay)
        XCTAssertEqual(f.scroll.contentView.bounds.minX, 0, "probe never scrolls")
    }

    @MainActor
    func testGeometryChangesReapplyAndRestoreWithoutSwiftUIUpdate() {
        let f = makeFixture(documentWidth: 200)
        defer { f.window.close() }

        // Document grows (e.g. content change) → overflow.
        f.document.setFrameSize(NSSize(width: 900, height: 60))
        settle()
        XCTAssertFalse(f.scroll.autohidesScrollers)
        XCTAssertEqual(f.scroll.scrollerStyle, .legacy)

        // Viewport widens past the document (window resize) → fits again,
        // the replaced policy is restored.
        f.scroll.setFrameSize(NSSize(width: 1000, height: 80))
        settle()
        XCTAssertTrue(f.scroll.autohidesScrollers)
        XCTAssertEqual(f.scroll.scrollerStyle, .overlay)

        // Viewport narrows again → overflow again.
        f.scroll.setFrameSize(NSSize(width: 300, height: 80))
        settle()
        XCTAssertFalse(f.scroll.autohidesScrollers)
        XCTAssertEqual(f.scroll.scrollerStyle, .legacy)
        XCTAssertEqual(f.scroll.contentView.bounds.minX, 0)
        XCTAssertTrue(f.outer.autohidesScrollers)
    }

    @MainActor
    func testDetachRestoresPolicyAndStopsObserving() {
        let f = makeFixture(documentWidth: 900)
        defer { f.window.close() }
        XCTAssertEqual(f.scroll.scrollerStyle, .legacy)

        f.probe.removeFromSuperview()
        settle()
        XCTAssertTrue(f.scroll.autohidesScrollers, "detached probe restores the policy it replaced")
        XCTAssertEqual(f.scroll.scrollerStyle, .overlay)

        // No observer left: later overflow changes are not acted on.
        f.document.setFrameSize(NSSize(width: 1200, height: 60))
        settle()
        XCTAssertTrue(f.scroll.autohidesScrollers)
        XCTAssertEqual(f.scroll.scrollerStyle, .overlay)
    }

    @MainActor
    func testObservingProbeHasNoRetainCycleAndLateGeometryIsSafe() {
        let f = makeFixture(documentWidth: 200)
        defer { f.window.close() }
        weak var weakProbe: ChatCodeScrollAffordance.Probe?
        autoreleasepool {
            let probe = ChatCodeScrollAffordance.Probe(frame: .zero)
            f.document.addSubview(probe)
            settle()
            weakProbe = probe
            // A pass is pending when the probe goes away.
            f.document.setFrameSize(NSSize(width: 900, height: 60))
            probe.removeFromSuperview()
        }
        settle()
        XCTAssertNil(weakProbe, "observers and pending passes must not retain the probe")
        // Geometry changes after release reach no stale observer.
        f.document.setFrameSize(NSSize(width: 100, height: 60))
        settle()
        XCTAssertTrue(f.scroll.autohidesScrollers)
    }

    @MainActor
    func testVerticalScrollViewIsNeverConfigured() {
        let f = makeFixture(documentWidth: 900)
        defer { f.window.close() }
        f.scroll.hasVerticalScroller = true
        f.probe.configureSoon()
        settle()
        // Leaving a qualifying scroll view restores its original policy.
        XCTAssertTrue(f.scroll.autohidesScrollers)
        XCTAssertEqual(f.scroll.scrollerStyle, .overlay)
    }
}
