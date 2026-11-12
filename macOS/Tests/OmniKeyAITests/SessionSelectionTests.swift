import AppKit
import Foundation
import SwiftUI
import XCTest

@testable import OmniKeyAI

/// Drives the real `ChatModel` transitions (new chat → selection changes →
/// first send → next new chat / resume) with an injected, manually
/// completed selection service, an isolated UserDefaults suite, no auth
/// token (so nothing reaches the network) and a recording turn starter.
@MainActor
final class SessionSelectionTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!
    private var service: FakeSelectionService!
    private var requests: [ChatTurnRequest] = []
    private var token: String? = nil

    override func setUp() async throws {
        suite = "SessionSelectionTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        service = FakeSelectionService()
        requests = []
        // No token by default so history/session calls never reach the
        // network; tests that exercise the injected fake service opt in.
        token = nil
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private func makeChat() -> ChatModel {
        ChatModel(
            modelDefaults: defaults,
            selectionService: service,
            authToken: { [unowned self] in self.token },
            startTurn: { [unowned self] request, _ in
                self.requests.append(request)
                return ChatSessionRunHandle()
            }
        )
    }

    private func settle() async { for _ in 0..<8 { await Task.yield() } }

    private let alpha = APIClient.TaskTemplateDTO(id: "a", heading: "Alpha review", instructions: "Review every diff carefully.", isDefault: true)
    private let beta = APIClient.TaskTemplateDTO(id: "b", heading: "Beta writer", instructions: "Write docs.", isDefault: false)
    private let groupG = AgentGroupInfo(groupName: "Gamma project", groupDescription: "g")
    private let groupH = AgentGroupInfo(groupName: "Hotel project", groupDescription: "h")

    private func session(_ id: String, group: String?, heading: String?, taskID: String? = nil) -> AgentSessionInfo {
        AgentSessionInfo(
            id: id, title: id, isPinned: false, platform: "macos", turns: 1, totalTokensUsed: 0,
            remainingContextTokens: 0, contextBudget: 0, groupName: group, groupDescription: nil,
            taskInstructionId: taskID, taskInstructionHeading: heading, lastActiveAt: "2026-11-12T00:00:00Z")
    }

    private func loadTemplates(_ chat: ChatModel, _ templates: [APIClient.TaskTemplateDTO]) async {
        token = "fake-service-token"
        chat.fetchDefaultTaskTemplate()
        service.completeTemplates(.success(templates))
        await settle()
    }

    // MARK: Task instructions

    func testNewChatKeepsCachedTaskDefaultAndStaleFetchCannotClobberUserChoice() async {
        let chat = makeChat()
        await loadTemplates(chat, [alpha, beta])
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Alpha review")

        chat.startNewChat()
        // Refresh in flight: the cached default stays visible (no "No instruction" flash).
        XCTAssertEqual(service.templateFetches.compactMap { $0 }.count, 1)
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Alpha review")
        XCTAssertTrue(chat.displayedTaskInstructionHelp.contains("Review every diff carefully."))

        chat.setDefaultTaskTemplate(id: "b")
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Beta writer")
        // The refresh started before the change now lands with the old default.
        service.completeTemplates(.success([alpha, beta]))
        await settle()
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Beta writer", "stale fetch must not clobber the choice")
        service.completeSetDefault(.success(APIClient.TaskTemplateDTO(id: "b", heading: "Beta writer", instructions: "Write docs.", isDefault: true)))
        await settle()
        XCTAssertEqual(chat.defaultTaskTemplate?.id, "b")

        chat.inputText = "hello"
        chat.sendCurrentInput()
        XCTAssertFalse(chat.canChangeSessionSetup)
        XCTAssertEqual(chat.activeSession?.taskInstructionHeading, "Beta writer")
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Beta writer")
        XCTAssertTrue(chat.displayedTaskInstructionHelp.contains("Locked to this session"))

        // Locked: a default change is ignored and does not reach the server.
        chat.setDefaultTaskTemplate(id: "a")
        XCTAssertEqual(service.setDefaultCalls, ["b"])
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Beta writer")
    }

    func testFirstSendWaitsForTaskSelectionSaveAndPreservesDraft() async {
        let chat = makeChat()
        await loadTemplates(chat, [alpha, beta])
        chat.setDefaultTaskTemplate(id: "b")
        chat.inputText = "draft waits"
        chat.sendCurrentInput()
        XCTAssertTrue(requests.isEmpty)
        XCTAssertEqual(chat.inputText, "draft waits")
        XCTAssertNil(chat.activeSessionId)
        service.completeSetDefault(.success(APIClient.TaskTemplateDTO(id: "b", heading: "Beta writer", instructions: "Write docs.", isDefault: true)))
        await settle()
        chat.sendCurrentInput()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(chat.activeSession?.taskInstructionHeading, "Beta writer")
    }

    func testOutOfOrderAndFailedTemplateFetchesKeepNewestSelection() async {
        let chat = makeChat()
        token = "fake-service-token"
        chat.fetchDefaultTaskTemplate()   // #1 (slow)
        chat.fetchDefaultTaskTemplate()   // #2
        service.completeTemplate(at: 1, .success([beta.asDefault]))
        await settle()
        service.completeTemplate(at: 0, .success([alpha]))
        await settle()
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Beta writer")

        chat.fetchDefaultTaskTemplate()
        service.completeTemplates(.failure(URLError(.timedOut)))
        await settle()
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Beta writer", "a transient failure keeps the cache")
        XCTAssertEqual(chat.availableTaskTemplates.map(\.id), ["b"])
    }

    func testFailedDefaultChangeRollsBack() async {
        let chat = makeChat()
        await loadTemplates(chat, [alpha, beta])
        chat.setDefaultTaskTemplate(id: "b")
        service.completeSetDefault(.failure(URLError(.notConnectedToInternet)))
        await settle()
        XCTAssertEqual(chat.displayedTaskInstructionTitle, "Alpha review")
        XCTAssertNotNil(chat.lastErrorMessage)
    }

    // MARK: Project

    func testProjectIsHonoredImmediatelyLockedAndNeverLeaksIntoOtherSessions() async {
        let chat = makeChat()
        chat.startNewChat(in: groupG)
        XCTAssertEqual(chat.displayedProjectName, "Gamma project")
        XCTAssertTrue(chat.displayedProjectHelp.contains("applies when this chat starts"))

        chat.inputText = "first"
        chat.sendCurrentInput()
        let created = try! XCTUnwrap(chat.activeSessionId)
        XCTAssertEqual(requests.last, ChatTurnRequest(sessionId: created, userText: "first", groupName: "Gamma project", model: nil))
        XCTAssertEqual(chat.displayedProjectName, "Gamma project")
        XCTAssertTrue(chat.displayedProjectHelp.contains("locked"))

        // Another existing session must show and send ITS project, not the
        // pending chat's leftover `selectedGroup`.
        let other = session("other", group: "Hotel project", heading: nil)
        let ungrouped = session("ungrouped", group: nil, heading: nil)
        chat.sessions.append(contentsOf: [other, ungrouped])
        chat.openSession(other)
        XCTAssertEqual(chat.displayedProjectName, "Hotel project")
        XCTAssertEqual(chat.turnRequest(sessionId: "other", text: "x", isNewSession: false).groupName, "Hotel project")
        chat.openSession(ungrouped)
        XCTAssertEqual(chat.displayedProjectName, "No project")
        XCTAssertNil(chat.turnRequest(sessionId: "ungrouped", text: "x", isNewSession: false).groupName)
    }

    func testNewChatResetsSetupButResumesAnUnsentDraft() async {
        let chat = makeChat()
        chat.applyAgentModelOptions(provider: "anthropic", model: "claude-opus-4-7", options: [])
        chat.startNewChat()
        chat.selectedGroup = groupH
        chat.setAgentModel("claude-sonnet-4-5-20250929")
        chat.inputText = "half-written idea"

        let existing = session("existing", group: "Gamma project", heading: nil)
        chat.sessions.append(existing)
        chat.openSession(existing)
        XCTAssertEqual(chat.displayedProjectName, "Gamma project")
        XCTAssertEqual(chat.activeAgentModel, "claude-opus-4-7", "existing session uses its own model")

        chat.startNewChat()   // resume the pending draft
        XCTAssertEqual(chat.inputText, "half-written idea")
        XCTAssertEqual(chat.displayedProjectName, "Hotel project")
        XCTAssertEqual(chat.activeAgentModel, "claude-sonnet-4-5-20250929")
        XCTAssertEqual(chat.activeAgentModelLabel, "Claude Sonnet 4.5 (20250929)")

        // An explicit sidebar group wins immediately, even over a draft.
        chat.startNewChat(in: groupG)
        XCTAssertEqual(chat.displayedProjectName, "Gamma project")

        chat.inputText = ""
        chat.startNewChat()   // deliberate reset
        XCTAssertEqual(chat.displayedProjectName, "Select project")
        XCTAssertEqual(chat.activeAgentModel, "claude-opus-4-7")
    }

    // MARK: Model

    func testModelLabelIsHonestBeforeSettingsAndDelayedSettingsDoNotOverwriteChoice() async {
        let chat = makeChat()
        XCTAssertEqual(chat.activeAgentModelLabel, "Server default model", "no fake GPT label before load")
        chat.inputText = "early"
        chat.sendCurrentInput()
        XCTAssertNil(requests.last?.model, "server picks its configured model until settings load")

        chat.startNewChat()
        token = "fake-service-token"
        chat.fetchAgentModelOptions()   // #1 (slow, stale)
        chat.fetchAgentModelOptions()   // #2
        service.completeProviders(at: 1, .success(.fake(provider: "anthropic", model: "claude-opus-4-7",
            options: [.init(id: "claude-opus-4-7", label: "Claude Opus 4.7")])))
        await settle()
        service.completeProviders(at: 0, .success(.fake(provider: "openai", model: "gpt-5.5", options: [])))
        await settle()
        XCTAssertEqual(chat.activeAIProvider, "anthropic")
        XCTAssertEqual(chat.activeAgentModelLabel, "Claude Opus 4.7")

        chat.setAgentModel("claude-fable-5-2")
        XCTAssertEqual(chat.activeAgentModelLabel, "Claude Fable 5.2")
        // A later settings refresh with a different default keeps the pending choice.
        chat.fetchAgentModelOptions()
        service.completeProviders(at: 2, .success(.fake(provider: "anthropic", model: "claude-sonnet-5", options: [])))
        await settle()
        XCTAssertEqual(chat.activeAgentModel, "claude-fable-5-2")
        chat.fetchAgentModelOptions()
        service.completeProviders(at: 3, .failure(URLError(.timedOut)))
        await settle()
        XCTAssertEqual(chat.activeAgentModel, "claude-fable-5-2")

        chat.inputText = "go"
        chat.sendCurrentInput()
        XCTAssertEqual(requests.last?.model, "claude-fable-5-2")
        XCTAssertEqual(chat.activeAgentModelLabel, "Claude Fable 5.2")
        XCTAssertTrue(chat.agentModelHelp.contains("claude-fable-5-2"))
    }

    func testModelDisplayNamesKeepVersions() {
        XCTAssertEqual(ModelDisplayName.label(for: "claude-opus-4-7"), "Claude Opus 4.7")
        XCTAssertEqual(ModelDisplayName.label(for: "claude-opus-5-5"), "Claude Opus 5.5")
        XCTAssertEqual(ModelDisplayName.label(for: "claude-sonnet-4-5-20250929"), "Claude Sonnet 4.5 (20250929)")
        XCTAssertEqual(ModelDisplayName.label(for: "gemini-2.5-pro"), "Gemini 2.5 Pro")
        XCTAssertEqual(ModelDisplayName.label(for: "gpt-5.5"), "GPT 5.5")
        XCTAssertEqual(ModelDisplayName.label(for: "nvidia/nemotron-3-nano-30b-a3b"), "nvidia/nemotron-3-nano-30b-a3b")
        XCTAssertEqual(ModelDisplayName.label(for: "my-org/custom-model"), "my-org/custom-model")
    }

    // MARK: Native layout

    func testNarrowComposerShowsLabelsAndKeepsSendReachable() async {
        let chat = makeChat()
        await loadTemplates(chat, [APIClient.TaskTemplateDTO(
            id: "long", heading: String(repeating: "Very long task instruction heading ", count: 4),
            instructions: "x", isDefault: true)])
        chat.applyAgentModelOptions(provider: "anthropic", model: "claude-sonnet-4-5-20250929-extended-preview-build", options: [])
        chat.startNewChat(in: AgentGroupInfo(groupName: String(repeating: "Project ", count: 12), groupDescription: nil))

        for width: CGFloat in [356, 420, 592, 700, 1100] {
            let send = NSView()
            let host = NSHostingView(rootView:
                ComposerSelectionToolbar(model: chat, width: width) {
                    Color.red.frame(width: 32, height: 32).background(ProbeView(view: send))
                }
                .padding(.horizontal, 10)
                .frame(width: width, alignment: .leading)
            )
            host.frame = NSRect(x: 0, y: 0, width: width, height: 120)
            host.layoutSubtreeIfNeeded()
            func popups(_ view: NSView) -> [NSPopUpButton] {
                if let popup = view as? NSPopUpButton { return [popup] }
                return view.subviews.flatMap(popups)
            }
            let menus = popups(host)
            XCTAssertEqual(menus.count, 3, "all selectors must be present")
            let frames = menus.map { $0.convert($0.bounds, to: host) }
            if let first = frames.first {
                for frame in frames {
                    XCTAssertEqual(frame.midY, first.midY, accuracy: 1, "all selectors must share a row")
                    XCTAssertGreaterThanOrEqual(frame.minX, 0)
                    XCTAssertLessThanOrEqual(frame.maxX, width + 0.5)
                }
            }
            let ideal = NSHostingView(rootView:
                ComposerSelectionToolbar(model: chat, width: width) { Color.red.frame(width: 32, height: 32) }
                    .padding(.horizontal, 10)
            )
            XCTAssertLessThanOrEqual(ideal.fittingSize.width, width + 0.5, "toolbar overflows at \(width)")
            let frame = send.convert(send.bounds, to: host)
            XCTAssertGreaterThan(frame.width, 0)
            XCTAssertLessThanOrEqual(frame.maxX, width + 0.5, "Send/Stop pushed off-screen at \(width)")
            XCTAssertGreaterThanOrEqual(frame.minX, 0)
        }

        let narrow = ComposerToolbarLayout.titleWidths(width: 420)
        XCTAssertGreaterThanOrEqual(narrow.task, ComposerToolbarLayout.minimumTitleWidth, "labels stay visible when narrow")
        XCTAssertGreaterThanOrEqual(narrow.model, ComposerToolbarLayout.minimumTitleWidth)
        let fitted = PillTitle.fitted(chat.displayedTaskInstructionTitle, maxWidth: narrow.task)
        XCTAssertTrue(!fitted.isEmpty && fitted.contains("…"), "narrow pill keeps a readable heading: \(fitted)")
        let model = PillTitle.fitted(chat.activeAgentModelLabel, maxWidth: narrow.model)
        XCTAssertFalse(model.isEmpty, "model pill remains named: \(model)")
        XCTAssertEqual(PillTitle.fitted("Short", maxWidth: 80), "Short")
    }
}

