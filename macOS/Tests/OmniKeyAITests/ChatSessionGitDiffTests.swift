import XCTest
@testable import OmniKeyAI

final class ChatSessionGitDiffTests: XCTestCase {
    private let diffJSON = #"{"id":"diff-9","fileCount":2,"repositoryCount":1,"createdAt":"2026-11-12T00:00:00Z","scope":"working_tree"}"#

    private func requestFrame(id: String, session: String = "session") -> String {
        #"{"session_id":"\#(session)","sender":"agent","content":"","git_diff_request":{"request_id":"\#(id)","candidate_paths":["/tmp"],"eligible_commits":[]}}"#
    }

    @MainActor
    private func start(
        _ socket: GitDiffTestSocket,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void = { _ in },
        onFinal: @escaping @MainActor @Sendable (String) -> Void = { _ in },
        collect: @escaping @Sendable (GitDiffRequestPayload) -> GitDiffResponsePayload,
        executeShell: @escaping @Sendable (String, @escaping @Sendable (Process?) -> Void) -> (output: String, status: Int32) = { _, _ in ("out", 0) }
    ) {
        ChatSessionRunner.shared.startAgentWebSocketSession(
            url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
            originalText: "Start", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
            onBlock: onBlock, onSteeringEvent: { _ in }, onFinal: onFinal,
            onError: { XCTFail("Unexpected error: \($0)") },
            socket: socket, executeShell: executeShell, collectGitDiff: { request, _ in collect(request) }
        )
    }

    @MainActor
    func testInitialMessageAdvertisesCapability() async {
        let sent = expectation(description: "initial")
        let socket = GitDiffTestSocket { message in
            if message.content == "Start" {
                XCTAssertEqual(message.supportsGitDiff, true)
                XCTAssertEqual(message.supportsGitTurnDiff, true)
                sent.fulfill()
            }
        }
        start(socket, collect: { _ in XCTFail("no request"); return GitDiffResponsePayload(requestID: "", status: .unavailable) })
        await fulfillment(of: [sent], timeout: 2)
    }

