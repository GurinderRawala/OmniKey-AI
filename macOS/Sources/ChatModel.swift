import Combine
import CryptoKit
import Foundation

// MARK: - Chat message model

enum ChatMessageRole: String {
    case user
    case assistant
    case system
}

enum SteeringDeliveryState: Equatable {
    case pending
    case received(pendingCount: Int?)
    case applied
    case failed(String)
}

enum SteeringContinuationPolicy {
    static func shouldCreateContinuation(for status: SteeringServerStatus) -> Bool {
        status == .received
    }
}

/// Kind of an assistant content block. The agent stream can interleave
/// "thinking" content (agent reasoning, terminal output, web calls, MCP
/// calls, image rendering) with a single final answer. Each block becomes
/// one `ChatBlock` so the view can group the thinking blocks into one
/// collapsible section and render the final block as markdown.
enum ChatBlockKind: Equatable {
    case agentReasoning
    case shellCommand
    case terminalOutput
    case webCall
    case mcpCall
    case imageRendering
    /// A tool invocation that isn't one of the specifically-modelled kinds
    /// above. The server transcript files these under `agentReasoning`, so
    /// they are recovered client-side by `AgentTimelineSummarizer.classify`
    /// and shown as a tool step rather than mislabelled as reasoning.
    case toolCall
    case finalAnswer
}

enum TranscriptContentIntegrity {
    static func contentID(kind: ChatBlockKind, text: String) -> String {
        let wireKind: String
        switch kind {
        case .agentReasoning, .toolCall: wireKind = "agentReasoning"
        case .shellCommand: wireKind = "shellCommand"
        case .terminalOutput: wireKind = "terminalOutput"
        case .webCall: wireKind = "webCall"
        case .mcpCall: wireKind = "mcpCall"
        case .imageRendering: wireKind = "imageRendering"
        case .finalAnswer: wireKind = "finalAnswer"
        }
        let digest = SHA256.hash(
            data: Data("transcript-content-v1\0\(wireKind)\0\(text)".utf8)
        )
        return "content-" + Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func matches(block: ChatBlock, fullText: String) -> Bool {
        guard let expected = block.fullContentID else { return false }
        return contentID(kind: block.kind, text: fullText) == expected
    }
}

enum ChatActivityPhase: String, Codable, Equatable {
    case pending
    case started
    case completed
    case failed
    case cancelled
}

struct ChatBlock: Identifiable, Equatable {
    let id: String
    let kind: ChatBlockKind
    var text: String
    /// Wall-clock time the block was appended to the transcript. Used by the
    /// timeline to show per-step timing ("2.4s") and the turn-level
    /// "Worked for …" header, mirroring the Codex desktop transcript.
    /// Blocks hydrated from history share the hydration timestamp, so the
    /// view falls back to hiding timings when every block has the same value.
    var createdAt: Date = Date()
    /// Stable server-provided identity used to pair the start and result of
    /// concurrent tool calls without relying on arrival order.
    var activityId: String? = nil
    var activityPhase: ChatActivityPhase? = nil
    var contentLength: Int? = nil
    var isContentTruncated: Bool = false
    var fullContentID: String? = nil
    var previewText: String? = nil

    init(
        id: String = "local:block:\(UUID().uuidString)",
        kind: ChatBlockKind,
        text: String,
        createdAt: Date = Date(),
        activityId: String? = nil,
        activityPhase: ChatActivityPhase? = nil,
        contentLength: Int? = nil,
        isContentTruncated: Bool = false,
        fullContentID: String? = nil,
        previewText: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.createdAt = createdAt
        self.activityId = activityId
        self.activityPhase = activityPhase
        self.contentLength = contentLength
        self.isContentTruncated = isContentTruncated
        self.fullContentID = fullContentID
        self.previewText = previewText
    }

    static func == (lhs: ChatBlock, rhs: ChatBlock) -> Bool {
        return lhs.id == rhs.id
            && lhs.text == rhs.text
            && lhs.activityId == rhs.activityId
            && lhs.activityPhase == rhs.activityPhase
            && lhs.contentLength == rhs.contentLength
            && lhs.isContentTruncated == rhs.isContentTruncated
            && lhs.fullContentID == rhs.fullContentID
            && lhs.previewText == rhs.previewText
    }
}

enum ChatCancellationLifecycle {
    static func block(for blocks: [ChatBlock], at date: Date = Date()) -> ChatBlock {
        let terminalActivityIDs = Set(blocks.compactMap { block -> String? in
            guard let id = block.activityId,
                  block.activityPhase == .completed || block.activityPhase == .failed
                    || block.activityPhase == .cancelled
            else { return nil }
            return id
        })
        if let active = blocks.reversed().first(where: {
            guard let id = $0.activityId, !terminalActivityIDs.contains(id) else { return false }
            return $0.activityPhase == .started || $0.activityPhase == .pending
        }) {
            return ChatBlock(
                kind: active.kind,
                text: "Stopped by user",
                createdAt: date,
                activityId: active.activityId,
                activityPhase: .cancelled
            )
        }
        return ChatBlock(
            kind: .toolCall,
            text: "Stopped by user",
            createdAt: date,
            activityId: "turn-cancelled-\(UUID().uuidString)",
            activityPhase: .cancelled
        )
    }
}

struct ChatMessage: Identifiable, Equatable {
    let id: String
    let role: ChatMessageRole
    /// User messages keep their content in `text`. Assistant messages
    /// use `blocks` for streamed agent output. System messages use `text`.
    var text: String
    var blocks: [ChatBlock]
    /// When the message was sent. Populated for messages composed in this
    /// app session. `nil` for messages hydrated from server history, which
    /// carries no per-message timestamp — the view hides the label rather
    /// than inventing a time.
    var sentAt: Date?
    /// Delivery state for guidance sent while this task was already running.
    /// `nil` identifies an ordinary user turn.
    var steeringState: SteeringDeliveryState?

    var isSteering: Bool { steeringState != nil }

    static func == (lhs: ChatMessage, rhs: ChatMessage) -> Bool {
        return lhs.id == rhs.id
            && lhs.role == rhs.role
            && lhs.text == rhs.text
            && lhs.blocks == rhs.blocks
            && lhs.sentAt == rhs.sentAt
            && lhs.steeringState == rhs.steeringState
    }

    static func user(
        _ text: String,
        sentAt: Date? = Date(),
        steeringState: SteeringDeliveryState? = nil,
        id: String = "local:message:\(UUID().uuidString)"
    ) -> ChatMessage {
        ChatMessage(id: id, role: .user, text: text, blocks: [], sentAt: sentAt, steeringState: steeringState)
    }

    static func assistant(id: String = "local:message:\(UUID().uuidString)") -> ChatMessage {
        ChatMessage(id: id, role: .assistant, text: "", blocks: [], sentAt: nil, steeringState: nil)
    }

