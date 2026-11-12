import XCTest
@testable import OmniKeyAI

/// Native diff-recovery evidence: real Git in temporary repositories. The
/// "shell" is simulated by mutating the tree between the before/after
/// hooks, exactly where the runner executes the script.
final class DiffRecoveryTests: XCTestCase {
    private func q(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    @discardableResult
    private func shell(
        _ store: DiffRecoveryStore, _ script: String, candidates: [String] = [],
        turn: String = "run-1", tool: String = "call-1", cwd: String? = nil,
        file: StaticString = #filePath, line: UInt = #line,
        _ action: () throws -> Void = {}
    ) -> DiffRecoveryEvidence? {
        let context = GitDiffContext(candidatePaths: candidates, turnID: turn, toolCallID: tool)
        let checkpoint = store.before(script: script, context: context, initialDirectory: cwd)
        do { try action() } catch { XCTFail("simulated shell failed: \(error)", file: file, line: line) }
        return checkpoint.flatMap(store.after)
    }

    private func recover(_ store: DiffRecoveryStore, turn: String = "run-1", ids: [String],
                         candidates: [String] = []) -> GitDiffResponsePayload {
        store.recover(GitDiffRequestPayload(
            requestID: "r-\(UUID().uuidString)", candidatePaths: candidates, eligibleCommits: [],
            phase: .recover, recovery: GitDiffRecoveryRequest(turnID: turn, evidenceIDs: ids)
        ))
    }

    private func files(in patch: String) -> Set<String> {
        Set(patch.components(separatedBy: "\n").compactMap { line -> String? in
            guard line.hasPrefix("diff --git a/") else { return nil }
            return line.components(separatedBy: " b/").last
        })
    }

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

    func testTmpSymlinkLiteralCreateThenAppendProducesRecovery() throws {
        let directory = "/tmp/diff-recovery-regression-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let path = directory + "/note.md"
        let store = DiffRecoveryStore()
        let first = try XCTUnwrap(shell(store, "printf 'first\\n' > \(q(path))") {
            try "first\n".write(toFile: path, atomically: true, encoding: .utf8)
        })
        let second = try XCTUnwrap(shell(store, "printf 'second\\n' >> \(q(path))", tool: "call-2") {
            try "first\nsecond\n".write(toFile: path, atomically: true, encoding: .utf8)
        })
        XCTAssertEqual(first.records.first?.id, second.records.first?.id)
        let patch = try XCTUnwrap(recover(store, ids: second.records.map(\.id)).repositories.first?.patch)
        XCTAssertTrue(patch.contains("+first"))
        XCTAssertTrue(patch.contains("+second"))
        XCTAssertTrue(second.records[0].root.hasPrefix("/private/tmp/"))
    }

    func testAIReconstructionLabelsNeverClaimNativeVerification() throws {
        let summary = SavedSessionDiff(id: "sdiff_ai", fileCount: 1, repositoryCount: 1, createdAt: "t",
            recovered: true, recoveryIncomplete: true, recoveryMethod: "ai_reconstructed")
        XCTAssertEqual(summary.headerTitle, "AI-reconstructed turn changes")
        XCTAssertTrue(summary.detailText.contains("unverified"))
        XCTAssertTrue(summary.helpText.contains("not a verified filesystem diff"))
        let roundtrip = try JSONDecoder().decode(SavedSessionDiff.self, from: JSONEncoder().encode(summary))
        XCTAssertEqual(roundtrip.recoveryMethod, "ai_reconstructed")
    }

    func testRenameEvidenceIncludesBothPaths() throws {
        let repo = try GitTestRepo()
        try repo.write("old.txt", "original\n")
        _ = try repo.commitAll()
        let store = DiffRecoveryStore()
        let evidence = try XCTUnwrap(shell(store, "git mv old.txt new.txt", candidates: [repo.root]) {
            try repo.git("mv", "old.txt", "new.txt")
        })
        let record = try XCTUnwrap(evidence.records.first)
        XCTAssertEqual(Set(record.paths), ["old.txt", "new.txt"])
        XCTAssertTrue(recover(store, ids: [record.id]).repositories.first?.patch.contains("rename from old.txt") == true)
    }

    func testSixtyFilesReplayOnlyAllowlistedFiftyWithPartialFlag() throws {
        let repo = try GitTestRepo()
        try repo.write("base", "base\n")
        _ = try repo.commitAll()
        let store = DiffRecoveryStore()
        let evidence = try XCTUnwrap(shell(store, "generate files", candidates: [repo.root]) {
            for i in 0..<60 { try repo.write(String(format: "f%03d.txt", i), "new\n") }
        })
        let record = try XCTUnwrap(evidence.records.first)
        XCTAssertEqual(record.paths.count, 50)
        XCTAssertFalse(record.complete)
        let replay = recover(store, ids: [record.id])
        XCTAssertEqual(files(in: try XCTUnwrap(replay.repositories.first?.patch)).count, 50)
    }

    func testNonGitReplayRejectsLaterUnobservedDeletion() throws {
        let repo = try GitTestRepo()
        let file = (repo.root as NSString).appendingPathComponent("note.txt")
        let store = DiffRecoveryStore()
        let evidence = try XCTUnwrap(shell(store, "echo hi > \(q(file))") {
            try "hi\n".write(toFile: file, atomically: true, encoding: .utf8)
        })
        let id = try XCTUnwrap(evidence.records.first?.id)
        try FileManager.default.removeItem(atPath: file)
        let response = recover(store, ids: [id])
        XCTAssertTrue(response.repositories.isEmpty)
        XCTAssertEqual(response.recovery?.omitted, 1)
    }

    // MARK: Git

    func testUnchangedPrimaryRepositoryProducesNoRecord() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        try repo.write("a.txt", "pre-existing dirt\n")
        let store = DiffRecoveryStore()
        XCTAssertNil(shell(store, "cd \(q(repo.root)) && ls", candidates: [repo.root]))
        XCTAssertNil(shell(store, "git status", candidates: [repo.root], tool: "call-2"))
    }

