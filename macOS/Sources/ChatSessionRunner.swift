import Foundation

/// The turn owns one receive loop independently of shell execution. Keeping the
/// transport injectable lets tests hold a command open while delivering events.
protocol ChatSessionSocket: Sendable {
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable (Error?) -> Void)
}

extension URLSessionWebSocketTask: ChatSessionSocket {}

/// Receive failures and shell/send completions can race on different queues.
private final class ChatSessionCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var shellRunning = false

    var isShellRunning: Bool { lock.withLock { shellRunning } }

    func setShellRunning(_ running: Bool) {
        lock.withLock { shellRunning = running }
    }

    var isFinished: Bool {
        lock.withLock { finished }
    }

    /// Keep completion from overtaking an active turn's send invocation.
    /// Actions must not synchronously reenter this gate, including in callbacks.
    func withActiveTurn(_ action: () -> Void) {
        lock.withLock {
            guard !finished else { return }
            action()
        }
    }

    func finish() -> Bool {
        lock.withLock {
            guard !finished else { return false }
            finished = true
            return true
        }
    }
}

/// Accepts each server `request_id` once per turn (bounded), so a replayed
/// control frame never triggers a second collection.
final class GitDiffRequestLedger: @unchecked Sendable {
    private let lock = NSLock()
    private var seen = Set<String>()

    func begin(_ requestID: String) -> Bool {
        lock.withLock {
            // Turn mode adds one baseline request per newly discovered
            // repository directory, so the per-run bound leaves headroom.
            guard !requestID.isEmpty, requestID.count <= 128, seen.count < 64 else { return false }
            return seen.insert(requestID).inserted
        }
    }
}

// MARK: - Per-turn cancellation handle

/// Owns one `URLSessionWebSocketTask` and one cancellation flag for exactly one
/// chat turn. Multiple handles can coexist in parallel — cancelling one does not
/// affect any other in-flight chat.
final class ChatSessionRunHandle: @unchecked Sendable {
    private var _task: (any ChatSessionSocket)?
    private var _process: Process?
    private var cancelledByUser = false
    private let lock = NSLock()

    /// `true` once `cancel()` has been called on this handle.
    var isCancelledByUser: Bool { lock.withLock { cancelledByUser } }

    func attach(task: any ChatSessionSocket) {
        lock.lock()
        defer { lock.unlock() }
        _task = task
    }

    func detach() {
        lock.lock()
        defer { lock.unlock() }
        _task = nil
    }

    func sendWebSocketMessage(_ jsonString: String, completion: @escaping @Sendable (Error?) -> Void) {
        lock.lock()
        let task = _task
        lock.unlock()

        guard let task else {
            let error = NSError(
                domain: "ChatSessionRunner",
                code: -3,
                userInfo: [NSLocalizedDescriptionKey: "The current agent turn is no longer connected."]
            )
            completion(error)
            return
        }

        task.send(.string(jsonString)) { error in
            completion(error)
        }
    }

    /// Register the shell `Process` currently running for this turn. Replaces
    /// any previously registered process (a single turn only ever runs one
    /// `<shell_script>` at a time — the next script is requested only after
    /// the previous one has finished and its output has been sent back).
    func attach(process: Process) {
        lock.lock()
        defer { lock.unlock() }
        _process = process
    }

    /// Clear the registered process. Safe to call after the process has exited
    /// naturally.
    func detachProcess() {
        lock.lock()
        defer { lock.unlock() }
        _process = nil
    }

    /// Cancel the WebSocket **and** terminate the currently running shell
    /// process (if any) for this turn. Other parallel turns are unaffected
    /// because each owns its own `ChatSessionRunHandle`.
    func cancel() {
        lock.lock()
        cancelledByUser = true
        let t = _task
        let p = _process
        _task = nil
        _process = nil
        lock.unlock()

        // Close this turn's socket so the receive loop unwinds.
        t?.cancel(with: .goingAway, reason: nil)

        // Terminate the running shell script for this turn — but only this
        // turn's process. The entire process group is killed (negative PID)
        // so any children spawned by the script also receive SIGTERM and do
        // not linger past cancellation.
        if let process = p, process.isRunning {
            let pid = process.processIdentifier
            kill(-pid, SIGTERM)
            process.terminate()
            print("[ChatSessionRunner] Cancelled turn — sent SIGTERM to process group \(pid).")
        }
    }
}

enum SteeringServerStatus: String, Codable, Equatable {
    case received
    case applied
    case rejected
}

struct SteeringServerEvent: Equatable {
    let id: String?
    let status: SteeringServerStatus
    let message: String
    let pendingCount: Int?
    let isLegacyAcknowledgement: Bool
    let isWaitingForShell: Bool