    static func system(_ text: String) -> ChatMessage {
        ChatMessage(
            id: "local:message:\(UUID().uuidString)",
            role: .system,
            text: text,
            blocks: [],
            sentAt: nil,
            steeringState: nil
        )
    }
}

struct PendingSteeringContext {
    let messageID: String
    let text: String
    let redirectKey: String
    var continuationMessageID: String?
}

struct SteeringRedirectRecord: Equatable {
    let redirectKey: String
    let continuationMessageID: String
    let sequence: Int
}

enum SteeringEventResolver {
    static func targetID(
        correlatedID: String?,
        pending: [String: PendingSteeringContext],
        messageIDsInDisplayOrder: [String]
    ) -> String? {
        if let correlatedID { return correlatedID }
        let positions = Dictionary(
            uniqueKeysWithValues: messageIDsInDisplayOrder.enumerated().map { ($1, $0) }
        )
        return pending.min { lhs, rhs in
            (positions[lhs.value.messageID] ?? .max) < (positions[rhs.value.messageID] ?? .max)
        }?.key
    }
}

enum SteeringRedirectResolver {
    static func target(
        for redirectKey: String,
        records: [String: SteeringRedirectRecord]
    ) -> String? {
        records.values
            .filter { $0.redirectKey == redirectKey }
            .max(by: { $0.sequence < $1.sequence })?
            .continuationMessageID
    }
}

enum ChatHistoryMergePolicy {
    static func prepend(existing: [ChatMessage], older: [ChatMessage]) -> [ChatMessage] {
        let existingIDs = Set(existing.map(\.id))
        return older.filter { !existingIDs.contains($0.id) } + existing
    }

    static func latestVisibleTurn(in messages: [ChatMessage]) -> [ChatMessage] {
        guard !messages.isEmpty else { return [] }
        guard let assistantIndex = messages.lastIndex(where: { $0.role == .assistant }) else {
            return [messages[messages.count - 1]]
        }
        return Array(messages[assistantIndex...])
    }
}

// MARK: - Per-session streaming state

/// Holds the mutable state for one chat session. Reference type so in-flight
/// WebSocket callbacks capture a stable reference — switching the active session
/// in `ChatModel` does not redirect streamed blocks into the wrong bubble.
final class ChatSessionState: @unchecked Sendable {
    var messages: [ChatMessage] = []
    var oldestCursor: String? = nil
    var hasMoreBefore: Bool = false
    var isLoadingOlder: Bool = false
    var olderLoadError: String? = nil
    var loadedMessageIDs: Set<String> = []
    /// Number of turns currently in flight (including queued turns waiting for a previous one).
    var runCount: Int = 0
    var isRunning: Bool { runCount > 0 }
    /// All active run handles for this session — kept so "Stop" cancels all of them.
    var runHandles: [ChatSessionRunHandle] = []
    /// Stable identity of the assistant `ChatMessage` receiving streamed blocks.
    /// Updated each time a new turn starts so streamed output targets the
    /// latest assistant turn.
    var streamingAssistantMessageID: String? = nil
    /// When the user steers an active turn, the continuation should appear after
    /// the steering bubble. Existing WebSocket callbacks still reference the
    /// assistant ID captured at turn start, so this maps that original ID
    /// to the current continuation bubble.
    var assistantRedirects: [String: String] = [:]
    var pendingSteering: [String: PendingSteeringContext] = [:]
    var steeringRedirectRecords: [String: SteeringRedirectRecord] = [:]
    var nextSteeringRedirectSequence: Int = 0
}

// MARK: - Chat model

@MainActor
final class ChatModel: ObservableObject {
    static let shared = ChatModel()

    /// Existing OmniAgent sessions (reused from the same backend
    /// endpoint as `AgentThinkingModel`).
    @Published var sessions: [AgentSessionInfo] = []

    /// Free-text query used to filter the sidebar. Deep transcript matching is
    /// performed by the authenticated search endpoint rather than downloading
    /// every session history into the desktop process.
    @Published var sessionSearchQuery: String = "" {
        didSet { scheduleSessionSearch() }
    }
    @Published private var serverSearchSessionIDs: Set<String>? = nil
    private var sessionSearchTask: URLSessionDataTask?
    private var sessionSearchWorkItem: DispatchWorkItem?
    private var sessionSearchGeneration: Int = 0

    /// Monotonically incrementing token per session used to discard
    /// out-of-order `loadSessionHistory` responses. Each call bumps
    /// the counter and captures the new value; when the async
    /// response returns we ignore it if a newer request has been
    /// fired for the same session. Without this a slow response from
    /// a previous open of the same session can clobber the fresh
    /// content the user is currently looking at — the symptom
    /// reported as "chat order looks corrupted after reselecting an
    /// older thread".
    private var sessionHistoryLoadGeneration: [String: Int] = [:]
    private var sessionHistoryTasks: [String: URLSessionDataTask] = [:]
    private var olderHistoryLoadGeneration: [String: Int] = [:]
    private var olderHistoryTasks: [String: URLSessionDataTask] = [:]
    private var fullContentTasks: [String: URLSessionDataTask] = [:]
    private var fullContentWaiters: [String: [(String?) -> Void]] = [:]

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
    @Published private(set) var hasMoreHistory: Bool = false
    @Published private(set) var isLoadingOlderHistory: Bool = false
    @Published private(set) var olderHistoryError: String? = nil
    @Published private(set) var historyPrependAnchorID: String? = nil
    @Published private(set) var fullContentLoadingIDs: Set<String> = []

    /// True while a turn is in flight (WebSocket open, awaiting final answer).
    @Published var isRunning: Bool = false

    /// Ids of every session with at least one turn in flight — not just the
    /// active one. Turns run in parallel across sessions, so the sidebar uses
    /// this to badge each busy chat instead of only the one on screen.
    @Published private(set) var runningSessionIds: Set<String> = []

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

    /// The task instruction label locked to the currently active
    /// session. For existing sessions this is derived from the
    /// persisted <stored_instructions> block when history is loaded;
    /// for a freshly-started session it snapshots the selected
    /// template at send time.
    @Published var activeSessionTaskInstructionTitle: String? = nil

    /// All saved task instruction templates for the current user. Drives
    /// the dropdown below the chat input. Empty until
    /// `fetchDefaultTaskTemplate` resolves.
    @Published var availableTaskTemplates: [APIClient.TaskTemplateDTO] = []

    /// True while a default-template change is being persisted to the
    /// backend. The dropdown is disabled while this is in flight to
    /// avoid stacked POSTs from impatient clicks.
    @Published var isUpdatingDefaultTaskTemplate: Bool = false

    /// Active AI provider/model for OmniAgent turns. These come from
    /// GET /api/providers and can be changed directly from the composer.
    @Published var activeAIProvider: String = "openai"
    @Published var activeAgentModel: String = "gpt-5.5"
    @Published var activeAgentModelOptions: [APIClient.AgentModelOptionDTO] = []
    @Published var isUpdatingAgentModel: Bool = false

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

    /// Project and task-instruction choices are part of how a new
    /// session is initialized. Once a session exists, or a first turn
    /// has been staged/sent, those choices are locked so an existing
    /// conversation cannot silently switch context mid-thread.
    var canChangeSessionSetup: Bool {
        activeSessionId == nil && messages.isEmpty && !isRunning && !isLoadingSessionHistory
    }

    var activeAgentModelLabel: String {
        activeAgentModelOptions.first(where: { $0.id == activeAgentModel })?.label
        ?? prettyModelLabel(activeAgentModel)
    }


