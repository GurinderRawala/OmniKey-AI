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
        try write(worktree, "file", "updated dependency\n")
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
        XCTAssertTrue(partial.reason.contains("first tool"))
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