    init(
        id: String?,
        status: SteeringServerStatus,
        message: String,
        pendingCount: Int?,
        isLegacyAcknowledgement: Bool = false,
        isWaitingForShell: Bool = false
    ) {
        self.id = id
        self.status = status
        self.message = message
        self.pendingCount = pendingCount
        self.isLegacyAcknowledgement = isLegacyAcknowledgement
        self.isWaitingForShell = status == .received && isWaitingForShell
    }
}

// MARK: - Runner

/// Drives a single chat turn over the OmniAgent WebSocket. Mirrors the
/// connection pattern used by `AgentRunner` (same endpoint, same
/// `AgentMessage` JSON wire format, same JWT/re-auth flow, same
/// `<shell_script>` / `<final_answer>` handshake) but streams every
/// agent event back to the chat view as a `ChatBlock` instead of
/// writing into the legacy `AgentThinkingModel`.
///
/// Reuses the static parsing helpers and the shell executor from
/// `AgentRunner` rather than duplicating them.
///
/// Unlike `AgentRunner`, this runner is designed for **parallel
/// execution**. Each call to `run(...)` produces an independent
/// `ChatSessionRunHandle` that owns its own WebSocket task and
/// per-run cancellation flag. This lets the user switch between
/// chats — or even kick off multiple chats at once — without one
/// turn cancelling another. The shared `AgentSessionState` is
/// deliberately not touched here so the keyboard-driven `@omniAgent`
/// flow remains independent of the chat UI.
@MainActor
final class ChatSessionRunner {
    static let shared = ChatSessionRunner()
    private init() {}

    /// Start a turn. Callbacks fire on the main thread. The returned
    /// handle can be used to cancel **only this turn** without affecting
    /// any other in-flight chat.
    ///
    /// - Parameters:
    ///   - sessionId: Existing session ID to continue, or a fresh UUID for a new chat.
    ///   - userText: The user's message.
    ///   - onBlock: Called as the agent streams reasoning, terminal output, web/MCP calls etc.
    ///   - onFinal: Called exactly once with the final answer text. After this the
    ///              underlying WebSocket has been closed.
    ///   - onError: Called if the connection fails or auth cannot be obtained.
    @discardableResult
    func run(
        sessionId: String,
        userText: String,
        groupName: String? = nil,
        model: String? = nil,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
        onSteeringEvent: @escaping @MainActor @Sendable (SteeringServerEvent) -> Void,
        onFinal: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (Error) -> Void
    ) -> ChatSessionRunHandle {
        let handle = ChatSessionRunHandle()

        // Acquire credentials first (same rules as `AgentRunner.startSession`).
        Self.resolveConnection(manager: .shared) { result in
            switch result {
            case let .success(connection):
                // A turn stopped while credentials were pending never connects.
                guard !handle.isCancelledByUser else {
                    onError(NSError(
                        domain: "ChatSessionRunner",
                        code: -9999,
                        userInfo: [NSLocalizedDescriptionKey: "Chat turn cancelled."]
                    ))
                    return
                }
                self.connect(
                    sessionId: sessionId,
                    connection: connection,
                    userText: userText,
                    groupName: groupName,
                    model: model,
                    handle: handle,
                    onBlock: onBlock,
                    onSteeringEvent: onSteeringEvent,
                    onFinal: onFinal,
                    onError: onError
                )
            case let .failure(error):
                onError(error)
            }
        }

        return handle
    }

    /// The backend, identity and token one chat turn connects with, taken
    /// from a single snapshot. Never logged (the token is a credential).
    struct ChatConnection: Sendable {
        let identity: SubscriptionIdentity
        let baseURL: URL
        let token: String
    }

    static let notActiveError = NSError(
        domain: "ChatSessionRunner",
        code: 401,
        userInfo: [NSLocalizedDescriptionKey: "Subscription is not active."]
    )

    /// Resolves the credentials for a turn bound to the identity current
    /// when it starts. With a token for that identity it completes inline;
    /// otherwise it re-activates and hops to the main queue. The connection
    /// is refused with `supersededError` if, by the time it would be used,
    /// the subscription or backend differs from the one the turn started
    /// for, so a queued turn never connects (or sends its text) as another
    /// subscription or to another backend. Completion runs on the main actor.
    static func resolveConnection(
        manager: SubscriptionManager,
        completion: @escaping @MainActor @Sendable (Result<ChatConnection, Error>) -> Void
    ) {
        let initial = manager.authSnapshot()
        let start = initial.identity
        if let start, let first = AgentAuthRetry.credentials(for: start, from: initial) {
            completion(.success(ChatConnection(identity: start, baseURL: first.baseURL, token: first.token)))
            return
        }

        manager.reactivateStoredKeyIfNeeded { outcome in
            let result: Result<ChatConnection, Error>
            switch outcome {
            case .success:
                if let start, let next = AgentAuthRetry.credentials(for: start, from: manager.authSnapshot()) {
                    result = .success(ChatConnection(identity: start, baseURL: next.baseURL, token: next.token))
                } else {
                    result = .failure(SubscriptionManager.supersededError)
                }
            case .superseded:
                // Fail without connecting as the newer subscription.
                result = .failure(SubscriptionManager.supersededError)
            case .noStoredKey, .expired:
                result = .failure(notActiveError)
            case let .failure(error):
                result = .failure(error)
            }

            DispatchQueue.main.async {
                // Re-check at the moment of use: the queued hop can run
                // after a sign-out, key change or backend switch.
                if case let .success(connection) = result,
                   !AgentAuthRetry.mayReplay(startedFor: connection.identity, current: manager.currentIdentity)
                {
                    completion(.failure(SubscriptionManager.supersededError))
                    return
                }
                completion(result)
            }
        }
    }

