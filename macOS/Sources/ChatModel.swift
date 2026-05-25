import Combine
import Foundation

// MARK: - Chat message model

enum ChatMessageRole: String {
    case user
    case assistant
    case system
}

/// Kind of an assistant content block. The agent stream can interleave
/// "thinking" content (agent reasoning, terminal output, web calls, MCP
/// calls, image rendering) with a single final answer. Each block becomes
/// one `ChatBlock` so the view can group the thinking blocks into one
/// collapsible section and render the final block as markdown.
enum ChatBlockKind {
    case agentReasoning
    case shellCommand
    case terminalOutput
    case webCall
    case mcpCall
    case imageRendering
    case finalAnswer
}

struct ChatBlock: Identifiable, Equatable {
    let id = UUID()
    let kind: ChatBlockKind
    var text: String

    static func == (lhs: ChatBlock, rhs: ChatBlock) -> Bool {
        return lhs.id == rhs.id && lhs.text == rhs.text
    }
}

struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: ChatMessageRole
    /// User messages keep their content in `text`. Assistant messages
    /// use `blocks` for streamed agent output. System messages use `text`.
    var text: String
    var blocks: [ChatBlock]

    static func == (lhs: ChatMessage, rhs: ChatMessage) -> Bool {
        return lhs.id == rhs.id && lhs.role == rhs.role && lhs.text == rhs.text && lhs.blocks == rhs.blocks
    }

    static func user(_ text: String) -> ChatMessage {
        ChatMessage(role: .user, text: text, blocks: [])
    }

    static func assistant() -> ChatMessage {
        ChatMessage(role: .assistant, text: "", blocks: [])
    }

    static func system(_ text: String) -> ChatMessage {
        ChatMessage(role: .system, text: text, blocks: [])
    }
}

// MARK: - Chat model

@MainActor
final class ChatModel: ObservableObject {
    static let shared = ChatModel()

    /// Existing OmniAgent sessions (reused from the same backend
    /// endpoint as `AgentThinkingModel`).
    @Published var sessions: [AgentSessionInfo] = []

    /// Free-text query used to filter the sidebar session list. The
    /// backend stores each session's `title` as the first ~60 characters
    /// of the very first user message in the thread, so filtering on
    /// `title` is equivalent to searching by "first user message" —
    /// without any extra network round-trips. Whitespace-trimmed,
    /// case- and diacritic-insensitive matching is applied in
    /// `filteredSessions`.
    @Published var sessionSearchQuery: String = ""

    /// The session the user is currently chatting in.
    /// `nil` means a brand-new session that has not been persisted yet —
    /// the backend will assign an ID on first turn.
    @Published var activeSessionId: String? = nil
    @Published var activeSessionTitle: String = "New Chat"

    /// Messages rendered in the conversation view.
    @Published var messages: [ChatMessage] = []

    /// True while an existing session transcript is being hydrated.
    @Published var isLoadingSessionHistory: Bool = false

    /// True while a turn is in flight (WebSocket open, awaiting final answer).
    @Published var isRunning: Bool = false

    /// Surfaced to the view when something goes wrong outside the
    /// per-turn assistant flow (e.g. session list refresh failure).
    @Published var lastErrorMessage: String? = nil

    /// The text in the bottom input box. Bound from the view.
    @Published var inputText: String = ""

    /// The user's default task instruction template, if any. Surfaced
    /// in the dropdown beneath the chat input so the user can see which
    /// base prompt the agent is being primed with — and switch to a
    /// different saved instruction without leaving the chat page.
    @Published var defaultTaskTemplate: APIClient.TaskTemplateDTO? = nil

    /// All saved task instruction templates for the current user. Drives
    /// the dropdown below the chat input. Empty until
    /// `fetchDefaultTaskTemplate` resolves.
    @Published var availableTaskTemplates: [APIClient.TaskTemplateDTO] = []

    /// True while a default-template change is being persisted to the
    /// backend. The dropdown is disabled while this is in flight to
    /// avoid stacked POSTs from impatient clicks.
    @Published var isUpdatingDefaultTaskTemplate: Bool = false

    /// Shared APIClient used for ancillary chat-page fetches (task
    /// instruction template list + default-template mutations).
    private let apiClient = APIClient()

