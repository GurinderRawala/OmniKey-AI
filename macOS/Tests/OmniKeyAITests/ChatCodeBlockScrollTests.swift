import AppKit
import SwiftUI
import Textual
import XCTest

@testable import OmniKeyAI

/// Measures the real AppKit geometry behind both markdown renderers' code
/// blocks (the NSScrollView SwiftUI creates for horizontal overflow) and what
/// a scroll-wheel event delivered to the hit-tested view actually moves.
///
/// Limitation: synthetic *phased* (trackpad) events are ignored by
/// NSScrollView outside a real gesture, even by the outer transcript, so only
/// non-phased wheel events (mouse wheel / shift-wheel) are asserted here.
final class ChatCodeBlockScrollTests: XCTestCase {
    private static let fence = String(repeating: "\u{0060}", count: 3)
    private static let longLine = "let value = \"" + String(repeating: "x", count: 400) + "\""
    private static let leadingFenceMessage =
        "\(fence)\nPlease follow these steps carefully " + String(repeating: "word ", count: 45)
        + "\n\nThen do this second instruction paragraph " + String(repeating: "more ", count: 30) + "\n\(fence)"

    private static var fixtures: [(String, AnyView)] {
        let f = fence
        return [
            ("code block", AnyView(ChatCodeBlockView(language: "swift", code: longLine))),
            ("bubble only code", AnyView(UserBubbleView(text: "\(f)\n\(longLine)\n\(f)"))),
            ("bubble leading fence", AnyView(UserBubbleView(text: leadingFenceMessage))),
            ("bubble mixed prose", AnyView(UserBubbleView(text: "Run this:\n\n\(f)sh\n\(longLine)\n\(f)\n\nThanks"))),
            ("bubble unclosed fence", AnyView(UserBubbleView(text: "\(f)\n\(longLine)\n\(f)\n\(f)"))),
            ("final answer", AnyView(FinalAnswerView(block: ChatBlock(kind: .finalAnswer,
                text: "Intro\n\n\(f)swift\n\(longLine)\n\(f)\n")))),
        ]
    }

    @MainActor
    func testShortCodeDoesNotForceLegacyScrollerOrClipItsLastLine() {
        let (host, window) = Self.host(ChatCodeBlockView(language: "swift", code: "let x = 1"), width: 500)
        defer { window.close() }
        let horizontal = Self.descendants(host).compactMap { $0 as? NSScrollView }.filter { $0.hasHorizontalScroller }
        XCTAssertFalse(horizontal.isEmpty)
        for scroll in horizontal {
            XCTAssertLessThanOrEqual(scroll.documentView?.frame.width ?? 0, scroll.contentView.bounds.width + 1)
            XCTAssertEqual(scroll.documentView?.frame.height ?? 0, scroll.contentView.bounds.height, accuracy: 1)
        }
        XCTAssertLessThan(host.fittingSize.height, 120)
    }

