import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

@MainActor
final class ChatReadingPositionTests: XCTestCase {
    final class FlippedView: NSView {
        override var isFlipped: Bool { true }
    }

    private func settle() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    }

    private func fixture() -> (NSScrollView, NSView, ChatReadingAnchorView) {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 300))
        let document = FlippedView(frame: NSRect(x: 0, y: 0, width: 600, height: 1500))
        let anchor = ChatReadingAnchorView(frame: NSRect(x: 0, y: 400, width: 600, height: 100))
        anchor.anchorID = "message-stable-id"
        document.addSubview(anchor)
        scroll.documentView = document
        return (scroll, document, anchor)
    }

    func testStreamingAndScriptGrowthNeverFollowBottomAndExplicitJumpDoes() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.save(ChatReadingPosition(anchorID: "message-stable-id", offset: 27), for: "a")
        let (scroll, document, _) = fixture()
        var below = false
        var configuration = ChatReadingViewport(session: "a", ready: true, jumpRequest: 0, store: store,
                                                onPosition: { below = $0 }, onMissingAnchor: { false })
        let coordinator = configuration.makeCoordinator()
        defer { coordinator.detach() }
        coordinator.configuration = configuration
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.minY, 427, accuracy: 1)
        // Repeated script/output updates used to start overlapping scroll animations.
        for update in 1...500 {
            document.setFrameSize(NSSize(width: 600, height: 1500 + update * 2))
            coordinator.attach(to: scroll)
        }
        settle()
        XCTAssertEqual(scroll.contentView.bounds.minY, 427, accuracy: 1)
        XCTAssertTrue(below)
        coordinator.attach(to: scroll)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 600))
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.minY, 600, accuracy: 1)
        configuration = ChatReadingViewport(session: "a", ready: true, jumpRequest: 1, store: store,
                                            onPosition: { below = $0 }, onMissingAnchor: { false })
        coordinator.configuration = configuration
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 1)
        XCTAssertFalse(below)
        document.setFrameSize(NSSize(width: 600, height: 2800))
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.maxY, 2500, accuracy: 1)
        XCTAssertTrue(below)
    }

    func testAnchorCompensatesForPrependingAndRestoresAcrossSessionsAndReload() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.save(ChatReadingPosition(anchorID: "message-stable-id", offset: 35), for: "a")
        let (scroll, document, anchor) = fixture()
        let coordinator = ChatReadingViewport.Coordinator()
        defer { coordinator.detach() }
        func configure(_ session: String, store: ChatReadingStore) {
            coordinator.configuration = ChatReadingViewport(session: session, ready: true, jumpRequest: 0,
                                                            store: store, onPosition: { _ in }, onMissingAnchor: { false })
            coordinator.attach(to: scroll)
            settle()
        }
        configure("a", store: store)
        anchor.setFrameOrigin(NSPoint(x: 0, y: 650))
        document.setFrameSize(NSSize(width: 600, height: 1750))
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.minY, 685, accuracy: 1)
        store.save(ChatReadingPosition(anchorID: "message-stable-id", offset: 90), for: "b")
        configure("b", store: store)
        XCTAssertEqual(scroll.contentView.bounds.minY, 740, accuracy: 1)
        configure("a", store: ChatReadingStore(defaults: defaults))
        XCTAssertEqual(scroll.contentView.bounds.minY, 685, accuracy: 1)
    }

    func testMissingAnchorWaitsForOlderPageWithoutOverwritingSavedPosition() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        let position = ChatReadingPosition(anchorID: "older-message", offset: 17)
        store.save(position, for: "a")
        let (scroll, document, _) = fixture()
        var loads = 0
        let coordinator = ChatReadingViewport.Coordinator()
        defer { coordinator.detach() }
        coordinator.configuration = ChatReadingViewport(session: "a", ready: true, jumpRequest: 0, store: store,
                                                        onPosition: { _ in }, onMissingAnchor: { loads += 1; return true })
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(store.position(for: "a"), position)
        let older = ChatReadingAnchorView(frame: NSRect(x: 0, y: 100, width: 600, height: 80))
        older.anchorID = "older-message"
        document.addSubview(older)
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.minY, 117, accuracy: 1)
    }

    func testDraftsAreScopedAndSurviveReloadWithUTF16SelectionClamping() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let chat = ChatModel(modelDefaults: defaults)
        chat.activeSessionId = "a"
        chat.inputText = "Draft 📝"
        chat.readingStore.save(ChatDraft(text: chat.inputText, location: 6, length: 2), for: "a")
        chat.activeSessionId = "b"
        XCTAssertEqual(chat.inputText, "")
        chat.inputText = "Other draft"
        chat.activeSessionId = "a"
        XCTAssertEqual(chat.inputText, "Draft 📝")
        let reopened = ChatModel(modelDefaults: defaults)
        reopened.activeSessionId = "a"
        XCTAssertEqual(reopened.inputText, "Draft 📝")
        XCTAssertEqual(reopened.readingStore.draft(for: "a").selection, NSRange(location: 6, length: 2))
        XCTAssertEqual(ChatDraft(text: "x", location: 999, length: 999).selection, NSRange(location: 1, length: 0))
    }
}