    /// The task-instruction label shown in the composer.
    ///
    /// While the session is still editable (`canChangeSessionSetup == true`)
    /// the label tracks the subscription's current default template so the
    /// user sees what the next send will use.
    ///
    /// Once a session has been started (or history has hydrated), the label
    /// is LOCKED to that session. Preference order:
    ///   1. `activeSession?.taskInstructionHeading` — server-persisted
    ///      snapshot taken at session-create time. Authoritative and
    ///      immutable, so renaming/replacing the default template
    ///      elsewhere does not change what this session displays.
    ///   2. `activeSessionTaskInstructionTitle` — best-effort heuristic
    ///      derived from the persisted `<stored_instructions>` block, kept
    ///      only as a fallback for pre-existing sessions created before the
    ///      server started snapshotting the heading.
    ///   3. `"No instruction"` — nothing was locked to this session.
    ///
    /// The current `defaultTaskTemplate?.heading` is intentionally NOT used
    /// as a fallback for locked sessions — that was the source of the bug
    /// where the label silently changed whenever the user picked a different
    /// default template in another chat.
    var displayedTaskInstructionTitle: String {
        if canChangeSessionSetup {
            return defaultTaskTemplate?.heading ?? "No instruction"
        }
        if let locked = activeSession?.taskInstructionHeading, !locked.isEmpty {
            return locked
        }
        return activeSessionTaskInstructionTitle ?? "No instruction"
    }

    var displayedProjectName: String {
        if canChangeSessionSetup {
            return selectedGroup?.groupName ?? "Select project"
        }
        return activeSession?.groupName ?? selectedGroup?.groupName ?? "No project"
    }

    var hasDisplayedTaskInstruction: Bool {
        displayedTaskInstructionTitle != "No instruction"
    }

    var hasDisplayedProject: Bool {
        displayedProjectName != "No project" && displayedProjectName != "Select project"
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
            var haystack = session.title
                .lowercased()
                .folding(options: .diacriticInsensitive, locale: .current)
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
            let metadataMatch = tokens.allSatisfy { haystack.contains($0) }
            return metadataMatch || (serverSearchSessionIDs?.contains(session.id) == true)
        }
    }

    private func scheduleSessionSearch() {
        sessionSearchWorkItem?.cancel()
        sessionSearchTask?.cancel()
        sessionSearchGeneration += 1
        let generation = sessionSearchGeneration
        let query = sessionSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            serverSearchSessionIDs = nil
            return
        }
        serverSearchSessionIDs = nil
        let work = DispatchWorkItem { [weak self] in
            DispatchQueue.main.async { self?.performSessionSearch(query: query, generation: generation) }
        }
        sessionSearchWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    private func performSessionSearch(query: String, generation: Int) {
        guard generation == sessionSearchGeneration,
              let token = SubscriptionManager.shared.jwtToken, !token.isEmpty
        else { return }
        var components = URLComponents(url: APIClient.baseURL
            .appendingPathComponent("api/agent/sessions/search"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: "50"),
        ]
        guard let url = components?.url else { return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct SearchResult: Decodable { let sessionId: String }
        struct SearchResponse: Decodable { let results: [SearchResult] }
        sessionSearchTask = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let data,
                  let http = response as? HTTPURLResponse,
                  200..<300 ~= http.statusCode,
                  let body = try? JSONDecoder().decode(SearchResponse.self, from: data)
            else { return }
            let ids = Set(body.results.map(\.sessionId))
            DispatchQueue.main.async {
                guard let self,
                      generation == self.sessionSearchGeneration,
                      query == self.sessionSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
                else { return }
                self.serverSearchSessionIDs = ids
            }
        }
        sessionSearchTask?.resume()
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
    }

