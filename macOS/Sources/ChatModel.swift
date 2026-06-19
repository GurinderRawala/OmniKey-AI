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

// MARK: - Per-session streaming state

/// Holds the mutable state for one chat session. Reference type so in-flight
/// WebSocket callbacks capture a stable reference — switching the active session
/// in `ChatModel` does not redirect streamed blocks into the wrong bubble.
final class ChatSessionState: @unchecked Sendable {
    var messages: [ChatMessage] = []
    var trimmedOlderMessageCount: Int = 0
    /// Number of turns currently in flight (including queued turns waiting for a previous one).
    var runCount: Int = 0
    var isRunning: Bool { runCount > 0 }
    /// All active run handles for this session — kept so "Stop" cancels all of them.
    var runHandles: [ChatSessionRunHandle] = []
    /// Index of the assistant `ChatMessage` currently receiving streamed blocks.
    /// Updated each time a new turn starts so the header "Running" indicator
    /// tracks the latest streaming turn.
    var streamingAssistantIndex: Int? = nil
}

// MARK: - Chat model

@MainActor
final class ChatModel: ObservableObject {
    static let shared = ChatModel()

    /// Existing OmniAgent sessions (reused from the same backend
    /// endpoint as `AgentThinkingModel`).
    @Published var sessions: [AgentSessionInfo] = []

    /// Free-text query used to filter the sidebar session list. The
    /// query is matched against the session title *and*, when
    /// available, the full transcript of user messages for the
    /// session (lazily fetched + cached in
    /// `sessionUserMessageHaystacks` once a search is active).
    /// Whitespace-trimmed, case- and diacritic-insensitive matching is
    /// applied in `filteredSessions`.
    @Published var sessionSearchQuery: String = "" {
        didSet { hydrateUserMessageHaystacksIfNeeded() }
    }

    /// Cache of normalised user-message text keyed by session id. Used
    /// to extend the sidebar search beyond session titles so the
    /// filter finds any prior question the user typed in a session,
    /// not only the first message that became the title. Hydrated
    /// lazily on first search; entries are reused across keystrokes
    /// so each session is fetched at most once per app launch.
    @Published private var sessionUserMessageHaystacks: [String: String] = [:]

    /// Set of session ids whose user-message transcript is currently
    /// being fetched. Guards against duplicate in-flight requests when
    /// the user types quickly into the sidebar search field.
    private var hydratingUserMessageSessionIds: Set<String> = []

    /// The session the user is currently chatting in.
    /// `nil` means a brand-new session that has not been persisted yet —
    /// the backend will assign an ID on first turn.
    @Published var activeSessionId: String? = nil
    @Published var activeSessionTitle: String = "New Chat"

    /// True when the user has tapped "New Chat" but has not yet sent
    /// the first message. Drives a synthetic placeholder row at the
    /// top of the sidebar so the not-yet-persisted chat is immediately
    /// visible. Cleared when the user sends, opens another session,
    /// or closes the pending chat.
    @Published var hasPendingNewChat: Bool = false

    /// One-shot signal consumed by the sidebar: when set, the sidebar
    /// expands whichever group currently contains this session id so the
    /// user can see it highlighted after the backend assigns / updates
    /// its `group_name` (e.g. right after a final answer arrives for a
    /// freshly created chat). Cleared by the sidebar once it has acted
    /// so the same signal doesn't re-fire on unrelated updates.
    @Published var pendingExpandSessionId: String? = nil

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