    func testEditIsRecordedWithoutUntouchedPreexistingDirt() throws {
        let repo = try GitTestRepo()
        try repo.write("dirty.txt", "a\n")
        try repo.write("b.txt", "b\n")
        let head = try repo.commitAll()
        try repo.write("dirty.txt", "pre-existing\n")
        let store = DiffRecoveryStore()
        let evidence = try XCTUnwrap(shell(store, "cd \(q(repo.root)) && echo edit >> b.txt") {
            try repo.write("b.txt", "b\nedit\n")
        })
        XCTAssertEqual(evidence.turnID, "run-1")
        let record = try XCTUnwrap(evidence.records.first)
        XCTAssertEqual(evidence.records.count, 1)
        XCTAssertEqual(record.kind, .git)
        XCTAssertEqual(record.toolCallId, "call-1")
        XCTAssertEqual(record.root, repo.root)
        XCTAssertEqual(record.paths, ["b.txt"])
        XCTAssertEqual(record.before, head)
        XCTAssertEqual(record.after, head)
        XCTAssertTrue(record.complete)

        let response = recover(store, ids: [record.id])
        XCTAssertEqual(response.status, .ok)
        XCTAssertEqual(response.recovery, GitDiffRecoveryResponse(turnID: "run-1", evidenceIDs: [record.id], omitted: 0))
        XCTAssertEqual(response.repositories.map(\.root), [repo.root])
        XCTAssertEqual(response.repositories.first?.scope, .workingTree)
        XCTAssertEqual(files(in: response.repositories[0].patch), ["b.txt"])
        XCTAssertTrue(response.repositories[0].patch.contains("+edit"))

        // Reverting to baseline removes the record; a replay omits it.
        let reverted = shell(store, "cd \(q(repo.root)) && git checkout b.txt", tool: "call-2") {
            try repo.git("checkout", "--", "b.txt")
        }
        XCTAssertTrue(reverted?.records.isEmpty ?? true)
        let empty = recover(store, ids: [record.id])
        XCTAssertEqual(empty.status, .ok)
        XCTAssertEqual(empty.repositories, [])
        XCTAssertEqual(empty.recovery?.omitted, 1)
    }

