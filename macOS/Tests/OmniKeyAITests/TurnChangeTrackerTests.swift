import XCTest
@testable import OmniKeyAI

final class TurnChangeTrackerTests: XCTestCase {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("turn-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url.resolvingSymlinksInPath()
    }
    private func write(_ root: URL, _ file: String, _ text: String) throws {
        try Data(text.utf8).write(to: root.appendingPathComponent(file))
    }
    private func begin(_ tracker: TurnChangeTracker, _ root: URL, source: GitTurnBaselineSource = .turnStart) -> GitDiffResponsePayload {
        tracker.baseline(GitDiffRequestPayload(requestID: "baseline", candidatePaths: [root.path], phase: .baseline, baselineSource: source, filesystem: true))
    }
    private func patch(_ tracker: TurnChangeTracker) -> String {
        tracker.capture(status: "running").repositories.map(\.patch).joined()
    }

    func testWideDirectoryStopsAtEntryBudget() throws {
        let root = try folder()
        for i in 0..<300 { try write(root, "file-\(i)", "original\n") }
        let tracker = TurnChangeTracker()
        tracker.limits.files = 3
        _ = begin(tracker, root)
        let diff = tracker.capture(status: "running")
        XCTAssertEqual(diff.coverage.first?.status, "partial")
        XCTAssertTrue(diff.coverage.first?.reason.contains("entry limit") == true)
        XCTAssertTrue(diff.repositories.isEmpty)
    }

    func testWorktreeCleanupCannotConsumeProjectPatchBudget() throws {
        let repo = try GitTestRepo()
        try repo.write("package.json", "before\n")
        try repo.write("README.md", "readme\n")
        _ = try repo.commitAll()
        let parent = try folder()
        let auxiliary = parent.appendingPathComponent("worktree")
        try repo.git("worktree", "add", "--detach", auxiliary.path)
        let tracker = TurnChangeTracker()
        tracker.limits.patchBytes = 300
        _ = begin(tracker, URL(fileURLWithPath: repo.root))
        _ = begin(tracker, auxiliary, source: .beforeTool)
        try repo.write("package.json", "after migration\n")
        try repo.git("worktree", "remove", "--force", auxiliary.path)
        let result = tracker.capture(status: "final")
        XCTAssertEqual(result.repositories.count, 1)
        XCTAssertEqual(result.repositories.first?.root, repo.root)
        XCTAssertTrue(result.repositories.first?.patch.contains("+after migration") == true)
        XCTAssertFalse(result.repositories.map(\.patch).joined().contains("deleted file mode"))
        XCTAssertEqual(result.coverage.first(where: { $0.root == auxiliary.path })?.status, "unavailable")
        // The later PR-creation turn begins from the already-edited checkout.
        let next = TurnChangeTracker()
        _ = begin(next, URL(fileURLWithPath: repo.root))
        try repo.git("worktree", "add", "--detach", auxiliary.path)
        _ = begin(next, auxiliary, source: .beforeTool)
        try repo.git("worktree", "remove", "--force", auxiliary.path)
        XCTAssertTrue(next.capture(status: "final").repositories.isEmpty)
    }