// MARK: - Fakes

private struct ProbeView: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

private extension APIClient.TaskTemplateDTO {
    var asDefault: Self { .init(id: id, heading: heading, instructions: instructions, isDefault: true) }
}

private extension APIClient.AIProviderListResponse {
    static func fake(provider: String, model: String, options: [APIClient.AgentModelOptionDTO]) -> Self {
        .init(providers: [], activeProvider: provider, activeModel: model, modelOptions: options,
              supportsCustomModel: true, runtimeProvider: provider)
    }
}

private final class FakeSelectionService: ChatSelectionService, @unchecked Sendable {
    typealias TemplatesCompletion = @Sendable (Result<[APIClient.TaskTemplateDTO], Error>) -> Void
    typealias ProvidersCompletion = @Sendable (Result<APIClient.AIProviderListResponse, Error>) -> Void
    var templateFetches: [TemplatesCompletion?] = []
    var providerFetches: [ProvidersCompletion?] = []
    var setDefaultCalls: [String] = []
    private var setDefaultCompletion: (@Sendable (Result<APIClient.TaskTemplateDTO, Error>) -> Void)?

    func fetchTaskTemplates(completion: @escaping TemplatesCompletion) { templateFetches.append(completion) }
    func setDefaultTaskTemplate(id: String, completion: @escaping @Sendable (Result<APIClient.TaskTemplateDTO, Error>) -> Void) {
        setDefaultCalls.append(id)
        setDefaultCompletion = completion
    }
    func clearDefaultTaskTemplate(completion: @escaping @Sendable (Result<Void, Error>) -> Void) {}
    func fetchAIProviders(completion: @escaping ProvidersCompletion) { providerFetches.append(completion) }

    /// Completes the oldest still-pending template fetch.
    func completeTemplates(_ result: Result<[APIClient.TaskTemplateDTO], Error>) {
        guard let index = templateFetches.firstIndex(where: { $0 != nil }) else { return XCTFail("no pending fetch") }
        completeTemplate(at: index, result)
    }
    func completeTemplate(at index: Int, _ result: Result<[APIClient.TaskTemplateDTO], Error>) {
        let completion = templateFetches[index]
        templateFetches[index] = nil
        completion?(result)
    }
    func completeProviders(at index: Int, _ result: Result<APIClient.AIProviderListResponse, Error>) {
        let completion = providerFetches[index]
        providerFetches[index] = nil
        completion?(result)
    }
    func completeSetDefault(_ result: Result<APIClient.TaskTemplateDTO, Error>) {
        setDefaultCompletion?(result)
        setDefaultCompletion = nil
    }
}
