import Foundation
import XCTest

@testable import OmniKeyAI

/// Exercise the production receive loop with a shell command that cannot finish
/// until the test releases it. No daemon, credentials, or real commands needed.
final class ChatSessionSteeringTests: XCTestCase {
    @MainActor
    func testAcknowledgesMultipleSteersBeforeShellFinishesAndKeepsOneReceiver() async {
        let shell = SuspendedShell()
        defer { shell.release() }
        let terminalSent = expectation(description: "terminal output sent")
        let socket = TestSocket { message in
            if message.isTerminalOutput == true { terminalSent.fulfill() }
        }
        let received = expectation(description: "both steering receipts delivered while shell is running")
        received.expectedFulfillmentCount = 2
        let applied = expectation(description: "steering applied after shell result")
        let final = expectation(description: "final answer")
        let handle = ChatSessionRunHandle()
        var events: [SteeringServerEvent] = []
        start(socket, shell: shell, handle: handle, onSteering: { event in
            events.append(event)
            if event.status == .received { received.fulfill() }
            if event.status == .applied { applied.fulfill() }
        }, onFinal: { text in
            XCTAssertEqual(text, "Done")
            final.fulfill()
        })
        socket.deliver(shellMessage)
        await fulfillment(of: [shell.started], timeout: 2)

        for id in ["first", "second"] {
            ChatSessionRunner.shared.sendSteeringMessage(
                sessionId: "session", steeringID: id, text: "Update \(id)", handle: handle
            ) { result in
                if case .failure(let error) = result { XCTFail("\(error)") }
            }
            socket.deliver(steeringMessage(id: id, status: "received"))
        }
        await fulfillment(of: [received], timeout: 2)
        XCTAssertEqual(events.map(\.id), ["first", "second"])
        XCTAssertFalse(socket.sentMessages.contains { $0.isTerminalOutput == true })
        XCTAssertEqual(socket.pendingReceiveCount, 1)

        shell.release()
        await fulfillment(of: [terminalSent], timeout: 2)
        socket.deliver(steeringMessage(id: "first", status: "applied"))
        await fulfillment(of: [applied], timeout: 2)
        XCTAssertEqual(socket.pendingReceiveCount, 1)
        XCTAssertFalse(socket.hadOverlappingReceives)
        socket.deliver(finalMessage)
        await fulfillment(of: [final], timeout: 2)
        XCTAssertEqual(socket.sentMessages.filter { $0.isTerminalOutput == true }.count, 1)
        XCTAssertEqual(socket.pendingReceiveCount, 0)
    }

    @MainActor
    func testRejectsSteeringWhileShellIsRunningWithoutEndingTurn() async {
        let shell = SuspendedShell()
        defer { shell.release() }
        let rejected = expectation(description: "steering rejected immediately")
        let terminalSent = expectation(description: "shell still returns normally")
        let socket = TestSocket { message in
            if message.isTerminalOutput == true { terminalSent.fulfill() }
        }
        start(socket, shell: shell, onSteering: { event in
            XCTAssertEqual(event.status, .rejected)
            XCTAssertEqual(event.id, "first")
            rejected.fulfill()
        })
        socket.deliver(shellMessage)
        await fulfillment(of: [shell.started], timeout: 2)
        socket.deliver(steeringMessage(id: "first", status: "rejected"))
        await fulfillment(of: [rejected], timeout: 2)
        shell.release()
        await fulfillment(of: [terminalSent], timeout: 2)
        XCTAssertFalse(socket.hadOverlappingReceives)
        socket.deliver(finalMessage)
    }

    @MainActor
    func testCancellationDuringShellDoesNotSendLateOutputOrReportTwoErrors() async {
        let shell = SuspendedShell()
        defer { shell.release() }
        let socket = TestSocket()
        let handle = ChatSessionRunHandle()
        let cancelled = expectation(description: "cancelled exactly once")
        cancelled.assertForOverFulfill = true
        start(socket, shell: shell, handle: handle, onError: { error in
            XCTAssertEqual((error as NSError).code, -9999)
            cancelled.fulfill()
        })
        socket.deliver(shellMessage)
        await fulfillment(of: [shell.started], timeout: 2)
        handle.cancel()
        await fulfillment(of: [cancelled], timeout: 2)
        // The receiver must not clear cancellation before the shell observes it.
        XCTAssertTrue(handle.isCancelledByUser)
        shell.release()
        await fulfillment(of: [shell.returned], timeout: 2)
        XCTAssertFalse(socket.sentMessages.contains { $0.isTerminalOutput == true })
        XCTAssertEqual(socket.pendingReceiveCount, 0)
    }

    @MainActor
    func testFinalDuringShellDiscardsLateResultAndSocketCloseError() async {
        let shell = SuspendedShell()
        defer { shell.release() }
        let socket = TestSocket()
        let final = expectation(description: "final exactly once")
        final.assertForOverFulfill = true
        start(socket, shell: shell, onFinal: { _ in final.fulfill() })
        socket.deliver(shellMessage)
        await fulfillment(of: [shell.started], timeout: 2)
        socket.deliver(finalMessage)
        await fulfillment(of: [final], timeout: 2)
        shell.release()
        await fulfillment(of: [shell.returned], timeout: 2)
        XCTAssertFalse(socket.sentMessages.contains { $0.isTerminalOutput == true })
        XCTAssertEqual(socket.pendingReceiveCount, 0)
    }

