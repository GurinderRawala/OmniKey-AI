import Foundation
import XCTest

@testable import OmniKeyAI

final class ChatSessionModelTests: XCTestCase {
    @MainActor
    func testLoadingSettingsDoesNotPinThePlaceholderModel() {
        let suite = "ChatSessionModelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let chat = ChatModel(modelDefaults: defaults)
        XCTAssertNil(chat.modelForCurrentTurn)
        chat.migratePendingSessionModel(to: "created-before-settings")
        chat.activeSessionId = "created-before-settings"
        chat.applyAgentModelOptions(provider: "anthropic", model: "claude-default", options: [])
        XCTAssertEqual(chat.modelForCurrentTurn, "claude-default")
    }

    @MainActor
    func testModelSelectionIsScopedToSessionAndProviderAndSurvivesRelaunch() {
        let suite = "ChatSessionModelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let chat = ChatModel(modelDefaults: defaults)
        func select(_ session: String, provider: String = "openai", defaultModel: String = "default") {
            chat.activeSessionId = session
            chat.applyAgentModelOptions(provider: provider, model: defaultModel, options: [])
        }
        select("a")
        chat.setAgentModel("model-a")
        select("b")
        XCTAssertEqual(chat.activeAgentModel, "default")
        chat.setAgentModel("model-b")
        select("a", defaultModel: "changed-global-default")
        XCTAssertEqual(chat.activeAgentModel, "model-a")
        select("a", provider: "anthropic", defaultModel: "claude-default")
        XCTAssertEqual(chat.activeAgentModel, "claude-default")
        chat.setAgentModel("claude-custom")
        select("a")
        XCTAssertEqual(chat.activeAgentModel, "model-a")
        select("b")
        XCTAssertEqual(chat.activeAgentModel, "model-b")
        let reopened = ChatModel(modelDefaults: defaults)
        reopened.activeSessionId = "a"
        reopened.applyAgentModelOptions(provider: "anthropic", model: "other", options: [])
        XCTAssertEqual(reopened.activeAgentModel, "claude-custom")
    }

    @MainActor
    func testNewChatChoiceMigratesToCreatedSessionWithoutChangingDefault() {
        let suite = "ChatSessionModelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let chat = ChatModel(modelDefaults: defaults)
        chat.applyAgentModelOptions(provider: "openai", model: "default", options: [])
        chat.setAgentModel("chosen-before-send")
        XCTAssertTrue((defaults.dictionary(forKey: "chatSessionModels") ?? [:]).isEmpty)
        chat.migratePendingSessionModel(to: "created")
        chat.activeSessionId = "created"
        chat.applyAgentModelOptions(provider: "openai", model: "default", options: [])
        XCTAssertEqual(chat.activeAgentModel, "chosen-before-send")
        chat.activeSessionId = nil
        chat.applyAgentModelOptions(provider: "openai", model: "default", options: [])
        XCTAssertEqual(chat.activeAgentModel, "default")
        let reopened = ChatModel(modelDefaults: defaults)
        reopened.activeSessionId = "created"
        reopened.applyAgentModelOptions(provider: "openai", model: "default", options: [])
        XCTAssertEqual(reopened.activeAgentModel, "chosen-before-send")
    }
}