    func testIgnoredBuildOutputsDoNotExhaustSourceBudget() throws {
        let repo = try GitTestRepo()
        try repo.write(".gitignore", "dist/\n.turbo/\n")
        try repo.write("package.json", "original\n")
        try repo.write("dist/tracked.txt", "tracked\n")
        try repo.git("add", "-f", "dist/tracked.txt")
        _ = try repo.commitAll()
        try repo.write("dist/generated.js", String(repeating: "generated", count: 1000))
        let tracker = TurnChangeTracker()
        tracker.limits.rootBytes = 100
        _ = begin(tracker, URL(fileURLWithPath: repo.root))
        try repo.write("package.json", "migrated\n")
        try repo.write("new-config.json", "new\n")
        try repo.write("dist/tracked.txt", "updated tracked\n")
        try repo.write(".turbo/cache/output", String(repeating: "cache", count: 1000))
        let result = tracker.capture(status: "final")
        let patch = result.repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("+migrated"))
        XCTAssertTrue(patch.contains("a/new-config.json b/new-config.json"))
        XCTAssertTrue(patch.contains("+updated tracked"))
        XCTAssertFalse(patch.contains("generated.js"))
        XCTAssertFalse(patch.contains(".turbo/cache"))
        XCTAssertEqual(result.coverage.first?.status, "complete")
    }

    func testCaseAliasesUseFilesystemIdentityWithoutRebasing() throws {
        let parent = try folder()
        let root = parent.appendingPathComponent("MixedCaseProject")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let alias = parent.appendingPathComponent("mixedcaseproject")
        guard FileManager.default.fileExists(atPath: alias.path) else { throw XCTSkip("Case-sensitive filesystem") }
        try write(root, "file", "original\n")
        let tracker = TurnChangeTracker()
        let first = begin(tracker, root)
        try write(root, "file", "edited\n")
        let next = begin(tracker, alias, source: .beforeTool)
        XCTAssertEqual(next.baselines, first.baselines)
        XCTAssertEqual(next.rootAliases, [GitRootAlias(root: root.path, alias: alias.path)])
        XCTAssertTrue(patch(tracker).contains("-original"))
        XCTAssertEqual(tracker.capture(status: "final").coverage.count, 1)
    }

    func testExistingRootReplacementIsNotComparedWithUnrelatedContents() throws {
        let parent = try folder(), root = parent.appendingPathComponent("checkout")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "file", "original\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        try FileManager.default.moveItem(at: root, to: parent.appendingPathComponent("original-checkout"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "file", "unrelated\n")
        let result = tracker.capture(status: "final")
        XCTAssertTrue(result.repositories.isEmpty)
        XCTAssertEqual(result.coverage.first?.status, "unavailable")
    }

    func testCleanedWorktreeRetainsLastCapturedEditsButNotDeletionNoise() throws {
        let repo = try GitTestRepo()
        try repo.write("file", "original\n")
        _ = try repo.commitAll()
        let parent = try folder(), worktree = parent.appendingPathComponent("worker")
        try repo.git("worktree", "add", "--detach", worktree.path)
        let tracker = TurnChangeTracker()
        _ = begin(tracker, worktree, source: .beforeTool)
        // Retention needs an explicit tool boundary; live scans alone are not
        // trusted after removal (one may have run mid-cleanup).
        tracker.beginTool()
        try write(worktree, "file", "updated dependency\n")
        tracker.endTool()
        let captured = tracker.capture(status: "running")
        XCTAssertTrue(captured.repositories.first?.patch.contains("+updated dependency") == true)
        try repo.git("worktree", "remove", "--force", worktree.path)
        let final = tracker.capture(status: "final")
        XCTAssertEqual(final.repositories, captured.repositories)
        XCTAssertTrue(final.coverage.first?.reason.contains("before this folder was removed") == true)
        XCTAssertFalse(final.repositories.first?.patch.contains("deleted file mode") == true)
    }

    func testNonGitStartingContentsAndNextTurnDoNotLeak() throws {
        let root = try folder()
        try write(root, "file.txt", "preexisting uncommitted content\n")
        let first = TurnChangeTracker()
        XCTAssertEqual(begin(first, root).status, .ok)
        XCTAssertEqual(patch(first), "")
        try write(root, "file.txt", "new content\n")
        XCTAssertTrue(patch(first).contains("-preexisting uncommitted content"))
        XCTAssertTrue(patch(first).contains("+new content"))
        let next = TurnChangeTracker()
        _ = begin(next, root)
        XCTAssertEqual(patch(next), "", "The next run starts from actual files, even without a commit")
    }

    func testSteeringAndRepeatedBaselineKeepOriginalInterval() throws {
        let root = try folder()
        try write(root, "file", "original\n")
        let tracker = TurnChangeTracker()
        let first = begin(tracker, root)
        try write(root, "file", "before steering\n")
        let repeated = begin(tracker, root, source: .beforeTool)
        XCTAssertEqual(first.baselines, repeated.baselines)
        try write(root, "file", "after steering\n")
        let result = patch(tracker)
        XCTAssertTrue(result.contains("-original"))
        XCTAssertTrue(result.contains("+after steering"))
        XCTAssertFalse(result.contains("before steering"))
        try write(root, "file", "original\n")
        XCTAssertEqual(patch(tracker), "", "Undo removes the net change")
    }

    func testDirtyGitBaselineMultipleCommitsAndHistoryRewrite() throws {
        let repo = try GitTestRepo()
        try repo.write("file", "committed\n")
        _ = try repo.commitAll("base")
        try repo.write("file", "dirty at start\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, URL(fileURLWithPath: repo.root))
        XCTAssertEqual(patch(tracker), "")
        try repo.write("file", "first edit\n")
        _ = try repo.commitAll("one")
        try repo.write("file", "second edit\n")
        _ = try repo.commitAll("two")
        let result = patch(tracker)
        XCTAssertTrue(result.contains("-dirty at start"))
        XCTAssertTrue(result.contains("+second edit"))
        XCTAssertFalse(result.contains("-committed"))
        // Removing the repository metadata cannot invalidate captured bytes.
        try FileManager.default.removeItem(atPath: repo.root + "/.git")
        XCTAssertEqual(patch(tracker), result)
    }

    func testAddsDeletesBinarySymlinkModeAndMissingNewline() throws {
        let root = try folder()
        try write(root, "deleted", "old")
        try write(root, "mode", "same\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        try FileManager.default.removeItem(at: root.appendingPathComponent("deleted"))
        try write(root, "new", "new")
        try Data([0, 1, 2]).write(to: root.appendingPathComponent("binary"))
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("link").path, withDestinationPath: "/outside/never-read")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent("mode").path)
        let result = patch(tracker)
        XCTAssertTrue(result.contains("deleted file mode"))
        XCTAssertTrue(result.contains("new file mode 120000"))
        XCTAssertTrue(result.contains("+/outside/never-read"))
        XCTAssertTrue(result.contains("Binary files /dev/null and b/binary differ"), result)
        XCTAssertTrue(result.contains("new mode 100755"))
        XCTAssertTrue(result.contains("\\ No newline at end of file"))
    }

    func testPartialRootDoesNotSuppressHealthyRootAndHasSuggestedFix() throws {
        let one = try folder(), two = try folder()
        try write(one, "file", "old\n")
        try write(two, "large", String(repeating: "x", count: 100))
        let tracker = TurnChangeTracker()
        tracker.limits.fileBytes = 32
        _ = begin(tracker, one)
        _ = begin(tracker, two, source: .beforeTool)
        try write(one, "file", "new\n")
        let result = tracker.capture(status: "running")
        XCTAssertEqual(result.repositories.count, 1)
        let partial = try XCTUnwrap(result.coverage.first { $0.root == two.path })
        XCTAssertEqual(partial.status, "partial")
        XCTAssertTrue(partial.reason.contains("later tool"))
        XCTAssertFalse(partial.suggestedFix.isEmpty)
    }

    func testFailedBaselineNeverBecomesAnInventedNewFile() throws {
        let root = try folder()
        try write(root, "file", String(repeating: "x", count: 100))
        let tracker = TurnChangeTracker()
        tracker.limits.fileBytes = 32
        _ = begin(tracker, root)
        try write(root, "file", "short now\n")
        XCTAssertEqual(patch(tracker), "")
        XCTAssertEqual(tracker.capture(status: "final").coverage.first?.status, "partial")
    }

    func testPatchRoundTripsWithSystemPatchAndQuotedUnicodePaths() throws {
        let old = TurnChangeTracker.File(bytes: Data("one\ntwo\nthree\n".utf8), mode: "100644")
        let new = TurnChangeTracker.File(bytes: Data("one\nchanged\nthree\n".utf8), mode: "100644")
        let root = try folder()
        try old.bytes.write(to: root.appendingPathComponent("file"))
        let patch = try TurnChangeTracker.patch(path: "file", old: old, new: new, budget: 4096)
        try Data(patch.utf8).write(to: root.appendingPathComponent("change.patch"))
        let runner = GitCommandRunner(gitPath: "/usr/bin/patch", prefixArguments: [])!
        let result = try runner.run(["-p1", "-i", "change.patch"], in: root.path, maxStdout: 4096, deadline: Date().addingTimeInterval(3))
        XCTAssertEqual(result.status, 0)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("file")), new.bytes)
        XCTAssertEqual(TurnChangeTracker.quoted("a/café"), "\"a/caf\\303\\251\"")
    }

    func testLiveTimerPublishesWithoutWaitingForToolCompletionAndStops() throws {
        let root = try folder()
        try write(root, "file", "old\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        let queue = DispatchQueue(label: "tracker-test")
        let changed = expectation(description: "live patch while tool still runs")
        changed.assertForOverFulfill = false
        tracker.start(queue: queue, isActive: { true }) { update in
            if update.repositories.first?.patch.contains("+during tool") == true { changed.fulfill() }
        }
        try write(root, "file", "during tool\n")
        wait(for: [changed], timeout: 4)
        queue.sync { tracker.stop() }
    }
}