    @MainActor
    func testTerminalSendFailureFinishesOnceWithReceiveStillPending() async {
        let shell = SuspendedShell()
        defer { shell.release() }
        let socket = TestSocket(failTerminalSend: true)
        let failed = expectation(description: "send failure exactly once")
        failed.assertForOverFulfill = true
        start(socket, shell: shell, onError: { error in
            XCTAssertEqual((error as NSError).code, 42)
            failed.fulfill()
        })
        socket.deliver(shellMessage)
        await fulfillment(of: [shell.started], timeout: 2)
        shell.release()
        await fulfillment(of: [failed], timeout: 2)
        XCTAssertFalse(socket.hadOverlappingReceives)
        XCTAssertEqual(socket.pendingReceiveCount, 0)
    }

    private var shellMessage: String {
        #"{"session_id":"session","sender":"agent","content":"<shell_script>held-command</shell_script>"}"#
    }

    private var finalMessage: String {
        #"{"session_id":"session","sender":"agent","content":"<final_answer>Done</final_answer>"}"#
    }

    private func steeringMessage(id: String, status: String) -> String {
        """
        {"session_id":"session","sender":"agent","content":"Steering update","is_steering":true,"steering_id":"\(id)","steering_status":"\(status)"}
        """
    }

    @MainActor
    private func start(
        _ socket: TestSocket,
        shell: SuspendedShell,
        handle: ChatSessionRunHandle = ChatSessionRunHandle(),
        onSteering: @escaping @MainActor @Sendable (SteeringServerEvent) -> Void = { _ in },
        onFinal: @escaping @MainActor @Sendable (String) -> Void = { _ in },
        onError: @escaping @MainActor @Sendable (Error) -> Void = { XCTFail("Unexpected error: \($0)") }
    ) {
        ChatSessionRunner.shared.startAgentWebSocketSession(
            url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
            originalText: "Start", groupName: nil, allowReauth: false, handle: handle,
            onBlock: { _ in }, onSteeringEvent: onSteering, onFinal: onFinal, onError: onError,
            socket: socket, executeShell: { _, _ in shell.run() }
        )
    }
}

private final class SuspendedShell: @unchecked Sendable {
    let started = XCTestExpectation(description: "shell started")
    let returned = XCTestExpectation(description: "shell returned")
    private let gate = DispatchSemaphore(value: 0)

    func release() { gate.signal() }

    func run() -> (output: String, status: Int32) {
        started.fulfill()
        // Bound a broken test rather than leaving a worker blocked forever.
        let result = gate.wait(timeout: .now() + 10)
        XCTAssertEqual(result, .success)
        returned.fulfill()
        return ("command output", 0)
    }
}

private final class TestSocket: ChatSessionSocket, @unchecked Sendable {
    typealias Receiver = @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    private let lock = NSLock()
    private var receiver: Receiver?
    private var inbox: [String] = []
    private var sent: [ChatSessionRunner.AgentMessage] = []
    private var overlap = false
    private let onSend: @Sendable (ChatSessionRunner.AgentMessage) -> Void
    private let failTerminalSend: Bool

    init(
        failTerminalSend: Bool = false,
        onSend: @escaping @Sendable (ChatSessionRunner.AgentMessage) -> Void = { _ in }
    ) {
        self.failTerminalSend = failTerminalSend
        self.onSend = onSend
    }

    var sentMessages: [ChatSessionRunner.AgentMessage] { lock.withLock { sent } }
    var pendingReceiveCount: Int { lock.withLock { receiver == nil ? 0 : 1 } }
    var hadOverlappingReceives: Bool { lock.withLock { overlap } }

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let callback = lock.withLock {
            let callback = receiver
            receiver = nil
            return callback
        }
        callback?(.failure(NSError(domain: "TestSocket", code: NSURLErrorCancelled)))
    }

    func receive(completionHandler: @escaping Receiver) {
        let queued: String? = lock.withLock {
            if receiver != nil { overlap = true }
            if !inbox.isEmpty { return inbox.removeFirst() }
            receiver = completionHandler
            return nil
        }
        if let queued { completionHandler(.success(.string(queued))) }
    }

    func deliver(_ json: String) {
        let callback = lock.withLock {
            guard let callback = receiver else {
                inbox.append(json)
                return Optional<Receiver>.none
            }
            receiver = nil
            return callback
        }
        callback?(.success(.string(json)))
    }

    func send(
        _ message: URLSessionWebSocketTask.Message,
        completionHandler: @escaping @Sendable (Error?) -> Void
    ) {
        guard case let .string(json) = message,
              let decoded = try? JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: Data(json.utf8))
        else {
            XCTFail("Invalid outgoing message")
            return
        }
        lock.withLock { sent.append(decoded) }
        if failTerminalSend && decoded.isTerminalOutput == true {
            completionHandler(NSError(domain: "TestSocket", code: 42))
        } else {
            completionHandler(nil)
        }
        onSend(decoded)
    }
}