    func sendSteeringMessage(
        sessionId: String,
        steeringID: String,
        text: String,
        handle: ChatSessionRunHandle,
        completion: @escaping @MainActor @Sendable (Result<Void, Error>) -> Void
    ) {
        let message = AgentMessage(
            sessionID: sessionId,
            sender: "client",
            content: text,
            isTerminalOutput: false,
            isError: false,
            isSteering: true,
            steeringID: steeringID,
            platform: "macos",
            supportsSkillStatus: true
        )

        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(message),
              let json = String(data: data, encoding: .utf8)
        else {
            let error = NSError(
                domain: "ChatSessionRunner",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode steering message."]
            )
            DispatchQueue.main.async { completion(.failure(error)) }
            return
        }

        handle.sendWebSocketMessage(json) { error in
            DispatchQueue.main.async {
                if let error {
                    completion(.failure(error))
                } else {
                    completion(.success(()))
                }
            }
        }
    }

    // MARK: - WebSocket session

    private func connect(
        sessionId: String,
        connection: ChatConnection,
        userText: String,
        groupName: String?,
        model: String? = nil,
        handle: ChatSessionRunHandle,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
        onSteeringEvent: @escaping @MainActor @Sendable (SteeringServerEvent) -> Void,
        onFinal: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (Error) -> Void
    ) {
        // The backend the token was issued for, not a fresh config read.
        guard let url = ChatSessionRunner.makeAgentWebSocketURL(baseURL: connection.baseURL) else {
            let error = NSError(
                domain: "ChatSessionRunner",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to construct agent WebSocket URL."]
            )
            DispatchQueue.main.async { onError(error) }
            return
        }

        print("[ChatSessionRunner] Connecting WebSocket to: \(url.absoluteString)")

        startAgentWebSocketSession(
            url: url,
            sessionID: sessionId,
            jwt: connection.token,
            originalText: userText,
            groupName: groupName,
            model: model,
            allowReauth: false,
            handle: handle,
            onBlock: onBlock,
            onSteeringEvent: onSteeringEvent,
            onFinal: onFinal,
            onError: onError
        )
    }

    /// Wire-format message shared with `AgentRunner.AgentMessage`, plus the
    /// optional activity metadata used by the Agent Chat timeline. Older
    /// servers omit those fields and continue to decode normally.
    struct AgentMessage: Codable {
        let sessionID: String
        let sender: String
        let content: String
        let isTerminalOutput: Bool?
        let isError: Bool?
        let isWebCall: Bool?
        let isImageRendering: Bool?
        let isMcpCall: Bool?
        let activityID: String?
        let activityPhase: ChatActivityPhase?
        let isSteering: Bool?
        let steeringID: String?
        let steeringStatus: SteeringServerStatus?
        let steeringPendingCount: Int?
        let platform: String?
        let groupName: String?
        let model: String?
        /// Client -> server opt-in for nonterminal Skills notices. Sent only
        /// on genuine user input (the initial message and steering).
        let supportsSkillStatus: Bool?
        /// Client -> server opt-in for per-final Git snapshots (initial message only).
        let supportsGitDiff: Bool?
        /// Client -> server opt-in for v3 per-turn baseline diffs (initial
        /// message only). The server uses turn mode only when literally true.
        let supportsGitTurnDiff: Bool?
        /// Client -> server opt-in for agent-assisted diff recovery
        /// (initial message only).
        let supportsDiffRecovery: Bool?
        let workingDirectory: String?
        /// Server -> client control frame; never a model/tool/transcript message.
        let gitDiffRequest: GitDiffRequestPayload?
        /// Client -> server reply to `gitDiffRequest`.
        let gitDiffResponse: GitDiffResponsePayload?
        /// Server -> client: repository hints attached to a shell request.
        let gitDiffContext: GitDiffContext?
        /// Client -> server on a terminal reply: commits observed during it.
        let gitCommitObservations: [GitCommitObservation]?
        /// Client -> server on a terminal reply: metadata of recovery
        /// evidence recorded around that shell (never patch content).
        let diffRecoveryEvidence: DiffRecoveryEvidence?
        /// Server -> client on the final answer: the saved snapshot summary.
        let sessionDiff: SavedSessionDiff?