extension TurnChangeTrackerTests {
    func testNewDirectoryIsCapturedButRemovedRootIsUnavailable() throws {
        let parent = try folder()
        let root = parent.appendingPathComponent("new-folder")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "file", "created\n")
        XCTAssertTrue(patch(tracker).contains("+created"))
        let deletion = TurnChangeTracker()
        _ = begin(deletion, root)
        try FileManager.default.removeItem(at: root)
        let removed = deletion.capture(status: "final")
        XCTAssertTrue(removed.repositories.isEmpty)
        XCTAssertEqual(removed.coverage.first?.status, "unavailable")
    }

    func testAliasesShareOneBaselineAndPatchesUseRelativePaths() throws {
        let root = try folder(), parent = try folder()
        let alias = parent.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
        try write(root, "file", "before\n")
        let tracker = TurnChangeTracker()
        let first = begin(tracker, alias)
        let second = begin(tracker, root, source: .beforeTool)
        XCTAssertEqual(first.baselines, second.baselines)
        XCTAssertEqual(first.baselines?.count, 1)
        try write(root, "file", "after\n")
        XCTAssertTrue(patch(tracker).hasPrefix("diff --git a/file b/file\n"))
    }

    func testFinalCapturesAcknowledgedRootsWithoutLosingOtherHealthyRoots() throws {
        let one = try folder(), two = try folder()
        try write(one, "file", "before\n")
        let tracker = TurnChangeTracker()
        let first = begin(tracker, one)
        _ = begin(tracker, two, source: .beforeTool) // imagine this reply was lost
        try write(one, "file", "after\n")
        let result = tracker.collect(GitDiffRequestPayload(requestID: "final", candidatePaths: [one.path, two.path], phase: .final, baselines: first.baselines, filesystem: true))
        XCTAssertEqual(result.status, .ok)
        XCTAssertEqual(result.coverage?.count, 1)
        XCTAssertTrue(result.repositories[0].patch.contains("+after"))
    }
}

