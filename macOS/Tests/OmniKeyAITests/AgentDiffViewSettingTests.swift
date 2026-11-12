import XCTest
@testable import OmniKeyAI

/// Diff view toggle: client mirror, capability flags, native gating,
/// Settings deep link and composer layout.
final class AgentDiffViewSettingTests: XCTestCase {
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "AgentDiffViewSettingTests.\(UUID().uuidString)"
    }

    override func tearDown() {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func q(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    // MARK: Mirror

    func testDefaultsToEnabledAndPersistsAcrossInstances() throws {
        let first = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        XCTAssertTrue(AgentDiffViewSetting.isEnabled(first), "missing key keeps historical behavior")
        AgentDiffViewSetting.store(false, in: first)
        first.synchronize()

        let second = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        XCTAssertFalse(AgentDiffViewSetting.isEnabled(second))
        AgentDiffViewSetting.store(true, in: second)
        XCTAssertTrue(AgentDiffViewSetting.isEnabled(try XCTUnwrap(UserDefaults(suiteName: suiteName))))
        XCTAssertEqual(AgentDiffViewSetting.defaultsKey, "agentDiffViewEnabled")
        XCTAssertEqual(AgentDiffViewSetting.explanation, "May use additional AI tokens to recover missing file changes.")
    }

    func testServerValueCompatibility() throws {
        XCTAssertTrue(AgentDiffViewSetting.resolve(serverValue: nil), "older backend omits the field")
        XCTAssertTrue(AgentDiffViewSetting.resolve(serverValue: true))
        XCTAssertFalse(AgentDiffViewSetting.resolve(serverValue: false))

        let legacy = #"{"terminalAccess":"full","webSearchEnabled":true,"browserAccessEnabled":false,"usageRecordingEnabled":true}"#
        let decodedLegacy = try JSONDecoder().decode(APIClient.AppSettingsResponse.self, from: Data(legacy.utf8))
        XCTAssertNil(decodedLegacy.diffViewEnabled)
        let off = #"{"terminalAccess":"full","webSearchEnabled":true,"browserAccessEnabled":false,"usageRecordingEnabled":true,"diffViewEnabled":false}"#
        XCTAssertEqual(try JSONDecoder().decode(APIClient.AppSettingsResponse.self, from: Data(off.utf8)).diffViewEnabled, false)
        let mutation = #"{"terminalAccess":"full","webSearchEnabled":true,"browserAccessEnabled":false,"diffViewEnabled":false}"#
        XCTAssertEqual(try JSONDecoder().decode(APIClient.AppSettingsMutationResponse.self, from: Data(mutation.utf8)).diffViewEnabled, false)
    }

    func testCapabilitiesFollowSettingForAllThreeFlags() {
        XCTAssertEqual(AgentDiffViewSetting.capabilities(enabled: false),
                       .init(gitDiff: false, gitTurnDiff: false, diffRecovery: false))
        XCTAssertEqual(AgentDiffViewSetting.capabilities(enabled: true),
                       .init(gitDiff: true, gitTurnDiff: true, diffRecovery: true))
    }

    // MARK: Runner

    @MainActor
    private func start(
        _ socket: GitDiffTestSocket,
        diffViewEnabled: Bool?,
        onBlock: @escaping @MainActor @Sendable (ChatBlock) -> Void = { _ in },
        onFinal: @escaping @MainActor @Sendable (String) -> Void = { _ in },
        collected: LockedCounter = LockedCounter()
    ) {
        let collect: @Sendable (GitDiffRequestPayload, GitTurnBaselineStore) -> GitDiffResponsePayload = { request, _ in
            collected.increment()
            return GitDiffResponsePayload(requestID: request.requestID, status: .notRepository)
        }
        let shell: @Sendable (String, @escaping @Sendable (Process?) -> Void) -> (output: String, status: Int32) = {
            runShellCommandWithStatus($0, processRegistrar: $1)
        }
        if let diffViewEnabled {
            ChatSessionRunner.shared.startAgentWebSocketSession(
                url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
                originalText: "Start", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
                onBlock: onBlock, onSteeringEvent: { _ in }, onFinal: onFinal,
                onError: { XCTFail("Unexpected error: \($0)") },
                socket: socket, executeShell: shell, collectGitDiff: collect,
                diffViewEnabled: diffViewEnabled
            )
        } else {
            // Default argument path: reads the persisted mirror (unset → on).
            ChatSessionRunner.shared.startAgentWebSocketSession(
                url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
                originalText: "Start", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
                onBlock: onBlock, onSteeringEvent: { _ in }, onFinal: onFinal,
                onError: { XCTFail("Unexpected error: \($0)") },
                socket: socket, executeShell: shell, collectGitDiff: collect
            )
        }
    }

    @MainActor
    private func initialFlags(diffViewEnabled: Bool?) async -> [Bool?] {
        let sent = expectation(description: "initial")
        let flags = LockedBox<[Bool?]>([])
        let socket = GitDiffTestSocket { message in
            if message.content == "Start" {
                flags.set([message.supportsGitDiff, message.supportsGitTurnDiff, message.supportsDiffRecovery])
                sent.fulfill()
            }
        }
        start(socket, diffViewEnabled: diffViewEnabled)
        await fulfillment(of: [sent], timeout: 2)
        return flags.get()
    }

    @MainActor
    func testInitialFrameFlagsFalseWhenOffAndTrueWhenOnOrDefault() async {
        let off = await initialFlags(diffViewEnabled: false)
        XCTAssertEqual(off, [false, false, false])
        let on = await initialFlags(diffViewEnabled: true)
        XCTAssertEqual(on, [true, true, true])
        if UserDefaults.standard.object(forKey: AgentDiffViewSetting.defaultsKey) == nil {
            let byDefault = await initialFlags(diffViewEnabled: nil)
            XCTAssertEqual(byDefault, [true, true, true])
        }
    }

    /// Off: a shell that writes and commits in a repo yields neither commit
    /// provenance nor recovery evidence (no native hooks ran).
    @MainActor
    func testOffSkipsProvenanceAndRecoveryHooks() async throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        let script = "cd \(q(repo.root)) && printf 'b\\n' > a.txt && git add -A && git -c user.name=T -c user.email=t@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m agent"
        let terminal = expectation(description: "terminal")
        let reply = LockedBox<ChatSessionRunner.AgentMessage?>(nil)
        let socket = GitDiffTestSocket { message in
            if message.isTerminalOutput == true { reply.set(message); terminal.fulfill() }
        }
        start(socket, diffViewEnabled: false)
        let content = String(decoding: try JSONEncoder().encode("<shell_script>\(script)</shell_script>"), as: UTF8.self)
        socket.deliver(#"{"session_id":"session","sender":"agent","content":\#(content),"git_diff_context":{"candidate_paths":["\#(repo.root)"],"turn_id":"run-1","tool_call_id":"tool-1"}}"#)
        await fulfillment(of: [terminal], timeout: 15)
        let message = try XCTUnwrap(reply.get())
        XCTAssertEqual(message.isError, false, "the script itself still runs")
        XCTAssertNil(message.gitCommitObservations)
        XCTAssertNil(message.diffRecoveryEvidence)
    }

    /// Off: a stale server's control frame is answered at once without Git
    /// work, and a final answer carrying a snapshot renders no card.
    @MainActor
    func testOffAnswersControlFramesWithoutCollectingAndDropsCard() async throws {
        let replied = expectation(description: "reply")
        let response = LockedBox<GitDiffResponsePayload?>(nil)
        let socket = GitDiffTestSocket { message in
            if let payload = message.gitDiffResponse { response.set(payload); replied.fulfill() }
        }
        let collected = LockedCounter()
        let events = LockedBox<[String]>([])
        let finished = expectation(description: "final")
        start(
            socket, diffViewEnabled: false,
            onBlock: { events.append("block:\($0.kind)") },
            onFinal: { events.append("final:\($0)"); finished.fulfill() },
            collected: collected
        )
        socket.deliver(#"{"session_id":"session","sender":"agent","content":"","git_diff_request":{"request_id":"req-1","candidate_paths":["/tmp"],"eligible_commits":[]}}"#)
        await fulfillment(of: [replied], timeout: 3)
        XCTAssertEqual(response.get()?.status, .unavailable)
        XCTAssertEqual(response.get()?.requestID, "req-1")
        XCTAssertEqual(collected.value, 0)

        let diff = #"{"id":"diff-1","fileCount":1,"repositoryCount":1,"createdAt":"2026-11-12T00:00:00Z","scope":"working_tree"}"#
        socket.deliver(#"{"session_id":"session","sender":"agent","content":"<final_answer>Done</final_answer>","session_diff":\#(diff)}"#)
        await fulfillment(of: [finished], timeout: 3)
        XCTAssertEqual(events.get(), ["final:Done"])
    }

    // MARK: Settings deep link

    @MainActor
    func testSettingsControllerSelectsAgentAccessPane() {
        let controller = SettingsWindowController()
        XCTAssertEqual(controller.navigation.selection, .providers)
        controller.select(.agentAccess)
        XCTAssertEqual(controller.navigation.selection, .agentAccess)
        XCTAssertEqual(SettingsTab.agentAccess.title, "Agent Access")
    }

    // MARK: Composer layout

    func testGearAndAllThreeSelectorsFitOneRowAtEveryWidth() {
        for width: CGFloat in [356, 420, 480, 567, 659, 660, 740, 900, 1200] {
            let titles = ComposerToolbarLayout.titleWidths(width: width)
            XCTAssertGreaterThanOrEqual(titles.task, ComposerToolbarLayout.minimumTitleWidth)
            XCTAssertGreaterThanOrEqual(titles.project, ComposerToolbarLayout.minimumTitleWidth)
            XCTAssertGreaterThanOrEqual(titles.model, ComposerToolbarLayout.minimumTitleWidth)
            XCTAssertLessThanOrEqual(
                ComposerToolbarLayout.requiredRowWidth(width: width), width,
                "gear and Send must stay reachable at width \(width)"
            )
        }
        // The gear is part of the fixed budget even when hints are hidden.
        XCTAssertGreaterThanOrEqual(
            ComposerToolbarLayout.fixedWidth(width: 356),
            ComposerToolbarLayout.sendButtonWidth + ComposerToolbarLayout.settingsButtonWidth
                + 3 * ComposerToolbarLayout.pillChrome
        )
    }
}