    /// Load a session state into the published properties (driving the SwiftUI view).
    private func loadState(_ s: ChatSessionState) {
        historyPrependAnchorID = nil
        messages = s.messages
        isRunning = s.isRunning
        hasMoreHistory = s.hasMoreBefore
        isLoadingOlderHistory = s.isLoadingOlder
        olderHistoryError = s.olderLoadError
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

    /// Start a brand-new chat. The currently running turn (if any) is **not**
    /// cancelled — it keeps streaming into its own `ChatSessionState` in the
    /// background. The user can switch back to it by tapping its session row.
    func startNewChat(in group: AgentGroupInfo? = nil) {
        savePublishedToActiveState()
        if let previous = activeSessionId {
            sessionHistoryTasks.removeValue(forKey: previous)?.cancel()
            olderHistoryTasks.removeValue(forKey: previous)?.cancel()
            olderHistoryLoadGeneration[previous, default: 0] += 1
            cancelFullContentTasks(for: previous)
            states[previous]?.isLoadingOlder = false
        }

        activeSessionId = nil
        activeSessionTitle = "New Chat"
        hasPendingNewChat = true
        lastErrorMessage = nil
        isLoadingSessionHistory = false

        // Replace the pending-new-chat state with a fresh, empty one.
        let fresh = ChatSessionState()
        states[pendingNewChatKey] = fresh
        loadState(fresh)

        // A chat started from a sidebar group should inherit that project
        // immediately, before its first message creates the backend session.
        selectedGroup = group
        defaultTaskTemplate = nil
        activeSessionTaskInstructionTitle = nil
        fetchDefaultTaskTemplate()
    }

    /// Switch to an existing session. The previously active turn (if any) keeps
    /// streaming into its own state; switching does **not** cancel it.
    func openSession(_ session: AgentSessionInfo) {
        savePublishedToActiveState()
        if let previous = activeSessionId, previous != session.id {
            sessionHistoryTasks.removeValue(forKey: previous)?.cancel()
            olderHistoryTasks.removeValue(forKey: previous)?.cancel()
            olderHistoryLoadGeneration[previous, default: 0] += 1
            cancelFullContentTasks(for: previous)
            states[previous]?.isLoadingOlder = false
        }

        activeSessionId = session.id
        activeSessionTitle = session.title
        hasPendingNewChat = false
        lastErrorMessage = nil

        // A session that is streaming in the background must NOT be
        // re-hydrated from the backend here. Re-fetching would overwrite
        // the in-flight `messages` array with the persisted (and
        // necessarily older) transcript, orphaning the
        // stable assistant ID the streaming callback writes to. The
        // turn would keep running (`runCount > 0`) while its thinking
        // blocks land at a stale index and never surface — i.e. "the
        // session stays running but shows no thinking" after switching
        // away and back. Restore the live state as-is instead.
        if let running = states[session.id], running.isRunning {
            isLoadingSessionHistory = false
            loadState(running)
        } else {
            // Idle session: show any cached messages immediately (no
            // blank flash), but rematerialize only its latest turn. Older
            // decoded pages must not rebuild a large SwiftUI tree on reopen.
            let existing = states[session.id] ?? ChatSessionState()
            states[session.id] = existing
            existing.messages = ChatHistoryMergePolicy.latestVisibleTurn(in: existing.messages)
            existing.loadedMessageIDs = Set(existing.messages.map(\.id))
            existing.oldestCursor = nil
            existing.hasMoreBefore = false
            existing.isLoadingOlder = false
            existing.olderLoadError = nil
            isLoadingSessionHistory = true
            loadState(existing)
            loadSessionHistory(sessionId: session.id)
        }

        defaultTaskTemplate = nil
        activeSessionTaskInstructionTitle = session.taskInstructionHeading
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
        // Bump the load generation for this session BEFORE firing the
        // request so any earlier in-flight request for the same
        // session becomes stale and drops its result on arrival.
        let generation = (sessionHistoryLoadGeneration[sessionId] ?? 0) + 1
        sessionHistoryLoadGeneration[sessionId] = generation

        var components = URLComponents(url: APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("messages"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "view", value: "latest-turn")]
        guard let url = components?.url else {
            isLoadingSessionHistory = false
            lastErrorMessage = "Couldn't load this chat history."
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        sessionHistoryTasks[sessionId]?.cancel()
        olderHistoryTasks.removeValue(forKey: sessionId)?.cancel()
        olderHistoryLoadGeneration[sessionId, default: 0] += 1
        states[sessionId]?.isLoadingOlder = false
        let requestStartedAt = CFAbsoluteTimeGetCurrent()
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self, let data else {
                DispatchQueue.main.async {
                    guard let self else { return }
                    guard self.activeSessionId == sessionId,
                          self.sessionHistoryLoadGeneration[sessionId] == generation else { return }
                    self.isLoadingSessionHistory = false
                }
                return
            }
            guard let http = response as? HTTPURLResponse,
                  200..<300 ~= http.statusCode,
                  let body = try? JSONDecoder().decode(SessionHistoryResponse.self, from: data)
            else {
                DispatchQueue.main.async {
                    guard self.activeSessionId == sessionId,
                          self.sessionHistoryLoadGeneration[sessionId] == generation else { return }
                    self.isLoadingSessionHistory = false
                    self.lastErrorMessage = "Couldn't load this chat history."
                }
                return
            }
            // Decode and transform on URLSession's background callback queue;
            // the main actor only publishes the already-built page.
            let hydrationStartedAt = CFAbsoluteTimeGetCurrent()
            let hydrated = ChatModel.hydrateTranscript(from: body.messages)
            #if DEBUG
            let completedAt = CFAbsoluteTimeGetCurrent()
            print(
                "[ChatHistoryMetrics] latest-turn bytes=\(data.count) "
                    + "requestMs=\(Int((completedAt - requestStartedAt) * 1_000)) "
                    + "hydrateMs=\(Int((completedAt - hydrationStartedAt) * 1_000)) "
                    + "messages=\(hydrated.count)"
            )
            #endif
            DispatchQueue.main.async {
                // Drop the response if the user has switched to another
                // session OR if a newer fetch for this same session has
                // already been fired (e.g. the user reselected the row).
                guard self.activeSessionId == sessionId,
                      self.sessionHistoryLoadGeneration[sessionId] == generation else { return }
                let s = self.sessionState(for: sessionId)
                s.messages = hydrated
                s.loadedMessageIDs = Set(hydrated.map(\.id))
                s.oldestCursor = body.pageInfo?.startCursor
                s.hasMoreBefore = body.pageInfo?.hasMoreBefore ?? false
                s.isLoadingOlder = false
                s.olderLoadError = nil

                self.messages = hydrated
                self.hasMoreHistory = s.hasMoreBefore
                self.isLoadingOlderHistory = false
                self.olderHistoryError = nil
                self.isLoadingSessionHistory = false
                self.sessionHistoryTasks.removeValue(forKey: sessionId)
            }
        }
        sessionHistoryTasks[sessionId] = task
        task.resume()
    }

    /// Loads the immediately preceding complete transcript page. Stable server
    /// message IDs make retries idempotent and keep live-tail callbacks correct
    /// while older messages are inserted at the front.
    func loadOlderMessages() {
        guard let sessionId = activeSessionId,
              let token = SubscriptionManager.shared.jwtToken, !token.isEmpty
        else { return }
        let state = sessionState(for: sessionId)
        guard state.hasMoreBefore, !state.isLoadingOlder, let cursor = state.oldestCursor else { return }
        let generation = (olderHistoryLoadGeneration[sessionId] ?? 0) + 1
        olderHistoryLoadGeneration[sessionId] = generation

        state.isLoadingOlder = true
        state.olderLoadError = nil
        isLoadingOlderHistory = true
        olderHistoryError = nil

        var components = URLComponents(url: APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("messages"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "turns", value: "8"),
            URLQueryItem(name: "before", value: cursor),
        ]
        guard let url = components?.url else {
            finishOlderHistoryFailure(
                sessionId: sessionId,
                generation: generation,
                message: "Couldn't load earlier messages."
            )
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let requestStartedAt = CFAbsoluteTimeGetCurrent()
        let task = URLSession.shared.dataTask(with: request) { [weak self, weak state] data, response, _ in
            guard let self, let state else { return }
            guard let data,
                  let http = response as? HTTPURLResponse,
                  200..<300 ~= http.statusCode,
                  let body = try? JSONDecoder().decode(SessionHistoryResponse.self, from: data)
            else {
                DispatchQueue.main.async {
                    self.finishOlderHistoryFailure(
                        sessionId: sessionId,
                        generation: generation,
                        message: "Couldn't load earlier messages."
                    )
                }
                return
            }
            let hydrationStartedAt = CFAbsoluteTimeGetCurrent()
            let hydrated = ChatModel.hydrateTranscript(from: body.messages)
            #if DEBUG
            let completedAt = CFAbsoluteTimeGetCurrent()
            print(
                "[ChatHistoryMetrics] older-turns bytes=\(data.count) "
                    + "requestMs=\(Int((completedAt - requestStartedAt) * 1_000)) "
                    + "hydrateMs=\(Int((completedAt - hydrationStartedAt) * 1_000)) "
                    + "messages=\(hydrated.count)"
            )
            #endif
            DispatchQueue.main.async {
                guard self.olderHistoryLoadGeneration[sessionId] == generation,
                      self.states[sessionId] === state,
                      state.oldestCursor == cursor else { return }
                let anchor = state.messages.first?.id
                let newMessages = hydrated.filter { !state.loadedMessageIDs.contains($0.id) }
                state.messages = ChatHistoryMergePolicy.prepend(existing: state.messages, older: newMessages)
                state.loadedMessageIDs.formUnion(newMessages.map(\.id))
                state.oldestCursor = body.pageInfo?.startCursor
                state.hasMoreBefore = body.pageInfo?.hasMoreBefore ?? false
                state.isLoadingOlder = false
                state.olderLoadError = nil
                self.olderHistoryTasks.removeValue(forKey: sessionId)
                guard self.activeSessionId == sessionId else { return }
                self.messages = state.messages
                self.hasMoreHistory = state.hasMoreBefore
                self.isLoadingOlderHistory = false
                self.olderHistoryError = nil
                self.historyPrependAnchorID = anchor
            }
        }
        olderHistoryTasks[sessionId] = task
        task.resume()
    }

    private func finishOlderHistoryFailure(sessionId: String, generation: Int, message: String) {
        guard olderHistoryLoadGeneration[sessionId] == generation else { return }
        guard let state = states[sessionId] else { return }
        state.isLoadingOlder = false
        state.olderLoadError = message
        olderHistoryTasks.removeValue(forKey: sessionId)
        guard activeSessionId == sessionId else { return }
        isLoadingOlderHistory = false
        olderHistoryError = message
    }

    func clearHistoryPrependAnchor() {
        historyPrependAnchorID = nil
    }

    func loadFullBlockContent(
        _ block: ChatBlock,
        completion: ((String?) -> Void)? = nil
    ) {
        guard block.previewText != nil,
              let contentID = block.fullContentID,
              let sessionId = activeSessionId,
              let token = SubscriptionManager.shared.jwtToken, !token.isEmpty
        else {
            completion?(block.text)
            return
        }
        let taskKey = "\(sessionId):\(contentID)"
        if let completion { fullContentWaiters[taskKey, default: []].append(completion) }
        guard fullContentTasks[taskKey] == nil else { return }
        fullContentLoadingIDs.insert(contentID)

        let url = APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("message-blocks")
            .appendingPathComponent(contentID)
            .appendingPathComponent("content")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct ContentResponse: Decodable { let text: String; let contentLength: Int }
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            let body: ContentResponse? = {
                guard let data,
                      let http = response as? HTTPURLResponse,
                      200..<300 ~= http.statusCode
                else { return nil }
                return try? JSONDecoder().decode(ContentResponse.self, from: data)
            }()
            DispatchQueue.main.async {
                self.fullContentTasks.removeValue(forKey: taskKey)
                self.fullContentLoadingIDs.remove(contentID)
                let waiters = self.fullContentWaiters.removeValue(forKey: taskKey) ?? []
                guard let body else {
                    if self.activeSessionId == sessionId {
                        self.lastErrorMessage = statusCode == 404 || statusCode == 409
                            ? "This content changed while the chat was open. Reopen the chat and try again."
                            : "Couldn't load the complete content."
                    }
                    waiters.forEach { $0(nil) }
                    return
                }
                guard TranscriptContentIntegrity.matches(block: block, fullText: body.text) else {
                    if self.activeSessionId == sessionId {
                        self.lastErrorMessage =
                            "This content changed while the chat was open. Reopen the chat and try again."
                    }
                    waiters.forEach { $0(nil) }
                    return
                }
                guard let state = self.states[sessionId] else {
                    waiters.forEach { $0(body.text) }
                    return
                }
                for messageIndex in state.messages.indices {
                    for blockIndex in state.messages[messageIndex].blocks.indices
                    where state.messages[messageIndex].blocks[blockIndex].fullContentID == contentID {
                        state.messages[messageIndex].blocks[blockIndex].text = body.text
                        state.messages[messageIndex].blocks[blockIndex].contentLength = body.contentLength
                        state.messages[messageIndex].blocks[blockIndex].isContentTruncated = false
                    }
                }
                if self.activeSessionId == sessionId { self.messages = state.messages }
                waiters.forEach { $0(body.text) }
            }
        }
        fullContentTasks[taskKey] = task
        task.resume()
    }

    func loadFullBlockContents(
        _ blocks: [ChatBlock],
        completion: @escaping ([ChatBlock]) -> Void
    ) {
        let pending = blocks.filter { $0.previewText != nil && $0.isContentTruncated }
        guard !pending.isEmpty else {
            completion(blocks)
            return
        }
        guard let sessionId = activeSessionId else {
            completion(blocks)
            return
        }
        let requestedIDs = Set(blocks.map(\.id))
        var remaining = pending.count
        var didComplete = false
        for block in pending {
            loadFullBlockContent(block) { _ in
                remaining -= 1
                guard remaining <= 0, !didComplete else { return }
                didComplete = true
                let resolvedByID = Dictionary(
                    uniqueKeysWithValues: (self.states[sessionId]?.messages ?? [])
                        .flatMap(\.blocks)
                        .filter { requestedIDs.contains($0.id) }
                        .map { ($0.id, $0) }
                )
                completion(blocks.map { resolvedByID[$0.id] ?? $0 })
            }
        }
    }

    private func cancelFullContentTasks(for sessionId: String) {
        let prefix = "\(sessionId):"
        for key in fullContentTasks.keys.filter({ $0.hasPrefix(prefix) }) {
            fullContentTasks.removeValue(forKey: key)?.cancel()
            fullContentLoadingIDs.remove(String(key.dropFirst(prefix.count)))
            let waiters = fullContentWaiters.removeValue(forKey: key) ?? []
            waiters.forEach { $0(nil) }
        }
    }

    private static func lockedInstructionTitle(from entries: [SessionHistoryEntry]) -> String? {
        let storedInstruction = entries
            .lazy
            .filter { $0.role == "user" }
            .compactMap { entry -> String? in
                guard let range = entry.text.range(
                    of: #"<stored_instructions>[\s\S]*?</stored_instructions>"#,
                    options: [.regularExpression, .caseInsensitive]
                ) else { return nil }
                let block = String(entry.text[range])
                guard let start = block.range(of: "\"\"\"") else { return nil }
                let remainder = block[start.upperBound...]
                guard let end = remainder.range(of: "\"\"\"") else { return nil }
                return String(remainder[..<end.lowerBound])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .first

        guard let storedInstruction, !storedInstruction.isEmpty else { return nil }
        let firstMeaningfulLine = storedInstruction
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty && !$0.hasPrefix("#") }
        return firstMeaningfulLine ?? "Custom instructions"
    }

    /// Prefixes of server-injected `role: 'user'` control prompts that
    /// steer the model mid-turn (web-tool retry, over-length recovery,
    /// untagged-response recovery, ...). The API's `buildTranscript`
    /// filters these out before returning history, but we also filter
    /// here so that:
    ///   * self-hosted backends running an older API version do not
    ///     leak the raw directive text into the chat as user bubbles;
    ///   * intermediate `assistant` retries stay grouped with the real
    ///     user turn instead of being split apart by a synthetic user
    ///     entry — which is what previously made resumed transcripts
    ///     look out-of-order after a failed web search.
    nonisolated private static let injectedUserPromptPrefixes: [String] = [
        "IMPORTANT: The web search tool failed",
        "Web research is complete",
        "Your previous response exceeded the output length limit",
        "Your response was plain text",
        "Content was truncated",
    ]

    nonisolated private static func isInjectedUserPrompt(_ text: String) -> Bool {
        let head = text.drop(while: { $0.isWhitespace || $0.isNewline })
        for prefix in injectedUserPromptPrefixes {
            if head.hasPrefix(prefix) { return true }
        }
        return false
    }

    /// The persisted agent history contains intermediate assistant messages
    /// as well as final answers. For chat resume, render each turn as a clean
    /// user message plus the last useful assistant response.
    nonisolated private static func hydrateTranscript(from entries: [SessionHistoryEntry]) -> [ChatMessage] {
        // One shared stamp for every hydrated block. The timeline treats a
        // zero-length span as "no real timing available" and hides the
        // duration badges, so replayed history never shows invented timings.
        let hydratedAt = Date()

        if entries.contains(where: { ($0.blocks ?? []).isEmpty == false }) {
            return entries.compactMap { entry in
                if entry.role == "user" {
                    if ChatModel.isInjectedUserPrompt(entry.text) { return nil }
                    // Server history carries no per-message timestamp, so the
                    // send time is unknown rather than "now".
                    return ChatMessage.user(entry.text, sentAt: nil, id: "server:\(entry.id)")
                }

                guard entry.role == "assistant" else { return nil }
                var message = ChatMessage.assistant(id: "server:\(entry.id)")
                message.blocks = (entry.blocks ?? []).compactMap { block in
                    guard let kind = ChatModel.blockKind(from: block.kind) else { return nil }
                    return ChatBlock(
                        id: "server:\(block.id)",
                        kind: kind,
                        text: block.text,
                        createdAt: hydratedAt,
                        activityId: block.activityId,
                        activityPhase: block.activityPhase,
                        contentLength: block.contentLength,
                        isContentTruncated: block.isContentTruncated ?? false,
                        fullContentID: block.contentId,
                        previewText: block.isContentTruncated == true ? block.text : nil
                    )
                }
                return message.blocks.isEmpty ? nil : message
            }
        }

        var result: [ChatMessage] = []
        var pendingAssistantEntries: [SessionHistoryEntry] = []

        func flushAssistant() {
            guard let displayEntry = pendingAssistantEntries.reversed().first(where: {
                historyAssistantDisplayText($0.text) != nil
            }), let text = historyAssistantDisplayText(displayEntry.text) else {
                pendingAssistantEntries = []
                return
            }

            var message = ChatMessage.assistant(id: "server:\(displayEntry.id)")
            message.blocks.append(ChatBlock(
                id: "server:\(displayEntry.id):final",
                kind: .finalAnswer,
                text: text,
                createdAt: hydratedAt
            ))
            result.append(message)
            pendingAssistantEntries = []
        }

        for entry in entries {
            if entry.role == "user" {
                if ChatModel.isInjectedUserPrompt(entry.text) { continue }
                flushAssistant()
                result.append(ChatMessage.user(entry.text, sentAt: nil, id: "server:\(entry.id)"))
            } else if entry.role == "assistant" {
                pendingAssistantEntries.append(entry)
            }
        }

        flushAssistant()
        return result
    }

    nonisolated private static func historyAssistantDisplayText(_ raw: String) -> String? {
        let extracted: String?
        if let start = raw.range(of: "<final_answer>"),
           let end = raw.range(of: "</final_answer>", range: start.upperBound..<raw.endIndex)
        {
            extracted = String(raw[start.upperBound..<end.lowerBound])
        } else {
            extracted = nil
        }
        let cleaned = (extracted ?? raw
            .replacingOccurrences(of: "<shell_script>", with: "")
            .replacingOccurrences(of: "</shell_script>", with: "")
            .replacingOccurrences(of: "<final_answer>", with: "")
            .replacingOccurrences(of: "</final_answer>", with: ""))
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !cleaned.isEmpty else { return nil }
        guard cleaned != "[shell command]" else { return nil }
        guard !cleaned.hasPrefix("[terminal ") else { return nil }

        return cleaned
    }

    nonisolated private static func blockKind(from value: String) -> ChatBlockKind? {
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
        case "toolCall":
            return .toolCall
        case "finalAnswer":
            return .finalAnswer
        default:
            return nil
        }
    }