extension TurnChangeTrackerTests {
    func testFilesystemEventsInvalidateAnIdleView() throws {
        let root = try folder()
        try write(root, "file", "before\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        let queue = DispatchQueue(label: "events-test")
        let initial = expectation(description: "initial empty snapshot")
        initial.assertForOverFulfill = false
        let changed = expectation(description: "filesystem invalidation before periodic reconciliation")
        changed.assertForOverFulfill = false
        queue.sync {
            tracker.start(queue: queue, isActive: { true }) { update in
                if update.repositories.isEmpty { initial.fulfill() }
                if update.repositories.first?.patch.contains("+after event") == true { changed.fulfill() }
            }
        }
        wait(for: [initial], timeout: 2)
        try write(root, "file", "after event\n")
        wait(for: [changed], timeout: 4)
        queue.sync { tracker.stop() }
    }

    func testSensitiveRootItselfIsNeverCaptured() throws {
        let parent = try folder()
        let root = parent.appendingPathComponent(".aws")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "config", "sensitive-before\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        try write(root, "config", "sensitive-after\n")
        let result = tracker.capture(status: "final")
        XCTAssertTrue(result.repositories.isEmpty)
        XCTAssertEqual(result.coverage.first?.status, "unavailable")
    }
}

extension TurnChangeTrackerTests {
    func testPinnedReaderRejectsAnAncestorReplacedWithASymlink() throws {
        let root = try folder(), outside = try folder()
        let sub = root.appendingPathComponent("sub")
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: false)
        try write(sub, "note.txt", "public\n")
        try write(outside, "note.txt", "private must never be read\n")
        let reader = try TurnFileReader(root: XCTUnwrap(TurnFileReader.physicalPath(root.path)))
        try FileManager.default.removeItem(at: sub)
        try FileManager.default.createSymbolicLink(at: sub, withDestinationURL: outside)
        XCTAssertThrowsError(try reader.read("sub/note.txt", limit: 4096))
        if case let .file(link) = try reader.read("sub", limit: 4096) {
            XCTAssertEqual(link.mode, "120000")
            XCTAssertFalse(String(decoding: link.bytes, as: UTF8.self).contains("private must never"))
        } else { XCTFail("Expected the link itself, never its target contents") }
    }

    func testRootReplacementWithSymlinkMakesCoverageUnavailable() throws {
        let parent = try folder(), outside = try folder()
        let root = parent.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "note", "before\n")
        try write(outside, "note", "private must never be read\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        try FileManager.default.moveItem(at: root, to: parent.appendingPathComponent("old-workspace"))
        try FileManager.default.createSymbolicLink(at: root, withDestinationURL: outside)
        let result = tracker.capture(status: "final")
        XCTAssertTrue(result.repositories.isEmpty)
        XCTAssertEqual(result.coverage.first?.status, "unavailable")
    }

    func testFilesystemSummaryRetainsDisplayLimitNotice() {
        let summary = SavedSessionDiff(id: "saved", fileCount: 73, repositoryCount: 1, createdAt: "now", scope: .turn, displayLimit: 50, filesystem: true)
        XCTAssertTrue(summary.detailText.contains("Showing 50 of 73 files"))
    }
}

extension TurnChangeTrackerTests {
    func testRootLimitIsVisibleInLiveCoverage() throws {
        let tracker = TurnChangeTracker()
        var ninth: URL?
        for index in 0..<9 {
            let root = try folder()
            _ = begin(tracker, root)
            if index == 8 { ninth = root }
        }
        let update = tracker.capture(status: "running")
        XCTAssertEqual(update.coverage.count, 9)
        XCTAssertEqual(update.coverage.first { $0.root == ninth!.path }?.status, "unavailable")
    }
}

