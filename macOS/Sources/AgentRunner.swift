import Foundation

/// Simple shell execution helper that captures both the
/// output and the exit status of the command.
func runShellCommandWithStatus(_ command: String) -> (output: String, status: Int32) {
    let process = Process()
    process.launchPath = "/bin/zsh"
    process.arguments = ["-l", "-c", command]

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe

    process.launch()
    process.waitUntilExit()

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let output = String(data: data, encoding: .utf8) ?? ""
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

            enum CodingKeys: String, CodingKey {
                case sessionID = "session_id"
                case sender
                case content
                case isTerminalOutput = "is_terminal_output"
                case isError = "is_error"
            }
        }

        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        var finalAnswerDelivered = false

        func receiveNext() {
            task.receive { result in
                switch result {
                case let .failure(error):
                    if !finalAnswerDelivered {
                        DispatchQueue.main.async {
                            completion(.failure(error))
                        }
                    }
                    task.cancel(with: .goingAway, reason: nil)

                case let .success(message):
                    guard case let .string(text) = message else {
                        // Ignore non-text messages
                        receiveNext()
                        return
                    }

                    guard let data = text.data(using: .utf8),
                          let response = try? decoder.decode(AgentMessage.self, from: data)
                    else {
                        receiveNext()
                        return
                    }

                    let content = response.content

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
                                isError: status != 0
                            )

                            if let jsonData = try? encoder.encode(reply),
                               let jsonString = String(data: jsonData, encoding: .utf8)
                            {
                                task.send(.string(jsonString)) { _ in }
                            }
                        }
                        receiveNext()
                        return
                    }

                    // If we received a final answer, surface it to the
                    // caller and close the stream.
                    if let final = AgentRunner.extractFinalAnswer(from: content) {
                        finalAnswerDelivered = true
                        DispatchQueue.main.async {
                            completion(.success(final))
                        }
                        task.cancel(with: .goingAway, reason: nil)
                        return
                    }

                    // If there is no shell script to run and no
                    // <final_answer> tag present, treat this message
                    // as the final answer as well and close the
                    // connection. This allows simpler agents that
                    // just stream plain text without special tags.
                    let answerText = !displayText.isEmpty ? displayText : content
                    finalAnswerDelivered = true
                    DispatchQueue.main.async {
                        completion(.success(answerText))
                    }
                    task.cancel(with: .goingAway, reason: nil)
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
            isError: false
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
