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

        // Acquire a JWT first (same flow as `AgentRunner.startSession`).
        if let token = SubscriptionManager.shared.jwtToken, !token.isEmpty {
            connect(
                sessionId: sessionId,
                jwt: token,
                userText: userText,
                groupName: groupName,
                model: model,
                allowReauth: true,
                handle: handle,
                onBlock: onBlock,
                onSteeringEvent: onSteeringEvent,
                onFinal: onFinal,
                onError: onError
            )
            return handle
        }

        SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
            switch outcome {
            case .success:
                let jwt = SubscriptionManager.shared.jwtToken ?? ""
                DispatchQueue.main.async {
                    self.connect(
                        sessionId: sessionId,
                        jwt: jwt,
                        userText: userText,
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

            case .noStoredKey, .expired:
                let error = NSError(
                    domain: "ChatSessionRunner",
                    code: 401,
                    userInfo: [NSLocalizedDescriptionKey: "Subscription is not active."]
                )
                DispatchQueue.main.async { onError(error) }

            case let .failure(error):
                DispatchQueue.main.async { onError(error) }
            }
        }

        return handle
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
            platform: "macos"
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
        jwt: String,
        userText: String,
        groupName: String?,
        model: String? = nil,
        allowReauth: Bool,
        handle: ChatSessionRunHandle,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
        onSteeringEvent: @escaping @MainActor @Sendable (SteeringServerEvent) -> Void,
        onFinal: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (Error) -> Void
    ) {
        guard let url = ChatSessionRunner.makeAgentWebSocketURL() else {
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
            jwt: jwt,
            originalText: userText,
            groupName: groupName,
            model: model,
            allowReauth: allowReauth,
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
            model: String? = nil
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
        }
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
        }
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

        @Sendable func finishWithError(_ error: Error) {
            guard completion.finish() else { return }
            DispatchQueue.main.async { onError(error) }
            task.cancel(with: .goingAway, reason: nil)
            handle.detach()
        }

        @Sendable func finishWithFinal(_ text: String) {
            guard completion.finish() else { return }
            DispatchQueue.main.async { onFinal(text) }
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

                    guard let data = text.data(using: .utf8),
                          let response = try? decoder.decode(AgentMessage.self, from: data)
                    else {
                        print("[ChatSessionRunner] Failed to decode AgentMessage; skipping.")
                        receiveNext()
                        return
                    }

                    let content = response.content

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
                        finishWithFinal(final)
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
                            let (output, status) = executeShell(
                                script,
                                { process in
                                    if let process {
                                        handle.attach(process: process)
                                    } else {
                                        handle.detachProcess()
                                    }
                                }
                            )

                            completion.setShellRunning(false)
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
                                model: model
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
            model: model
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
    private static func makeAgentWebSocketURL() -> URL? {
        guard var components = URLComponents(url: APIClient.baseURL, resolvingAgainstBaseURL: false) else {
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
