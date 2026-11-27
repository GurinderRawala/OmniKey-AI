import AppKit
import Combine
import XCTest
@testable import OmniKeyAI

@MainActor
final class ChatComposerResponsivenessTests: XCTestCase {
    func testTypingDuringStreamingDoesNotPublishConversationChanges() throws {
        let suite = "ComposerTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var callbacks: ChatTurnCallbacks?
        let chat = ChatModel(modelDefaults: defaults, authToken: { nil }, startTurn: { _, incoming in
            callbacks = incoming
            return ChatSessionRunHandle()
        })
        chat.inputText = "Start"
        chat.sendCurrentInput()
        let hooks = try XCTUnwrap(callbacks)
        XCTAssertTrue(chat.isRunning)
        var conversationUpdates = 0
        var composerUpdates = 0
        let conversation = chat.objectWillChange.sink { conversationUpdates += 1 }
        let composer = chat.composerState.objectWillChange.sink { composerUpdates += 1 }
        defer { conversation.cancel(); composer.cancel(); chat.readingStore.flushDrafts() }
        for index in 0..<100 {
            hooks.onBlock(ChatBlock(kind: .agentReasoning, text: "Working \(index)"))
            let beforeTyping = conversationUpdates
            chat.inputText += "x"
            XCTAssertEqual(conversationUpdates, beforeTyping, "Typing must not invalidate the transcript")
            XCTAssertEqual(chat.readingStore.draft(for: chat.activeSessionId!).text, chat.inputText)
        }
        XCTAssertEqual(composerUpdates, 100)
        XCTAssertGreaterThan(conversationUpdates, 0, "Stream updates must still reach the conversation")
        XCTAssertTrue(chat.isRunning)
    }

    func testSwitchFlushesLatestDraftAndSelectionWithoutCrossChatWrites() throws {
        let suite = "ComposerTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let chat = ChatModel(modelDefaults: defaults)
        chat.activeSessionId = "a"
        chat.inputText = "Draft 📝"
        chat.readingStore.scheduleDraftSave(ChatDraft(text: chat.inputText, location: 6, length: 2), for: "a")
        XCTAssertNil(defaults.data(forKey: "chatDraft.a"), "Typing should not serialize immediately")
        chat.activeSessionId = "b"
        XCTAssertEqual(ChatReadingStore(defaults: defaults).draft(for: "a").selection, NSRange(location: 6, length: 2))
        chat.inputText = "Other draft"
        chat.activeSessionId = "a"
        XCTAssertEqual(chat.inputText, "Draft 📝")
        XCTAssertEqual(ChatReadingStore(defaults: defaults).draft(for: "b").text, "Other draft")
    }

    func testDebouncePersistsLatestValueAndDeletionCannotResurrectDraft() async throws {
        let suite = "ComposerTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.scheduleDraftSave(ChatDraft(text: "old"), for: "a")
        store.scheduleDraftSave(ChatDraft(text: "latest"), for: "a")
        store.scheduleDraftSave(ChatDraft(text: "deleted"), for: "b")
        store.removeSession("b")
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(ChatReadingStore(defaults: defaults).draft(for: "a").text, "latest")
        XCTAssertNil(defaults.data(forKey: "chatDraft.b"))
    }

    func testTerminationFlushesPendingDraft() throws {
        let suite = "ComposerTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ChatReadingStore(defaults: defaults)
        store.scheduleDraftSave(ChatDraft(text: "unsaved"), for: "a")
        NotificationCenter.default.post(name: NSApplication.willTerminateNotification, object: nil)
        XCTAssertEqual(ChatReadingStore(defaults: defaults).draft(for: "a").text, "unsaved")
    }

    func testSendClearsPersistedDraftImmediately() throws {
        let suite = "ComposerTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let chat = ChatModel(modelDefaults: defaults, authToken: { nil }, startTurn: { _, _ in ChatSessionRunHandle() })
        chat.activeSessionId = "a"
        chat.inputText = "Send me"
        chat.readingStore.flushDrafts()
        chat.sendCurrentInput()
        XCTAssertEqual(chat.inputText, "")
        XCTAssertEqual(ChatReadingStore(defaults: defaults).draft(for: "a").text, "")
    }

    func testScreenChangesPreserveNormalFramesAndFitOversizedFrames() {
        let screen = NSRect(x: 100, y: 30, width: 1200, height: 750)
        let straddling = NSRect(x: 900, y: 60, width: 800, height: 650)
        XCTAssertEqual(ChatWindowSizing.fittedFrame(straddling, in: screen), straddling)
        let oversized = NSRect(x: 900, y: -50, width: 1320, height: 900)
        let fitted = ChatWindowSizing.fittedFrame(oversized, in: screen)
        XCTAssertEqual(fitted, screen)
        XCTAssertEqual(ChatWindowSizing.fittedFrame(fitted, in: screen), fitted)
    }
}