    func testWorktreeVariableCommitDeleteIsRecoveredFromStoredPatch() throws {
        let repo = try GitTestRepo()
        try repo.write("main.txt", "main\n")
        let head = try repo.commitAll()
        let worktree = repo.root + "-wt"
        defer { try? FileManager.default.removeItem(atPath: worktree) }
        let store = DiffRecoveryStore()

        // 1: create the worktree via a literal variable.
        let create = "R=\(q(worktree))\ngit -C \(q(repo.root)) worktree add -q \"$R\" -b feat"
        XCTAssertNil(shell(store, create, candidates: [repo.root]) {
            try repo.git("worktree", "add", "-q", worktree, "-b", "feat")
        })

        // 2: edit and commit inside it, reached only through `$R`.
        let edit = "R=\(q(worktree))\ncd \"$R\" && printf 'feature\\n' > feature.txt && git add -A && git commit -qm feat"
        let evidence = try XCTUnwrap(shell(store, edit, tool: "call-2") {
            try "feature\n".write(toFile: worktree + "/feature.txt", atomically: true, encoding: .utf8)
            try repo.git("add", "-A", in: worktree)
            try repo.git("commit", "-q", "-m", "feat", in: worktree)
        })
        let record = try XCTUnwrap(evidence.records.first { $0.root == worktree })
        XCTAssertEqual(record.paths, ["feature.txt"])
        XCTAssertEqual(record.before, head)
        XCTAssertEqual(record.after, try repo.git("rev-parse", "HEAD", in: worktree))
        XCTAssertTrue(record.complete)
        XCTAssertFalse(evidence.records.contains { $0.root == repo.root }, "primary unchanged")

        // 3: delete the worktree and its branch; the last verified patch stays.
        let remove = "git -C \(q(repo.root)) worktree remove --force \(q(worktree)) && git -C \(q(repo.root)) branch -D feat"
        let deleted = try XCTUnwrap(shell(store, remove, tool: "call-3") {
            try repo.git("worktree", "remove", "--force", worktree)
            try repo.git("branch", "-D", "feat")
        })
        let retained = try XCTUnwrap(deleted.records.first)
        XCTAssertEqual(retained.id, record.id)
        XCTAssertEqual(retained.toolCallId, "call-3")
        XCTAssertNil(retained.after)
        XCTAssertFalse(retained.complete)
        XCTAssertFalse(FileManager.default.fileExists(atPath: worktree))

        let response = recover(store, ids: [record.id])
        XCTAssertEqual(response.status, .ok)
        XCTAssertEqual(response.repositories.map(\.root), [worktree])
        XCTAssertTrue(response.repositories[0].patch.contains("+feature"))
        XCTAssertEqual(response.reason, "Some selected evidence is incomplete.")
    }

    func testWorktreeCreatedAndCommittedInOneShellCannotClaimCompleteness() throws {
        let repo = try GitTestRepo()
        try repo.write("main.txt", "main\n")
        _ = try repo.commitAll()
        let worktree = repo.root + "-wt1"
        defer { try? FileManager.default.removeItem(atPath: worktree) }
        let store = DiffRecoveryStore()
        let script = "git -C \(q(repo.root)) worktree add -q \(q(worktree)) -b one && cd \(q(worktree)) && git commit -qm x"
        let evidence = try XCTUnwrap(shell(store, script, candidates: [repo.root]) {
            try repo.git("worktree", "add", "-q", worktree, "-b", "one")
            try "w\n".write(toFile: worktree + "/w.txt", atomically: true, encoding: .utf8)
            try repo.git("add", "-A", in: worktree)
            try repo.git("commit", "-q", "-m", "x", in: worktree)
            try "late\n".write(toFile: worktree + "/late.txt", atomically: true, encoding: .utf8)
        })
        let record = try XCTUnwrap(evidence.records.first { $0.root == worktree })
        // The commit made before discovery is part of the observed baseline,
        // so only the later edit is visible and the record says so.
        XCTAssertEqual(record.paths, ["late.txt"])
        XCTAssertFalse(record.complete)
    }