        init(
            sessionID: String,
            sender: String,
            content: String,
            isTerminalOutput: Bool? = nil,
            isError: Bool? = nil,
            isWebCall: Bool? = nil,
            isImageRendering: Bool? = nil,
            isMcpCall: Bool? = nil,
            activityID: String? = nil,
            activityPhase: ChatActivityPhase? = nil,
            isSteering: Bool? = nil,
            steeringID: String? = nil,
            steeringStatus: SteeringServerStatus? = nil,
            steeringPendingCount: Int? = nil,
            platform: String? = nil,
            groupName: String? = nil,
            model: String? = nil,
            supportsSkillStatus: Bool? = nil,
            supportsGitDiff: Bool? = nil,
            supportsGitTurnDiff: Bool? = nil,
            supportsDiffRecovery: Bool? = nil,
            workingDirectory: String? = nil,
            gitDiffRequest: GitDiffRequestPayload? = nil,
            gitDiffResponse: GitDiffResponsePayload? = nil,
            gitDiffContext: GitDiffContext? = nil,
            gitCommitObservations: [GitCommitObservation]? = nil,
            diffRecoveryEvidence: DiffRecoveryEvidence? = nil,
            sessionDiff: SavedSessionDiff? = nil
        ) {
            self.sessionID = sessionID
            self.sender = sender
            self.content = content
            self.isTerminalOutput = isTerminalOutput
            self.isError = isError
            self.isWebCall = isWebCall
            self.isImageRendering = isImageRendering
            self.isMcpCall = isMcpCall
            self.activityID = activityID
            self.activityPhase = activityPhase
            self.isSteering = isSteering
            self.steeringID = steeringID
            self.steeringStatus = steeringStatus
            self.steeringPendingCount = steeringPendingCount
            self.platform = platform
            self.groupName = groupName
            self.model = model
            self.supportsSkillStatus = supportsSkillStatus
            self.supportsGitDiff = supportsGitDiff
            self.supportsGitTurnDiff = supportsGitTurnDiff
            self.supportsDiffRecovery = supportsDiffRecovery
            self.workingDirectory = workingDirectory
            self.gitDiffRequest = gitDiffRequest
            self.gitDiffResponse = gitDiffResponse
            self.gitDiffContext = gitDiffContext
            self.gitCommitObservations = gitCommitObservations
            self.diffRecoveryEvidence = diffRecoveryEvidence
            self.sessionDiff = sessionDiff
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case sender
            case content
            case isTerminalOutput = "is_terminal_output"
            case isError = "is_error"
            case isWebCall = "is_web_call"
            case isImageRendering = "is_image_rendering"
            case isMcpCall = "is_mcp_call"
            case activityID = "activity_id"
            case activityPhase = "activity_phase"
            case isSteering = "is_steering"
            case steeringID = "steering_id"
            case steeringStatus = "steering_status"
            case steeringPendingCount = "steering_pending_count"
            case platform
            case model
            case groupName = "group_name"
            case supportsSkillStatus = "supports_skill_status"
            case supportsGitDiff = "supports_git_diff"
            case supportsGitTurnDiff = "supports_git_turn_diff"
            case supportsDiffRecovery = "supports_diff_recovery"
            case workingDirectory = "working_directory"
            case gitDiffRequest = "git_diff_request"
            case gitDiffResponse = "git_diff_response"
            case gitDiffContext = "git_diff_context"
            case gitCommitObservations = "git_commit_observations"
            case diffRecoveryEvidence = "diff_recovery_evidence"
            case sessionDiff = "session_diff"
        }