extension TurnChangeTrackerTests {
    func testLargeSubtreeCannotStarveRootDocumentsAndCapturedDeletions() throws {
        let root = try folder()
        let subtree = root.appendingPathComponent("aaa-large-subtree")
        try FileManager.default.createDirectory(at: subtree, withIntermediateDirectories: false)
        for index in 0..<40 { try write(subtree, "file-\(index)", "irrelevant\n") }
        try write(root, "README.md", "original readme\n")
        try write(root, "CONTRIBUTING.md", "original contributing\n")
        let tracker = TurnChangeTracker()
        tracker.limits.files = 10
        _ = begin(tracker, root)
        try write(root, "README.md", "updated readme\n")
        try FileManager.default.removeItem(at: root.appendingPathComponent("CONTRIBUTING.md"))
        // New entries must not displace previously captured paths on subsequent scans.
        for index in 0..<15 { try write(root, "000-added-\(index)", "new\n") }
        let result = tracker.capture(status: "final")
        let diff = result.repositories.map(\.patch).joined()
        XCTAssertTrue(diff.contains("-original readme"), diff)
        XCTAssertTrue(diff.contains("+updated readme"), diff)
        XCTAssertTrue(diff.contains("-original contributing"), diff)
        XCTAssertFalse(diff.contains("+new\n"), "An incomplete baseline cannot prove new paths were absent")
        XCTAssertEqual(result.coverage.first?.status, "partial")
        XCTAssertTrue(result.coverage.first?.reason.contains("entry limit reached (10 entries)") == true)
    }

    func testScanDeadlineDoesNotConsumePatchGenerationBudget() throws {
        let root = try folder()
        try write(root, "README.md", "original\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        try write(root, "README.md", "changed\n")
        var clockCalls = 0
        tracker.scanNow = {
            clockCalls += 1
            // Admit the root and its prioritized read, then expire enumeration.
            return clockCalls <= 3 ? Date() : Date.distantFuture
        }
        let result = tracker.capture(status: "final")
        XCTAssertTrue(result.repositories.first?.patch.contains("+changed") == true)
        XCTAssertEqual(result.coverage.first?.status, "partial")
        XCTAssertTrue(result.coverage.first?.reason.contains("scan time limit reached") == true)
    }

    func testPartialEmptyCaptureExplicitlyDoesNotClaimNoChanges() throws {
        let root = try folder()
        try write(root, "file", String(repeating: "x", count: 100))
        let tracker = TurnChangeTracker()
        tracker.limits.fileBytes = 16
        _ = begin(tracker, root)
        try write(root, "file", "short\n")
        let result = tracker.capture(status: "final")
        XCTAssertTrue(result.repositories.isEmpty)
        XCTAssertTrue(result.coverage.first?.reason.contains("does not establish that no files changed") == true)
        XCTAssertTrue(result.coverage.first?.reason.contains("Captured 0 starting files") == true)
    }
}

extension TurnChangeTrackerTests {
    func testSelectedSubfolderIsNotExpandedToGitMonorepoRoot() throws {
        let repo = try GitTestRepo()
        let subfolder = URL(fileURLWithPath: repo.root).appendingPathComponent("docs")
        try FileManager.default.createDirectory(at: subfolder, withIntermediateDirectories: false)
        try write(subfolder, "README.md", "before\n")
        let tracker = TurnChangeTracker()
        let baseline = begin(tracker, subfolder)
        XCTAssertEqual(baseline.baselines?.first?.root, subfolder.path)
        try write(subfolder, "README.md", "after\n")
        XCTAssertTrue(patch(tracker).hasPrefix("diff --git a/README.md b/README.md\n"))
    }
}

// MARK: - Tool-boundary checkpoints

extension TurnChangeTrackerTests {
    private func lines(_ count: Int) -> String {
        (0..<count).map { "line \($0)\n" }.joined()
    }

    func testCleanupInterleavedWithinToolRetainsOnlyRealChanges() throws {
        let parent = try folder(), root = parent.appendingPathComponent("worker")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "large.txt", lines(46_000))
        try write(root, "edit.txt", "original\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root, source: .beforeTool)
        tracker.beginTool()
        try write(root, "edit.txt", "edited\n")
        tracker.endTool()
        // Cleanup tool: a live scan lands between deletion stages.
        tracker.beginTool()
        try FileManager.default.removeItem(at: root.appendingPathComponent("large.txt"))
        let midCleanup = tracker.capture(status: "running")
        XCTAssertTrue(midCleanup.repositories.first?.patch.contains("deleted file mode") == true, "Live view shows current state")
        try FileManager.default.removeItem(at: root)
        tracker.endTool()
        let final = tracker.capture(status: "final")
        let patch = final.repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("-original\n+edited"), patch)
        XCTAssertFalse(patch.contains("deleted file mode"))
        XCTAssertFalse(patch.contains("line 45999"))
        XCTAssertEqual(final.coverage.first?.status, "late")
        // The cleanup tool's own pre-tool checkpoint is the retained state.
        XCTAssertTrue(final.coverage.first?.reason.contains("before-tool checkpoint before this folder was removed") == true)
    }

