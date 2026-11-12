import XCTest
@testable import OmniKeyAI

/// v3 turn mode: baseline HEAD captured once per turn, final diff is
/// baseline -> current working tree (all net commits + uncommitted).
final class GitTurnDiffTests: XCTestCase {
    private func baseline(
        _ paths: [String], store: GitTurnBaselineStore?, source: GitTurnBaselineSource? = .turnStart,
        collector: GitSnapshotCollector = GitSnapshotCollector()
    ) -> GitDiffResponsePayload {
        collector.collect(
            GitDiffRequestPayload(requestID: "b-\(UUID().uuidString)", candidatePaths: paths, phase: .baseline, baselineSource: source),
            turnStore: store
        )
    }

    private func final(
        _ paths: [String], baselines: [GitTurnBaseline], store: GitTurnBaselineStore? = nil,
        collector: GitSnapshotCollector = GitSnapshotCollector()
    ) -> GitDiffResponsePayload {
        collector.collect(
            GitDiffRequestPayload(requestID: "f-1", candidatePaths: paths, eligibleCommits: [], phase: .final,
                                  baselines: baselines, displayLimit: 50),
            turnStore: store
        )
    }

    private func files(in patch: String) -> Set<String> {
        Set(patch.components(separatedBy: "\n").compactMap { line -> String? in
            guard line.hasPrefix("diff --git a/") else { return nil }
            return line.components(separatedBy: " b/").last
        })
    }

    // MARK: Core scenario

    func testAllNetCommitsPlusDirtyAndUntrackedAreCapturedInOnePatch() throws {
        let repo = try GitTestRepo()
        try repo.write("base.txt", "base\n")
        try repo.write("shared.txt", "v0\n")
        let start = try repo.commitAll("start")
        try repo.write("preexisting.txt", "dirty before turn\n")

        let store = GitTurnBaselineStore()
        let b = baseline([repo.root], store: store)
        XCTAssertEqual(b.status, .ok)
        XCTAssertEqual(b.repositories, [])
        let recorded = try XCTUnwrap(b.baselines?.first)
        XCTAssertEqual(recorded.head, start)
        XCTAssertEqual(recorded.source, .turnStart)
        XCTAssertEqual(recorded.root, repo.root)

        try repo.write("a1.txt", "a1\n")
        try repo.write("a2.txt", "a2\n")
        try repo.write("shared.txt", "v1-intermediate\n")
        _ = try repo.commitAll("A")
        try repo.write("b1.txt", "b1\n")
        try repo.write("b2.txt", "b2\n")
        try repo.write("shared.txt", "v2-final\n")
        let headB = try repo.commitAll("B")
        try repo.write("base.txt", "base\ndirty tracked\n")
        try repo.write("new.txt", "brand new\n")
        let index = try repo.indexFingerprint()

        let response = final([repo.root], baselines: [recorded], store: store)
        XCTAssertEqual(response.status, .ok, response.reason ?? "")
        let patch = try XCTUnwrap(response.repositories.first)
        XCTAssertEqual(patch.scope, .turn)
        XCTAssertEqual(patch.baselineHead, start)
        XCTAssertEqual(patch.head, headB)
        XCTAssertEqual(patch.baselineSource, .turnStart)
        XCTAssertEqual(patch.baselineCapturedAt, recorded.capturedAt)
        XCTAssertEqual(files(in: patch.patch),
                       ["a1.txt", "a2.txt", "b1.txt", "b2.txt", "shared.txt", "base.txt", "new.txt", "preexisting.txt"])
        // Net change only: intermediate content of a file changed across commits is absent.
        XCTAssertTrue(patch.patch.contains("+v2-final"))
        XCTAssertTrue(patch.patch.contains("-v0"))
        XCTAssertFalse(patch.patch.contains("v1-intermediate"))
        XCTAssertEqual(try repo.indexFingerprint(), index, "turn capture must not touch the index")
    }