    @MainActor
    func testSameLineBackticksStayVisibleAsProseInsteadOfEmptyFence() {
        let text = Self.fence + "inline command" + Self.fence + " followed by instructions"
        let (host, window) = Self.host(UserBubbleView(text: text), width: 500)
        defer { window.close() }
        XCTAssertTrue(host.fittingSize.height.isFinite)
        XCTAssertTrue(Self.overflowing(in: host).isEmpty)
        let textValues = Self.descendants(host).compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: " ")
        XCTAssertTrue(textValues.contains("inline command"))
        XCTAssertTrue(textValues.contains("followed by instructions"))
    }

    @MainActor
    func testOverflowingCodeIsFiniteBoundedAndWheelScrollsTheClipView() {
        for (name, view) in Self.fixtures {
            for width: CGFloat in [695, 320] {
                let (host, window) = Self.host(view, width: width)
                defer { window.orderOut(nil) }
                let fitting = host.fittingSize
                XCTAssertTrue(fitting.height.isFinite && fitting.height > 0 && fitting.height < 400,
                              "\(name) @\(width): height \(fitting.height)")
                XCTAssertEqual(fitting.width, width, accuracy: 1, "\(name) @\(width) widened its container")

                let overflowing = Self.overflowing(in: host)
                XCTAssertEqual(overflowing.count, 1, "\(name) @\(width): one horizontally overflowing code body")
                for scroll in overflowing {
                    XCTAssertTrue(scroll.hasHorizontalScroller, "code needs a horizontal scrollbar")
                    XCTAssertFalse(scroll.autohidesScrollers, "code scrollbar remains discoverable")
                    XCTAssertEqual(scroll.scrollerStyle, .legacy)
                    XCTAssertLessThanOrEqual(scroll.frame.width, width, "\(name): viewport wider than container")
                    XCTAssertEqual(scroll.documentView?.frame.height ?? 0, scroll.contentView.bounds.height,
                                   accuracy: 1, "\(name): code body must not need vertical scrolling")
                    let moved = Self.deliverWheel(dx: -60, dy: 0, to: scroll, in: host)
                    XCTAssertEqual(moved.inner, 60, accuracy: 1, "\(name) @\(width): wheel did not scroll code")
                }
            }
        }
    }

    /// Inside the transcript: horizontal wheel over code moves only the code;
    /// vertical wheel over code must reach the transcript instead of being
    /// swallowed by the horizontal-only code scroller.
    @MainActor
    func testTranscriptRoutesHorizontalWheelToCodeAndVerticalWheelToTranscript() {
        let view = ScrollView {
            VStack(spacing: 18) {
                Color.clear.frame(height: 300)
                UserBubbleView(text: Self.leadingFenceMessage)
                FinalAnswerView(block: ChatBlock(kind: .finalAnswer,
                    text: "Intro\n\n\(Self.fence)swift\n\(Self.longLine)\n\(Self.fence)\n"))
                Color.clear.frame(height: 600)
            }
            .padding(.horizontal, 32)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        let (host, window) = Self.host(view, width: 900, height: 500)
        defer { window.orderOut(nil) }
        guard let outer = Self.descendants(host).compactMap({ $0 as? NSScrollView }).first else {
            return XCTFail("missing transcript scroll view")
        }
        outer.contentView.scroll(to: NSPoint(x: 0, y: 200))
        outer.reflectScrolledClipView(outer.contentView)
        Self.settle(host)

        let codeScrolls = Self.overflowing(in: host).filter { $0 !== outer }
        XCTAssertEqual(codeScrolls.count, 2, "user bubble + final answer code bodies")
        for scroll in codeScrolls {
            let horizontal = Self.deliverWheel(dx: -60, dy: 0, to: scroll, in: host, outer: outer)
            XCTAssertEqual(horizontal.inner, 60, accuracy: 1)
            XCTAssertEqual(horizontal.outer, 0, accuracy: 0.5)
            let vertical = Self.deliverWheel(dx: 0, dy: -60, to: scroll, in: host, outer: outer)
            XCTAssertEqual(vertical.inner, 0, accuracy: 0.5)
            XCTAssertNotEqual(vertical.outer, 0, "vertical wheel over code was swallowed")
        }
    }

    /// Drags the real NSScroller knob through `NSWindow.sendEvent` (the knob's
    /// own tracking loop consumes the queued drag/up events, as with a mouse),
    /// with SwiftUI updates landing mid-drag, inside a transcript hosted the way
    /// `ChatWindowController` hosts it. The far-end offset must then survive a
    /// SwiftUI update and a narrower window, and the end must stay reachable.
    @MainActor
    func testScrollerKnobDragReachesFarEndAndSurvivesUpdatesAndNarrowResize() {
        for (name, inner) in Self.fixtures {
            let tick = TranscriptTick()
            let controller = NSHostingController(rootView: TickingTranscript(tick: tick, inner: inner))
            controller.sizingOptions = []
            let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 900, height: 500),
                                  styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentViewController = controller
            window.setContentSize(NSSize(width: 900, height: 500))
            window.orderFront(nil)
            defer { window.orderOut(nil) }
            let host = controller.view
            Self.settle(host, passes: 8)
            guard let scroll = Self.overflowing(in: host).first(where: { !$0.hasVerticalScroller }),
                  let scroller = scroll.horizontalScroller else { XCTFail("\(name): no code scroller"); continue }
            func maxX() -> CGFloat { (scroll.documentView?.frame.width ?? 0) - scroll.contentView.bounds.width }

            Self.dragKnob(of: scroller, in: window, by: scroller.bounds.width, tick: tick)
            Self.settle(host)
            XCTAssertEqual(scroll.contentView.bounds.minX, maxX(), accuracy: 1, "\(name): knob drag did not reach the far end")

            tick.value += 1
            ChatModel.shared.objectWillChange.send()
            Self.settle(host)
            XCTAssertEqual(scroll.contentView.bounds.minX, maxX(), accuracy: 1, "\(name): update reset the offset")

            window.setContentSize(NSSize(width: 520, height: 500))
            Self.settle(host, passes: 6)
            XCTAssertTrue(Self.descendants(host).contains { $0 === scroll }, "\(name): code scroll view was rebuilt")
            XCTAssertGreaterThan(scroll.contentView.bounds.minX, 0, "\(name): narrow resize reset the offset")
            XCTAssertLessThanOrEqual(scroll.contentView.bounds.minX, maxX() + 1)
            Self.dragKnob(of: scroller, in: window, by: scroller.bounds.width, tick: tick)
            Self.settle(host)
            XCTAssertEqual(scroll.contentView.bounds.minX, maxX(), accuracy: 1, "\(name): far end unreachable after narrow resize")
        }
    }

    // MARK: - Harness

    @MainActor
    private static func host(_ view: some View, width: CGFloat, height: CGFloat = 400) -> (NSHostingView<AnyView>, NSWindow) {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: AnyView(view.frame(width: width)))
        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: width, height: height),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        settle(host, passes: 8)
        return (host, window)
    }

    @MainActor
    private static func settle(_ host: NSView, passes: Int = 4) {
        for _ in 0..<passes {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.04))
        }
    }

    private static func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    private static func overflowing(in host: NSView) -> [NSScrollView] {
        descendants(host).compactMap { $0 as? NSScrollView }.filter {
            ($0.documentView?.frame.width ?? 0) > $0.contentView.bounds.width + 1
        }
    }

    /// Routes like NSWindow does: hit-test the viewport centre and send the
    /// event to that view, letting the responder chain decide who scrolls.
    @MainActor
    private static func deliverWheel(
        dx: Int32, dy: Int32, to scroll: NSScrollView, in host: NSView, outer: NSScrollView? = nil
    ) -> (inner: CGFloat, outer: CGFloat) {
        let innerBefore = scroll.contentView.bounds.minX
        let outerBefore = outer?.contentView.bounds.minY ?? 0
        let point = scroll.convert(NSPoint(x: scroll.bounds.midX, y: scroll.bounds.midY), to: host.superview)
        let hit = host.hitTest(point)
        XCTAssertTrue(hit?.isDescendant(of: scroll) == true, "wheel target \(String(describing: hit)) outside code")
        if let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0),
           let event = NSEvent(cgEvent: cg) {
            hit?.scrollWheel(with: event)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        return (scroll.contentView.bounds.minX - innerBefore,
                (outer?.contentView.bounds.minY ?? 0) - outerBefore)
    }

    /// Real knob drag: mouse-down is dispatched by the window (hit-testing
    /// included); the scroller's tracking loop pulls drag/up events that a
    /// common-mode timer posts one at a time, publishing a SwiftUI update
    /// before each so re-renders interleave with tracking.
    @MainActor
    private static func dragKnob(of scroller: NSScroller, in window: NSWindow, by distance: CGFloat,
                                 tick: TranscriptTick) {
        let knob = scroller.rect(for: .knob)
        let start = scroller.convert(NSPoint(x: knob.midX, y: knob.midY), to: nil)
        let hit = window.contentView?.superview?.hitTest(window.contentView!.superview!.convert(start, from: nil))
        XCTAssertTrue(hit === scroller, "knob hit-tests to \(String(describing: hit)), not the scroller")
        func mouse(_ type: NSEvent.EventType, _ dx: CGFloat) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: NSPoint(x: start.x + dx, y: start.y), modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)!
        }
        let queue = EventQueue()
        queue.events = (1...10).map { mouse(.leftMouseDragged, distance * CGFloat($0) / 10) }
            + [mouse(.leftMouseUp, distance)]
        nonisolated(unsafe) let tickRef = tick
        let timer = Timer(timeInterval: 0.02, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard !queue.events.isEmpty else { return }
                tickRef.value += 1
                NSApp.postEvent(queue.events.removeFirst(), atStart: false)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        window.sendEvent(mouse(.leftMouseDown, 0))
        timer.invalidate()
    }
}

private final class EventQueue: @unchecked Sendable { var events: [NSEvent] = [] }

@MainActor
private final class TranscriptTick: ObservableObject { @Published var value = 0 }

/// Minimal transcript: outer vertical ScrollView whose body re-renders on
/// every tick, mirroring `conversationContent`'s layout constraints.
private struct TickingTranscript: View {
    @ObservedObject var tick: TranscriptTick
    let inner: AnyView
    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("revision \(tick.value)")
                inner
                Color.clear.frame(height: 600)
            }
            .padding(.horizontal, 32)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}