    func testRealLinkedWorktreeCleanupInterleavingRetainsCheckpoint() throws {
        let repo = try GitTestRepo()
        try repo.write("large.txt", lines(46_000))
        try repo.write("edit.txt", "original\n")
        _ = try repo.commitAll()
        let parent = try folder(), worktree = parent.appendingPathComponent("worker")
        try repo.git("worktree", "add", "--detach", worktree.path)
        let tracker = TurnChangeTracker()
        _ = begin(tracker, worktree, source: .beforeTool)
        tracker.beginTool()
        try write(worktree, "edit.txt", "edited\n")
        tracker.endTool()
        tracker.beginTool()
        try FileManager.default.removeItem(at: worktree.appendingPathComponent("large.txt"))
        _ = tracker.capture(status: "running")
        try repo.git("worktree", "remove", "--force", worktree.path)
        tracker.endTool()
        let patch = tracker.capture(status: "final").repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("+edited"), patch)
        XCTAssertFalse(patch.contains("deleted file mode"))
    }

    func testLegitimateDeletionsRemainVisibleWhenRootSurvives() throws {
        let root = try folder()
        try write(root, "obsolete.txt", lines(500))
        try write(root, "keep.txt", "keep\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        tracker.beginTool()
        try FileManager.default.removeItem(at: root.appendingPathComponent("obsolete.txt"))
        tracker.endTool()
        let final = tracker.capture(status: "final")
        XCTAssertTrue(final.repositories.first?.patch.contains("deleted file mode 100644") == true)
        XCTAssertTrue(final.repositories.first?.patch.contains("-line 499") == true)
        XCTAssertEqual(final.coverage.first?.status, "complete")
    }

    func testRootRemovedBeforeAnyCheckpointLosesOnlyLiveObservations() throws {
        let parent = try folder(), root = parent.appendingPathComponent("worker")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "file", "original\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root, source: .beforeTool)
        try write(root, "file", "edited\n")
        XCTAssertTrue(patch(tracker).contains("+edited"))
        try FileManager.default.removeItem(at: root)
        let final = tracker.capture(status: "final")
        XCTAssertTrue(final.repositories.isEmpty, "No mass deletion and no unverified retained poll")
        XCTAssertEqual(final.coverage.first?.status, "unavailable")
        XCTAssertTrue(final.coverage.first?.reason.contains("before a tool-boundary checkpoint") == true)
    }

    func testRemovalDuringFirstToolUsesPreToolCheckpoint() throws {
        let parent = try folder(), root = parent.appendingPathComponent("worker")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "file", "original\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root, source: .beforeTool)
        tracker.beginTool()
        try write(root, "file", "edited and removed by one opaque tool\n")
        _ = tracker.capture(status: "running")
        try FileManager.default.removeItem(at: root)
        tracker.endTool()
        let final = tracker.capture(status: "final")
        // Documented limitation: edit+remove inside one tool is not recovered.
        XCTAssertTrue(final.repositories.isEmpty)
        XCTAssertEqual(final.coverage.first?.status, "late")
        XCTAssertTrue(final.coverage.first?.reason.contains("before-tool checkpoint") == true)
        XCTAssertTrue(final.coverage.first?.reason.contains("same tool") == true)
    }

    func testReplacedRootUsesCheckpointNeverReplacementContents() throws {
        let parent = try folder(), root = parent.appendingPathComponent("checkout")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "file", "original\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        tracker.beginTool()
        try write(root, "file", "checkpointed\n")
        tracker.endTool()
        tracker.beginTool()
        try FileManager.default.moveItem(at: root, to: parent.appendingPathComponent("moved"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try write(root, "file", "unrelated\n")
        tracker.endTool() // must not checkpoint the replacement
        let final = tracker.capture(status: "final")
        let patch = final.repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("+checkpointed"), patch)
        XCTAssertFalse(patch.contains("unrelated"))
        XCTAssertTrue(final.coverage.first?.reason.contains("replaced") == true)
    }

    func testUnbalancedEndToolIsIgnoredAndNestedToolsCheckpointOnce() throws {
        let root = try folder()
        try write(root, "file", "a\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, root)
        tracker.endTool()
        tracker.beginTool(); tracker.beginTool()
        try write(root, "file", "b\n")
        tracker.endTool()
        try write(root, "file", "c\n")
        tracker.endTool()
        XCTAssertTrue(patch(tracker).contains("+c"))
    }
}

// MARK: - Nested roots

extension TurnChangeTrackerTests {
    /// Parent repo whose budget cannot cover a nested linked worktree.
    private func nestedFixture() throws -> (GitTestRepo, URL) {
        let repo = try GitTestRepo()
        try repo.write(".gitignore", "worktrees/\n")
        try repo.write("a-parent.txt", "parent\n")
        try repo.write("z-big.txt", String(repeating: "z", count: 400) + "\n")
        _ = try repo.commitAll()
        let child = URL(fileURLWithPath: repo.root).appendingPathComponent("worktrees/child")
        try repo.git("worktree", "add", "--detach", child.path)
        try write(child, "child.txt", "child start\n")
        return (repo, child)
    }

    func testNestedWorktreeUnderPartialParentIsCapturedIndependently() throws {
        let (repo, child) = try nestedFixture()
        let tracker = TurnChangeTracker()
        tracker.limits.rootBytes = 200
        _ = begin(tracker, URL(fileURLWithPath: repo.root))
        let admitted = begin(tracker, child, source: .beforeTool)
        XCTAssertEqual(admitted.baselines?.count, 2)
        try write(child, "child.txt", "child edited\n")
        try repo.write("a-parent.txt", "parent edited\n")
        let result = tracker.capture(status: "final")
        let childPatch = try XCTUnwrap(result.repositories.first { $0.root == child.path }?.patch)
        XCTAssertTrue(childPatch.contains("-child start\n+child edited"), childPatch)
        let parentPatch = try XCTUnwrap(result.repositories.first { $0.root == repo.root }?.patch)
        XCTAssertTrue(parentPatch.contains("+parent edited"))
        XCTAssertFalse(parentPatch.contains("child"))
        XCTAssertEqual(result.coverage.first { $0.root == repo.root }?.status, "partial")
        XCTAssertNotNil(result.coverage.first { $0.root == child.path })
    }

    func testPartialParentKeepsStartingBytesItOwnsAndChildCapturesTheRest() throws {
        let parent = try folder()
        let child = parent.appendingPathComponent("child")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: false)
        try write(child, "a-owned", "parent start\n")
        try write(child, "b-omitted", String(repeating: "o", count: 300) + "\n")
        let tracker = TurnChangeTracker()
        tracker.limits.rootBytes = 100
        _ = begin(tracker, parent)
        tracker.limits.rootBytes = 1_000 // the child root has room for what the parent omitted
        // Edited before the child is registered: only the parent knows the original.
        try write(child, "a-owned", "edited before child\n")
        _ = begin(tracker, child, source: .beforeTool)
        try write(child, "b-omitted", "child edit\n")
        try write(child, "c-new", "new in child\n")
        try FileManager.default.removeItem(at: child.appendingPathComponent("a-owned"))
        let result = tracker.capture(status: "final")
        let all = result.repositories.map(\.patch).joined()
        XCTAssertEqual(all.components(separatedBy: "diff --git").count, 4, all) // a-owned, b-omitted, c-new once each
        let parentPatch = try XCTUnwrap(result.repositories.first { $0.root == parent.path }?.patch)
        XCTAssertTrue(parentPatch.contains("-parent start"), "Original bytes come from the parent, never the child")
        let childPatch = try XCTUnwrap(result.repositories.first { $0.root == child.path }?.patch)
        XCTAssertTrue(childPatch.contains("+child edit"), childPatch)
        XCTAssertTrue(childPatch.contains("+new in child"))
        XCTAssertFalse(childPatch.contains("a-owned"))
        XCTAssertFalse(childPatch.contains("edited before child"))
    }

    func testChildRegisteredBeforeParentOwnsItsSubtree() throws {
        let (repo, child) = try nestedFixture()
        let tracker = TurnChangeTracker()
        _ = begin(tracker, child)
        _ = begin(tracker, URL(fileURLWithPath: repo.root), source: .beforeTool)
        try write(child, "child.txt", "child edited\n")
        try write(child, "child-new.txt", "added\n")
        try repo.write("a-parent.txt", "parent edited\n")
        let result = tracker.capture(status: "final")
        XCTAssertEqual(result.repositories.count, 2)
        let parentPatch = try XCTUnwrap(result.repositories.first { $0.root == repo.root }?.patch)
        XCTAssertFalse(parentPatch.contains("child"), parentPatch)
        let childPatch = try XCTUnwrap(result.repositories.first { $0.root == child.path }?.patch)
        XCTAssertTrue(childPatch.contains("+child edited") && childPatch.contains("+added"))
        XCTAssertEqual(result.coverage.first { $0.root == child.path }?.status, "complete")
    }

    func testCompleteParentKeepsItsStartingBytesWithoutDuplicates() throws {
        let parent = try folder()
        let child = parent.appendingPathComponent("child")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: false)
        try write(child, "file", "start\n")
        let tracker = TurnChangeTracker()
        _ = begin(tracker, parent)
        try write(child, "file", "edited before child\n")
        _ = begin(tracker, child, source: .beforeTool)
        try write(child, "new", "new\n")
        let result = tracker.capture(status: "final")
        let parentPatch = try XCTUnwrap(result.repositories.first { $0.root == parent.path }?.patch)
        XCTAssertTrue(parentPatch.contains("-start\n+edited before child"), parentPatch)
        XCTAssertFalse(parentPatch.contains("new"))
        let childPatch = try XCTUnwrap(result.repositories.first { $0.root == child.path }?.patch)
        XCTAssertTrue(childPatch.contains("+new"))
        XCTAssertFalse(childPatch.contains("a/file"), "Never uses the child's later bytes as an original")
        XCTAssertEqual(result.coverage.first { $0.root == parent.path }?.status, "complete")
        XCTAssertEqual(result.coverage.first { $0.root == child.path }?.status, "late")
        XCTAssertTrue(result.coverage.first { $0.root == child.path }?.reason.contains("enclosing") == true)
    }
}