extension ChatReadingPositionTests {
    func testNativeSelectionRestoreDoesNotTakeFocus() {
        let session = "selection-test-\(UUID())"
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: "chatDraft.\(session)") }
        ChatReadingStore.shared.save(ChatDraft(text: "saved draft", location: 2, length: 4), for: session)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
        textView.string = "saved draft"
        textView.isSelectable = true
        textView.isEditable = true
        window.contentView?.addSubview(textView)
        window.makeFirstResponder(window)
        let originalResponder = window.firstResponder
        let tracker = ChatDraftSelectionTracker()
        defer { tracker.detach(); window.close() }
        settle()
        tracker.attach(textView, session: session)
        settle()
        XCTAssertEqual(textView.selectedRange(), NSRange(location: 2, length: 4))
        XCTAssertTrue(window.firstResponder === originalResponder)
        window.makeFirstResponder(textView)
        NotificationCenter.default.post(name: NSText.didBeginEditingNotification, object: textView)
        XCTAssertEqual(textView.selectedRange(), NSRange(location: 2, length: 4))
        textView.setSelectedRange(NSRange(location: 5, length: 0))
        NotificationCenter.default.post(name: NSTextView.didChangeSelectionNotification, object: textView)
        XCTAssertEqual(ChatReadingStore.shared.draft(for: session).selection, NSRange(location: 5, length: 0))
    }

    func testSwiftUIViewportDiscoversScrollViewAndPreservesPositionDuringLayout() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.save(ChatReadingPosition(anchorID: "message", offset: 20), for: "hosted")
        func content(height: CGFloat) -> some SwiftUI.View {
            SwiftUI.ScrollView {
                SwiftUI.VStack(spacing: 0) {
                    SwiftUI.Color.clear.frame(height: 400)
                    SwiftUI.Color.clear.frame(height: height)
                        .background(ChatReadingAnchor(id: "message"))
                }
                .background(ChatReadingViewport(session: "hosted", ready: true, jumpRequest: 0, store: store,
                                                onPosition: { _ in }, onMissingAnchor: { false }))
            }
        }
        let hosting = NSHostingView(rootView: content(height: 1000))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        settle()
        hosting.layoutSubtreeIfNeeded()
        settle()
        func scroll(in view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.compactMap { scroll(in: $0) }.first
        }
        guard let viewport = scroll(in: hosting) else { return XCTFail("Missing transcript scroll view") }
        XCTAssertEqual(viewport.contentView.bounds.minY, 420, accuracy: 2)
        for index in 0..<20 {
            hosting.rootView = content(height: CGFloat(1100 + index * 20))
            hosting.layoutSubtreeIfNeeded()
            settle()
        }
        XCTAssertEqual(viewport.contentView.bounds.minY, 420, accuracy: 2)
    }
}

extension ChatReadingPositionTests {
    func testCollapsedActivityFallsBackToItsMessageAnchor() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.save(ChatReadingPosition(anchorID: "activity-now-collapsed", offset: 10,
                                       fallbackAnchorID: "message-stable-id", fallbackOffset: 55), for: "a")
        let (scroll, _, _) = fixture()
        let coordinator = ChatReadingViewport.Coordinator()
        defer { coordinator.detach() }
        coordinator.configuration = ChatReadingViewport(session: "a", ready: true, jumpRequest: 0, store: store,
                                                        onPosition: { _ in }, onMissingAnchor: { XCTFail("No pagination needed"); return false })
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.minY, 455, accuracy: 1)
    }
}


extension ChatReadingPositionTests {
    func testUserScrollDuringHistoryLoadingWinsAndStillCompensatesForPrepending() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.save(ChatReadingPosition(anchorID: "message-stable-id", offset: 27), for: "a")
        let (scroll, document, anchor) = fixture()
        let coordinator = ChatReadingViewport.Coordinator()
        defer { coordinator.detach() }
        func configure(_ ready: Bool) {
            coordinator.configuration = ChatReadingViewport(session: "a", ready: ready, jumpRequest: 0,
                                                            store: store, onPosition: { _ in }, onMissingAnchor: { false })
            coordinator.attach(to: scroll)
            settle()
        }
        configure(true)
        XCTAssertEqual(scroll.contentView.bounds.minY, 427, accuracy: 1)
        configure(false)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 700))
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
        configure(true)
        XCTAssertEqual(scroll.contentView.bounds.minY, 700, accuracy: 1)
        XCTAssertEqual(store.position(for: "a")?.offset, 300)

        // Preserve the newly chosen content, not the old saved position, when older rows arrive.
        configure(false)
        anchor.setFrameOrigin(NSPoint(x: 0, y: 650))
        document.setFrameSize(NSSize(width: 600, height: 1750))
        configure(true)
        XCTAssertEqual(scroll.contentView.bounds.minY, 950, accuracy: 1)
    }
}


