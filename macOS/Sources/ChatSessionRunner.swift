import Foundation

// MARK: - Per-turn cancellation handle

/// Owns one `URLSessionWebSocketTask` and one cancellation flag for exactly one
/// chat turn. Multiple handles can coexist in parallel — cancelling one does not
/// affect any other in-flight chat.
final class ChatSessionRunHandle: @unchecked Sendable {
    private var _task: URLSessionWebSocketTask?
    private var _process: Process?
    private let cancelFlag = BoolBox()
    private let lock = NSLock()

    /// `true` once `cancel()` has been called on this handle.
    var isCancelledByUser: Bool { cancelFlag.value }

    func attach(task: URLSessionWebSocketTask) {
        lock.lock()
        defer { lock.unlock() }
        _task = task
    }

    func detach() {
        lock.lock()
        defer { lock.unlock() }
        _task = nil
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
        cancelFlag.value = true

        lock.lock()
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

    /// Returns and clears the cancelled flag. Synchronous — safe to call from
    /// `DispatchQueue` closures that cannot `await`.
    func takeWasCancelledByUser() -> Bool {
        let was = cancelFlag.value
        cancelFlag.value = false
        return was
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
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
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
                allowReauth: true,
                handle: handle,
                onBlock: onBlock,
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
                        allowReauth: false,
                        handle: handle,
                        onBlock: onBlock,
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

    // MARK: - WebSocket session

    private func connect(
        sessionId: String,
        jwt: String,
        userText: String,
        allowReauth: Bool,
        handle: ChatSessionRunHandle,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
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
            allowReauth: allowReauth,
            handle: handle,
            onBlock: onBlock,
            onFinal: onFinal,
            onError: onError
        )
    }

    /// Wire-format message — must stay byte-for-byte identical to
    /// `AgentRunner.AgentMessage` so the backend treats both flows the same way.
    private struct AgentMessage: Codable {
        let sessionID: String
        let sender: String
        let content: String
        let isTerminalOutput: Bool?
        let isError: Bool?
        let isWebCall: Bool?
        let isImageRendering: Bool?
        let isMcpCall: Bool?
        let platform: String?

        init(
            sessionID: String,
            sender: String,
            content: String,
            isTerminalOutput: Bool? = nil,
            isError: Bool? = nil,
            isWebCall: Bool? = nil,
            isImageRendering: Bool? = nil,
            isMcpCall: Bool? = nil,
            platform: String? = nil
        ) {
            self.sessionID = sessionID
            self.sender = sender
            self.content = content
            self.isTerminalOutput = isTerminalOutput
            self.isError = isError
            self.isWebCall = isWebCall
            self.isImageRendering = isImageRendering
            self.isMcpCall = isMcpCall
            self.platform = platform
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
            case platform
        }
    }

    private func startAgentWebSocketSession(
        url: URL,
        sessionID: String,
        jwt: String,
        originalText: String,
        allowReauth: Bool,
        handle: ChatSessionRunHandle,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
        onFinal: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (Error) -> Void
    ) {
        var request = URLRequest(url: url)
        request.addValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: request)

        // Bind this socket to the per-turn handle so the chat view's
        // Stop button (or session deletion) closes only this turn's
        // connection — not any other parallel chat that happens to be
        // running. The global `AgentSessionState` is intentionally
        // *not* used here.
        handle.attach(task: task)

        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let finalDelivered = BoolBox()

        func finishWithError(_ error: Error) {
            if !finalDelivered.value {
                finalDelivered.value = true
                DispatchQueue.main.async { onError(error) }
            }
            task.cancel(with: .goingAway, reason: nil)
            handle.detach()
        }

        func finishWithFinal(_ text: String) {
            if !finalDelivered.value {
                finalDelivered.value = true
                DispatchQueue.main.async { onFinal(text) }
            }
            task.cancel(with: .goingAway, reason: nil)
            handle.detach()
        }

        func receiveNext() {
            task.receive { result in
                switch result {
                case let .failure(error):
                    // Check whether this was a user-initiated cancel — if so,
                    // surface a clean cancellation error instead of the raw
                    // socket failure.
                    if handle.takeWasCancelledByUser() {
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
                            onBlock(ChatBlock(kind: .webCall, text: content))
                        }
                        receiveNext()
                        return
                    }
                    if response.isImageRendering == true {
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(kind: .imageRendering, text: content))
                        }
                        receiveNext()
                        return
                    }
                    if response.isMcpCall == true {
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(kind: .mcpCall, text: content))
                        }
                        receiveNext()
                        return
                    }

                    // Detect a final-answer block — terminates the turn.
                    if let final = AgentRunner.extractFinalAnswer(from: content) {
                        print("[ChatSessionRunner] Final answer received (length: \(final.count))")
                        finishWithFinal(final)
                        return
                    }

                    // Shell script request — run it and stream output back.
                    if let script = AgentRunner.extractShellScript(from: content) {
                        // Surface the reasoning that accompanied the script too.
                        let reasoning = ChatSessionRunner.cleanedTextRemovingShellScript(from: content)
                        if !reasoning.isEmpty {
                            DispatchQueue.main.async {
                                onBlock(ChatBlock(kind: .agentReasoning, text: reasoning))
                            }
                        }
                        DispatchQueue.main.async {
                            onBlock(ChatBlock(kind: .shellCommand, text: script))
                        }

                        DispatchQueue.global(qos: .userInitiated).async {
                            // Bind the shell `Process` to *this* turn's handle so
                            // a Stop press only kills this script — never another
                            // chat's running script. The global
                            // `AgentSessionState.shared.shellProcess` slot is
                            // intentionally untouched here.
                            let (output, status) = runShellCommandWithStatus(
                                script,
                                processRegistrar: { [weak handle] process in
                                    guard let handle else { return }
                                    if let process {
                                        handle.attach(process: process)
                                    } else {
                                        handle.detachProcess()
                                    }
                                }
                            )

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

                            DispatchQueue.main.async {
                                let statusLabel = (status == 0) ? "success" : "error (exit code: \(status))"
                                let display = "[terminal \(statusLabel)]\n\(output)"
                                onBlock(ChatBlock(kind: .terminalOutput, text: display))
                            }

                            let reply = AgentMessage(
                                sessionID: response.sessionID,
                                sender: "client",
                                content: output,
                                isTerminalOutput: true,
                                isError: status != 0,
                                platform: "macos"
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

                            task.send(.string(jsonString)) { error in
                                if let error = error {
                                    finishWithError(error)
                                } else {
                                    receiveNext()
                                }
                            }
                        }
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
            platform: "macos"
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

    private static func cleanedTextRemovingShellScript(from content: String) -> String {
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