    /// The session metadata for the currently-active chat, if it has
    /// been hydrated into `sessions` yet. Used to drive the context
    /// window indicator under the input bar.
    var activeSession: AgentSessionInfo? {
        guard let id = activeSessionId else { return nil }
        return sessions.first { $0.id == id }
    }

    /// Sessions filtered by `sessionSearchQuery`. When the query is
    /// empty (or only whitespace) the full session list is returned
    /// unchanged. Otherwise each space-separated token in the query
    /// must appear (case- and diacritic-insensitive) somewhere in the
    /// session's `title` for the session to be included — this matches
    /// the user expectation of a "find as you type" filter where typing
    /// additional words narrows the result set.
    var filteredSessions: [AgentSessionInfo] {
        let query = sessionSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return sessions }

        let tokens = query
            .lowercased()
            .folding(options: .diacriticInsensitive, locale: .current)
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        guard !tokens.isEmpty else { return sessions }

        return sessions.filter { session in
            let haystack = session.title
                .lowercased()
                .folding(options: .diacriticInsensitive, locale: .current)
            return tokens.allSatisfy { haystack.contains($0) }
        }
    }

    /// True when the user has typed something into the sidebar search
    /// field. Used by the view to switch between the "No chats yet"
    /// empty state and the "No matches" empty state.
    var isSessionSearchActive: Bool {
        !sessionSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Clears the sidebar search query. Exposed so the view can wire
    /// this to the clear button and the Escape key.
    func clearSessionSearch() {
        sessionSearchQuery = ""
    }

    private init() {}

    /// Maximum number of messages kept in `messages` at any time.
    /// Older messages are trimmed off the front of the array to keep
    /// the SwiftUI view from rebuilding an arbitrarily large tree on
    /// every input keystroke or stream block (which was causing input
    /// lag in long chats). The trimmed history is still persisted on
    /// the backend and re-hydrated when the user re-opens the session.
    static let maxVisibleMessages: Int = 30

    /// Number of older messages that have been trimmed from the
    /// visible window for the current session. Surfaced to the view
    /// so it can render a "Showing last N messages" hint at the top
    /// of the feed.
    @Published var trimmedOlderMessageCount: Int = 0

    /// Trim `messages` down to `maxVisibleMessages` by dropping the
    /// oldest entries. No-op when already within the cap.
    private func enforceMessageCap() {
        let overflow = messages.count - Self.maxVisibleMessages
        guard overflow > 0 else { return }
        messages.removeFirst(overflow)
        trimmedOlderMessageCount += overflow
    }

    // MARK: - Session list

    /// Fetch the current user's existing sessions.
    func refreshSessions(completion: (@Sendable () -> Void)? = nil) {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else {
            completion?()
            return
        }
        let url = APIClient.baseURL.appendingPathComponent("api/agent/sessions")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data else {
                DispatchQueue.main.async { completion?() }
                return
            }
            let decoder = JSONDecoder()
            if let list = try? decoder.decode([AgentSessionInfo].self, from: data) {
                DispatchQueue.main.async {
                    self.sessions = list
                    completion?()
                }
            } else {
                DispatchQueue.main.async { completion?() }
            }
        }.resume()
    }

    /// Start a brand-new chat (clears the messages area, doesn't touch the backend).
    func startNewChat() {
        // Cancel any in-flight turn so its socket doesn't bleed into the new chat.
        if isRunning {
            AgentRunner.shared.cancelCurrentSession()
        }
        activeSessionId = nil
        activeSessionTitle = "New Chat"
        messages = []
        trimmedOlderMessageCount = 0
        lastErrorMessage = nil
        isLoadingSessionHistory = false
        isRunning = false
        // The default task instruction can have been re-assigned between
        // chats, so refresh the footer chip every time the user lands on
        // a fresh chat. Clear it synchronously first to avoid a stale
        // value flashing while the network round-trip is in flight.
        defaultTaskTemplate = nil
        fetchDefaultTaskTemplate()
    }

    /// Switch to an existing session and load its prior turns from the backend.
    func openSession(_ session: AgentSessionInfo) {
        if isRunning {
            AgentRunner.shared.cancelCurrentSession()
        }
        activeSessionId = session.id
        activeSessionTitle = session.title
        messages = []
        trimmedOlderMessageCount = 0
        lastErrorMessage = nil
        isLoadingSessionHistory = true
        isRunning = false
        // Refresh the default-task-instruction chip when switching chats.
        // The backend bakes the default template into the session's
        // system prompt at creation time and there is no per-session
        // endpoint to recover which template was used, so we surface the
        // user's *current* configured default — i.e. what would be used
        // for any further turns the user submits — which is the most
        // useful forward-looking indicator. Clear synchronously so a
        // stale value doesn't briefly flash for the other session.
        defaultTaskTemplate = nil
        fetchDefaultTaskTemplate()
        loadSessionHistory(sessionId: session.id)
    }

    /// Fetch the compact message transcript for the given session and
    /// hydrate `messages`.
    private func loadSessionHistory(sessionId: String) {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else {
            isLoadingSessionHistory = false
            lastErrorMessage = "Sign in to load this chat history."
            return
        }
        let url = APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("messages")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data else {
                DispatchQueue.main.async {
                    guard self?.activeSessionId == sessionId else { return }
                    self?.isLoadingSessionHistory = false
                }
                return
            }
            struct Response: Decodable { let messages: [SessionHistoryEntry] }
            guard let body = try? JSONDecoder().decode(Response.self, from: data) else {
                DispatchQueue.main.async {
                    guard self.activeSessionId == sessionId else { return }
                    self.isLoadingSessionHistory = false
                    self.lastErrorMessage = "Couldn't load this chat history."
                }
                return
            }
            DispatchQueue.main.async {
                guard self.activeSessionId == sessionId else {
                    return
                }
                let hydrated = ChatModel.hydrateTranscript(from: body.messages)
                let overflow = max(0, hydrated.count - ChatModel.maxVisibleMessages)
                self.trimmedOlderMessageCount = overflow
                self.messages = overflow > 0 ? Array(hydrated.suffix(ChatModel.maxVisibleMessages)) : hydrated
                self.isLoadingSessionHistory = false
            }
        }.resume()
    }

    /// The persisted agent history contains intermediate assistant messages
    /// as well as final answers. For chat resume, render each turn as a clean
    /// user message plus the last useful assistant response.
    private static func hydrateTranscript(from entries: [SessionHistoryEntry]) -> [ChatMessage] {
        if entries.contains(where: { ($0.blocks ?? []).isEmpty == false }) {
            return entries.compactMap { entry in
                if entry.role == "user" {
                    return ChatMessage.user(entry.text)
                }

                guard entry.role == "assistant" else { return nil }
                var message = ChatMessage.assistant()
                message.blocks = (entry.blocks ?? []).compactMap { block in
                    guard let kind = ChatModel.blockKind(from: block.kind) else { return nil }
                    return ChatBlock(kind: kind, text: block.text)
                }
                return message.blocks.isEmpty ? nil : message
            }
        }

        var result: [ChatMessage] = []
        var pendingAssistantTexts: [String] = []

        func flushAssistant() {
            guard let text = pendingAssistantTexts.reversed().compactMap(historyAssistantDisplayText).first else {
                pendingAssistantTexts = []
                return
            }

            var message = ChatMessage.assistant()
            message.blocks.append(ChatBlock(kind: .finalAnswer, text: text))
            result.append(message)
            pendingAssistantTexts = []
        }

        for entry in entries {
            if entry.role == "user" {
                flushAssistant()
                result.append(ChatMessage.user(entry.text))
            } else if entry.role == "assistant" {
                pendingAssistantTexts.append(entry.text)
            }
        }

        flushAssistant()
        return result
    }

    private static func historyAssistantDisplayText(_ raw: String) -> String? {
        let extracted = AgentRunner.extractFinalAnswer(from: raw)
        let cleaned = (extracted ?? AgentRunner.cleanedDisplayText(from: raw))
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !cleaned.isEmpty else { return nil }
        guard cleaned != "[shell command]" else { return nil }
        guard !cleaned.hasPrefix("[terminal ") else { return nil }

        return cleaned
    }

    private static func blockKind(from value: String) -> ChatBlockKind? {
        switch value {
        case "agentReasoning":
            return .agentReasoning
        case "shellCommand":
            return .shellCommand
        case "terminalOutput":
            return .terminalOutput
        case "webCall":
            return .webCall
        case "mcpCall":
            return .mcpCall
        case "imageRendering":
            return .imageRendering
        case "finalAnswer":
            return .finalAnswer
        default:
            return nil
        }
    }

    /// Delete a session from the backend.
    func deleteSession(_ session: AgentSessionInfo) {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else { return }
        let url = APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(session.id)
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let success = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                guard let self else { return }
                if success {
                    self.sessions.removeAll { $0.id == session.id }
                    if self.activeSessionId == session.id {
                        self.startNewChat()
                    }
                }
            }
        }.resume()
    }

    // MARK: - Turn lifecycle

    /// Send the current `inputText` as a new user turn. Opens the
    /// WebSocket via `ChatSessionRunner` and streams the assistant
    /// response into the active assistant message.
    func sendCurrentInput() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isRunning else { return }

        inputText = ""

        let userMessage = ChatMessage.user(text)
        messages.append(userMessage)

        // Allocate the assistant message ahead of time so streamed
        // blocks have a stable container to append into.
        let assistantMessage = ChatMessage.assistant()
        messages.append(assistantMessage)
        enforceMessageCap()
        let assistantIndex = messages.count - 1

        isRunning = true
        lastErrorMessage = nil

        // Use whatever the user has selected, or let the backend assign a new ID.
        let sessionId = activeSessionId ?? UUID().uuidString

        // Optimistically surface a brand-new chat in the sidebar so the
        // user sees and can navigate to it immediately — even while the
        // assistant is still streaming. Without this the sidebar only
        // updates after `onFinal` triggers `refreshSessions()`, which
        // means leaving the chat screen during a long-running turn
        // loses the in-flight conversation. The placeholder uses the
        // same `sessionId` we'll send to the backend, so the entry is
        // seamlessly replaced once `refreshSessions()` returns the
        // canonical record from the server.
        if activeSessionId == nil {
            let placeholderTitle = String(text.prefix(60))
            let placeholder = AgentSessionInfo(
                id: sessionId,
                title: placeholderTitle.isEmpty ? "New Chat" : placeholderTitle,
                platform: "macos",
                turns: 0,
                totalTokensUsed: 0,
                remainingContextTokens: 0,
                contextBudget: 0,
                lastActiveAt: ISO8601DateFormatter().string(from: Date())
            )
            sessions.removeAll { $0.id == sessionId }
            sessions.insert(placeholder, at: 0)
            activeSessionId = sessionId
            activeSessionTitle = placeholder.title
        }

        ChatSessionRunner.shared.run(
            sessionId: sessionId,
            userText: text,
            onBlock: { [weak self] block in
                guard let self else { return }
                self.appendBlock(block, toAssistantAt: assistantIndex)
            },
            onFinal: { [weak self] finalText in
                guard let self else { return }
                self.appendBlock(ChatBlock(kind: .finalAnswer, text: finalText), toAssistantAt: assistantIndex)
                self.isRunning = false
                // Adopt the session ID so subsequent turns reuse it.
                if self.activeSessionId == nil {
                    self.activeSessionId = sessionId
                }
                // Refresh after every completed turn so the sidebar and
                // the context-window indicator under the input bar both
                // reflect the latest backend metadata.
                self.refreshSessions()
            },
            onError: { [weak self] error in
                guard let self else { return }
                let block = ChatBlock(
                    kind: .finalAnswer,
                    text: "**Error:** \(error.localizedDescription)"
                )
                self.appendBlock(block, toAssistantAt: assistantIndex)
                self.isRunning = false
            }
        )
    }

    private func appendBlock(_ block: ChatBlock, toAssistantAt index: Int) {
        guard index >= 0, index < messages.count else { return }
        var message = messages[index]
        guard message.role == .assistant else { return }
        message.blocks.append(block)
        messages[index] = message
    }

    /// Recall the most recent user message into `inputText`.
    /// Wired to the Up Arrow key in the chat input so users can quickly
    /// edit and resend their previous prompt — a convention familiar
    /// from terminal shells and most chat UIs.
    ///
    /// No-ops when there's no prior user message or when the input
    /// already has content (so it doesn't clobber what the user is
    /// currently typing). Returns `true` when the input was populated
    /// so the caller can decide whether to swallow the keystroke.
    @discardableResult
    func recallLastUserMessage() -> Bool {
        guard inputText.isEmpty else { return false }
        guard let last = messages.reversed().first(where: { $0.role == .user }) else {
            return false
        }
        let text = last.text
        guard !text.isEmpty else { return false }
        inputText = text
        return true
    }

    /// Cancel the currently running turn.
    func cancelCurrentTurn() {
        AgentRunner.shared.cancelCurrentSession()
        isRunning = false
    }
    // MARK: - Default task instruction template

    /// Fetch the user's task instruction templates and store both the
    /// full list and the one flagged as default. Drives the dropdown
    /// rendered beneath the chat input. Failures are silent — the
    /// dropdown simply shows "None" if we can't load templates.
    func fetchDefaultTaskTemplate() {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else {
            self.defaultTaskTemplate = nil
            self.availableTaskTemplates = []
            return
        }
        apiClient.fetchTaskTemplates { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let templates):
                    self.availableTaskTemplates = templates
                    self.defaultTaskTemplate = templates.first(where: { $0.isDefault })
                case .failure:
                    self.availableTaskTemplates = []
                    self.defaultTaskTemplate = nil
                }
            }
        }
    }

    /// Persist a new default task instruction template selection from
    /// the chat-input dropdown. Pass `nil` to clear the default. Updates
    /// the local cache optimistically so the dropdown UI reflects the
    /// change immediately, and rolls back on failure.
    func setDefaultTaskTemplate(id: String?) {
        guard !isUpdatingDefaultTaskTemplate else { return }
        // Skip no-op selections so we don't fire a request when the
        // user re-picks the already-default template.
        if id == defaultTaskTemplate?.id { return }

        let previousDefault = defaultTaskTemplate
        let previousTemplates = availableTaskTemplates

        // Optimistic local update.
        if let id = id, let target = availableTaskTemplates.first(where: { $0.id == id }) {
            availableTaskTemplates = availableTaskTemplates.map { tpl in
                APIClient.TaskTemplateDTO(
                    id: tpl.id,
                    heading: tpl.heading,
                    instructions: tpl.instructions,
                    isDefault: tpl.id == id
                )
            }
            defaultTaskTemplate = APIClient.TaskTemplateDTO(
                id: target.id,
                heading: target.heading,
                instructions: target.instructions,
                isDefault: true
            )
        } else {
            availableTaskTemplates = availableTaskTemplates.map { tpl in
                APIClient.TaskTemplateDTO(
                    id: tpl.id,
                    heading: tpl.heading,
                    instructions: tpl.instructions,
                    isDefault: false
                )
            }
            defaultTaskTemplate = nil
        }

        isUpdatingDefaultTaskTemplate = true

        let rollback: @MainActor () -> Void = { [weak self] in
            guard let self else { return }
            self.availableTaskTemplates = previousTemplates
            self.defaultTaskTemplate = previousDefault
        }

        if let id = id {
            apiClient.setDefaultTaskTemplate(id: id) { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    self.isUpdatingDefaultTaskTemplate = false
                    switch result {
                    case .success(let updated):
                        self.availableTaskTemplates = self.availableTaskTemplates.map { tpl in
                            if tpl.id == updated.id { return updated }
                            return APIClient.TaskTemplateDTO(
                                id: tpl.id,
                                heading: tpl.heading,
                                instructions: tpl.instructions,
                                isDefault: false
                            )
                        }
                        self.defaultTaskTemplate = updated
                    case .failure(let error):
                        rollback()
                        self.lastErrorMessage = "Failed to change task instruction: \(error.localizedDescription)"
                    }
                }
            }
        } else {
            apiClient.clearDefaultTaskTemplate { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    self.isUpdatingDefaultTaskTemplate = false
                    switch result {
                    case .success:
                        self.availableTaskTemplates = self.availableTaskTemplates.map { tpl in
                            APIClient.TaskTemplateDTO(
                                id: tpl.id,
                                heading: tpl.heading,
                                instructions: tpl.instructions,
                                isDefault: false
                            )
                        }
                        self.defaultTaskTemplate = nil
                    case .failure(let error):
                        rollback()
                        self.lastErrorMessage = "Failed to clear task instruction: \(error.localizedDescription)"
                    }
                }
            }
        }
    }

}
