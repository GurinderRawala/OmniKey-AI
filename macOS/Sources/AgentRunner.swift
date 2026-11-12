import Foundation

// Concurrency-safe container for the currently running shell
// process, WebSocket task, and cancellation flag so that a
// user-initiated Cancel action can stop them cleanly.
actor AgentSessionState {
    static let shared = AgentSessionState()

    private var shellProcess: Process?
    private var webSocketTask: URLSessionWebSocketTask?
    private var wasCancelledByUser: Bool = false

    // Fast synchronous flag readable from DispatchQueue closures without await.
    // Written only under actor isolation; reads are intentionally unsynchronised
    // (single-writer, multiple-reader boolean — safe in practice).
    private let _cancelFlag = BoolBox()

    /// Non-async check for DispatchQueue.global closures that cannot await.
    nonisolated var isCancelledByUser: Bool { _cancelFlag.value }

    func registerShellProcess(_ process: Process?) {
        shellProcess = process
    }

    func registerWebSocketTask(_ task: URLSessionWebSocketTask?) {
        webSocketTask = task
    }

    func markCancelledByUser() {
        wasCancelledByUser = true
        _cancelFlag.value = true
    }

    /// Returns and clears the cancellation flag so each
    /// session observes it at most once.
    func takeWasCancelledByUser() -> Bool {
        let flag = wasCancelledByUser
        wasCancelledByUser = false
        _cancelFlag.value = false
        return flag
    }

    /// Cancel any running shell command and close the active
    /// WebSocket connection.
    func cancelCurrentSession() {
        wasCancelledByUser = true
        _cancelFlag.value = true

        if let process = shellProcess, process.isRunning {
            let pid = process.processIdentifier
            // Kill the entire process group so child processes spawned by the
            // script also receive SIGTERM and don't linger after cancellation.
            kill(-pid, SIGTERM)
            process.terminate()
            print("[AgentRunner] Sent SIGTERM to process group \(pid) and process.")
        }
        shellProcess = nil

        if let task = webSocketTask {
            print("[AgentRunner] Cancelling current WebSocket task…")
            task.cancel(with: .goingAway, reason: nil)
        }
        webSocketTask = nil
    }
}

