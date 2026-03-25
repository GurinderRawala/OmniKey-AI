import Foundation

// Concurrency-safe container for the currently running shell
// process, WebSocket task, and cancellation flag so that a
// user-initiated Cancel action can stop them cleanly.
actor AgentSessionState {
    static let shared = AgentSessionState()

    private var shellProcess: Process?
    private var webSocketTask: URLSessionWebSocketTask?
    private var wasCancelledByUser: Bool = false

    func registerShellProcess(_ process: Process?) {
        shellProcess = process
    }

    func registerWebSocketTask(_ task: URLSessionWebSocketTask?) {
        webSocketTask = task
    }

    func markCancelledByUser() {
        wasCancelledByUser = true
    }

    /// Returns and clears the cancellation flag so each
    /// session observes it at most once.
    func takeWasCancelledByUser() -> Bool {
        let flag = wasCancelledByUser
        wasCancelledByUser = false
        return flag
    }

    /// Cancel any running shell command and close the active
    /// WebSocket connection.
    func cancelCurrentSession() {
        wasCancelledByUser = true

        if let process = shellProcess, process.isRunning {
            print("[AgentRunner] Cancelling running shell process…")
            process.terminate()
        }
        shellProcess = nil

        if let task = webSocketTask {
            print("[AgentRunner] Cancelling current WebSocket task…")
            task.cancel(with: .goingAway, reason: nil)
        }
        webSocketTask = nil
    }
}

/// Simple shell execution helper that captures both the
/// output and the exit status of the command.
func runShellCommandWithStatus(_ command: String) -> (output: String, status: Int32) {
    let trimmedCommandForLog: String
    if command.count > 2000 {
        let prefix = command.prefix(2000)
        trimmedCommandForLog = String(prefix) + "... [truncated]"
    } else {
        trimmedCommandForLog = command
    }

    print("[AgentRunner] About to run shell command (length: \(command.count)):\n\(trimmedCommandForLog)")

    let process = Process()
    process.launchPath = "/bin/zsh"
    process.arguments = ["-l", "-c", command]

    // Remember this process so it can be cancelled if the user
    // presses the Cancel button in the thinking window.
    Task {
        await AgentSessionState.shared.registerShellProcess(process)
    }

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe

    process.launch()

    // Drain the pipe BEFORE calling waitUntilExit. The pipe's internal
    // buffer is ~64 KB on macOS. If the script produces more output than
    // that, the child blocks trying to write while the parent is stuck in
    // waitUntilExit waiting for the child to exit — a deadlock. Reading
    // first continuously empties the buffer so the child can always write,
    // and readDataToEndOfFile returns once the child closes the write end
    // (i.e. exits). waitUntilExit then returns immediately.
    let data = pipe.fileHandleForReading.readDataToEndOfFile()

    process.waitUntilExit()

    // Clear the tracked process once it has finished.
    Task {
        await AgentSessionState.shared.registerShellProcess(nil)
    }
    let output = String(data: data, encoding: .utf8) ?? ""

    let outputForLog: String
    if output.count > 2000 {
        let prefix = output.prefix(2000)
        outputForLog = String(prefix) + "... [truncated]"
    } else {
        outputForLog = output
    }

    print("[AgentRunner] Shell command finished with status \(process.terminationStatus). Output length: \(output.count). Sample:\n\(outputForLog)")

    return (output, process.terminationStatus)
}

/// Orchestrates a single @omniAgent run by talking to the backend
/// gRPC AgentService and executing any <shell_script> blocks
/// returned by the model. Terminal output is streamed back to
/// the backend as context until a <final_answer> is produced.
@MainActor
final class AgentRunner {
    static let shared = AgentRunner()
    private init() {}

    /// Cancel the current agent session, if any. This will
    /// terminate a running shell command and close the active
    /// WebSocket connection via the shared AgentSessionState
    /// actor. KeyboardMonitor treats this as a user-cancelled
    /// run and will not show an error.
    func cancelCurrentSession() {
        Task {
            await AgentSessionState.shared.cancelCurrentSession()
        }
    }

    /// Returns true if the provided text contains an @omniAgent
    func containsAgentDirective(_ text: String) -> Bool {
        return text.range(of: "@omniAgent", options: .caseInsensitive) != nil
    }