    /// Applies user-managed sidebar metadata optimistically, then persists it.
    /// The session ID and active state are deliberately untouched.
    func renameSession(_ session: AgentSessionInfo, to proposedTitle: String) {
        let title = proposedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 255, title != session.title else { return }
        updateSessionMetadata(session, title: title, isPinned: nil)
    }

    func setSessionPinned(_ session: AgentSessionInfo, isPinned: Bool) {
        guard session.isPinned != isPinned else { return }
        updateSessionMetadata(session, title: nil, isPinned: isPinned)
    }

    private func updateSessionMetadata(
        _ session: AgentSessionInfo,
        title: String?,
        isPinned: Bool?
    ) {
        guard let index = sessions.firstIndex(where: { $0.id == session.id }) else { return }
        let original = sessions[index]
        let updated = original.updating(title: title, isPinned: isPinned)
        sessions[index] = updated
        if activeSessionId == session.id, let title { activeSessionTitle = title }

        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else {
            sessions[index] = original
            if activeSessionId == session.id { activeSessionTitle = original.title }
            return
        }
        let url = APIClient.baseURL.appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(session.id)
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let title { body["title"] = title }
        if let isPinned { body["isPinned"] = isPinned }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let success = (response as? HTTPURLResponse).map { 200..<300 ~= $0.statusCode } ?? false
            guard !success else { return }
            DispatchQueue.main.async {
                guard let self,
                      let currentIndex = self.sessions.firstIndex(where: { $0.id == session.id }),
                      self.sessions[currentIndex] == updated else { return }
                self.sessions[currentIndex] = original
                if self.activeSessionId == session.id { self.activeSessionTitle = original.title }
                self.lastErrorMessage = "Could not update this chat. Please try again."
            }
        }.resume()
    }

    func deleteSession(_ session: AgentSessionInfo) {
        sessionHistoryTasks.removeValue(forKey: session.id)?.cancel()
        olderHistoryTasks.removeValue(forKey: session.id)?.cancel()
        olderHistoryLoadGeneration[session.id, default: 0] += 1
        cancelFullContentTasks(for: session.id)
        // Optimistically cancel all running turns for this session.
        states[session.id]?.runHandles.forEach { $0.cancel() }
        runningSessionIds.remove(session.id)

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
        lastErrorMessage = nil
        if currentState.isRunning {
            inputText = ""
            sendSteeringInput(text, to: currentState)
            return
        }
        inputText = ""
        if activeSessionId == nil && messages.isEmpty {
            activeSessionTaskInstructionTitle = defaultTaskTemplate?.heading
        }

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
        sessionSt.loadedMessageIDs.formUnion(sessionSt.messages.suffix(2).map(\.id))

        // Capture the index for *this* turn's assistant bubble so concurrent
        // turns each stream into their own row rather than fighting over one index.
        let capturedAssistantMessageID = sessionSt.messages.last!.id
        sessionSt.streamingAssistantMessageID = capturedAssistantMessageID
        sessionSt.assistantRedirects[capturedAssistantMessageID] = nil
        sessionSt.runCount += 1
        runningSessionIds.insert(sessionId)

        // Sync published properties so the view reflects the new messages.
        messages = sessionSt.messages
        isRunning = true

        // Optimistically surface the session in the sidebar.
        if activeSessionId == nil {
            let placeholderTitle = String(text.prefix(60))
            // Optimistically stamp the placeholder with the task
            // instruction heading we just locked in. The next
            // `refreshSessions()` will replace this row with the
            // server-authoritative record; until then the composer chip
            // reads the right value straight from the placeholder rather
            // than falling through to `activeSessionTaskInstructionTitle`
            // (which would be stale on the very first turn).
            let placeholder = AgentSessionInfo(
                id: sessionId,
                title: placeholderTitle.isEmpty ? "New Chat" : placeholderTitle,
                isPinned: false,
                platform: "macos",
                turns: 0,
                totalTokensUsed: 0,
                remainingContextTokens: 0,
                contextBudget: 0,
                groupName: selectedGroup?.groupName,
                groupDescription: selectedGroup?.groupDescription,
                taskInstructionId: defaultTaskTemplate?.id,
                taskInstructionHeading: defaultTaskTemplate?.heading,
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
                self.appendBlock(block, toSession: sessionSt, messageID: capturedAssistantMessageID)
            },
            onSteeringEvent: { [weak self] event in
                self?.handleSteeringEvent(event, in: sessionSt)
            },
            onFinal: { [weak self] finalText in
                guard let self else { return }
                self.appendBlock(
                    ChatBlock(kind: .finalAnswer, text: finalText),
                    toSession: sessionSt,
                    messageID: capturedAssistantMessageID
                )
                self.failUnresolvedSteering(
                    in: sessionSt,
                    reason: "The task finished before this update was applied. Send it again as a follow-up."
                )
                sessionSt.runCount = max(0, sessionSt.runCount - 1)
                if sessionSt.runCount == 0 {
                    sessionSt.runHandles = []
                    sessionSt.streamingAssistantMessageID = nil
                    sessionSt.assistantRedirects.removeAll()
                    sessionSt.steeringRedirectRecords.removeAll()
                    self.runningSessionIds.remove(sessionId)
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
                let nsError = error as NSError
                if !(nsError.domain == "ChatSessionRunner" && nsError.code == -9999) {
                    self.appendBlock(
                        ChatBlock(kind: .finalAnswer, text: "**Error:** \(error.localizedDescription)"),
                        toSession: sessionSt,
                        messageID: capturedAssistantMessageID
                    )
                }
                self.failUnresolvedSteering(
                    in: sessionSt,
                    reason: "The task ended before this update was applied."
                )
                sessionSt.runCount = max(0, sessionSt.runCount - 1)
                if sessionSt.runCount == 0 {
                    sessionSt.runHandles = []
                    sessionSt.streamingAssistantMessageID = nil
                    sessionSt.assistantRedirects.removeAll()
                    sessionSt.steeringRedirectRecords.removeAll()
                    self.runningSessionIds.remove(sessionId)
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

    private func sendSteeringInput(_ text: String, to sessionSt: ChatSessionState) {
        guard let sessionId = activeSessionId, let handle = sessionSt.runHandles.last else {
            inputText = text
            lastErrorMessage = "The current task is no longer connected."
            return
        }

        let currentAssistantMessageID = sessionSt.streamingAssistantMessageID
            ?? sessionSt.messages.last(where: { $0.role == .assistant })?.id
        guard let currentAssistantMessageID,
              let currentAssistantIndex = sessionSt.messages.firstIndex(where: {
                  $0.id == currentAssistantMessageID
              })
        else {
            lastErrorMessage = "The current task has no active response to steer."
            inputText = text
            return
        }

        let redirectKey = sessionSt.assistantRedirects.first(where: {
            $0.value == currentAssistantMessageID
        })?.key ?? currentAssistantMessageID
        let steeringID = UUID().uuidString
        let steeringMessage = ChatMessage.user(text, steeringState: .pending)
        let insertIndex = min(currentAssistantIndex + 1, sessionSt.messages.count)
        sessionSt.messages.insert(steeringMessage, at: insertIndex)
        sessionSt.loadedMessageIDs.insert(steeringMessage.id)
        sessionSt.pendingSteering[steeringID] = PendingSteeringContext(
            messageID: steeringMessage.id,
            text: text,
            redirectKey: redirectKey,
            continuationMessageID: nil
        )
        if states[activeStateKey] === sessionSt {
            messages = sessionSt.messages
        }

        ChatSessionRunner.shared.sendSteeringMessage(
            sessionId: sessionId,
            steeringID: steeringID,
            text: text,
            handle: handle
        ) { [weak self, weak sessionSt] result in
            guard let self, let sessionSt else { return }
            switch result {
            case .success:
                DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self, weak sessionSt] in
                    guard let self, let sessionSt,
                          let context = sessionSt.pendingSteering[steeringID],
                          let messageIndex = sessionSt.messages.firstIndex(where: {
                              $0.id == context.messageID
                          }),
                          sessionSt.messages[messageIndex].steeringState == .pending
                    else { return }
                    self.failSteering(
                        id: steeringID,
                        in: sessionSt,
                        reason: "The server did not acknowledge this update. Try again or send it as a follow-up."
                    )
                }

            case let .failure(error):
                self.failSteering(
                    id: steeringID,
                    in: sessionSt,
                    reason: "Couldn't send this update: \(error.localizedDescription)"
                )
            }
        }
    }

    private func handleSteeringEvent(_ event: SteeringServerEvent, in sessionSt: ChatSessionState) {
        guard let steeringID = SteeringEventResolver.targetID(
                  correlatedID: event.id,
                  pending: sessionSt.pendingSteering,
                  messageIDsInDisplayOrder: sessionSt.messages.map(\.id)
              ),
              var context = sessionSt.pendingSteering[steeringID],
              let messageIndex = sessionSt.messages.firstIndex(where: { $0.id == context.messageID })
        else { return }

        switch event.status {
        case .received:
            sessionSt.messages[messageIndex].steeringState = .received(pendingCount: event.pendingCount)
            if SteeringContinuationPolicy.shouldCreateContinuation(for: event.status),
               context.continuationMessageID == nil
            {
                let continuation = ChatMessage.assistant()
                let continuationIndex = min(messageIndex + 1, sessionSt.messages.count)
                sessionSt.messages.insert(continuation, at: continuationIndex)
                sessionSt.loadedMessageIDs.insert(continuation.id)
                context.continuationMessageID = continuation.id
                sessionSt.pendingSteering[steeringID] = context
                sessionSt.nextSteeringRedirectSequence += 1
                sessionSt.steeringRedirectRecords[steeringID] = SteeringRedirectRecord(
                    redirectKey: context.redirectKey,
                    continuationMessageID: continuation.id,
                    sequence: sessionSt.nextSteeringRedirectSequence
                )
                recomputeSteeringRedirect(for: context.redirectKey, in: sessionSt)
            }
            if event.isLegacyAcknowledgement {
                // Legacy servers send no later `applied` event. The receipt is
                // their terminal acknowledgement, so keep the continuation
                // redirect but clear the timeout-tracked pending request.
                sessionSt.messages[messageIndex].steeringState = .applied
                sessionSt.pendingSteering.removeValue(forKey: steeringID)
            }

        case .applied:
            sessionSt.messages[messageIndex].steeringState = .applied
            sessionSt.pendingSteering.removeValue(forKey: steeringID)

        case .rejected:
            failSteering(id: steeringID, in: sessionSt, reason: event.message)
            return
        }

        publish(sessionSt)
    }

    private func failSteering(id: String, in sessionSt: ChatSessionState, reason: String) {
        guard let context = sessionSt.pendingSteering.removeValue(forKey: id) else { return }
        sessionSt.steeringRedirectRecords.removeValue(forKey: id)
        if let messageIndex = sessionSt.messages.firstIndex(where: { $0.id == context.messageID }) {
            sessionSt.messages[messageIndex].steeringState = .failed(reason)
        }

        if let continuationID = context.continuationMessageID,
           let continuationIndex = sessionSt.messages.firstIndex(where: { $0.id == continuationID })
        {
            let continuation = sessionSt.messages[continuationIndex]
            if continuation.text.isEmpty && continuation.blocks.isEmpty {
                sessionSt.messages.remove(at: continuationIndex)
            }
        }

        recomputeSteeringRedirect(for: context.redirectKey, in: sessionSt)

        if states[activeStateKey] === sessionSt {
            if inputText.isEmpty { inputText = context.text }
            lastErrorMessage = reason
        }
        publish(sessionSt)
    }

    private func recomputeSteeringRedirect(for redirectKey: String, in sessionSt: ChatSessionState) {
        if let target = SteeringRedirectResolver.target(
            for: redirectKey,
            records: sessionSt.steeringRedirectRecords
        ) {
            sessionSt.assistantRedirects[redirectKey] = target
            sessionSt.streamingAssistantMessageID = target
        } else {
            sessionSt.assistantRedirects.removeValue(forKey: redirectKey)
            sessionSt.streamingAssistantMessageID = redirectKey
        }
    }

    private func failUnresolvedSteering(in sessionSt: ChatSessionState, reason: String) {
        for id in Array(sessionSt.pendingSteering.keys) {
            failSteering(id: id, in: sessionSt, reason: reason)
        }
    }

    private func publish(_ sessionSt: ChatSessionState) {
        guard states[activeStateKey] === sessionSt else { return }
        messages = sessionSt.messages
    }

    /// Append `block` to the assistant message at `index` in `sessionSt`.
    /// Each turn captures its own index at send time so concurrent turns write
    /// to separate bubbles. If `sessionSt` is the active session the published
    /// `messages` array is also updated so the view refreshes.
    private func appendBlock(
        _ block: ChatBlock,
        toSession sessionSt: ChatSessionState,
        messageID: String
    ) {
        let targetID = sessionSt.assistantRedirects[messageID] ?? messageID
        guard let targetIndex = sessionSt.messages.firstIndex(where: { $0.id == targetID }) else {
            return
        }
        var message = sessionSt.messages[targetIndex]
        guard message.role == .assistant else { return }
        message.blocks.append(block)
        sessionSt.messages[targetIndex] = message

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
        if let s {
            failUnresolvedSteering(in: s, reason: "The task was stopped before this update was applied.")
        }
        if let s,
           let messageID = s.streamingAssistantMessageID
            ?? s.messages.last(where: { $0.role == .assistant })?.id,
           s.messages.contains(where: { $0.id == messageID })
        {
            let targetID = s.assistantRedirects[messageID] ?? messageID
            if let targetIndex = s.messages.firstIndex(where: { $0.id == targetID }) {
                let cancellation = ChatCancellationLifecycle.block(for: s.messages[targetIndex].blocks)
                appendBlock(cancellation, toSession: s, messageID: messageID)
            }
        }
        s?.runHandles.forEach { $0.cancel() }
        s?.runCount = 0
        s?.runHandles = []
        s?.streamingAssistantMessageID = nil
        s?.assistantRedirects.removeAll()
        s?.steeringRedirectRecords.removeAll()
        if let id = activeSessionId { runningSessionIds.remove(id) }
        isRunning = false
    }

    // MARK: - Agent model selection

    private func fallbackAgentModelOptions(for provider: String) -> [APIClient.AgentModelOptionDTO] {
        switch provider {
        case "anthropic":
            return [
                APIClient.AgentModelOptionDTO(id: "claude-opus-4-5", label: "Claude Opus 4.5"),
                APIClient.AgentModelOptionDTO(id: "claude-opus-4-7", label: "Claude Opus 4.7"),
                APIClient.AgentModelOptionDTO(id: "claude-opus-5", label: "Claude Opus 5.0"),
                APIClient.AgentModelOptionDTO(id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5"),
                APIClient.AgentModelOptionDTO(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6"),
                APIClient.AgentModelOptionDTO(id: "claude-sonnet-5", label: "Claude Sonnet 5.0"),
                APIClient.AgentModelOptionDTO(id: "claude-fable-5", label: "Claude Fable 5.0")
            ]
        case "gemini":
            return [
                APIClient.AgentModelOptionDTO(id: "gemini-2.5-pro", label: "Gemini 2.5 Pro"),
                APIClient.AgentModelOptionDTO(id: "gemini-2.5-flash", label: "Gemini 2.5 Flash")
            ]
        case "nemotron":
            return [
                APIClient.AgentModelOptionDTO(
                    id: "nvidia/nemotron-3-ultra-550b-a55b",
                    label: "nvidia/nemotron-3-ultra-550b-a55b"
                ),
                APIClient.AgentModelOptionDTO(
                    id: "nvidia/nemotron-3-super-120b-a12b",
                    label: "nvidia/nemotron-3-super-120b-a12b"
                ),
                APIClient.AgentModelOptionDTO(
                    id: "nvidia/nemotron-3-nano-30b-a3b",
                    label: "nvidia/nemotron-3-nano-30b-a3b"
                )
            ]
        default:
            return [
                APIClient.AgentModelOptionDTO(id: "gpt-5.6", label: "GPT 5.6"),
                APIClient.AgentModelOptionDTO(id: "gpt-5.5", label: "GPT 5.5"),
                APIClient.AgentModelOptionDTO(id: "gpt-5.1", label: "GPT 5.1"),
                APIClient.AgentModelOptionDTO(id: "gpt-4.1", label: "GPT 4.1")
            ]
        }
    }

    private func prettyModelLabel(_ model: String) -> String {
        if model.isEmpty { return "Model" }
        if model.hasPrefix("gpt-") {
            return model.replacingOccurrences(of: "gpt-", with: "GPT ")
        }
        if model.hasPrefix("nvidia/") { return model }
        if model.contains("opus") { return "Opus" }
        if model.contains("fable") { return "Fable" }
        if model.contains("sonnet") { return "Sonnet" }
        return model
    }

    func fetchAgentModelOptions() {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else { return }
        apiClient.fetchAIProviders { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let response):
                    let provider = response.activeProvider
                    let options = response.modelOptions.isEmpty
                        ? self.fallbackAgentModelOptions(for: provider)
                        : response.modelOptions
                    self.activeAIProvider = provider
                    self.activeAgentModelOptions = options
                    self.activeAgentModel = response.activeModel ?? options.first?.id ?? self.activeAgentModel
                case .failure(let error):
                    self.lastErrorMessage = "Failed to load model options: \(error.localizedDescription)"
                }
            }
        }
    }

    func setAgentModel(_ modelId: String) {
        guard !modelId.isEmpty, modelId != activeAgentModel else { return }
        guard !isUpdatingAgentModel else { return }

        let provider = activeAIProvider
        let previousModel = activeAgentModel
        activeAgentModel = modelId
        isUpdatingAgentModel = true

        apiClient.updateProviderModel(provider: provider, model: modelId) { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                self.isUpdatingAgentModel = false
                switch result {
                case .success(let response):
                    self.activeAgentModel = response.activeModel ?? response.model ?? modelId
                    if let options = response.modelOptions, !options.isEmpty {
                        self.activeAgentModelOptions = options
                    }
                case .failure(let error):
                    self.activeAgentModel = previousModel
                    self.lastErrorMessage = "Failed to change model: \(error.localizedDescription)"
                }
            }
        }
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
        guard canChangeSessionSetup else { return }
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