// MARK: - Large disk-backed baselines

extension TurnChangeTrackerTests {
    func testDefaultLimitsCaptureOver10kFilesAndOver32MiBWithDirtyTailEdit() throws {
        let root = try folder()
        let small = root.appendingPathComponent("small")
        try FileManager.default.createDirectory(at: small, withIntermediateDirectories: false)
        for index in 0..<10_500 { try autoreleasepool { try Data("file \(index)\n".utf8).write(to: small.appendingPathComponent(String(format: "f%05d", index))) } }
        let large = root.appendingPathComponent("large")
        try FileManager.default.createDirectory(at: large, withIntermediateDirectories: false)
        let chunk = Data(repeating: UInt8(ascii: "x"), count: 1_000_000)
        for index in 0..<36 {
            var distinct = chunk
            distinct.replaceSubrange(0..<8, with: Data(String(format: "%08d", index).utf8))
            try autoreleasepool { try distinct.write(to: large.appendingPathComponent("blob-\(index)")) }
        }
        // Dirty-at-start tail file: sorts and traverses last.
        try write(root, "zzz-tail", "dirty at start\n")
        let zzz = root.appendingPathComponent("zzzz")
        try FileManager.default.createDirectory(at: zzz, withIntermediateDirectories: false)
        try write(zzz, "tail.txt", "dirty tail start\n")
        let tracker = TurnChangeTracker()
        let started = Date()
        _ = begin(tracker, root)
        let baselineSeconds = Date().timeIntervalSince(started)
        XCTAssertGreaterThan(tracker.store.diskUsed, 32 * 1_048_576)
        XCTAssertLessThanOrEqual(tracker.store.inlineUsed, tracker.limits.store.inlineBytes)
        tracker.beginTool()
        try write(zzz, "tail.txt", "edited tail\n")
        try write(small, "f10499", "edited small\n")
        tracker.endTool()
        let result = tracker.capture(status: "final")
        let patch = result.repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("-dirty tail start\n+edited tail"), patch)
        XCTAssertTrue(patch.contains("+edited small"))
        XCTAssertEqual(result.coverage.first?.status, "complete", result.coverage.first?.reason ?? "")
        print("[measure] baseline \(String(format: "%.2f", baselineSeconds))s, disk \(tracker.store.diskUsed) bytes, inline \(tracker.store.inlineUsed) bytes")
    }
}