    /// Run a single agent session for the given input text.
    /// The completion handler is invoked on the main thread
    /// with either the final answer or an error.
    func runAgentSession(
        originalText: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        func startSession(with jwt: String, allowReauth: Bool) {
            connectAndRun(originalText: originalText, jwt: jwt) { result in
                // If the user pressed Cancel, surface a dedicated
                // cancellation error and skip any re-auth logic.
                Task { @MainActor in
                    let wasCancelled = await AgentSessionState.shared.takeWasCancelledByUser()
                    if wasCancelled {
                        let cancelError = NSError(
                            domain: "AgentRunner",
                            code: -9999,
                            userInfo: [NSLocalizedDescriptionKey: "Agent run cancelled by user."]
                        )

                        completion(.failure(cancelError))
                        return
                    }

                switch result {
                case .success:
                    completion(result)

                case let .failure(error):
                    guard allowReauth else {
                        completion(.failure(error))
                        return
                    }

                    SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
                        switch outcome {
                        case .success:
                            let newJwt = SubscriptionManager.shared.jwtToken ?? ""
                            DispatchQueue.main.async {
                                startSession(with: newJwt, allowReauth: false)
                            }

                        case .noStoredKey, .expired:
                            DispatchQueue.main.async {
                                completion(.failure(error))
                            }

                        case let .failure(activationError):
                            DispatchQueue.main.async {
                                completion(.failure(activationError))
                            }
                        }
                    }
                }
                }
            }
        }

        // Ensure we have (or can obtain) a JWT before
        // attempting to connect to the agent.
        if let token = SubscriptionManager.shared.jwtToken, !token.isEmpty {
            startSession(with: token, allowReauth: true)
            return
        }

        SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
            switch outcome {
            case .success:
                let jwt = SubscriptionManager.shared.jwtToken ?? ""
                DispatchQueue.main.async {
                    startSession(with: jwt, allowReauth: false)
                }

            case .noStoredKey, .expired:
                let error = NSError(
                    domain: "AgentRunner",
                    code: 401,
                    userInfo: [NSLocalizedDescriptionKey: "Subscription is not active."]
                )
                DispatchQueue.main.async {
                    completion(.failure(error))
                }

            case let .failure(error):
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }

    /// Lightweight connectivity check to verify that the WebSocket
    /// agent endpoint is reachable and the current JWT is valid.
    func checkAgentConnectivity(
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        if let token = SubscriptionManager.shared.jwtToken, !token.isEmpty {
            connectAndCheck(jwt: token, completion: completion)
            return
        }

        SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
            switch outcome {
            case .success:
                let jwt = SubscriptionManager.shared.jwtToken ?? ""
                self.connectAndCheck(jwt: jwt, completion: completion)

            case .noStoredKey, .expired:
                let error = NSError(
                    domain: "AgentRunner",
                    code: 401,
                    userInfo: [NSLocalizedDescriptionKey: "Subscription is not active."]
                )
                DispatchQueue.main.async {
                    completion(.failure(error))
                }

            case let .failure(error):
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }

    private func connectAndRun(
        originalText: String,
        jwt: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        guard let url = makeAgentWebSocketURL() else {
            let error = NSError(
                domain: "AgentRunner",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to construct agent WebSocket URL."]
            )
            DispatchQueue.main.async {
                completion(.failure(error))
            }
            return
        }

        print("[AgentRunner] Connecting WebSocket to: \(url.absoluteString)")

        let sessionID = UUID().uuidString
        startAgentWebSocketSession(
            url: url,
            sessionID: sessionID,
            jwt: jwt,
            originalText: originalText,
            completion: completion
        )
    }

    private func connectAndCheck(
        jwt: String,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        guard let url = makeAgentWebSocketURL() else {
            let error = NSError(
                domain: "AgentRunner",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to construct agent WebSocket URL."]
            )
            DispatchQueue.main.async {
                completion(.failure(error))
            }
            return
        }

        var request = URLRequest(url: url)
        request.addValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: request)

        // Track the active WebSocket so it can be closed when the
        // user cancels an in-progress agent session.
        Task {
            await AgentSessionState.shared.registerWebSocketTask(task)
        }

        task.resume()

        task.sendPing { error in
            DispatchQueue.main.async {
                if let error {
                    completion(.failure(error))
                } else {
                    completion(.success(()))
                }
            }
            task.cancel(with: .goingAway, reason: nil)
        }
    }