/// Returns the path of the user's preferred login shell by reading $SHELL
/// from the current process environment. Falls back to /bin/zsh then
/// /bin/bash if the value is absent or points to a non-executable path.
func resolvedLoginShell() -> String {
    let envShell = ProcessInfo.processInfo.environment["SHELL"] ?? ""
    let candidates = [
        envShell,
        // zsh — default on macOS Catalina+; also available via Homebrew
        "/bin/zsh",
        "/usr/bin/zsh",
        "/usr/local/bin/zsh",       // Homebrew (Intel)
        "/opt/homebrew/bin/zsh",    // Homebrew (Apple Silicon)
        // bash — default on older macOS / most Linux distros
        "/bin/bash",
        "/usr/bin/bash",
        "/usr/local/bin/bash",      // Homebrew (Intel)
        "/opt/homebrew/bin/bash",   // Homebrew (Apple Silicon)
        // fish — popular third-party shell, installed via Homebrew or package manager
        "/usr/local/bin/fish",      // Homebrew (Intel)
        "/opt/homebrew/bin/fish",   // Homebrew (Apple Silicon)
        "/usr/bin/fish",
        // ksh — KornShell, common on Linux
        "/bin/ksh",
        "/usr/bin/ksh",
        "/usr/local/bin/ksh",
        // tcsh — legacy, still present on some macOS/BSD systems
        "/bin/tcsh",
        "/usr/bin/tcsh",
        // sh — POSIX fallback, always present
        "/bin/sh",
        "/usr/bin/sh",
    ]
    for candidate in candidates where !candidate.isEmpty {
        if FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return "/bin/sh"
}

/// Thread-safe boolean flag used to guard against calling a completion
/// handler more than once across URLSession WebSocket callbacks.
final class BoolBox: @unchecked Sendable { var value = false }

/// Wire message for the hotkey (`@omniAgent`) WebSocket session.
struct HotkeyAgentMessage: Codable, Equatable, Sendable {
    let sessionID: String
    let sender: String
    let content: String
    let isTerminalOutput: Bool?
    let isError: Bool?
    let isWebCall: Bool?
    let isImageRendering: Bool?
    let isMcpCall: Bool?
    let platform: String?
    /// Opt-in for Skills notices; sent only on the user's input.
    let supportsSkillStatus: Bool?

    init(
        sessionID: String,
        sender: String,
        content: String,
        isTerminalOutput: Bool? = nil,
        isError: Bool? = nil,
        isWebCall: Bool? = nil,
        isImageRendering: Bool? = nil,
        isMcpCall: Bool? = nil,
        platform: String? = nil,
        supportsSkillStatus: Bool? = nil
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
        self.supportsSkillStatus = supportsSkillStatus
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
        case supportsSkillStatus = "supports_skill_status"
    }
}

/// Pure decision for one inbound hotkey-agent frame. `AgentRunner`'s
/// receive loop calls this for every text frame and only performs the side
/// effects (UI, shell, completion) the action names, so the ordering —
/// Skills notices first, before decode, shell or final-answer parsing — is
/// testable without a socket.
enum HotkeyAgentFrame {
    enum Disposition: Equatable, Sendable {
        case runShellScript(String)
        case finalAnswer(String)
        /// No tags: this runner treats the text as the final answer.
        case implicitFinalAnswer(String)
        /// A terminal frame marked `is_error` (e.g. Skills blocked the run).
        /// Completes with an error and is never pasted into the document.
        /// The string is a sanitized single line safe for an alert.
        case failure(String)
        /// The backend rejected the connection's credentials before
        /// processing the message (legacy untagged frame: `is_error`, empty
        /// `session_id`, `Unauthorized:` text). The only replay-safe failure.
        case unauthorized
    }

    /// The backend's pre-processing auth rejection (agentServer/websocket.ts).
    /// It has no error code, so match its fixed shape exactly.
    static func isAuthRejection(_ message: HotkeyAgentMessage) -> Bool {
        message.isError == true && message.sessionID.isEmpty && message.sender == "agent"
            && message.content.hasPrefix("Unauthorized:")
    }

    static let genericFailureText = "The agent could not complete this request."
    static let failureTextLimit = 300

    /// Single-line, length-capped failure text: the cleaned server message
    /// without markup, controls or bidi/format characters, or a fixed
    /// fallback when nothing readable remains.
    static func safeFailureText(from raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("**Error:**") { text = String(text.dropFirst("**Error:**".count)) }
        var scalars = String.UnicodeScalarView()
        var lastWasSpace = false
        for scalar in text.unicodeScalars {
            let category = scalar.properties.generalCategory
            let breaking = category == .control || category == .format
                || category == .lineSeparator || category == .paragraphSeparator
                || scalar.properties.isWhitespace
            if breaking {
                if !lastWasSpace { scalars.append(" ") }
                lastWasSpace = true
            } else {
                scalars.append(scalar)
                lastWasSpace = false
            }
        }
        var line = String(scalars).trimmingCharacters(in: .whitespaces)
        if line.count > failureTextLimit { line = String(line.prefix(failureTextLimit)) + "…" }
        return line.isEmpty ? genericFailureText : line
    }

    enum Action: Equatable, Sendable {
        /// A Skills notice (valid, duplicate or malformed). Never executes
        /// or completes; `display` is literal live-only text, or nil.
        case skillNotice(display: String?)
        case undecodable
        case webCall(String)
        case imageRendering(String)
        case mcpCall(String)
        case agentText(HotkeyAgentMessage, display: String, disposition: Disposition)
    }

    static func action(for data: Data, tracker: SkillStatusTracker) -> Action {
        if case let .consumed(display) = SkillNoticeInterceptor.intercept(data, tracker: tracker) {
            return .skillNotice(display: display)
        }
        guard let message = try? JSONDecoder().decode(HotkeyAgentMessage.self, from: data) else {
            return .undecodable
        }
        let content = message.content
        if message.isWebCall == true { return .webCall(content) }
        if message.isImageRendering == true { return .imageRendering(content) }
        if message.isMcpCall == true { return .mcpCall(content) }

        let display = AgentRunner.cleanedDisplayText(from: content)
        let disposition: Disposition
        if isAuthRejection(message) {
            disposition = .unauthorized
        } else if let script = AgentRunner.extractShellScript(from: content) {
            disposition = .runShellScript(script)
        } else if let final = AgentRunner.extractFinalAnswer(from: content) {
            // Server-generated terminal failures (e.g. Skills blocked) are
            // final answers with is_error; never deliver them as the answer.
            disposition = message.isError == true ? .failure(safeFailureText(from: final)) : .finalAnswer(final)
        } else {
            disposition = .implicitFinalAnswer(display.isEmpty ? content : display)
        }
        return .agentText(message, display: display, disposition: disposition)
    }
}

/// When a failed hotkey run may re-authenticate and resend the original
/// message. Replaying re-runs the whole request, so it is allowed only when
/// the backend provably did no work: its credentials were rejected (WebSocket
/// handshake 401/403, or the pre-processing `Unauthorized:` frame). Terminal
/// agent errors (`AgentRunner/-3`), transport and provider failures can
/// follow completed tool work and are reported, never replayed. The replay
/// must also stay on the identity the run started with; a refreshed JWT for
/// the same backend + subscription is fine.
enum AgentAuthRetry {
    static let domain = "AgentRunner"
    static let code = 401

    static func authenticationError() -> NSError {
        NSError(
            domain: domain, code: code,
            userInfo: [NSLocalizedDescriptionKey: "Subscription is not active. Please re-activate your key."]
        )
    }

    static func isAuthenticationFailure(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == domain && error.code == code
    }

    /// A socket error, reclassified as an auth failure if the server
    /// refused the WebSocket upgrade for credentials.
    static func socketError(_ error: Error, handshakeStatus: Int?) -> Error {
        handshakeStatus == 401 || handshakeStatus == 403 ? authenticationError() : error
    }

    static func shouldReauthenticate(after error: Error, allowReauth: Bool) -> Bool {
        allowReauth && isAuthenticationFailure(error)
    }

    static func mayReplay(startedFor started: SubscriptionIdentity?, current: SubscriptionIdentity?) -> Bool {
        started != nil && started == current
    }

    /// Token and backend for a send of a run that started for `started`:
    /// only from one snapshot, only for that identity, never empty.
    static func credentials(
        for started: SubscriptionIdentity?, from snapshot: SubscriptionAuthSnapshot
    ) -> (token: String, baseURL: URL)? {
        guard mayReplay(startedFor: started, current: snapshot.identity),
              let token = snapshot.token, !token.isEmpty
        else { return nil }
        return (token, snapshot.baseURL)
    }
}

/// Box that holds an optional closure so it can be captured by reference
/// inside @Sendable closures without triggering data-race warnings.
final class ClosureBox<T>: @unchecked Sendable { var call: T? }

/// Simple shell execution helper that captures both the
/// output and the exit status of the command.
///
/// - Parameters:
///   - command: Shell script body to run via the user's login shell.
///   - processRegistrar: Optional sink invoked with the live `Process` once it
///     has launched, and again with `nil` after it has exited. Callers that
///     need per-turn cancellation (e.g. `ChatSessionRunner`) pass a closure
///     that attaches the process to their own handle, so cancellation only
///     touches their own running script. When `nil`, the helper falls back to
///     registering with the shared `AgentSessionState` so the legacy
///     `@omniAgent` keyboard flow keeps working unchanged.
func runShellCommandWithStatus(
    _ command: String,
    processRegistrar: (@Sendable (Process?) -> Void)? = nil
) -> (output: String, status: Int32) {
    let trimmedCommandForLog: String
    if command.count > 2000 {
        let prefix = command.prefix(2000)
        trimmedCommandForLog = String(prefix) + "... [truncated]"
    } else {
        trimmedCommandForLog = command
    }

    print("[AgentRunner] About to run shell command (length: \(command.count)):\n\(trimmedCommandForLog)")

    let shellPath = resolvedLoginShell()
    print("[AgentRunner] Using shell: \(shellPath)")

    let process = Process()
    process.launchPath = shellPath
    process.arguments = ["-l", "-c", command]

    // Track the live process so it can be cancelled. Caller-provided
    // registrars own the lifecycle for parallel-safe per-turn cancellation;
    // when none is supplied we fall back to the shared global slot used by
    // the legacy `@omniAgent` flow.
    if let registrar = processRegistrar {
        registrar(process)
    } else {
        Task {
            await AgentSessionState.shared.registerShellProcess(process)
        }
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

    // Clear the tracked process once it has finished, on whichever sink the
    // caller chose. Cancellation that ran concurrently with the script is
    // still observable to the caller via its own cancel flag.
    if let registrar = processRegistrar {
        registrar(nil)
    } else {
        Task {
            await AgentSessionState.shared.registerShellProcess(nil)
        }
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
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        // Fetch existing sessions first so we can offer the session picker.
        AgentThinkingModel.shared.fetchSessions {
            Task { @MainActor in
                let sessions = AgentThinkingModel.shared.availableSessions

                // If the user has stored a default session, skip the picker entirely.
                if let stored = AgentThinkingModel.storedDefaultSessionId {
                    if stored == AgentThinkingModel.newSessionSentinel {
                        // Default is "New Session" — start fresh immediately.
                        AgentThinkingModel.shared.selectedSessionId = nil
                        AgentThinkingModel.shared.currentSessionTitle = "New Session"
                        AgentThinkingModel.shared.remainingContextTokens = 0
                        self.startSession(originalText: originalText, completion: completion)
                        return
                    } else if let session = sessions.first(where: { $0.id == stored }) {
                        // Default session still exists — auto-select it.
                        AgentThinkingModel.shared.selectedSessionId = session.id
                        AgentThinkingModel.shared.currentSessionTitle = session.title
                        AgentThinkingModel.shared.remainingContextTokens = session.remainingContextTokens
                        self.startSession(originalText: originalText, completion: completion)
                        return
                    }
                    // Stored session no longer exists — clear it and fall through to the picker.
                    AgentThinkingModel.storedDefaultSessionId = nil
                }

                // Show the picker whenever there are existing sessions and the
                // user has not already chosen one this run. This lets them
                // continue an old session or start fresh every time.
                if !sessions.isEmpty {
                    AgentThinkingModel.shared.isShowingSessionPicker = true

                    // The picker runs asynchronously. Poll until dismissed.
                    self.waitForSessionPickerThenRun(originalText: originalText, completion: completion)
                } else {
                    // No existing sessions — start a brand-new one immediately.
                    AgentThinkingModel.shared.selectedSessionId = nil
                    AgentThinkingModel.shared.currentSessionTitle = "New Session"
                    AgentThinkingModel.shared.remainingContextTokens = 0
                    self.startSession(originalText: originalText, completion: completion)
                }
            }
        }
    }

    /// Polls until the session picker sheet has been dismissed, then
    /// proceeds with the agent run using the chosen session ID.
    private func waitForSessionPickerThenRun(
        originalText: String,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        if !AgentThinkingModel.shared.isShowingSessionPicker {
            // Picker was dismissed — proceed with whatever the user chose.
            startSession(originalText: originalText, completion: completion)
            return
        }
        // Wait 100 ms and check again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.waitForSessionPickerThenRun(originalText: originalText, completion: completion)
        }
    }

    /// Internal: kick off the JWT acquisition and WebSocket connection,
    /// using `AgentThinkingModel.shared.selectedSessionId` as the
    /// session ID (or a fresh UUID if nil).
    private func startSession(
        originalText: String,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        let chosenSessionId = AgentThinkingModel.shared.selectedSessionId ?? UUID().uuidString
        // One snapshot: the identity this run acts for, and (if issued for
        // it) the token and backend of the first send.
        let initial = SubscriptionManager.shared.authSnapshot()
        let startIdentity = initial.identity
        let notActive = NSError(
            domain: "AgentRunner",
            code: 401,
            userInfo: [NSLocalizedDescriptionKey: "Subscription is not active."]
        )

        // Pre-load prior turns so the view can show a compact history banner.
        if AgentThinkingModel.shared.selectedSessionId != nil {
            AgentThinkingModel.shared.fetchSessionHistory(for: chosenSessionId)
        }

        let sessionBox = ClosureBox<@MainActor @Sendable (String, URL, Bool) -> Void>()
        sessionBox.call = { [self] jwt, baseURL, allowReauth in
            self.connectAndRun(originalText: originalText, sessionId: chosenSessionId, jwt: jwt, baseURL: baseURL) { result in
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
                    // Only a credentials rejection is replayed; anything
                    // else may follow completed tool work.
                    guard AgentAuthRetry.shouldReauthenticate(after: error, allowReauth: allowReauth) else {
                        completion(.failure(error))
                        return
                    }

                    SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
                        switch outcome {
                        case .success:
                            DispatchQueue.main.async {
                                // Never resend this request as another subscription.
                                guard let next = AgentAuthRetry.credentials(
                                    for: startIdentity, from: SubscriptionManager.shared.authSnapshot()
                                ) else {
                                    completion(.failure(error))
                                    return
                                }
                                sessionBox.call?(next.token, next.baseURL, false)
                            }

                        case .superseded:
                            // Another subscription/backend is current: never
                            // replay this run as it.
                            DispatchQueue.main.async {
                                completion(.failure(SubscriptionManager.supersededError))
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
        if let first = AgentAuthRetry.credentials(for: startIdentity, from: initial) {
            sessionBox.call?(first.token, first.baseURL, true)
            return
        }

        SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
            switch outcome {
            case .success:
                DispatchQueue.main.async {
                    // Only send for the identity this run started with.
                    guard let first = AgentAuthRetry.credentials(
                        for: startIdentity, from: SubscriptionManager.shared.authSnapshot()
                    ) else {
                        completion(.failure(notActive))
                        return
                    }
                    sessionBox.call?(first.token, first.baseURL, false)
                }

            case .superseded:
                DispatchQueue.main.async {
                    completion(.failure(SubscriptionManager.supersededError))
                }

            case .noStoredKey, .expired:
                DispatchQueue.main.async {
                    completion(.failure(notActive))
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

            case .superseded:
                DispatchQueue.main.async {
                    completion(.failure(SubscriptionManager.supersededError))
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

    private func connectAndRun(
        originalText: String,
        sessionId: String,
        jwt: String,
        baseURL: URL,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        // The backend the token was issued for, not a fresh config read.
        guard let url = makeAgentWebSocketURL(baseURL: baseURL) else {
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

        startAgentWebSocketSession(
            url: url,
            sessionID: sessionId,
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
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        var request = URLRequest(url: url)
        request.addValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: request)

        typealias AgentMessage = HotkeyAgentMessage

        let encoder = JSONEncoder()

        let finalAnswerDelivered = BoolBox()
        // Live-only Skills feedback, deduplicated for this run alone.
        let skillNotices = SkillStatusTracker()

        func receiveNext() {
            task.receive { result in
                switch result {
                case let .failure(error):
                    print("[AgentRunner] WebSocket receive failed: \(error.localizedDescription)")
                    if !finalAnswerDelivered.value {
                        let mapped = AgentAuthRetry.socketError(
                            error, handshakeStatus: (task.response as? HTTPURLResponse)?.statusCode
                        )
                        DispatchQueue.main.async {
                            completion(.failure(mapped))
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

                    // Every frame goes through the pure classifier, which
                    // consumes Skills notices before any decode, shell or
                    // final-answer handling (this runner otherwise treats
                    // untagged text as the final answer).
                    let action = HotkeyAgentFrame.action(for: Data(text.utf8), tracker: skillNotices)

                    let response: AgentMessage
                    let displayText: String
                    let disposition: HotkeyAgentFrame.Disposition
                    switch action {
                    case let .skillNotice(display):
                        if let display {
                            DispatchQueue.main.async {
                                AgentThinkingModel.shared.append(display)
                            }
                        }
                        receiveNext()
                        return

                    case .undecodable:
                        print("[AgentRunner] Failed to decode AgentMessage from text payload.")
                        receiveNext()
                        return

                    // Web/image/MCP notifications: show them in the thinking
                    // view and keep listening — they are not final answers.
                    case let .webCall(content):
                        DispatchQueue.main.async {
                            AgentThinkingModel.shared.appendWebCall(content)
                        }
                        receiveNext()
                        return

                    case let .imageRendering(content):
                        DispatchQueue.main.async {
                            AgentThinkingModel.shared.appendImageRendering(content)
                        }
                        receiveNext()
                        return

                    case let .mcpCall(content):
                        DispatchQueue.main.async {
                            AgentThinkingModel.shared.appendMcpCall(content)
                        }
                        receiveNext()
                        return

                    case let .agentText(message, display, kind):
                        response = message
                        displayText = display
                        disposition = kind
                    }

                    // Credentials rejected before any work: fail as an auth
                    // error (the caller may refresh and replay once).
                    if case .unauthorized = disposition {
                        print("[AgentRunner] Agent rejected credentials; completing with auth failure.")
                        finalAnswerDelivered.value = true
                        DispatchQueue.main.async {
                            completion(.failure(AgentAuthRetry.authenticationError()))
                        }
                        task.cancel(with: .goingAway, reason: nil)
                        Task {
                            await AgentSessionState.shared.registerWebSocketTask(nil)
                        }
                        return
                    }

                    // Surface a cleaned, human-readable version of
                    // the agent's message (without XML-like tags)
                    // directly to the shared thinking model so the
                    // UI can display a streaming transcript.
                    if !displayText.isEmpty {
                        DispatchQueue.main.async {
                            AgentThinkingModel.shared.append(displayText)
                        }
                    }

                    // If the agent wants us to run a shell script,
                    // execute it and stream the output back as a
                    // terminal_output message.
                    if case let .runShellScript(script) = disposition {
                        print("[AgentRunner] Detected <shell_script> block in agent response. Script length: \(script.count)")
                        DispatchQueue.global(qos: .userInitiated).async {
                            // Session Changes capture for the legacy hotkey flow:
                            // only sessions with opted-in roots are captured.
                            SessionChangeTracker.shared.beforeTool(sessionID: sessionID)
                            let (output, status) = runShellCommandWithStatus(script)
                            SessionChangeTracker.shared.afterTool(sessionID: sessionID)

                            // If the user cancelled while the command was running, discard
                            // the output instead of sending stale terminal results back to
                            // the agent. The WebSocket is already closed at this point, so
                            // we just surface a clean cancellation and stop.
                            if AgentSessionState.shared.isCancelledByUser {
                                print("[AgentRunner] Shell execution completed but session was cancelled; discarding output.")
                                if !finalAnswerDelivered.value {
                                    finalAnswerDelivered.value = true
                                    DispatchQueue.main.async {
                                        completion(.failure(NSError(
                                            domain: "AgentRunner",
                                            code: -9999,
                                            userInfo: [NSLocalizedDescriptionKey: "Agent run cancelled by user."]
                                        )))
                                    }
                                }
                                return
                            }

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
                                if !finalAnswerDelivered.value {
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
                                    if !finalAnswerDelivered.value {
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
                    if case let .finalAnswer(final) = disposition {
                        print("[AgentRunner] Detected <final_answer> block in agent response. Length: \(final.count)")
                        finalAnswerDelivered.value = true
                        DispatchQueue.main.async {
                            AgentThinkingModel.shared.appendFinalResult(final)
                            completion(.success(final))
                        }
                        task.cancel(with: .goingAway, reason: nil)
                        Task {
                            await AgentSessionState.shared.registerWebSocketTask(nil)
                        }
                        return
                    }

                    // Server-reported terminal error: fail the run so the
                    // caller shows an alert instead of pasting the text.
                    if case let .failure(reason) = disposition {
                        print("[AgentRunner] Agent reported an error; completing with failure.")
                        finalAnswerDelivered.value = true
                        DispatchQueue.main.async {
                            completion(.failure(NSError(
                                domain: "AgentRunner",
                                code: -3,
                                userInfo: [NSLocalizedDescriptionKey: reason]
                            )))
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
                    guard case let .implicitFinalAnswer(answerText) = disposition else { return }
                    print("[AgentRunner] Treating agent message as implicit final answer. Length: \(answerText.count)")
                    finalAnswerDelivered.value = true
                    DispatchQueue.main.async {
                        AgentThinkingModel.shared.appendFinalResult(answerText)
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
            platform: "macos",
            supportsSkillStatus: true
        )

        if let data = try? encoder.encode(initial),
           let json = String(data: data, encoding: .utf8)
        {
            print("[AgentRunner] Sending initial WebSocket message (length: \(json.count))")
            task.send(.string(json)) { error in
                if let error, !finalAnswerDelivered.value {
                    print("[AgentRunner] Failed to send initial WebSocket message: \(error.localizedDescription)")
                    let mapped = AgentAuthRetry.socketError(
                        error, handshakeStatus: (task.response as? HTTPURLResponse)?.statusCode
                    )
                    DispatchQueue.main.async {
                        completion(.failure(mapped))
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

    nonisolated static func extractShellScript(from text: String) -> String? {
        guard let startRange = text.range(of: "<shell_script>") else { return nil }
        guard let endRange = text.range(of: "</shell_script>", range: startRange.upperBound ..< text.endIndex) else { return nil }

        let inner = text[startRange.upperBound ..< endRange.lowerBound]
        return String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Remove internal XML-like tags used by the agent protocol
    /// so that we can show a clean, human-readable stream of
    /// content in the UI.
    nonisolated static func cleanedDisplayText(from text: String) -> String {
        var result = text
        let tags = ["<shell_script>", "</shell_script>", "<final_answer>", "</final_answer>"]
        for tag in tags {
            result = result.replacingOccurrences(of: tag, with: "")
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated static func extractFinalAnswer(from text: String) -> String? {
        guard let startRange = text.range(of: "<final_answer>") else { return nil }
        guard let endRange = text.range(of: "</final_answer>", range: startRange.upperBound ..< text.endIndex) else { return nil }

        let inner = text[startRange.upperBound ..< endRange.lowerBound]
        return String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - URL helpers

    /// Construct the WebSocket URL for the agent endpoint based on the
    /// configured HTTP API base URL. This mirrors the backend's
    /// /ws/omni-agent path.
    private func makeAgentWebSocketURL(baseURL: URL = APIClient.baseURL) -> URL? {
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
}
