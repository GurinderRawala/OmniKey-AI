import Foundation
import NIO
import NIOHPACK
import GRPC

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
    private let eventLoopGroup: EventLoopGroup

    private init() {
        self.eventLoopGroup = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    }

    /// Returns true if the provided text contains an @omniAgent
    /// directive and should be handled by the gRPC agent.
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
        // Ensure we have (or can obtain) a JWT before
        // attempting to connect to the agent.
        if let token = SubscriptionManager.shared.jwtToken, !token.isEmpty {
            connectAndRun(originalText: originalText, jwt: token, completion: completion)
            return
        }

        SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
            switch outcome {
            case .success:
                let jwt = SubscriptionManager.shared.jwtToken ?? ""
                self.connectAndRun(originalText: originalText, jwt: jwt, completion: completion)

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

    /// Lightweight connectivity check to verify that the gRPC
    /// AgentService is reachable and the current JWT is valid.
    /// This opens a short-lived AgentStream and immediately
    /// closes it, reporting any transport or auth failures.
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
        // Derive the gRPC host and port from the HTTP
        // API base URL and the AGENT_GRPC_PORT env var,
        // falling back to localhost:50051 for local dev.
        let host = APIClient.baseURL.host ?? "localhost"
        let port: Int
        if let env = ProcessInfo.processInfo.environment["AGENT_GRPC_PORT"],
           let envPort = Int(env)
        {
            port = envPort
        } else {
            port = 50051
        }

        let sessionID = UUID().uuidString

        // Establish a gRPC connection using the Swift gRPC v1
        // ClientConnection API. Any transport issues will be
        // surfaced via the call status handler.
        let connection = ClientConnection
            .insecure(group: eventLoopGroup)
            .connect(host: host, port: port)

        startAgentStream(
            connection: connection,
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
        let host = APIClient.baseURL.host ?? "localhost"
        let port: Int
        if let env = ProcessInfo.processInfo.environment["AGENT_GRPC_PORT"],
           let envPort = Int(env)
        {
            port = envPort
        } else {
            port = 50051
        }

        let connection = ClientConnection
            .insecure(group: eventLoopGroup)
            .connect(host: host, port: port)

        var headers = HPACKHeaders()
        headers.add(name: "authorization", value: "Bearer \(jwt)")

        let callOptions = CallOptions(
            customMetadata: headers,
            timeLimit: .timeout(.seconds(5))
        )

        let client = Omnikey_AgentServiceNIOClient(
            channel: connection,
            defaultCallOptions: callOptions
        )

        let call = client.agentStream(callOptions: callOptions) { _ in
            // We ignore any responses for this lightweight check.
        }

        let endPromise = call.eventLoop.makePromise(of: Void.self)
        call.sendEnd(promise: endPromise)

        call.status.whenComplete { result in
            switch result {
            case let .success(status) where status.code == .ok:
                DispatchQueue.main.async {
                    completion(.success(()))
                }

            case let .success(status):
                let error = NSError(
                    domain: "AgentRunner",
                    code: Int(status.code.rawValue),
                    userInfo: [NSLocalizedDescriptionKey: status.message ?? "Agent gRPC connectivity check failed with status \(status.code)."]
                )
                DispatchQueue.main.async {
                    completion(.failure(error))
                }

            case let .failure(error):
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }

            let closePromise = self.eventLoopGroup.next().makePromise(of: Void.self)
            connection.close(promise: closePromise)
        }
    }

    /// Open the bi-directional AgentStream, send the initial
    /// user message, execute any <shell_script> blocks returned
    /// by the agent, and finally surface the <final_answer>.
    private func startAgentStream(
        connection: ClientConnection,
        sessionID: String,
        jwt: String,
        originalText: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        var headers = HPACKHeaders()
        headers.add(name: "authorization", value: "Bearer \(jwt)")

        let callOptions = CallOptions(customMetadata: headers)
        let client = Omnikey_AgentServiceNIOClient(channel: connection, defaultCallOptions: callOptions)

        var finalAnswerDelivered = false

        var streamingCall: BidirectionalStreamingCall<Omnikey_AgentMessage, Omnikey_AgentMessage>?

        streamingCall = client.agentStream(callOptions: callOptions) { response in
            let content = response.content

            // If the agent wants us to run a shell script,
            // execute it and stream the output back as a
            // terminal_output message.
            if let script = AgentRunner.extractShellScript(from: content) {
                DispatchQueue.global(qos: .userInitiated).async {
                    let (output, status) = runShellCommandWithStatus(script)

                    var reply = Omnikey_AgentMessage()
                    reply.sessionID = response.sessionID
                    reply.sender = "client"
                    reply.content = output
                    reply.isTerminalOutput = true
                    reply.isError = (status != 0)

                    if let activeCall = streamingCall {
                        let promise = activeCall.eventLoop.makePromise(of: Void.self)
                        activeCall.sendMessage(reply, promise: promise)
                    }
                }
                return
            }

            // If we received a final answer, surface it to the
            // caller and close the stream.
            if let final = AgentRunner.extractFinalAnswer(from: content) {
                finalAnswerDelivered = true
                DispatchQueue.main.async {
                    completion(.success(final))
                }
                if let activeCall = streamingCall {
                    let endPromise = activeCall.eventLoop.makePromise(of: Void.self)
                    activeCall.sendEnd(promise: endPromise)
                }
                return
            }

            // Any other agent messages (e.g. intermediate
            // reasoning) are currently ignored by the app but
            // are still part of the agent's conversation state
            // on the backend.
        }

        guard let call = streamingCall else {
            let error = NSError(
                domain: "AgentRunner",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create AgentStream call."]
            )
            DispatchQueue.main.async {
                completion(.failure(error))
            }
            return
        }

        // Send the initial user message that kicks off the
        // agent session.
        var initial = Omnikey_AgentMessage()
        initial.sessionID = sessionID
        initial.sender = "client"
        initial.content = originalText
        initial.isTerminalOutput = false
        initial.isError = false

        let sendPromise = call.eventLoop.makePromise(of: Void.self)
        call.sendMessage(initial, promise: sendPromise)

        // Observe the call status so we can surface any
        // transport-level errors if no final answer was
        // delivered.
        call.status.whenComplete { result in
            switch result {
            case let .success(status):
                if !finalAnswerDelivered {
                    let error = NSError(
                        domain: "AgentRunner",
                        code: Int(status.code.rawValue),
                        userInfo: [NSLocalizedDescriptionKey: status.message ?? "Agent stream ended without a final answer."]
                    )
                    DispatchQueue.main.async {
                        completion(.failure(error))
                    }
                }

            case let .failure(error):
                if !finalAnswerDelivered {
                    DispatchQueue.main.async {
                        completion(.failure(error))
                    }
                }
            }

            // Close the underlying connection once the
            // call has completed.
            let closePromise = self.eventLoopGroup.next().makePromise(of: Void.self)
            connection.close(promise: closePromise)
        }
    }

    // MARK: - Tag parsing helpers

    static func extractShellScript(from text: String) -> String? {
        guard let startRange = text.range(of: "<shell_script>") else { return nil }
        guard let endRange = text.range(of: "</shell_script>", range: startRange.upperBound ..< text.endIndex) else { return nil }

        let inner = text[startRange.upperBound ..< endRange.lowerBound]
        return String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func extractFinalAnswer(from text: String) -> String? {
        guard let startRange = text.range(of: "<final_answer>") else { return nil }
        guard let endRange = text.range(of: "</final_answer>", range: startRange.upperBound ..< text.endIndex) else { return nil }

        let inner = text[startRange.upperBound ..< endRange.lowerBound]
        return String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