    @MainActor
    func testControlFrameIsAnsweredOnceAndNeverShownThenCardPrecedesFinal() async {
        let replied = expectation(description: "git reply")
        let socket = GitDiffTestSocket { message in
            if let response = message.gitDiffResponse {
                XCTAssertEqual(response.requestID, "req-1")
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(message.sender, "client")
                XCTAssertNotEqual(message.isTerminalOutput, true)
                replied.fulfill()
            }
        }
        let collected = LockedCounter()
        let events = LockedBox<[String]>([])
        let finished = expectation(description: "final")
        start(
            socket,
            onBlock: { block in events.append("block:\(block.kind):\(block.sessionDiff?.id ?? "")") },
            onFinal: { text in events.append("final:\(text)"); finished.fulfill() },
            collect: { request in
                collected.increment()
                return GitDiffResponsePayload(
                    requestID: request.requestID, status: .ok,
                    repositories: [GitDiffRepositoryPatch(root: "/tmp", patch: "diff --git a/x b/x\n")]
                )
            }
        )
        socket.deliver(requestFrame(id: "req-1"))
        socket.deliver(requestFrame(id: "req-1"))          // replay: ignored
        socket.deliver(requestFrame(id: "req-2", session: "other")) // wrong session: ignored
        await fulfillment(of: [replied], timeout: 3)
        socket.deliver(#"{"session_id":"session","sender":"agent","content":"<final_answer>Done</final_answer>","session_diff":\#(diffJSON)}"#)
        await fulfillment(of: [finished], timeout: 3)
        XCTAssertEqual(collected.value, 1)
        XCTAssertEqual(events.get(), ["block:sessionDiff:diff-9", "final:Done"])
        XCTAssertEqual(socket.sentMessages.filter { $0.gitDiffResponse != nil }.count, 1)
    }

    @MainActor
    func testErrorFinalKeepsItsSavedSnapshotCard() async {
        let events = LockedBox<[String]>([])
        let finished = expectation(description: "final")
        let socket = GitDiffTestSocket()
        start(
            socket,
            onBlock: { events.append("block:\($0.kind)") },
            onFinal: { events.append("final:\($0)"); finished.fulfill() },
            collect: { GitDiffResponsePayload(requestID: $0.requestID, status: .notRepository) }
        )
        socket.deliver(#"{"session_id":"session","sender":"agent","content":"<final_answer>boom</final_answer>","is_error":true,"session_diff":\#(diffJSON)}"#)
        await fulfillment(of: [finished], timeout: 3)
        XCTAssertEqual(events.get(), ["block:sessionDiff", "final:**Error:** boom"])
    }

    func testStructuredWorkingDirectoryIsLiteralAndUsedByProvenance() throws {
        let path = "/Users/test/project with 'quote'"
        let script = ChatSessionRunner.script("git commit -m saved", in: path)
        XCTAssertTrue(script.hasPrefix("cd -- "))
        let analysis = GitShellCommandAnalyzer.analyze(script, initialDirectory: "/Users/test")
        XCTAssertEqual(analysis.commitDirectories, [path])
        XCTAssertEqual(ChatSessionRunner.script("echo ok", in: nil), "echo ok")
        XCTAssertTrue(ChatSessionRunner.script("echo never", in: "relative").contains("exit 1"))
        let frame = "{\"session_id\":\"s\",\"sender\":\"agent\",\"content\":\"x\",\"working_directory\":\"/tmp/project\"}"
        XCTAssertEqual(try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: Data(frame.utf8)).workingDirectory, "/tmp/project")
    }

    @MainActor
    func testTerminalReplyCarriesObservedCommit() async throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        let before = try repo.commitAll()
        try repo.write("a.txt", "b\n")
        let path = repo.root.replacingOccurrences(of: "'", with: "'\\''")
        let script = "cd '\(path)' && git add -A && git -c user.name=T -c user.email=t@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m agent"
        let terminal = expectation(description: "terminal")
        let observed = LockedBox<[GitCommitObservation]?>(nil)
        let socket = GitDiffTestSocket { message in
            if message.isTerminalOutput == true {
                observed.set(message.gitCommitObservations)
                terminal.fulfill()
            }
        }
        start(
            socket,
            collect: { GitDiffResponsePayload(requestID: $0.requestID, status: .notRepository) },
            executeShell: { script, registrar in runShellCommandWithStatus(script, processRegistrar: registrar) }
        )
        let escapedScript = String(decoding: try JSONEncoder().encode("<shell_script>\(script)</shell_script>"), as: UTF8.self)
        socket.deliver(#"{"session_id":"session","sender":"agent","content":\#(escapedScript),"git_diff_context":{"candidate_paths":["\#(repo.root)"]}}"#)
        await fulfillment(of: [terminal], timeout: 15)
        let after = try repo.git("rev-parse", "HEAD")
        XCTAssertEqual(observed.get(), [GitCommitObservation(root: repo.root, before: before, after: after)])
    }
}

final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func set(_ next: T) { lock.withLock { value = next } }
    func get() -> T { lock.withLock { value } }
}

extension LockedBox where T == [String] {
    func append(_ item: String) { lock2 { $0.append(item) } }
}

extension LockedBox {
    func lock2(_ body: (inout T) -> Void) {
        var current = get()
        body(&current)
        set(current)
    }
}

final class GitDiffTestSocket: ChatSessionSocket, @unchecked Sendable {
    typealias Receiver = @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    private let lock = NSLock()
    private var receiver: Receiver?
    private var inbox: [String] = []
    private var sent: [ChatSessionRunner.AgentMessage] = []
    private let onSend: @Sendable (ChatSessionRunner.AgentMessage) -> Void

    init(onSend: @escaping @Sendable (ChatSessionRunner.AgentMessage) -> Void = { _ in }) {
        self.onSend = onSend
    }

    var sentMessages: [ChatSessionRunner.AgentMessage] { lock.withLock { sent } }

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let callback = lock.withLock { () -> Receiver? in
            let callback = receiver
            receiver = nil
            return callback
        }
        callback?(.failure(NSError(domain: "GitDiffTestSocket", code: NSURLErrorCancelled)))
    }

    func receive(completionHandler: @escaping Receiver) {
        let queued: String? = lock.withLock {
            if !inbox.isEmpty { return inbox.removeFirst() }
            receiver = completionHandler
            return nil
        }
        if let queued { completionHandler(.success(.string(queued))) }
    }

    func deliver(_ json: String) {
        let callback = lock.withLock { () -> Receiver? in
            guard let callback = receiver else {
                inbox.append(json)
                return nil
            }
            receiver = nil
            return callback
        }
        callback?(.success(.string(json)))
    }

    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable (Error?) -> Void) {
        guard case let .string(json) = message,
              let decoded = try? JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: Data(json.utf8))
        else { return XCTFail("Invalid outgoing message") }
        lock.withLock { sent.append(decoded) }
        completionHandler(nil)
        onSend(decoded)
    }
}