    // ── Project group state ───────────────────────────────────────────────────
    /// Distinct project groups fetched from GET /api/agent/groups.
    @Published var availableGroups: [AgentGroupInfo] = []
    /// The project group the user has selected for context injection.
    /// When set, the group description is prepended to each outgoing message.
    @Published var selectedGroup: AgentGroupInfo? = nil

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
            // Title (the first ~60 chars of the first user message) is
            // always searched. When we've cached deeper transcript text
            // for the session, fold it into the same haystack so the
            // query also matches against later user messages in the
            // thread.
            var haystack = session.title
                .lowercased()
                .folding(options: .diacriticInsensitive, locale: .current)
            if let extra = sessionUserMessageHaystacks[session.id], !extra.isEmpty {
                haystack += "\n" + extra
            }
            // Project group name + description should also be searchable
            // so users can find chats by typing the project name even
            // when the title doesn't reference it directly.
            if let groupName = session.groupName, !groupName.isEmpty {
                haystack += "\n" + groupName
                    .lowercased()
                    .folding(options: .diacriticInsensitive, locale: .current)
            }
            if let desc = session.groupDescription, !desc.isEmpty {
                haystack += "\n" + desc
                    .lowercased()
                    .folding(options: .diacriticInsensitive, locale: .current)
            }
            return tokens.allSatisfy { haystack.contains($0) }
        }
    }

    /// When a search is active, kick off background fetches for any
    /// session whose user-message text we haven't cached yet so the
    /// haystack grows beyond the title for the next keystroke. Limits
    /// concurrent fetches via `hydratingUserMessageSessionIds` and the
    /// per-session in-progress set so a fast typist doesn't fan out
    /// dozens of duplicate requests.
    private func hydrateUserMessageHaystacksIfNeeded() {
        guard isSessionSearchActive else { return }
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else { return }

        // Sessions whose transcript we haven't fetched yet, prioritised
        // by recency (the same order the sidebar displays). Cap the
        // fan-out per keystroke so the network stays calm on accounts
        // with hundreds of sessions.
        let pending = sessions.lazy.filter { [weak self] s in
            guard let self else { return false }
            return self.sessionUserMessageHaystacks[s.id] == nil
                && !self.hydratingUserMessageSessionIds.contains(s.id)
        }
        let batch = Array(pending.prefix(8))
        for session in batch {
            fetchUserMessageHaystack(for: session.id, token: token)
        }
    }

    /// Fetch the persisted transcript for `sessionId` and cache the
    /// concatenated user-message text (folded + lowercased) for use as
    /// a search haystack. Decode failures and HTTP errors are
    /// swallowed silently — search falls back to title-only matching
    /// for that session, which is no worse than the previous behaviour.
    private func fetchUserMessageHaystack(for sessionId: String, token: String) {
        hydratingUserMessageSessionIds.insert(sessionId)

        let url = APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("messages")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data else {
                DispatchQueue.main.async {
                    self.hydratingUserMessageSessionIds.remove(sessionId)
                }
                return
            }
            struct Response: Decodable { let messages: [SessionHistoryEntry] }
            let decoded = try? JSONDecoder().decode(Response.self, from: data)

            let folded: String
            if let entries = decoded?.messages {
                folded = entries
                    .filter { $0.role == "user" }
                    .map(\.text)
                    .joined(separator: "\n")
                    .lowercased()
                    .folding(options: .diacriticInsensitive, locale: .current)
            } else {
                folded = ""
            }

            DispatchQueue.main.async {
                self.hydratingUserMessageSessionIds.remove(sessionId)
                // Always populate the cache (even with an empty string)
                // so a failed fetch isn't re-attempted on every
                // keystroke. The "" sentinel is treated as "no extra
                // haystack" by the filter.
                self.sessionUserMessageHaystacks[sessionId] = folded
            }
        }.resume()
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

    // MARK: - Per-session state store

    /// Sentinel key for the "new chat" landing state before the backend assigns an ID.
    private let pendingNewChatKey = "__pending_new__"

    /// Per-session state, keyed by session ID (or `pendingNewChatKey`).
    private var states: [String: ChatSessionState] = [:]

    /// The key into `states` that corresponds to the currently active view.
    private var activeStateKey: String { activeSessionId ?? pendingNewChatKey }

    /// Return the existing state for `key`, or create and store a fresh one.
    private func sessionState(for key: String) -> ChatSessionState {
        if let existing = states[key] { return existing }
        let s = ChatSessionState()
        states[key] = s
        return s
    }

    /// Push changes back from published properties into the current session's state
    /// before switching away. This preserves the visible message list so switching
    /// back restores it exactly.
    private func savePublishedToActiveState() {
        let s = sessionState(for: activeStateKey)
        s.messages = messages
        s.trimmedOlderMessageCount = trimmedOlderMessageCount
    }

    /// Load a session state into the published properties (driving the SwiftUI view).
    private func loadState(_ s: ChatSessionState) {
        messages = s.messages
        trimmedOlderMessageCount = s.trimmedOlderMessageCount
        isRunning = s.isRunning
    }

    /// Trim `state.messages` to `maxVisibleMessages`, updating the state's own
    /// trimmed-count. The caller is responsible for syncing published properties
    /// afterwards if needed.
    private func enforceMessageCap(on s: ChatSessionState) {
        let overflow = s.messages.count - Self.maxVisibleMessages
        guard overflow > 0 else { return }
        s.messages.removeFirst(overflow)
        s.trimmedOlderMessageCount += overflow
    }

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

    /// Start a brand-new chat. The currently running turn (if any) is **not**
    /// cancelled — it keeps streaming into its own `ChatSessionState` in the
    /// background. The user can switch back to it by tapping its session row.
    func startNewChat() {
        savePublishedToActiveState()

        activeSessionId = nil
        activeSessionTitle = "New Chat"
        hasPendingNewChat = true
        lastErrorMessage = nil
        isLoadingSessionHistory = false

        // Replace the pending-new-chat state with a fresh, empty one.
        let fresh = ChatSessionState()
        states[pendingNewChatKey] = fresh
        loadState(fresh)

        defaultTaskTemplate = nil
        fetchDefaultTaskTemplate()
    }

    /// Switch to an existing session. The previously active turn (if any) keeps
    /// streaming into its own state; switching does **not** cancel it.
    func openSession(_ session: AgentSessionInfo) {
        savePublishedToActiveState()

        activeSessionId = session.id
        activeSessionTitle = session.title
        hasPendingNewChat = false
        lastErrorMessage = nil

        // A session that is streaming in the background must NOT be
        // re-hydrated from the backend here. Re-fetching would overwrite
        // the in-flight `messages` array with the persisted (and
        // necessarily older) transcript, orphaning the
        // `capturedAssistantIndex` the streaming callback writes to. The
        // turn would keep running (`runCount > 0`) while its thinking
        // blocks land at a stale index and never surface — i.e. "the
        // session stays running but shows no thinking" after switching
        // away and back. Restore the live state as-is instead.
        if let running = states[session.id], running.isRunning {
            isLoadingSessionHistory = false
            loadState(running)
        } else {
            // Idle session: show any cached messages immediately (no
            // blank flash) and refresh the transcript from the backend.
            let existing = states[session.id] ?? ChatSessionState()
            states[session.id] = existing
            isLoadingSessionHistory = true
            loadState(existing)
            loadSessionHistory(sessionId: session.id)
        }

        defaultTaskTemplate = nil
        fetchDefaultTaskTemplate()
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
                guard self.activeSessionId == sessionId else { return }
                let hydrated = ChatModel.hydrateTranscript(from: body.messages)
                let overflow = max(0, hydrated.count - ChatModel.maxVisibleMessages)
                let visible = overflow > 0 ? Array(hydrated.suffix(ChatModel.maxVisibleMessages)) : hydrated

                let s = self.sessionState(for: sessionId)
                s.messages = visible
                s.trimmedOlderMessageCount = overflow

                // Refresh the sidebar deep-search cache for this
                // session from the just-hydrated transcript so any
                // user messages beyond the title become matchable
                // straight away without a second round-trip.
                let userBlob = hydrated
                    .filter { $0.role == .user }
                    .map(\.text)
                    .joined(separator: "\n")
                    .lowercased()
                    .folding(options: .diacriticInsensitive, locale: .current)
                self.sessionUserMessageHaystacks[sessionId] = userBlob

                self.messages = visible
                self.trimmedOlderMessageCount = overflow
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

    /// Delete a session from the backend. Cancels any in-flight turn for that
    /// session so its WebSocket closes cleanly.
    /// Append `text` (folded + lowercased) to the cached search
    /// haystack for `sessionId`. Used both when the user sends a new
    /// turn and when streamed history is hydrated, so the sidebar
    /// deep-search reflects the freshest content.
    private func appendToUserMessageHaystack(sessionId: String, text: String) {
        let folded = text
            .lowercased()
            .folding(options: .diacriticInsensitive, locale: .current)
        guard !folded.isEmpty else { return }
        let existing = sessionUserMessageHaystacks[sessionId] ?? ""
        sessionUserMessageHaystacks[sessionId] = existing.isEmpty
            ? folded
            : existing + "\n" + folded
    }

    func deleteSession(_ session: AgentSessionInfo) {
        sessionUserMessageHaystacks.removeValue(forKey: session.id)
        // Optimistically cancel all running turns for this session.
        states[session.id]?.runHandles.forEach { $0.cancel() }

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
                    self.states.removeValue(forKey: session.id)
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
    /// response into the session's own `ChatSessionState`. Switching to
    /// another chat while this turn runs does **not** cancel it.
    func sendCurrentInput() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        let currentState = sessionState(for: activeStateKey)
        inputText = ""
        lastErrorMessage = nil

        // Determine (or create) the session ID for this turn.
        let sessionId = activeSessionId ?? UUID().uuidString

        // For brand-new chats, migrate from the pending-key state to a
        // real-session-keyed state before we start writing messages.
        let sessionSt: ChatSessionState
        if activeSessionId == nil {
            // Move state from pendingNewChatKey → sessionId.
            sessionSt = currentState
            states[sessionId] = sessionSt
            states.removeValue(forKey: pendingNewChatKey)
        } else {
            sessionSt = currentState
        }

        // Append the user and (empty) assistant messages into the session state.
        sessionSt.messages.append(ChatMessage.user(text))
        sessionSt.messages.append(ChatMessage.assistant())
        enforceMessageCap(on: sessionSt)

        // Keep the sidebar deep-search cache in sync with what the
        // user just sent so it's matchable immediately, without
        // waiting for the session to be re-fetched.
        appendToUserMessageHaystack(sessionId: sessionId, text: text)

        // Capture the index for *this* turn's assistant bubble so concurrent
        // turns each stream into their own row rather than fighting over one index.
        let capturedAssistantIndex = sessionSt.messages.count - 1
        sessionSt.streamingAssistantIndex = capturedAssistantIndex
        sessionSt.runCount += 1

        // Sync published properties so the view reflects the new messages.
        messages = sessionSt.messages
        trimmedOlderMessageCount = sessionSt.trimmedOlderMessageCount
        isRunning = true

        // Optimistically surface the session in the sidebar.
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
                groupName: selectedGroup?.groupName,
                groupDescription: selectedGroup?.groupDescription,
                lastActiveAt: ISO8601DateFormatter().string(from: Date())
            )
            sessions.removeAll { $0.id == sessionId }
            sessions.insert(placeholder, at: 0)
            activeSessionId = sessionId
            activeSessionTitle = placeholder.title
            hasPendingNewChat = false
        }

        let handle = ChatSessionRunner.shared.run(
            sessionId: sessionId,
            userText: text,
            groupName: selectedGroup?.groupName,
            onBlock: { [weak self] block in
                guard let self else { return }
                self.appendBlock(block, toSession: sessionSt, at: capturedAssistantIndex)
            },
            onFinal: { [weak self] finalText in
                guard let self else { return }
                self.appendBlock(
                    ChatBlock(kind: .finalAnswer, text: finalText),
                    toSession: sessionSt,
                    at: capturedAssistantIndex
                )
                sessionSt.runCount = max(0, sessionSt.runCount - 1)
                if sessionSt.runCount == 0 {
                    sessionSt.runHandles = []
                    sessionSt.streamingAssistantIndex = nil
                    if self.states[self.activeStateKey] === sessionSt {
                        self.isRunning = false
                    }
                }
                let activeId = self.activeSessionId
                self.refreshSessions {
                    DispatchQueue.main.async {
                        if let id = activeId {
                            self.pendingExpandSessionId = id
                        }
                    }
                }
                self.fetchGroups()
            },
            onError: { [weak self] error in
                guard let self else { return }
                self.appendBlock(
                    ChatBlock(kind: .finalAnswer, text: "**Error:** \(error.localizedDescription)"),
                    toSession: sessionSt,
                    at: capturedAssistantIndex
                )
                sessionSt.runCount = max(0, sessionSt.runCount - 1)
                if sessionSt.runCount == 0 {
                    sessionSt.runHandles = []
                    sessionSt.streamingAssistantIndex = nil
                    if self.states[self.activeStateKey] === sessionSt {
                        self.isRunning = false
                    }
                }
                let activeId = self.activeSessionId
                self.refreshSessions {
                    DispatchQueue.main.async {
                        if let id = activeId {
                            self.pendingExpandSessionId = id
                        }
                    }
                }
                self.fetchGroups()
            }
        )

        sessionSt.runHandles.append(handle)
    }

    /// Append `block` to the assistant message being streamed in `sessionSt`.
    /// Append `block` to the assistant message at `index` in `sessionSt`.
    /// Each turn captures its own index at send time so concurrent turns write
    /// to separate bubbles. If `sessionSt` is the active session the published
    /// `messages` array is also updated so the view refreshes.
    private func appendBlock(_ block: ChatBlock, toSession sessionSt: ChatSessionState, at index: Int) {
        guard index >= 0, index < sessionSt.messages.count else { return }
        var message = sessionSt.messages[index]
        guard message.role == .assistant else { return }
        message.blocks.append(block)
        sessionSt.messages[index] = message

        if states[activeStateKey] === sessionSt {
            messages = sessionSt.messages
        }
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

    /// Cancel all running turns for the active session.
    func cancelCurrentTurn() {
        let s = states[activeStateKey]
        s?.runHandles.forEach { $0.cancel() }
        s?.runCount = 0
        s?.runHandles = []
        s?.streamingAssistantIndex = nil
        isRunning = false
    }
    // MARK: - Project groups

    /// Fetch distinct project groups for the subscription and populate
    /// `availableGroups`. Called on `ChatView.onAppear` so the composer
    /// dropdown is ready before the user types.
    func fetchGroups() {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else { return }
        let url = APIClient.baseURL.appendingPathComponent("api/agent/groups")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data else { return }
            struct Response: Decodable { let groups: [AgentGroupInfo] }
            if let body = try? JSONDecoder().decode(Response.self, from: data) {
                DispatchQueue.main.async { self.availableGroups = body.groups }
            }
        }.resume()
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
