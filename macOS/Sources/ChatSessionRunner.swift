import Foundation

/// Drives a single chat turn over the OmniAgent WebSocket. Mirrors the
/// connection pattern used by `AgentRunner` (same endpoint, same
/// `AgentMessage` JSON wire format, same JWT/re-auth flow, same
/// `<shell_script>` / `<final_answer>` handshake) but streams every
/// agent event back to the chat view as a `ChatBlock` instead of
/// writing into the legacy `AgentThinkingModel`.
///
/// Reuses the static parsing helpers and the shell executor from
/// `AgentRunner` rather than duplicating them.
@MainActor
final class ChatSessionRunner {
    static let shared = ChatSessionRunner()
    private init() {}

    /// Start a turn. Callbacks fire on the main thread.
    ///
    /// - Parameters:
    ///   - sessionId: Existing session ID to continue, or a fresh UUID for a new chat.
    ///   - userText: The user's message.
    ///   - onBlock: Called as the agent streams reasoning, terminal output, web/MCP calls etc.
    ///   - onFinal: Called exactly once with the final answer text. After this the
    ///              underlying WebSocket has been closed.
    ///   - onError: Called if the connection fails or auth cannot be obtained.
    func run(
        sessionId: String,
        userText: String,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
        onFinal: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (Error) -> Void
    ) {
        // Acquire a JWT first (same flow as `AgentRunner.startSession`).
        if let token = SubscriptionManager.shared.jwtToken, !token.isEmpty {
            connect(
                sessionId: sessionId,
                jwt: token,
                userText: userText,
                allowReauth: true,
                onBlock: onBlock,
                onFinal: onFinal,
                onError: onError
            )
            return
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
    }

    // MARK: - WebSocket session

    private func connect(
        sessionId: String,
        jwt: String,
        userText: String,
        allowReauth: Bool,
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
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void,
        onFinal: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (Error) -> Void
    ) {
        var request = URLRequest(url: url)
        request.addValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: request)

        // Register with the shared session state so the user's Cancel
        // button (in AgentRunner.cancelCurrentSession) closes our socket too.
        Task {
            await AgentSessionState.shared.registerWebSocketTask(task)
        }

        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let finalDelivered = BoolBox()

        func finishWithError(_ error: Error) {
            if !finalDelivered.value {
                finalDelivered.value = true
                DispatchQueue.main.async { onError(error) }
            }
            task.cancel(with: .goingAway, reason: nil)
            Task { await AgentSessionState.shared.registerWebSocketTask(nil) }
        }

        func finishWithFinal(_ text: String) {
            if !finalDelivered.value {
                finalDelivered.value = true
                DispatchQueue.main.async { onFinal(text) }
            }
            task.cancel(with: .goingAway, reason: nil)
            Task { await AgentSessionState.shared.registerWebSocketTask(nil) }
        }

        func receiveNext() {
            task.receive { result in
                switch result {
                case let .failure(error):
                    // Check whether this was a user-initiated cancel — if so,
                    // surface a clean cancellation error instead of the raw
                    // socket failure.
                    Task { @MainActor in
                        let wasCancelled = await AgentSessionState.shared.takeWasCancelledByUser()
                        if wasCancelled {
                            let cancelError = NSError(
                                domain: "ChatSessionRunner",
                                code: -9999,
                                userInfo: [NSLocalizedDescriptionKey: "Chat turn cancelled."]
                            )
                            finishWithError(cancelError)
                        } else {
                            finishWithError(error)
                        }
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
                            let (output, status) = runShellCommandWithStatus(script)

                            // If the user cancelled while the command was running, discard
                            // the output and surface a clean cancellation error. The WebSocket
                            // is already closed, so attempting to send would only produce a
                            // confusing network error in the chat view.
                            if AgentSessionState.shared.isCancelledByUser {
                                print("[ChatSessionRunner] Shell execution completed but session was cancelled; discarding output.")
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
            range: startRange.upperBound ..< cleaned.endIndex
           )
        {
            cleaned.removeSubrange(startRange.lowerBound ..< endRange.upperBound)
        }
        return AgentRunner.cleanedDisplayText(from: cleaned)
    }
}