    /// Open the bi-directional WebSocket stream, send the initial
    /// user message, execute any <shell_script> blocks returned
    /// by the agent, and finally surface the <final_answer>.
    private func startAgentWebSocketSession(
        url: URL,
        sessionID: String,
        jwt: String,
        originalText: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        var request = URLRequest(url: url)
        request.addValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: request)

        struct AgentMessage: Codable {
            let sessionID: String
            let sender: String
            let content: String
            let isTerminalOutput: Bool?
            let isError: Bool?
            let isWebCall: Bool?
            let platform: String?

            init(
                sessionID: String,
                sender: String,
                content: String,
                isTerminalOutput: Bool? = nil,
                isError: Bool? = nil,
                isWebCall: Bool? = nil,
                platform: String? = nil
            ) {
                self.sessionID = sessionID
                self.sender = sender
                self.content = content
                self.isTerminalOutput = isTerminalOutput
                self.isError = isError
                self.isWebCall = isWebCall
                self.platform = platform
            }

            enum CodingKeys: String, CodingKey {
                case sessionID = "session_id"
                case sender
                case content
                case isTerminalOutput = "is_terminal_output"
                case isError = "is_error"
                case isWebCall = "is_web_call"
                case platform
            }
        }

        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        var finalAnswerDelivered = false

        func receiveNext() {
            task.receive { result in
                switch result {
                case let .failure(error):
                    print("[AgentRunner] WebSocket receive failed: \(error.localizedDescription)")
                    if !finalAnswerDelivered {
                        DispatchQueue.main.async {
                            completion(.failure(error))
                        }
                    }
                    task.cancel(with: .goingAway, reason: nil)
                    Task {
                        await AgentSessionState.shared.registerWebSocketTask(nil)
                    }

                case let .success(message):
                    guard case let .string(text) = message else {
                        // Ignore non-text messages
                        print("[AgentRunner] Received non-text WebSocket message; ignoring.")
                        receiveNext()
                        return
                    }

                    print("[AgentRunner] Received WebSocket text message (length: \(text.count))")

                    guard let data = text.data(using: .utf8),
                          let response = try? decoder.decode(AgentMessage.self, from: data)
                    else {
                        print("[AgentRunner] Failed to decode AgentMessage from text payload.")
                        receiveNext()
                        return
                    }

                    let content = response.content

                    // Web call notification: show it in the thinking view and
                    // keep listening — this is not a final answer.
                    if response.isWebCall == true {
                        DispatchQueue.main.async {
                            AgentThinkingModel.shared.appendWebCall(content)
                        }
                        receiveNext()
                        return
                    }

                    // Surface a cleaned, human-readable version of
                    // the agent's message (without XML-like tags)
                    // directly to the shared thinking model so the
                    // UI can display a streaming transcript.
                    let displayText = AgentRunner.cleanedDisplayText(from: content)
                    if !displayText.isEmpty {
                        DispatchQueue.main.async {
                            AgentThinkingModel.shared.append(displayText)
                        }
                    }

                    // If the agent wants us to run a shell script,
                    // execute it and stream the output back as a
                    // terminal_output message.
                    if let script = AgentRunner.extractShellScript(from: content) {
                        print("[AgentRunner] Detected <shell_script> block in agent response. Script length: \(script.count)")
                        DispatchQueue.global(qos: .userInitiated).async {
                            let (output, status) = runShellCommandWithStatus(script)

                            // Surface the terminal output in the thinking window so
                            // the user can see exactly what the command produced.
                            DispatchQueue.main.async {
                                let statusLabel = (status == 0) ? "success" : "error (exit code: \(status))"
                                let display = "[terminal \(statusLabel)]\n\(output)"
                                AgentThinkingModel.shared.append(display)
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
                                print("[AgentRunner] Failed to encode terminal output reply; aborting session.")
                                if !finalAnswerDelivered {
                                    DispatchQueue.main.async {
                                        completion(.failure(NSError(
                                            domain: "AgentRunner",
                                            code: -2,
                                            userInfo: [NSLocalizedDescriptionKey: "Failed to encode terminal output."]
                                        )))
                                    }
                                }
                                task.cancel(with: .goingAway, reason: nil)
                                Task { await AgentSessionState.shared.registerWebSocketTask(nil) }
                                return
                            }

                            print("[AgentRunner] Sending terminal output back to agent. Exit status: \(status). Output length: \(output.count). Encoded JSON length: \(jsonData.count)")

                            // Send the terminal output and resume the receive loop only
                            // after the send succeeds. Ignoring the callback here was the
                            // bug: a silent send failure left the pending receiveNext()
                            // waiting forever for a server reply that never arrived.
                            task.send(.string(jsonString)) { error in
                                if let error = error {
                                    print("[AgentRunner] Failed to send terminal output: \(error.localizedDescription)")
                                    if !finalAnswerDelivered {
                                        DispatchQueue.main.async {
                                            completion(.failure(error))
                                        }
                                    }
                                    task.cancel(with: .goingAway, reason: nil)
                                    Task { await AgentSessionState.shared.registerWebSocketTask(nil) }
                                } else {
                                    // Terminal output delivered; listen for the agent's next message.
                                    receiveNext()
                                }
                            }
                        }
                        return
                    }

                    // If we received a final answer, surface it to the
                    // caller and close the stream.
                    if let final = AgentRunner.extractFinalAnswer(from: content) {
                        print("[AgentRunner] Detected <final_answer> block in agent response. Length: \(final.count)")
                        finalAnswerDelivered = true
                        DispatchQueue.main.async {
                            completion(.success(final))
                        }
                        task.cancel(with: .goingAway, reason: nil)
                        Task {
                            await AgentSessionState.shared.registerWebSocketTask(nil)
                        }
                        return
                    }

                    // If there is no shell script to run and no
                    // <final_answer> tag present, treat this message
                    // as the final answer as well and close the
                    // connection. This allows simpler agents that
                    // just stream plain text without special tags.
                    let answerText = !displayText.isEmpty ? displayText : content
                    print("[AgentRunner] Treating agent message as implicit final answer. Length: \(answerText.count)")
                    finalAnswerDelivered = true
                    DispatchQueue.main.async {
                        completion(.success(answerText))
                    }
                    task.cancel(with: .goingAway, reason: nil)
                    Task {
                        await AgentSessionState.shared.registerWebSocketTask(nil)
                    }
                    return
                }
            }
        }