extension TurnChangeTrackerTests {
    func testFailedCleanupDoesNotPromoteIntermediateDeletionToCheckpoint() throws {
        let root = try folder()
        try write(root, "bulk", String(repeating: "line\n", count: 46_000))
        try write(root, "edit", "before\n")
        let tracker = TurnChangeTracker(); _ = begin(tracker, root)
        tracker.beginTool(); try write(root, "edit", "after\n"); tracker.endTool()
        tracker.beginTool()
        try FileManager.default.removeItem(at: root.appendingPathComponent("bulk"))
        _ = tracker.capture(status: "running")
        tracker.endTool(success: false) // cancelled or failed while a child may still run
        try FileManager.default.removeItem(at: root)
        let final = tracker.capture(status: "final")
        let text = final.repositories.map(\.patch).joined()
        XCTAssertTrue(text.contains("+after"))
        XCTAssertFalse(text.contains("deleted file mode"))
    }
}


extension TurnChangeTrackerTests {
    func testNestedCleanupDoesNotBecomeMassParentDeletions() throws {
        let parent = try folder(), child = parent.appendingPathComponent("worker")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: false)
        try write(child, "bulk", String(repeating: "line\n", count: 46_000))
        try write(child, "edit", "before\n")
        let tracker = TurnChangeTracker(); _ = begin(tracker, parent); _ = begin(tracker, child, source: .beforeTool)
        tracker.beginTool(); try write(child, "edit", "after\n"); tracker.endTool()
        tracker.beginTool()
        try FileManager.default.removeItem(at: child.appendingPathComponent("bulk"))
        _ = tracker.capture(status: "running")
        try FileManager.default.removeItem(at: child); tracker.endTool()
        let final = tracker.capture(status: "final"), text = final.repositories.map(\.patch).joined()
        XCTAssertTrue(text.contains("+after"))
        XCTAssertFalse(text.contains("deleted file mode"))
        XCTAssertTrue(final.coverage.contains { $0.reason.contains("Nested folder removed") })
    }
}
