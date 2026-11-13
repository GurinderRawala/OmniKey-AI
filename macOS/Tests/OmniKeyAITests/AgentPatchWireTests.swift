import Darwin
import XCTest
@testable import OmniKeyAI

/// Records raw outgoing frames so tests can assert on exact wire keys.
private final class RawCaptureSocket: ChatSessionSocket, @unchecked Sendable {
    typealias Receiver = @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    private let lock = NSLock()
    private var receiver: Receiver?
    private var inbox: [String] = []
    private let onSend: @Sendable (String) -> Void

    init(onSend: @escaping @Sendable (String) -> Void) { self.onSend = onSend }

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let callback = lock.withLock { () -> Receiver? in defer { receiver = nil }; return receiver }
        callback?(.failure(NSError(domain: "RawCaptureSocket", code: NSURLErrorCancelled)))
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
            guard let callback = receiver else { inbox.append(json); return nil }
            receiver = nil
            return callback
        }
        callback?(.success(.string(json)))
    }

    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable (Error?) -> Void) {
        if case let .string(json) = message { onSend(json) }
        completionHandler(nil)
    }
}

/// Agent-patch capability (`supports_agent_patches`) and the removal of
/// native per-shell recovery checkpoints, plus the saved-summary labels
/// historical (legacy recovered) and new AI-generated snapshots rely on.
final class AgentPatchWireTests: XCTestCase {
    private func q(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    // MARK: Initial frame

    @MainActor
    private func initialFrame(diffViewEnabled: Bool) async throws -> [String: Any] {
        let sent = expectation(description: "initial")
        let box = LockedBox<String?>(nil)
        let socket = RawCaptureSocket { json in
            if json.contains(#""content":"Start""#) { box.set(json); sent.fulfill() }
        }
        ChatSessionRunner.shared.startAgentWebSocketSession(
            url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
            originalText: "Start", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
            onBlock: { _ in }, onSteeringEvent: { _ in }, onFinal: { _ in }, onError: { _ in },
            socket: socket, diffViewEnabled: diffViewEnabled
        )
        await fulfillment(of: [sent], timeout: 2)
        return try object(XCTUnwrap(box.get()))
    }

    @MainActor
    func testInitialFrameAdvertisesAgentPatchesAndNeverLegacyRecovery() async throws {
        let on = try await initialFrame(diffViewEnabled: true)
        XCTAssertEqual(on["supports_git_diff"] as? Bool, true)
        XCTAssertEqual(on["supports_git_turn_diff"] as? Bool, true)
        XCTAssertEqual(on["supports_agent_patches"] as? Bool, true)
        XCTAssertNil(on["supports_diff_recovery"], "legacy checkpoint recovery is never advertised")

        let off = try await initialFrame(diffViewEnabled: false)
        XCTAssertEqual(off["supports_git_diff"] as? Bool, false)
        XCTAssertEqual(off["supports_git_turn_diff"] as? Bool, false)
        XCTAssertEqual(off["supports_agent_patches"] as? Bool, false)
        XCTAssertNil(off["supports_diff_recovery"])
    }

    func testAgentMessageRoundTripsAgentPatchFlag() throws {
        let message = ChatSessionRunner.AgentMessage(sessionID: "s", sender: "client", content: "", supportsAgentPatches: true)
        let json = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
        XCTAssertTrue(json.contains(#""supports_agent_patches":true"#))
        let decoded = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.supportsAgentPatches, true)
        // A malformed optional flag never discards the frame.
        let bad = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: Data(
            #"{"session_id":"s","sender":"agent","content":"x","supports_agent_patches":"yes"}"#.utf8))
        XCTAssertNil(bad.supportsAgentPatches)
        XCTAssertEqual(bad.content, "x")
    }

    // MARK: No native checkpoints

    /// A shell that writes a plain file (and receives a legacy context with
    /// recovery IDs) returns a terminal reply with no recovery evidence, and
    /// a later `phase:"recover"` request is refused without collecting.
    @MainActor
    func testShellCarriesNoEvidenceAndRecoverIsUnsupportedWithoutFileAccess() async throws {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("agent-patch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/out.txt"
        let terminal = expectation(description: "terminal")
        let replied = expectation(description: "recover reply")
        let terminalJSON = LockedBox<String?>(nil)
        let responseJSON = LockedBox<String?>(nil)
        let collected = LockedCounter()
        let socket = RawCaptureSocket { json in
            if json.contains(#""is_terminal_output":true"#) { terminalJSON.set(json); terminal.fulfill() }
            if json.contains(#""git_diff_response""#) { responseJSON.set(json); replied.fulfill() }
        }
        ChatSessionRunner.shared.startAgentWebSocketSession(
            url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
            originalText: "Start", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
            onBlock: { _ in }, onSteeringEvent: { _ in }, onFinal: { _ in }, onError: { XCTFail("\($0)") },
            socket: socket,
            executeShell: { runShellCommandWithStatus($0, processRegistrar: $1) },
            collectGitDiff: { request, _ in
                collected.increment()
                return GitDiffResponsePayload(requestID: request.requestID, status: .notRepository)
            },
            diffViewEnabled: true
        )
        let script = "printf 'hello\\n' > \(q(path))"
        let content = String(decoding: try JSONEncoder().encode("<shell_script>\(script)</shell_script>"), as: UTF8.self)
        socket.deliver(#"{"session_id":"session","sender":"agent","content":\#(content),"git_diff_context":{"candidate_paths":[],"turn_id":"run-7","tool_call_id":"tool-1"}}"#)
        await fulfillment(of: [terminal], timeout: 15)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "hello\n", "the script itself ran")
        let reply = try object(XCTUnwrap(terminalJSON.get()))
        XCTAssertNil(reply["diff_recovery_evidence"])
        XCTAssertNil(reply["git_commit_observations"])

        socket.deliver(#"{"session_id":"session","sender":"agent","content":"","git_diff_request":{"request_id":"rec-1","candidate_paths":["\#(dir)"],"eligible_commits":[],"phase":"recover","recovery":{"turn_id":"run-7","evidence_ids":["f_1"]}}}"#)
        await fulfillment(of: [replied], timeout: 5)
        let frame = try object(XCTUnwrap(responseJSON.get()))
        let response = try XCTUnwrap(frame["git_diff_response"] as? [String: Any])
        XCTAssertEqual(response["request_id"] as? String, "rec-1")
        XCTAssertEqual(response["status"] as? String, "unavailable")
        XCTAssertEqual(response["reason"] as? String, "unsupported_recovery")
        XCTAssertEqual((response["repositories"] as? [Any])?.count, 0)
        XCTAssertNil(response["recovery"])
        XCTAssertEqual(collected.value, 0, "recover never reaches the collector")
    }

    func testRecoverPhaseDecodesAndCollectorNeverServesIt() throws {
        for frame in [
            #"{"request_id":"x","candidate_paths":["/etc"],"phase":"recover"}"#,
            #"{"request_id":"x","candidate_paths":["/etc"],"phase":"recover","recovery":{"turn_id":"t","evidence_ids":["a"]}}"#,
        ] {
            let decoded = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(frame.utf8))
            XCTAssertEqual(decoded.phase, .recover)
            XCTAssertEqual(decoded.requestID, "x")
            let response = GitSnapshotCollector().collect(decoded, turnStore: nil)
            XCTAssertEqual(response.status, .unavailable)
            XCTAssertTrue(response.repositories.isEmpty)
        }
        let unknown = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(
            #"{"request_id":"y","candidate_paths":[],"phase":"later"}"#.utf8))
        XCTAssertTrue(unknown.hasUnsupportedPhase)
    }

    func testLegacyContextIDsAreIgnored() throws {
        let context = try JSONDecoder().decode(GitDiffContext.self, from: Data(
            #"{"candidate_paths":["/r"],"turn_id":"run-1","tool_call_id":"call-1"}"#.utf8))
        XCTAssertEqual(context, GitDiffContext(candidatePaths: ["/r"]))
        let json = String(decoding: try JSONEncoder().encode(context), as: UTF8.self)
        XCTAssertFalse(json.contains("turn_id"))
    }

    // MARK: Saved summaries

    func testAIGeneratedLabelsNeverClaimNativeVerification() throws {
        let summary = SavedSessionDiff(id: "sdiff_ai", fileCount: 1, repositoryCount: 1, createdAt: "t",
            recovered: true, recoveryIncomplete: true, recoveryMethod: "ai_reconstructed")
        XCTAssertEqual(summary.buttonTitle, "View AI-generated changes")
        XCTAssertEqual(summary.headerTitle, "AI-generated turn changes")
        XCTAssertTrue(summary.detailText.contains("unverified"))
        XCTAssertTrue(summary.helpText.contains("not a verified filesystem diff"))
        for text in [summary.buttonTitle, summary.headerTitle, summary.detailText, summary.helpText] {
            XCTAssertFalse(text.contains("checkpoint"), text)
            XCTAssertFalse(text.contains("AI-reconstructed"), text)
        }
        let roundtrip = try JSONDecoder().decode(SavedSessionDiff.self, from: JSONEncoder().encode(summary))
        XCTAssertEqual(roundtrip.recoveryMethod, "ai_reconstructed")
        let unknownMethod = try JSONDecoder().decode(SavedSessionDiff.self, from: Data(
            #"{"id":"d","fileCount":1,"repositoryCount":1,"createdAt":"t","recovered":true,"recoveryMethod":"native_magic"}"#.utf8))
        XCTAssertNil(unknownMethod.recoveryMethod)
        XCTAssertFalse(unknownMethod.isAIReconstructed)
    }

    func testKnownPartialSnapshotsAreNotViewerEligible() {
        let partial = SavedSessionDiff(id: "partial", fileCount: 2, repositoryCount: 1, createdAt: "t",
            recovered: true, recoveryIncomplete: true)
        let missingBase = SavedSessionDiff(id: "base", fileCount: 2, repositoryCount: 1, createdAt: "t",
            baselineUnavailable: true)
        let completeAI = SavedSessionDiff(id: "ai", fileCount: 100, repositoryCount: 1, createdAt: "t",
            displayLimit: 50, recovered: true, recoveryIncomplete: false, recoveryMethod: "ai_reconstructed")
        XCTAssertFalse(partial.isEligibleForViewer)
        XCTAssertFalse(missingBase.isEligibleForViewer)
        XCTAssertTrue(completeAI.isEligibleForViewer, "display cap is not missing capture data")
        let response = ChatSessionRunner.AgentMessage(sessionID: "s", sender: "agent", content: "done", sessionDiff: partial)
        XCTAssertNil(ChatSessionRunner.acceptedSessionDiff(from: response, sessionID: "s"))
        let accepted = ChatSessionRunner.AgentMessage(sessionID: "s", sender: "agent", content: "done", sessionDiff: completeAI)
        XCTAssertEqual(ChatSessionRunner.acceptedSessionDiff(from: accepted, sessionID: "s"), completeAI)
    }

    /// Historical summaries saved by the checkpoint protocol still decode
    /// and keep their labels.
    func testLegacyRecoveredSummaryLabels() throws {
        let json = #"{"id":"d","fileCount":2,"repositoryCount":1,"createdAt":"t","scope":"working_tree","recovered":true,"recoveryIncomplete":true,"recoveryMethod":"checkpoint"}"#
        let diff = try JSONDecoder().decode(SavedSessionDiff.self, from: Data(json.utf8))
        XCTAssertEqual(diff.recoveryMethod, "checkpoint")
        XCTAssertEqual(diff.buttonTitle, "View recovered turn changes")
        XCTAssertEqual(diff.headerTitle, "Recovered turn changes")
        XCTAssertTrue(diff.detailText.contains("partial"))
        XCTAssertFalse(diff.detailText.contains("pre-existing uncommitted"))
        XCTAssertTrue(diff.helpText.contains("Partial"))
        let again = try JSONDecoder().decode(SavedSessionDiff.self, from: JSONEncoder().encode(diff))
        XCTAssertEqual(again, diff)
        let complete = SavedSessionDiff(id: "d", fileCount: 1, repositoryCount: 1, createdAt: "t", recovered: true)
        XCTAssertNil(complete.recoveryWarning)
        XCTAssertEqual(SavedSessionDiff(id: "d", fileCount: 1, repositoryCount: 1, createdAt: "t").buttonTitle, "View working-tree snapshot")
    }

    // MARK: Collector regressions (moved from the deleted recovery suite)

    func testDeletedBaselineIsNotReportedCleanBecauseAnotherRootExists() throws {
        let first = try GitTestRepo()
        try first.write("a", "a\n")
        _ = try first.commitAll()
        let second = try GitTestRepo()
        try second.write("b", "b\n")
        _ = try second.commitAll()
        let collector = GitSnapshotCollector()
        let baseline = collector.collect(GitDiffRequestPayload(requestID: "base", candidatePaths: [first.root], phase: .baseline, baselineSource: .turnStart), turnStore: nil)
        try FileManager.default.removeItem(atPath: first.root)
        let final = collector.collect(GitDiffRequestPayload(requestID: "last", candidatePaths: [second.root], phase: .final, baselines: baseline.baselines), turnStore: nil)
        XCTAssertEqual(final.status, .unavailable)
        XCTAssertTrue(final.repositories.isEmpty)
    }

    func testReportedRootNeverLeavesTheRepositoryForSymlinkedCandidates() throws {
        let repo = try GitTestRepo()
        try repo.write("a/b/c.txt", "c\n")
        let links = (NSTemporaryDirectory() as NSString).appendingPathComponent("agent-patch-links-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: links, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: links) }
        let link = links + "/l"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: repo.root + "/a/b")
        let root = try XCTUnwrap(GitSnapshotCollector.canonicalDirectory(repo.root))
        // Walking two levels up from `…/l` would land outside the repository.
        XCTAssertEqual(GitSnapshotCollector.reportedRoot(root, candidates: [link]), root)
        let rootLink = links + "/repo"
        try FileManager.default.createSymbolicLink(atPath: rootLink, withDestinationPath: repo.root)
        let reported = GitSnapshotCollector.reportedRoot(root, candidates: [rootLink + "/a"])
        XCTAssertEqual(physicalPath(reported), physicalPath(rootLink))
        XCTAssertTrue(reported.hasSuffix("/repo"), "preserve the repository symlink spelling")
        XCTAssertEqual(GitSnapshotCollector.reportedRoot(root, candidates: ["/"]), root)
    }

    private func physicalPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