    func testSensitiveFilesAreNeverInGitEvidence() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll()
        let store = DiffRecoveryStore()
        let evidence = try XCTUnwrap(shell(store, "cd \(q(repo.root)) && touch .env app.txt") {
            try repo.write(".env", "SECRET=1\n")
            try repo.write("app.txt", "x\n")
        })
        XCTAssertEqual(evidence.records.first?.paths, ["app.txt"])
        XCTAssertEqual(evidence.records.first?.complete, false, "sensitive exclusion is a limitation")
        let patch = recover(store, ids: evidence.records.map(\.id)).repositories.first?.patch ?? ""
        XCTAssertFalse(patch.contains("SECRET"))
    }

    // MARK: Files outside Git

    private func plainDirectory() throws -> GitTestRepo { try GitTestRepo(initialize: false) }

    func testNonGitFileBeforeAfterIsRecordedFromExplicitQuotedPath() throws {
        let dir = try plainDirectory()
        let path = dir.root + "/notes.txt"
        try "one\ntwo\nthree\n".write(toFile: path, atomically: true, encoding: .utf8)
        let store = DiffRecoveryStore()
        let evidence = try XCTUnwrap(shell(store, "cat > \(q(path)) <<'EOF'\none\nTWO\nthree\nEOF") {
            try "one\nTWO\nthree\n".write(toFile: path, atomically: true, encoding: .utf8)
        })
        let record = try XCTUnwrap(evidence.records.first)
        XCTAssertEqual(record.kind, .file)
        XCTAssertEqual(record.root, dir.root)
        XCTAssertEqual(record.paths, ["notes.txt"])
        XCTAssertEqual(record.before, DiffRecoveryStore.hash(Data("one\ntwo\nthree\n".utf8)))
        XCTAssertEqual(record.after, DiffRecoveryStore.hash(Data("one\nTWO\nthree\n".utf8)))
        XCTAssertEqual(record.before?.count, 64)
        let patch = try XCTUnwrap(recover(store, ids: [record.id]).repositories.first?.patch)
        XCTAssertEqual(patch, """
        diff --git a/notes.txt b/notes.txt
        --- a/notes.txt
        +++ b/notes.txt
        @@ -1,3 +1,3 @@
         one
        -two
        +TWO
         three

        """)
    }

    func testCreatedFileFromVerifiedAbsenceAndPythonPathLiteral() throws {
        let dir = try plainDirectory()
        let path = dir.root + "/new.py"
        let store = DiffRecoveryStore()
        let script = "python3 - <<'EOF'\nfrom pathlib import Path\nPath(\(q(path))).write_text('x = 1')\nEOF"
        let evidence = try XCTUnwrap(shell(store, script) {
            try "x = 1".write(toFile: path, atomically: true, encoding: .utf8)
        })
        let record = try XCTUnwrap(evidence.records.first)
        XCTAssertNil(record.before)
        let patch = try XCTUnwrap(recover(store, ids: [record.id]).repositories.first?.patch)
        XCTAssertTrue(patch.contains("new file mode 100644\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+x = 1\n\\ No newline at end of file\n"))
    }

    func testUnsafeOrUnreliableFilesProduceNoRecord() throws {
        let dir = try plainDirectory()
        let store = DiffRecoveryStore()
        let secret = dir.root + "/.env"
        let tool = dir.root + "/run.sh"
        try "#!/bin/sh\n".write(toFile: tool, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool)
        let target = dir.root + "/target.txt"
        try "t\n".write(toFile: target, atomically: true, encoding: .utf8)
        let link = dir.root + "/link.txt"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: target)
        let unquoted = dir.root + "/unquoted.txt"
        let big = dir.root + "/big.txt"
        try Data(repeating: 65, count: 300 * 1024).write(to: URL(fileURLWithPath: big))

        let script = [
            "echo S=1 > \(q(secret))", "echo x >> \(q(tool))", "echo y > \(q(link))",
            "echo z > \(unquoted)", "echo d > \(q(dir.root))", "echo b >> \(q(big))", "echo r > '/etc/hosts.new'",
        ].joined(separator: "\n")
        let evidence = shell(store, script) {
            try "S=1\n".write(toFile: secret, atomically: true, encoding: .utf8)
            try "#!/bin/sh\nx\n".write(toFile: tool, atomically: false, encoding: .utf8)
            try "changed\n".write(toFile: target, atomically: true, encoding: .utf8)
            try "z\n".write(toFile: unquoted, atomically: true, encoding: .utf8)
            try Data(repeating: 66, count: 300 * 1024).write(to: URL(fileURLWithPath: big))
        }
        XCTAssertNil(evidence, "no record for sensitive, executable, symlink, unquoted, directory, oversized or system paths")
    }

    func testOverwrittenWithoutReliableBeforeImageIsSkipped() throws {
        let dir = try plainDirectory()
        let path = dir.root + "/grows.txt"
        let store = DiffRecoveryStore()
        // Before is unavailable (the file does not exist yet *and* is created
        // as something unrepresentable): a directory is never guessed.
        XCTAssertNil(shell(store, "mkdir \(q(path))") {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
        })
    }

    // MARK: Turn isolation and recover validation

    func testNextTurnNeverSeesOrReplaysAnOldRecord() throws {
        let dir = try plainDirectory()
        let path = dir.root + "/f.txt"
        let store = DiffRecoveryStore()
        let first = try XCTUnwrap(shell(store, "echo a > \(q(path))") {
            try "a\n".write(toFile: path, atomically: true, encoding: .utf8)
        })
        let oldID = try XCTUnwrap(first.records.first?.id)
        // A different turn rebinds the store; the old record is gone.
        let second = shell(store, "echo b > \(q(path))", turn: "run-2", tool: "call-9") {
            try "a\nb\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
        XCTAssertFalse(second?.records.contains { $0.id == oldID } ?? false)
        XCTAssertEqual(recover(store, turn: "run-1", ids: [oldID]).status, .unavailable)
        XCTAssertEqual(recover(store, turn: "run-2", ids: [oldID]).status, .unavailable)
        // A fresh store (the next outer run) has nothing at all.
        XCTAssertEqual(recover(DiffRecoveryStore(), turn: "run-1", ids: [oldID]).status, .unavailable)
    }

    func testRecoverRejectsMaliciousSelections() throws {
        let dir = try plainDirectory()
        let path = dir.root + "/f.txt"
        let store = DiffRecoveryStore()
        let id = try XCTUnwrap(shell(store, "echo a > \(q(path))") {
            try "a\n".write(toFile: path, atomically: true, encoding: .utf8)
        }?.records.first?.id)
        XCTAssertEqual(recover(store, ids: [id]).status, .ok)
        XCTAssertEqual(recover(store, turn: "other", ids: [id]).status, .unavailable)
        XCTAssertEqual(recover(store, ids: [id, id]).status, .unavailable)
        XCTAssertEqual(recover(store, ids: [id, "g_forged"]).status, .unavailable)
        XCTAssertEqual(recover(store, ids: []).status, .unavailable)
        XCTAssertEqual(recover(store, ids: [id], candidates: ["/etc"]).status, .unavailable)
        // No shell context IDs: never recorded.
        XCTAssertNil(store.before(script: "echo", context: GitDiffContext(candidatePaths: []), initialDirectory: nil))
        // A recover phase without a selection decodes as unsupported.
        let frame = #"{"request_id":"x","candidate_paths":[],"phase":"recover"}"#
        let decoded = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(frame.utf8))
        XCTAssertTrue(decoded.hasUnsupportedPhase)
        XCTAssertEqual(store.recover(decoded).status, .unavailable)
        XCTAssertEqual(GitSnapshotCollector().collect(decoded, turnStore: nil).status, .unavailable)
    }

    // MARK: Wire

    func testWireShapes() throws {
        let context = try JSONDecoder().decode(GitDiffContext.self, from: Data(
            #"{"candidate_paths":["/r"],"turn_id":"run-1","tool_call_id":"call 1"}"#.utf8))
        XCTAssertEqual(context.turnID, "run-1")
        XCTAssertNil(context.toolCallID, "malformed IDs are dropped")

        let evidence = DiffRecoveryEvidence(turnID: "run-1", records: [
            DiffRecoveryRecord(id: "f_1", toolCallId: "c", root: "/r", paths: ["a"], kind: .file, before: nil, after: String(repeating: "a", count: 64), complete: true),
        ], omitted: nil)
        let json = String(decoding: try JSONEncoder().encode(evidence), as: UTF8.self)
        XCTAssertTrue(json.contains(#""turn_id":"run-1""#))
        XCTAssertTrue(json.contains(#""toolCallId":"c""#))
        XCTAssertTrue(json.contains(#""before":null"#))
        XCTAssertFalse(json.contains("omitted"))

        let request = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(
            #"{"request_id":"x","candidate_paths":[],"eligible_commits":[],"phase":"recover","recovery":{"turn_id":"run-1","evidence_ids":["a","b"]}}"#.utf8))
        XCTAssertFalse(request.hasUnsupportedPhase)
        XCTAssertEqual(request.recovery, GitDiffRecoveryRequest(turnID: "run-1", evidenceIDs: ["a", "b"]))
        let stray = try JSONDecoder().decode(GitDiffRequestPayload.self, from: Data(
            #"{"request_id":"x","candidate_paths":[],"phase":"final","recovery":{"turn_id":"t","evidence_ids":[]}}"#.utf8))
        XCTAssertTrue(stray.hasUnsupportedPhase)

        let response = GitDiffResponsePayload(requestID: "x", status: .ok, repositories: [GitDiffRepositoryPatch(root: "/r", patch: "p")],
                                              recovery: GitDiffRecoveryResponse(turnID: "run-1", evidenceIDs: ["a"], omitted: 0))
        let encoded = String(decoding: try JSONEncoder().encode(response), as: UTF8.self)
        XCTAssertTrue(encoded.contains(#""recovery":{"#) && encoded.contains(#""evidence_ids":["a"]"#))
        XCTAssertNil(GitDiffResponsePayload(requestID: "x", status: .unavailable,
                                            recovery: GitDiffRecoveryResponse(turnID: "t", evidenceIDs: [], omitted: 0)).recovery)
    }

    func testRecoveredSummaryLabels() throws {
        let json = #"{"id":"d","fileCount":2,"repositoryCount":1,"createdAt":"t","scope":"working_tree","recovered":true,"recoveryIncomplete":true}"#
        let diff = try JSONDecoder().decode(SavedSessionDiff.self, from: Data(json.utf8))
        XCTAssertEqual(diff.buttonTitle, "View recovered turn changes")
        XCTAssertEqual(diff.headerTitle, "Recovered turn changes")
        XCTAssertTrue(diff.detailText.contains("partial"))
        XCTAssertFalse(diff.detailText.contains("pre-existing uncommitted"))
        XCTAssertTrue(diff.helpText.contains("Partial"))
        // Round-trips through persistence.
        let again = try JSONDecoder().decode(SavedSessionDiff.self, from: JSONEncoder().encode(diff))
        XCTAssertEqual(again, diff)
        let complete = SavedSessionDiff(id: "d", fileCount: 1, repositoryCount: 1, createdAt: "t", recovered: true)
        XCTAssertNil(complete.recoveryWarning)
        XCTAssertEqual(SavedSessionDiff(id: "d", fileCount: 1, repositoryCount: 1, createdAt: "t").buttonTitle, "View working-tree snapshot")
    }

    func testReportedRootNeverLeavesTheRepositoryForSymlinkedCandidates() throws {
        let repo = try GitTestRepo()
        try repo.write("a/b/c.txt", "c\n")
        let links = try plainDirectory()
        let link = links.root + "/l"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: repo.root + "/a/b")
        let root = try XCTUnwrap(GitSnapshotCollector.canonicalDirectory(repo.root))
        // Walking two levels up from `…/l` would land outside the repository.
        XCTAssertEqual(GitSnapshotCollector.reportedRoot(root, candidates: [link]), root)
        let rootLink = links.root + "/repo"
        try FileManager.default.createSymbolicLink(atPath: rootLink, withDestinationPath: repo.root)
        XCTAssertEqual(GitSnapshotCollector.reportedRoot(root, candidates: [rootLink + "/a"]), rootLink)
        XCTAssertEqual(GitSnapshotCollector.reportedRoot(root, candidates: ["/"]), root)
    }

    func testUnifiedDiffIsDeterministic() {
        let patch = DiffRecoveryPatch.unifiedDiff(name: "x", old: Data("a\nb".utf8), new: Data("a\nb\n".utf8))
        XCTAssertEqual(patch, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n")
        XCTAssertEqual(DiffRecoveryPatch.unifiedDiff(name: "x", old: Data("s".utf8), new: Data("s".utf8)), "")
        XCTAssertTrue(DiffRecoveryPatch.unifiedDiff(name: "x", old: Data([0, 1]), new: Data([0, 2])).hasSuffix("Binary files a/x and b/x differ\n"))
        XCTAssertTrue(DiffRecoveryPatch.unifiedDiff(name: "x", old: Data("a\n".utf8), new: nil).contains("deleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n"))
        XCTAssertNil(DiffRecoveryPatch.path(fromHeader: "diff --git a/../x b/../x"))
        XCTAssertEqual(DiffRecoveryPatch.path(fromHeader: "diff --git a/x y b/x y"), "x y")
    }

    // MARK: Runner

    @MainActor
    func testRunnerAdvertisesCapabilityAttachesEvidenceAndServesRecover() async throws {
        let dir = try plainDirectory()
        let path = dir.root + "/out.txt"
        let terminal = expectation(description: "terminal")
        let recovered = expectation(description: "recover")
        let evidenceBox = LockedBox<DiffRecoveryEvidence?>(nil)
        let responseBox = LockedBox<GitDiffResponsePayload?>(nil)
        let initial = LockedBox<Bool?>(nil)
        let socket = GitDiffTestSocket { message in
            if message.content == "Start" { initial.set(message.supportsDiffRecovery) }
            if message.isTerminalOutput == true { evidenceBox.set(message.diffRecoveryEvidence); terminal.fulfill() }
            if let response = message.gitDiffResponse { responseBox.set(response); recovered.fulfill() }
        }
        ChatSessionRunner.shared.startAgentWebSocketSession(
            url: URL(string: "ws://localhost/unused")!, sessionID: "session", jwt: "",
            originalText: "Start", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
            onBlock: { _ in }, onSteeringEvent: { _ in }, onFinal: { _ in }, onError: { XCTFail("\($0)") },
            socket: socket,
            executeShell: { script, registrar in runShellCommandWithStatus(script, processRegistrar: registrar) },
            collectGitDiff: { request, _ in
                XCTFail("recover must not reach the collector")
                return GitDiffResponsePayload(requestID: request.requestID, status: .unavailable)
            }
        )
        let script = "printf 'hello\\n' > \(q(path))"
        let content = String(decoding: try JSONEncoder().encode("<shell_script>\(script)</shell_script>"), as: UTF8.self)
        socket.deliver(#"{"session_id":"session","sender":"agent","content":\#(content),"git_diff_context":{"candidate_paths":[],"turn_id":"run-7","tool_call_id":"tool-1"}}"#)
        await fulfillment(of: [terminal], timeout: 15)
        XCTAssertEqual(initial.get(), true)
        let evidence = try XCTUnwrap(evidenceBox.get())
        XCTAssertEqual(evidence.turnID, "run-7")
        let record = try XCTUnwrap(evidence.records.first)
        XCTAssertEqual(record.toolCallId, "tool-1")
        XCTAssertNil(record.before)

        socket.deliver(#"{"session_id":"session","sender":"agent","content":"","git_diff_request":{"request_id":"rec-1","candidate_paths":[],"eligible_commits":[],"phase":"recover","recovery":{"turn_id":"run-7","evidence_ids":["\#(record.id)"]}}}"#)
        await fulfillment(of: [recovered], timeout: 5)
        let response = try XCTUnwrap(responseBox.get())
        XCTAssertEqual(response.status, .ok)
        XCTAssertEqual(response.recovery?.evidenceIDs, [record.id])
        XCTAssertEqual(response.repositories.first?.root, dir.root)
        XCTAssertTrue(response.repositories.first?.patch.contains("+hello") ?? false)
    }
}