extension ChatReadingPositionTests {
    func testFailedRestorationPaginationPausesUntilExplicitRetry() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        let saved = ChatReadingPosition(anchorID: "older-message", offset: 17)
        store.save(saved, for: "a")
        let (scroll, document, _) = fixture()
        let coordinator = ChatReadingViewport.Coordinator()
        defer { coordinator.detach() }
        var requests = 0
        func configure(ready: Bool = true, failed: Bool = false) {
            coordinator.configuration = ChatReadingViewport(
                session: "a", ready: ready, restorationPaginationPaused: failed,
                jumpRequest: 0, store: store, onPosition: { _ in },
                onMissingAnchor: { requests += 1; return true })
            coordinator.attach(to: scroll)
            settle()
        }
        configure()
        XCTAssertEqual(requests, 1)
        configure(ready: false)
        // Request completion exposes an error while more history is still available.
        for _ in 0..<10 { configure(failed: true) }
        XCTAssertEqual(requests, 1, "Layout/streaming updates must not retry failed pagination")
        XCTAssertEqual(store.position(for: "a"), saved)
        // Explicit retry clears the error and enters loading, without an automatic duplicate.
        requests += 1
        configure(ready: false)
        let older = ChatReadingAnchorView(frame: NSRect(x: 0, y: 100, width: 600, height: 80))
        older.anchorID = "older-message"
        document.addSubview(older)
        configure()
        XCTAssertEqual(requests, 2)
        XCTAssertEqual(scroll.contentView.bounds.minY, 117, accuracy: 1)
    }
}

extension ChatReadingPositionTests {
    func testSessionDeletionRemovesDraftAndReadingPositionOnlyForDeletedSession() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        for session in ["deleted", "kept"] {
            store.save(ChatDraft(text: "private draft", location: 3, length: 2), for: session)
            store.save(ChatReadingPosition(anchorID: "server:message", offset: 10), for: session)
        }
        store.removeSession("deleted")
        XCTAssertNil(defaults.data(forKey: "chatDraft.deleted"))
        XCTAssertNil(store.position(for: "deleted"))
        XCTAssertEqual(store.draft(for: "kept").text, "private draft")
        XCTAssertNotNil(store.position(for: "kept"))
    }

    func testReadingIdentitySurvivesLocalToServerHydrationAndPrepending() {
        let local = [ChatMessage.user("same prompt", id: "local:message:u"),
                     ChatMessage.assistant(id: "local:message:a")]
        let hydrated = [ChatMessage.user("same prompt", id: "server:u"),
                        ChatMessage.assistant(id: "server:a")]
        let localIDs = ChatReadingIdentity.anchors(for: local)
        let hydratedIDs = ChatReadingIdentity.anchors(for: hydrated)
        XCTAssertEqual(localIDs["local:message:u"], hydratedIDs["server:u"])
        XCTAssertEqual(localIDs["local:message:a"], hydratedIDs["server:a"])
        let older = [ChatMessage.user("same prompt", id: "server:older-u"),
                     ChatMessage.assistant(id: "server:older-a")]
        let prependedIDs = ChatReadingIdentity.anchors(for: older + hydrated)
        XCTAssertEqual(hydratedIDs["server:u"], prependedIDs["server:u"])
        XCTAssertEqual(hydratedIDs["server:a"], prependedIDs["server:a"])
        XCTAssertNotEqual(prependedIDs["server:older-u"], prependedIDs["server:u"])
    }

    func testMissingAnchorPaginationIsBoundedAndFallsBackToLatest() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.save(ChatReadingPosition(anchorID: "local:message:expired", offset: 27), for: "a")
        let (scroll, document, _) = fixture()
        let coordinator = ChatReadingViewport.Coordinator()
        defer { coordinator.detach() }
        var requests = 0
        coordinator.configuration = ChatReadingViewport(session: "a", ready: true, jumpRequest: 0, store: store,
                                                        onPosition: { _ in }, onMissingAnchor: { requests += 1; return true })
        for _ in 0..<10 {
            coordinator.attach(to: scroll)
            settle()
        }
        XCTAssertEqual(requests, ChatReadingViewport.Coordinator.maximumRestorationPages)
        XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 1)
    }

    func testExhaustedHistoryFallsBackToLatestInsteadOfTop() {
        let suite = "ChatReadingTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.save(ChatReadingPosition(anchorID: "deleted-message", offset: 10), for: "a")
        let (scroll, document, _) = fixture()
        let coordinator = ChatReadingViewport.Coordinator()
        defer { coordinator.detach() }
        coordinator.configuration = ChatReadingViewport(session: "a", ready: true, jumpRequest: 0, store: store,
                                                        onPosition: { _ in }, onMissingAnchor: { false })
        coordinator.attach(to: scroll)
        settle()
        XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 1)
    }
}