    func testCleanTreeWithCommitsStillShowsCommitsAndCleanUnchangedRepoIsOmitted() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        let b = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        XCTAssertTrue(final([repo.root], baselines: [b]).repositories.isEmpty)
        try repo.write("y.txt", "y\n")
        _ = try repo.commitAll()
        let response = final([repo.root], baselines: [b])
        XCTAssertEqual(files(in: try XCTUnwrap(response.repositories.first).patch), ["y.txt"])
    }

    func testNextTurnUsesFreshHeadExcludingPriorCommitsButKeepsDirty() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        let first = GitTurnBaselineStore()
        let b1 = try XCTUnwrap(baseline([repo.root], store: first).baselines?.first)
        try repo.write("turn1.txt", "t1\n")
        let afterTurn1 = try repo.commitAll()
        try repo.write("x.txt", "x\nleft dirty\n")
        XCTAssertEqual(files(in: final([repo.root], baselines: [b1], store: first).repositories[0].patch), ["turn1.txt", "x.txt"])

        let second = GitTurnBaselineStore()
        let b2 = try XCTUnwrap(baseline([repo.root], store: second).baselines?.first)
        XCTAssertEqual(b2.head, afterTurn1)
        XCTAssertNotEqual(b2.head, b1.head)
        let response = final([repo.root], baselines: [b2], store: second)
        XCTAssertEqual(files(in: response.repositories[0].patch), ["x.txt"])
    }

    // MARK: Baseline stability

    func testBaselineIsRecordedOnceAndNeverRebased() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        let start = try repo.commitAll()
        let store = GitTurnBaselineStore()
        let first = try XCTUnwrap(baseline([repo.root], store: store).baselines?.first)
        try repo.write("y.txt", "y\n")
        _ = try repo.commitAll()
        let again = try XCTUnwrap(baseline([repo.root + "/"], store: store, source: .beforeTool).baselines?.first)
        XCTAssertEqual(again, first)
        XCTAssertEqual(again.head, start)
        XCTAssertEqual(store.count, 1)
    }

    func testNewRepositoryDiscoveredLaterUsesBeforeToolSource() throws {
        let one = try GitTestRepo()
        try one.write("a", "a\n")
        _ = try one.commitAll()
        let two = try GitTestRepo()
        try two.write("b", "b\n")
        let twoHead = try two.commitAll()
        let store = GitTurnBaselineStore()
        _ = baseline([one.root], store: store)
        let late = try XCTUnwrap(baseline([two.root], store: store, source: .beforeTool).baselines?.first)
        XCTAssertEqual(late.source, .beforeTool)
        XCTAssertEqual(late.head, twoHead)
        try two.write("c", "c\n")
        _ = try two.commitAll()
        let response = final([one.root, two.root], baselines: [late], store: store)
        XCTAssertEqual(response.repositories.first?.baselineSource, .beforeTool)
        XCTAssertEqual(files(in: response.repositories[0].patch), ["c"])
    }

    func testMissingBaselineShowsUncommittedOnlyWithNotice() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        try repo.write("committed.txt", "c\n")
        _ = try repo.commitAll()
        try repo.write("x.txt", "x\ndirty\n")
        let response = final([repo.root], baselines: [])
        XCTAssertEqual(response.status, .ok)
        let patch = try XCTUnwrap(response.repositories.first)
        XCTAssertEqual(patch.scope, .workingTree)
        XCTAssertEqual(files(in: patch.patch), ["x.txt"], "no history guess for a repo without a baseline")
        XCTAssertTrue(response.reason?.contains("baseline unavailable") == true)
    }

    func testUnbornBaselineIncludesEverythingCommittedSince() throws {
        let repo = try GitTestRepo()
        let store = GitTurnBaselineStore()
        let b = try XCTUnwrap(baseline([repo.root], store: store).baselines?.first)
        XCTAssertNil(b.head)
        try repo.write("first.txt", "1\n")
        let head = try repo.commitAll()
        try repo.write("dirty.txt", "d\n")
        let response = final([repo.root], baselines: [b], store: store)
        let patch = try XCTUnwrap(response.repositories.first)
        XCTAssertEqual(patch.scope, .turn)
        XCTAssertNil(patch.baselineHead)
        XCTAssertEqual(patch.head, head)
        XCTAssertEqual(files(in: patch.patch), ["first.txt", "dirty.txt"])
        let json = String(decoding: try JSONEncoder().encode(patch), as: UTF8.self)
        XCTAssertTrue(json.contains(#""baselineHead":null"#))
    }

    func testUnbornStillUnbornDiffsAgainstEmptyTree() throws {
        let repo = try GitTestRepo()
        let b = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        try repo.write("n.txt", "n\n")
        let patch = try XCTUnwrap(final([repo.root], baselines: [b]).repositories.first)
        XCTAssertEqual(patch.scope, .turn)
        XCTAssertNil(patch.head)
        XCTAssertEqual(files(in: patch.patch), ["n.txt"])
    }

    // MARK: Fail closed

    func testResetBehindBaselineFailsClosed() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        try repo.write("x.txt", "y\n")
        _ = try repo.commitAll()
        let b = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        try repo.git("reset", "-q", "--hard", "HEAD~1")
        let response = final([repo.root], baselines: [b])
        XCTAssertEqual(response.status, .unavailable)
        XCTAssertTrue(response.repositories.isEmpty)
        XCTAssertTrue(response.reason?.contains("reset or diverged") == true, response.reason ?? "")
    }

    func testDivergedBranchFailsClosed() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        try repo.git("checkout", "-q", "-b", "side")
        try repo.write("side.txt", "s\n")
        _ = try repo.commitAll()
        let b = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        try repo.git("checkout", "-q", "main")
        try repo.write("main.txt", "m\n")
        _ = try repo.commitAll()
        XCTAssertEqual(final([repo.root], baselines: [b]).status, .unavailable)
    }

    func testUnknownBaselineObjectFailsClosed() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        let bogus = GitTurnBaseline(root: repo.root, head: String(repeating: "a", count: 40),
                                    capturedAt: GitTurnBaseline.timestamp(), source: .turnStart)
        let response = final([repo.root], baselines: [bogus])
        XCTAssertEqual(response.status, .unavailable)
        let malformed = GitTurnBaseline(root: repo.root, head: "HEAD~1", capturedAt: "t", source: .turnStart)
        XCTAssertEqual(final([repo.root], baselines: [malformed]).status, .unavailable)
    }

    func testServerBaselineMismatchingLocalCaptureFailsClosed() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        let first = try repo.commitAll()
        let store = GitTurnBaselineStore()
        _ = baseline([repo.root], store: store)
        try repo.write("y.txt", "y\n")
        let second = try repo.commitAll()
        XCTAssertNotEqual(first, second)
        let forged = GitTurnBaseline(root: repo.root, head: second, capturedAt: GitTurnBaseline.timestamp(), source: .turnStart)
        XCTAssertEqual(final([repo.root], baselines: [forged], store: store).status, .unavailable)
    }

    func testHeadMovingDuringCaptureFailsClosed() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        let b = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        try repo.write("y.txt", "y\n")
        _ = try repo.commitAll()

        // A git wrapper that commits (moving HEAD) the first time a diff is listed.
        let scratch = URL(fileURLWithPath: repo.root).deletingLastPathComponent()
            .appendingPathComponent("race-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let marker = scratch.appendingPathComponent("fired").path
        let wrapper = scratch.appendingPathComponent("git").path
        let real = GitTestRepo.gitPath
        let script = """
        #!/bin/sh
        case " $* " in
          *" --name-status "*)
            if [ ! -e '\(marker)' ]; then
              : > '\(marker)'
              '\(real)' -c user.name=T -c user.email=t@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --allow-empty -m race >/dev/null 2>&1
            fi ;;
        esac
        exec '\(real)' "$@"
        """
        try script.write(toFile: wrapper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper)
        let collector = GitSnapshotCollector(runner: GitCommandRunner(gitPath: wrapper))
        let response = final([repo.root], baselines: [b], collector: collector)
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker))
        XCTAssertEqual(response.status, .unavailable)
        XCTAssertTrue(response.reason?.contains("HEAD moved") == true, response.reason ?? "")
    }

    func testExpiredDeadlineIsUnavailableForBothPhases() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        var limits = GitSnapshotCollector.Limits()
        limits.timeout = 0
        let collector = GitSnapshotCollector(limits: limits)
        let b = baseline([repo.root], store: nil, collector: collector)
        XCTAssertEqual(b.status, .unavailable)
        XCTAssertEqual(b.baselines, [])
        let good = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        XCTAssertEqual(final([repo.root], baselines: [good], collector: collector).status, .unavailable)
    }

    func testPatchBudgetOverflowIsUnavailableNotPartial() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        let b = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        try repo.write("big.txt", String(repeating: "line\n", count: 4000))
        _ = try repo.commitAll()
        var limits = GitSnapshotCollector.Limits()
        limits.maxPatchBytes = 1024
        let response = final([repo.root], baselines: [b], collector: GitSnapshotCollector(limits: limits))
        XCTAssertEqual(response.status, .unavailable)
        XCTAssertTrue(response.repositories.isEmpty)
    }

    // MARK: Roots

    func testSymlinkAliasesCollapseToOneRepositoryWithStableReportedRoot() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        let link = URL(fileURLWithPath: repo.root).deletingLastPathComponent()
            .appendingPathComponent("link-\(UUID().uuidString)").path
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: repo.root)
        defer { try? FileManager.default.removeItem(atPath: link) }

        let store = GitTurnBaselineStore()
        let viaLink = try XCTUnwrap(baseline([link], store: store).baselines?.first)
        XCTAssertEqual(viaLink.root, link, "wire root keeps the candidate's spelling")
        let viaReal = try XCTUnwrap(baseline([repo.root], store: store).baselines?.first)
        XCTAssertEqual(viaReal, viaLink, "an alias never records a second baseline")
        XCTAssertEqual(store.count, 1)

        try repo.write("y.txt", "y\n")
        _ = try repo.commitAll()
        let late = GitTurnBaseline(root: repo.root, head: try repo.git("rev-parse", "HEAD"),
                                   capturedAt: GitTurnBaseline.timestamp(), source: .beforeTool)
        let response = final([link, repo.root], baselines: [late, viaLink], store: store)
        XCTAssertEqual(response.status, .ok, response.reason ?? "")
        XCTAssertEqual(response.repositories.count, 1)
        XCTAssertEqual(response.repositories[0].root, link)
        XCTAssertEqual(response.repositories[0].baselineHead, viaLink.head, "turn_start wins over a later alias")
        XCTAssertEqual(files(in: response.repositories[0].patch), ["y.txt"])
    }

    func testSensitiveFilesStayExcludedInTurnMode() throws {
        let repo = try GitTestRepo()
        try repo.write("x.txt", "x\n")
        _ = try repo.commitAll()
        let b = try XCTUnwrap(baseline([repo.root], store: nil).baselines?.first)
        try repo.write(".env", "SECRET=1\n")
        try repo.write("ok.txt", "ok\n")
        _ = try repo.commitAll()
        try repo.write("id_rsa", "key\n")
        let response = final([repo.root], baselines: [b])
        XCTAssertEqual(files(in: response.repositories[0].patch), ["ok.txt"])
        XCTAssertFalse(response.repositories[0].patch.contains("SECRET"))
        XCTAssertTrue(response.reason?.contains("Excluded 2 sensitive files") == true, response.reason ?? "")
    }

    func testNonRepositoryBaseline() {
        let dir = NSTemporaryDirectory() + "not-repo-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let response = baseline([dir], store: GitTurnBaselineStore())
        XCTAssertEqual(response.status, .notRepository)
        XCTAssertEqual(response.baselines, [])
    }

    // MARK: Wire

    func testRequestDecodingAndLegacyFallback() throws {
        let finalJSON = #"{"request_id":"r","candidate_paths":["/tmp"],"eligible_commits":[],"phase":"final","display_limit":50,"baselines":[{"root":"/tmp/r","head":null,"capturedAt":"2026-11-12T00:00:00.000Z","source":"turn_start"}]}"#
        let request = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(finalJSON.utf8))
        XCTAssertEqual(request.phase, .final)
        XCTAssertEqual(request.displayLimit, 50)
        XCTAssertEqual(request.baselines?.first?.head, nil)
        XCTAssertFalse(request.hasUnsupportedPhase)

        let baselineJSON = #"{"request_id":"r","candidate_paths":[],"phase":"baseline","baseline_source":"before_tool"}"#
        XCTAssertEqual(try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(baselineJSON.utf8)).baselineSource, .beforeTool)

        let legacy = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(#"{"request_id":"r","candidate_paths":[]}"#.utf8))
        XCTAssertNil(legacy.phase)
        XCTAssertFalse(legacy.hasUnsupportedPhase)

        let unknown = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(#"{"request_id":"r","candidate_paths":[],"phase":"later"}"#.utf8))
        XCTAssertTrue(unknown.hasUnsupportedPhase)
        XCTAssertEqual(GitSnapshotCollector().collect(unknown, turnStore: nil).status, .unavailable)
        let badSource = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(#"{"request_id":"r","candidate_paths":[],"phase":"baseline","baseline_source":"x"}"#.utf8))
        XCTAssertTrue(badSource.hasUnsupportedPhase)
    }

    func testResponseEncodingShapes() throws {
        let b = GitTurnBaseline(root: "/r", head: nil, capturedAt: "t", source: .turnStart)
        let ok = String(decoding: try JSONEncoder().encode(GitDiffResponsePayload(requestID: "r", status: .ok, baselines: [b])), as: UTF8.self)
        XCTAssertTrue(ok.contains(#""repositories":[]"#))
        XCTAssertTrue(ok.contains(#""head":null"#))
        let failed = GitDiffResponsePayload(requestID: "r", status: .unavailable, baselines: [b])
        XCTAssertEqual(failed.baselines, [])
        // Legacy patches keep their v2 shape (no turn keys).
        let legacy = String(decoding: try JSONEncoder().encode(GitDiffRepositoryPatch(root: "/r", patch: "p")), as: UTF8.self)
        XCTAssertFalse(legacy.contains("baselineHead"))
        let legacyResponse = String(decoding: try JSONEncoder().encode(GitDiffResponsePayload(requestID: "r", status: .ok)), as: UTF8.self)
        XCTAssertFalse(legacyResponse.contains("baselines"))
    }

    func testPartialBaselineSummariesKeepTurnWordingAndWarnings() {
        for scope: SavedSessionDiffScope in [.mixed, .workingTree] {
            let diff = SavedSessionDiff(id: "turn-partial", fileCount: 4, repositoryCount: 2, createdAt: "t",
                                       scope: scope, displayLimit: 50, baselineUnavailable: true)
            XCTAssertEqual(diff.buttonTitle, "View turn changes")
            XCTAssertEqual(diff.headerTitle, "Turn changes")
            XCTAssertTrue(diff.detailText.contains("baseline unavailable"))
            XCTAssertFalse(diff.detailText.contains("agent commit"))
            XCTAssertTrue(diff.helpText.contains("pre-existing"))
        }
    }

    func testSavedSummaryTurnLabelsAndDisplayLimit() throws {
        let json = #"{"id":"d","fileCount":73,"repositoryCount":2,"createdAt":"t","scope":"turn","displayLimit":50}"#
        let diff = try JSONDecoder().decode(SavedSessionDiff.self, from: Data(json.utf8))
        XCTAssertEqual(diff.scope, .turn)
        XCTAssertEqual(diff.buttonTitle, "View turn changes")
        XCTAssertEqual(diff.headerTitle, "Turn changes")
        XCTAssertEqual(diff.displayLimitNotice, "Showing 50 of 73 files")
        XCTAssertTrue(diff.detailText.contains("uncommitted"))
        XCTAssertTrue(diff.detailText.contains("Showing 50 of 73 files"))
        XCTAssertFalse(diff.detailText.lowercased().contains("latest commit"))
        XCTAssertFalse(diff.helpText.contains("commit observed"))

        let late = SavedSessionDiff(id: "d", fileCount: 3, repositoryCount: 1, createdAt: "t", scope: .turn,
                                    displayLimit: 50, baselineSource: .beforeTool)
        XCTAssertNil(late.displayLimitNotice)
        XCTAssertTrue(late.detailText.contains("before a later tool step"))

        // Saved legacy cards are unchanged.
        for scope in ["working_tree", "commit", "mixed"] {
            let old = try JSONDecoder().decode(SavedSessionDiff.self, from: Data(#"{"id":"d","fileCount":1,"repositoryCount":1,"createdAt":"t","scope":"\#(scope)","displayLimit":"bad"}"#.utf8))
            XCTAssertEqual(old.scope.rawValue, scope)
            XCTAssertNil(old.displayLimit)
            XCTAssertNotEqual(old.buttonTitle, "View turn changes")
        }
    }

    // MARK: Runner

    @MainActor
    func testRunnerAnswersBaselineFramesSilentlyWithOneStorePerRun() async throws {
        let replies = LockedBox<[GitDiffResponsePayload]>([])
        let both = expectation(description: "two replies")
        both.expectedFulfillmentCount = 2
        let socket = GitDiffTestSocket { message in
            if let response = message.gitDiffResponse {
                replies.lock2 { $0.append(response) }
                both.fulfill()
            }
        }
        let stores = LockedBox<[ObjectIdentifier]>([])
        let blocks = LockedCounter()
        ChatSessionRunner.shared.startAgentWebSocketSession(
            url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
            originalText: "Start", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
            onBlock: { _ in blocks.increment() }, onSteeringEvent: { _ in }, onFinal: { _ in },
            onError: { _ in },
            socket: socket,
            collectGitDiff: { request, store in
                stores.lock2 { $0.append(ObjectIdentifier(store)) }
                XCTAssertEqual(request.phase, .baseline)
                let b = GitTurnBaseline(root: "/r", head: nil, capturedAt: "t", source: request.baselineSource ?? .turnStart)
                return GitDiffResponsePayload(requestID: request.requestID, status: .ok, baselines: [b])
            }
        )
        socket.deliver(#"{"session_id":"session","sender":"agent","content":"","git_diff_request":{"request_id":"b1","candidate_paths":["/r"],"phase":"baseline","baseline_source":"turn_start"}}"#)
        socket.deliver(#"{"session_id":"session","sender":"agent","content":"","git_diff_request":{"request_id":"b2","candidate_paths":["/s"],"phase":"baseline","baseline_source":"before_tool"}}"#)
        await fulfillment(of: [both], timeout: 3)
        XCTAssertEqual(replies.get().map(\.requestID), ["b1", "b2"])
        XCTAssertEqual(replies.get().map { $0.baselines?.first?.source }, [.turnStart, .beforeTool])
        XCTAssertEqual(Set(stores.get()).count, 1, "one baseline store for the whole run")
        XCTAssertEqual(blocks.value, 0, "control frames never reach the chat")
    }
}