        task.resume()

        // Send the initial user message that kicks off the agent session.
        let initial = AgentMessage(
            sessionID: sessionID,
            sender: "client",
            content: originalText,
            isTerminalOutput: false,
            isError: false,
            platform: "macos"
        )

        if let data = try? encoder.encode(initial),
           let json = String(data: data, encoding: .utf8)
        {
            print("[AgentRunner] Sending initial WebSocket message (length: \(json.count))")
            task.send(.string(json)) { error in
                if let error, !finalAnswerDelivered {
                    print("[AgentRunner] Failed to send initial WebSocket message: \(error.localizedDescription)")
                    DispatchQueue.main.async {
                        completion(.failure(error))
                    }
                    task.cancel(with: .goingAway, reason: nil)
                    return
                }

                print("[AgentRunner] Initial WebSocket message sent successfully, starting receive loop…")
                // Start receiving responses once the initial
                // message has been sent.
                receiveNext()
            }
        } else {
            let error = NSError(
                domain: "AgentRunner",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode initial agent message."]
            )
            DispatchQueue.main.async {
                completion(.failure(error))
            }
            task.cancel(with: .goingAway, reason: nil)
        }
    }

    // MARK: - Tag parsing helpers

    static func extractShellScript(from text: String) -> String? {
        guard let startRange = text.range(of: "<shell_script>") else { return nil }
        guard let endRange = text.range(of: "</shell_script>", range: startRange.upperBound ..< text.endIndex) else { return nil }

        let inner = text[startRange.upperBound ..< endRange.lowerBound]
        return String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Remove internal XML-like tags used by the agent protocol
    /// so that we can show a clean, human-readable stream of
    /// content in the UI.
    static func cleanedDisplayText(from text: String) -> String {
        var result = text
        let tags = ["<shell_script>", "</shell_script>", "<final_answer>", "</final_answer>"]
        for tag in tags {
            result = result.replacingOccurrences(of: tag, with: "")
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func extractFinalAnswer(from text: String) -> String? {
        guard let startRange = text.range(of: "<final_answer>") else { return nil }
        guard let endRange = text.range(of: "</final_answer>", range: startRange.upperBound ..< text.endIndex) else { return nil }

        let inner = text[startRange.upperBound ..< endRange.lowerBound]
        return String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - URL helpers

    /// Construct the WebSocket URL for the agent endpoint based on the
    /// configured HTTP API base URL. This mirrors the backend's
    /// /ws/omni-agent path.
    private func makeAgentWebSocketURL() -> URL? {
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
}