        /// Tolerant decode: a malformed optional Git field is dropped rather
        /// than discarding the whole frame (which may carry the final answer).
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            sessionID = try c.decode(String.self, forKey: .sessionID)
            sender = try c.decode(String.self, forKey: .sender)
            content = try c.decode(String.self, forKey: .content)
            isTerminalOutput = try c.decodeIfPresent(Bool.self, forKey: .isTerminalOutput)
            isError = try c.decodeIfPresent(Bool.self, forKey: .isError)
            isWebCall = try c.decodeIfPresent(Bool.self, forKey: .isWebCall)
            isImageRendering = try c.decodeIfPresent(Bool.self, forKey: .isImageRendering)
            isMcpCall = try c.decodeIfPresent(Bool.self, forKey: .isMcpCall)
            activityID = try c.decodeIfPresent(String.self, forKey: .activityID)
            activityPhase = try c.decodeIfPresent(ChatActivityPhase.self, forKey: .activityPhase)
            isSteering = try c.decodeIfPresent(Bool.self, forKey: .isSteering)
            steeringID = try c.decodeIfPresent(String.self, forKey: .steeringID)
            steeringStatus = try c.decodeIfPresent(SteeringServerStatus.self, forKey: .steeringStatus)
            steeringPendingCount = try c.decodeIfPresent(Int.self, forKey: .steeringPendingCount)
            platform = try c.decodeIfPresent(String.self, forKey: .platform)
            groupName = try c.decodeIfPresent(String.self, forKey: .groupName)
            model = try c.decodeIfPresent(String.self, forKey: .model)
            supportsSkillStatus = try c.decodeIfPresent(Bool.self, forKey: .supportsSkillStatus)
            supportsGitDiff = try? c.decodeIfPresent(Bool.self, forKey: .supportsGitDiff)
            supportsGitTurnDiff = try? c.decodeIfPresent(Bool.self, forKey: .supportsGitTurnDiff)
            supportsDiffRecovery = try? c.decodeIfPresent(Bool.self, forKey: .supportsDiffRecovery)
            workingDirectory = try? c.decodeIfPresent(String.self, forKey: .workingDirectory)
            gitDiffRequest = try? c.decodeIfPresent(GitDiffRequestPayload.self, forKey: .gitDiffRequest)
            gitDiffResponse = try? c.decodeIfPresent(GitDiffResponsePayload.self, forKey: .gitDiffResponse)
            gitDiffContext = try? c.decodeIfPresent(GitDiffContext.self, forKey: .gitDiffContext)
            gitCommitObservations = try? c.decodeIfPresent([GitCommitObservation].self, forKey: .gitCommitObservations)
            diffRecoveryEvidence = try? c.decodeIfPresent(DiffRecoveryEvidence.self, forKey: .diffRecoveryEvidence)
            sessionDiff = try? c.decodeIfPresent(SavedSessionDiff.self, forKey: .sessionDiff)
        }
    }

    nonisolated static func script(_ script: String, in directory: String?) -> String {
        guard let directory else { return script }
        guard directory.hasPrefix("/"), directory.utf8.count <= 4096,
              !directory.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            return "printf '%s\\n' 'Invalid working_directory' >&2; exit 1"
        }
        let literal = "'" + directory.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
        return "cd -- \(literal) || exit 1\n" + script
    }

    nonisolated static func steeringEvent(
        from response: AgentMessage,
        isShellRunning: Bool = false
    ) -> SteeringServerEvent? {
        guard response.isSteering == true else { return nil }
        if let id = response.steeringID {
            return SteeringServerEvent(
                id: id,
                status: response.steeringStatus ?? (response.isError == true ? .rejected : .received),
                message: response.content,
                pendingCount: response.steeringPendingCount,
                isWaitingForShell: isShellRunning
            )
        }
        // Daemons released before correlated steering only sent
        // `is_steering`. Treat that notice as an acknowledgement (or a
        // rejection when it is explicitly an error) for the oldest pending
        // local update.
        return SteeringServerEvent(
            id: nil,
            status: response.isError == true ? .rejected : .received,
            message: response.content,
            pendingCount: nil,
            isLegacyAcknowledgement: true
        )
    }

    nonisolated static func finalAnswerDisplayText(from response: AgentMessage) -> String? {
        guard let final = AgentRunner.extractFinalAnswer(from: response.content) else { return nil }
        if response.isError == true && !final.hasPrefix("**Error:**") {
            return "**Error:** \(final)"
        }
        return final
    }

    func startAgentWebSocketSession(
        url: URL,
        sessionID: String,
        jwt: String,
        originalText: String,
        groupName: String?,
        model: String? = nil,
        allowReauth: Bool,
        handle: ChatSessionRunHandle,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
        onSteeringEvent: @escaping @MainActor @Sendable (SteeringServerEvent) -> Void,
        onFinal: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (Error) -> Void,
        socket: (any ChatSessionSocket)? = nil,
        executeShell: @escaping @Sendable (String, @escaping @Sendable (Process?) -> Void) -> (output: String, status: Int32) = {
            runShellCommandWithStatus($0, processRegistrar: $1)
        },
        collectGitDiff: @escaping @Sendable (GitDiffRequestPayload, GitTurnBaselineStore) -> GitDiffResponsePayload = {
            GitSnapshotCollector().collect($0, turnStore: $1)
        },
        gitProvenance: GitProvenanceTracker = GitProvenanceTracker(),
        // Evaluated per call: one recovery store per outer run, so a later
        // turn can never see or replay this run's evidence.
        diffRecovery: DiffRecoveryStore = DiffRecoveryStore()
    ) {
        var request = URLRequest(url: url)
        request.addValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        let task: any ChatSessionSocket = socket
            ?? URLSession(configuration: .default).webSocketTask(with: request)

        // Bind this socket to the per-turn handle so the chat view's
        // Stop button (or session deletion) closes only this turn's
        // connection — not any other parallel chat that happens to be
        // running. The global `AgentSessionState` is intentionally
        // *not* used here.
        handle.attach(task: task)

        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let completion = ChatSessionCompletion()
        // Live-only Skills feedback, deduplicated for this turn alone.
        let skillNotices = SkillStatusTracker()
        // Git snapshot work runs serially off the receive/main paths.
        let gitQueue = DispatchQueue(label: "ChatSessionRunner.git-snapshot", qos: .userInitiated)
        let gitRequests = GitDiffRequestLedger()
        // First HEAD captured per repository for this run (one outer user
        // input, reused across recursion and steering; never reset or
        // rebased within the run). The next turn gets a fresh store.
        let turnBaselines = GitTurnBaselineStore()

        @Sendable func finishWithError(_ error: Error) {
            guard completion.finish() else { return }
            DispatchQueue.main.async { onError(error) }
            task.cancel(with: .goingAway, reason: nil)
            handle.detach()
        }

        @Sendable func finishWithFinal(_ text: String, sessionDiff: SavedSessionDiff? = nil) {
            guard completion.finish() else { return }
            // One main-queue hop keeps the snapshot card strictly before the
            // final answer it belongs to.
            DispatchQueue.main.async {
                if let sessionDiff { onBlock(ChatSessionRunner.sessionDiffBlock(sessionDiff)) }
                onFinal(text)
            }
            task.cancel(with: .goingAway, reason: nil)
            handle.detach()
        }

        @Sendable func receiveNext() {
            guard !completion.isFinished else { return }
            task.receive { result in
                guard !completion.isFinished else { return }
                switch result {
                case let .failure(error):
                    // Check whether this was a user-initiated cancel — if so,
                    // surface a clean cancellation error instead of the raw
                    // socket failure.
                    if handle.isCancelledByUser {
                        let cancelError = NSError(
                            domain: "ChatSessionRunner",
                            code: -9999,
                            userInfo: [NSLocalizedDescriptionKey: "Chat turn cancelled."]
                        )
                        finishWithError(cancelError)
                    } else {
                        finishWithError(error)
                    }

                case let .success(message):
                    guard case let .string(text) = message else {
                        receiveNext()
                        return
                    }

                    guard let data = text.data(using: .utf8) else {
                        receiveNext()
                        return
                    }

                    // Skills notices are status only. Intercept them before any
                    // tool, steering, shell-script, or final-answer parsing so
                    // their content can never run a command or end the turn.
                    if case let .consumed(display) = SkillNoticeInterceptor.intercept(data, tracker: skillNotices) {
                        if let display {
                            DispatchQueue.main.async {
                                onBlock(ChatSessionRunner.skillStatusBlock(display))
                            }
                        }
                        receiveNext()
                        return
                    }

                    guard let response = try? decoder.decode(AgentMessage.self, from: data) else {
                        print("[ChatSessionRunner] Failed to decode AgentMessage; skipping.")
                        receiveNext()
                        return
                    }

                    let content = response.content

                    // Git snapshot control frame: consumed here, before any
                    // error/final/shell parsing, and never shown in the chat.
                    if let gitRequest = response.gitDiffRequest {
                        if response.sender == "agent", response.sessionID == sessionID,
                           gitRequests.begin(gitRequest.requestID)
                        {
                            gitQueue.async {
                                guard !completion.isFinished, !handle.isCancelledByUser else { return }
                                // Recovery replays only this run's stored evidence.
                                let payload = gitRequest.phase == .recover
                                    ? diffRecovery.recover(gitRequest)
                                    : collectGitDiff(gitRequest, turnBaselines)
                                let reply = AgentMessage(
                                    sessionID: sessionID, sender: "client", content: "",
                                    platform: "macos", gitDiffResponse: payload
                                )
                                guard let data = try? encoder.encode(reply),
                                      let json = String(data: data, encoding: .utf8)
                                else { return }
                                completion.withActiveTurn {
                                    // A failed reply only loses the snapshot; the
                                    // server times out and still delivers the final.
                                    task.send(.string(json)) { _ in }
                                }
                            }
                        }
                        receiveNext()
                        return
                    }

                    // Side-channel notifications (web/image/MCP). Surface them
                    // as thinking blocks and keep listening.
                    if response.isWebCall == true {
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(
                                kind: .webCall,
                                text: content,
                                activityId: response.activityID,
                                activityPhase: response.activityPhase
                            ))
                        }
                        receiveNext()
                        return
                    }
                    if response.isImageRendering == true {
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(
                                kind: .imageRendering,
                                text: content,
                                activityId: response.activityID,
                                activityPhase: response.activityPhase
                            ))
                        }
                        receiveNext()
                        return
                    }
                    if response.isMcpCall == true {
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(
                                kind: .mcpCall,
                                text: content,
                                activityId: response.activityID,
                                activityPhase: response.activityPhase
                            ))
                        }
                        receiveNext()
                        return
                    }
                    if response.isSteering == true {
                        if let event = ChatSessionRunner.steeringEvent(
                            from: response, isShellRunning: completion.isShellRunning
                        ) {
                            DispatchQueue.main.async { onSteeringEvent(event) }
                        }
                        receiveNext()
                        return
                    }

                    // Detect a final-answer block before the generic-error path.
                    // Server-generated failures are final answers with
                    // `is_error=true`; treating them as a tool event would leave
                    // the turn running and make its durable failure differ from
                    // what the live chat displayed.
                    if let final = ChatSessionRunner.finalAnswerDisplayText(from: response) {
                        print("[ChatSessionRunner] Final answer received (length: \(final.count))")
                        finishWithFinal(
                            final,
                            sessionDiff: ChatSessionRunner.acceptedSessionDiff(from: response, sessionID: sessionID)
                        )
                        return
                    }

                    // Unknown, disabled, or newly-added tool categories can still
                    // arrive as generic errors. Preserve their failed lifecycle
                    // instead of presenting them as successful reasoning.
                    if response.isError == true {
                        DispatchQueue.main.async {
                            onBlock(ChatSessionRunner.genericErrorBlock(from: response))
                        }
                        receiveNext()
                        return
                    }

                    // Shell script request — run it and stream output back.
                    if let script = AgentRunner.extractShellScript(from: content) {
                        // Set this before dispatching the worker so a receipt
                        // arriving before Process registration still shows waiting.
                        completion.setShellRunning(true)
                        // Surface the reasoning that accompanied the script too.
                        let reasoning = ChatSessionRunner.cleanedTextRemovingShellScript(from: content)
                        if !reasoning.isEmpty {
                            DispatchQueue.main.async {
                                onBlock(ChatBlock(kind: .agentReasoning, text: reasoning))
                            }
                        }
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(
                                kind: .shellCommand,
                                text: script,
                                activityId: response.activityID,
                                activityPhase: response.activityPhase
                            ))
                        }

                        DispatchQueue.global(qos: .userInitiated).async {
                            // Bind the shell `Process` to *this* turn's handle so
                            // a Stop press only kills this script — never another
                            // chat's running script. The global
                            // `AgentSessionState.shared.shellProcess` slot is
                            // intentionally untouched here.
                            guard !completion.isFinished, !handle.isCancelledByUser else { return }
                            // Apply the structured directory as a quoted literal cd
                            // so production and injected executors share identical semantics.
                            let executionScript = Self.script(script, in: response.workingDirectory)
                            let gitBaseline = gitProvenance.baseline(script: executionScript, context: response.gitDiffContext)
                            // Bounded read-only before-checkpoint (no script execution).
                            let recoveryCheckpoint = diffRecovery.before(
                                script: executionScript, context: response.gitDiffContext,
                                initialDirectory: GitProvenanceTracker.shellWorkingDirectory
                            )
                            guard !completion.isFinished, !handle.isCancelledByUser else { return }
                            let (output, status) = executeShell(
                                executionScript,
                                { process in
                                    if let process {
                                        handle.attach(process: process)
                                    } else {
                                        handle.detachProcess()
                                    }
                                }
                            )

                            completion.setShellRunning(false)
                            let commitObservations = gitProvenance.observations(after: gitBaseline)
                            // Skipped on cancellation: nothing late is recorded.
                            let recoveryEvidence = handle.isCancelledByUser ? nil : recoveryCheckpoint.flatMap(diffRecovery.after)
                            guard !completion.isFinished else { return }

                            // If the user cancelled this specific turn while the
                            // command was running, discard the output and surface a
                            // clean cancellation error. The WebSocket is already
                            // closed, so attempting to send would only produce a
                            // confusing network error in the chat view.
                            if handle.isCancelledByUser {
                                print("[ChatSessionRunner] Shell execution completed but turn was cancelled; discarding output.")
                                let cancelError = NSError(
                                    domain: "ChatSessionRunner",
                                    code: -9999,
                                    userInfo: [NSLocalizedDescriptionKey: "Chat turn cancelled."]
                                )
                                finishWithError(cancelError)
                                return
                            }

                            let reply = AgentMessage(
                                sessionID: response.sessionID,
                                sender: "client",
                                content: output,
                                isTerminalOutput: true,
                                isError: status != 0,
                                platform: "macos",
                                model: model,
                                gitCommitObservations: commitObservations.isEmpty ? nil : commitObservations,
                                diffRecoveryEvidence: recoveryEvidence
                            )

                            guard let jsonData = try? encoder.encode(reply),
                                  let jsonString = String(data: jsonData, encoding: .utf8)
                            else {
                                let err = NSError(
                                    domain: "ChatSessionRunner",
                                    code: -2,
                                    userInfo: [NSLocalizedDescriptionKey: "Failed to encode terminal output."]
                                )
                                finishWithError(err)
                                return
                            }

                            completion.withActiveTurn {
                                DispatchQueue.main.async {
                                    let statusLabel = (status == 0) ? "success" : "error (exit code: \(status))"
                                    let display = "[terminal \(statusLabel)]\n\(output)"
                                    onBlock(ChatBlock(
                                        kind: .terminalOutput,
                                        text: display,
                                        activityId: response.activityID,
                                        activityPhase: status == 0 ? .completed : .failed
                                    ))
                                }

                                task.send(.string(jsonString)) { error in
                                    if let error {
                                        // A socket may invoke this callback inline.
                                        // Finish outside the gate to avoid deadlock.
                                        DispatchQueue.global(qos: .userInitiated).async {
                                            finishWithError(error)
                                        }
                                    }
                                }
                            }
                        }
                        // A shell command can outlive the steering acknowledgement
                        // timeout. Read control events while it runs; the terminal
                        // send callback must never start a second receive loop.
                        receiveNext()
                        return
                    }

                    // Plain agent message — show as reasoning and keep listening.
                    let displayText = AgentRunner.cleanedDisplayText(from: content)
                    if !displayText.isEmpty {
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(kind: .agentReasoning, text: displayText))
                        }
                    }
                    receiveNext()
                }
            }
        }

        task.resume()

        let initial = AgentMessage(
            sessionID: sessionID,
            sender: "client",
            content: originalText,
            isTerminalOutput: false,
            isError: false,
            platform: "macos",
            groupName: groupName,
            model: model,
            supportsSkillStatus: true,
            supportsGitDiff: true,
            supportsGitTurnDiff: true,
            supportsDiffRecovery: true
        )

        guard let data = try? encoder.encode(initial),
              let json = String(data: data, encoding: .utf8)
        else {
            let error = NSError(
                domain: "ChatSessionRunner",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode initial agent message."]
            )
            finishWithError(error)
            return
        }

        task.send(.string(json)) { error in
            if let error = error {
                finishWithError(error)
                return
            }
            receiveNext()
        }
    }

    /// A dedicated live-only Skills row. Its own kind keeps it out of tool
    /// reclassification, the reasoning noise filter, and milestone grouping,
    /// so a notice can never relabel the preceding tool activity. The
    /// timeline renders it literally via `Text(String)`.
    nonisolated static func sessionDiffBlock(_ diff: SavedSessionDiff) -> ChatBlock {
        ChatBlock(kind: .sessionDiff, text: "", sessionDiff: diff)
    }

    /// Only a well-formed summary on a successful final for this turn's
    /// session is shown; error finals never get a snapshot card.
    nonisolated static func acceptedSessionDiff(from response: AgentMessage, sessionID: String) -> SavedSessionDiff? {
        guard  response.sessionID == sessionID,
              let diff = response.sessionDiff, diff.isEligibleForViewer, diff.fileCount >= 0, diff.repositoryCount > 0
        else { return nil }
        return diff
    }

    nonisolated static func skillStatusBlock(_ text: String) -> ChatBlock {
        ChatBlock(kind: .skillStatus, text: text)
    }

    static func genericErrorBlock(from response: AgentMessage) -> ChatBlock {
        ChatBlock(
            kind: .toolCall,
            text: response.content,
            activityId: response.activityID,
            activityPhase: response.activityPhase ?? .failed
        )
    }

    // MARK: - URL helpers

    /// Mirror of `AgentRunner.makeAgentWebSocketURL` — kept private here so
    /// this file does not depend on a non-public helper.
    static func makeAgentWebSocketURL(baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        let scheme = components.scheme?.lowercased()
        components.scheme = (scheme == "https") ? "wss" : "ws"

        var path = components.path
        if !path.hasSuffix("/") {
            path += "/"
        }
        path += "ws/omni-agent"
        components.path = path

        return components.url
    }

    private nonisolated static func cleanedTextRemovingShellScript(from content: String) -> String {
        var cleaned = content
        if let startRange = cleaned.range(of: "<shell_script>"),
           let endRange = cleaned.range(
            of: "</shell_script>",
            range: startRange.upperBound..<cleaned.endIndex
        ) {
            cleaned.removeSubrange(startRange.lowerBound..<endRange.upperBound)
        }
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
