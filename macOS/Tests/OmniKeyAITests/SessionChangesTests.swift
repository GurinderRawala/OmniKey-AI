import Foundation
import SwiftUI
import XCTest

@testable import OmniKeyAI

/// Production-helper tests for session change tracking. Every test uses a
/// fresh temporary store and workspace; the real user store is never opened
/// (the shared tracker is disabled inside test processes).
final class SessionChangesTests: XCTestCase {
    private var tempRoot: URL!
    private var workspace: URL!
    private var storeDir: URL!

    override func setUpWithError() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("session-changes-tests-\(UUID().uuidString)", isDirectory: true)
        workspace = tempRoot.appendingPathComponent("ws", isDirectory: true)
        storeDir = tempRoot.appendingPathComponent("store", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    private func write(_ rel: String, _ text: String) throws {
        try write(rel, Data(text.utf8))
    }

    private func write(_ rel: String, _ data: Data) throws {
        let url = workspace.appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private func tracker(now: @escaping @Sendable () -> Date = { Date() }) -> SessionChangeTracker {
        SessionChangeTracker(storeRoot: storeDir, now: now)
    }

    private func change(_ snapshot: SessionChangesSnapshot, _ path: String) -> SessionFileChange? {
        snapshot.changes.first { $0.relPath == path }
    }

    private func textDiff(_ tracker: SessionChangeTracker, _ change: SessionFileChange) async throws -> SessionFileDiff {
        guard case let .text(preview, _) = try await tracker.loadDiff(for: change) else {
            XCTFail("expected text diff"); return .empty
        }
        return preview
    }

    func testSameSizeEditWithRestoredModificationDateIsCaptured() async throws {
        try write("same.txt", "before")
        let url = workspace.appendingPathComponent("same.txt")
        let stamp = try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]!
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        try write("same.txt", "after!")
        try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: url.path)
        try await t.refreshNow(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(change(snapshot, "same.txt")?.status, .modified)
    }

    func testSupersededLatestBlobsAreReclaimed() async throws {
        try write("a.txt", "baseline")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        try write("a.txt", "intermediate")
        try await t.refreshNow(sessionID: "s")
        let intermediate = SessionHashing.sha256Hex(Data("intermediate".utf8))
        try write("a.txt", "final")
        try await t.refreshNow(sessionID: "s")
        let store = SessionChangesStore(rootDirectory: storeDir)
        try store.open()
        XCTAssertFalse(try store.hasBlob(intermediate))
        XCTAssertTrue(try store.hasBlob(SessionHashing.sha256Hex(Data("baseline".utf8))))
    }

    func testDirectoryReplacementWithSymlinkDoesNotEscapeRootOrInventDeletion() async throws {
        try write("sub/inside.txt", "original")
        let outside = tempRoot.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secret.txt"))
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        try FileManager.default.removeItem(at: workspace.appendingPathComponent("sub"))
        try FileManager.default.createSymbolicLink(at: workspace.appendingPathComponent("sub"), withDestinationURL: outside)
        try await t.refreshNow(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        XCTAssertNil(change(snapshot, "sub/secret.txt"))
        XCTAssertEqual(change(snapshot, "sub")?.latest?.kind, .symlink)
    }

    func testActiveTurnProtectsSnapshotsBetweenTools() async throws {
        try write("a.txt", "a")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        t.beginTurn(sessionID: "s")
        do {
            try await t.deleteSnapshots(sessionID: "s")
            XCTFail("active baseline must be protected")
        } catch { XCTAssertTrue(error.localizedDescription.contains("running")) }
        t.reconcileEndOfTurn(sessionID: "s")
        t.drain()
        try await t.deleteSnapshots(sessionID: "s")
    }

    func testPartialBaselineCannotExportInventedAddition() async throws {
        try write("first.txt", "first")
        try write("second.txt", "second")
        let t = tracker()
        var settings = SessionChangesSettings.default
        settings.maxFilesPerRoot = 1
        try await t.updateSettings(settings)
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        settings.maxFilesPerRoot = 100
        try await t.updateSettings(settings)
        try await t.refreshNow(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        let unknown = try XCTUnwrap(snapshot.changes.first { $0.status == .notInBaseline })
        guard case .card = try await t.loadDiff(for: unknown) else { return XCTFail("unknown baseline must not become an addition patch") }
    }

    func testDeletedPatchUsesDevNull() async throws {
        try write("deleted.txt", "old\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        try FileManager.default.removeItem(at: workspace.appendingPathComponent("deleted.txt"))
        try await t.refreshNow(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        let deleted = try XCTUnwrap(change(snapshot, "deleted.txt"))
        guard case let .text(_, patch) = try await t.loadDiff(for: deleted) else { return XCTFail("text expected") }
        XCTAssertTrue(patch?.contains("+++ /dev/null") == true)
    }

    func testNewlineMatrixPatchesRoundTripWithGitApply() throws {
        let variants = ["x\ny", "x\ny\n", "x\ny\nz", "x\ny\nz\n", "z\nx\ny", "z\nx\ny\n", "", "\n"]
        let file = workspace.appendingPathComponent("sample.txt")
        let patchFile = tempRoot.appendingPathComponent("roundtrip.patch")
        for old in variants {
            for new in variants where old != new {
                try Data(old.utf8).write(to: file)
                let diff = SessionDiffEngine.diff(old: old, new: new)
                let patch = SessionDiffEngine.unifiedPatch(path: "sample.txt", diff: diff, oldExists: true, newExists: true)
                try Data(patch.utf8).write(to: patchFile)
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                process.arguments = ["apply", "--whitespace=nowarn", patchFile.path]
                process.currentDirectoryURL = workspace
                let output = Pipe()
                process.standardError = output
                try process.run()
                process.waitUntilExit()
                XCTAssertEqual(process.terminationStatus, 0, "\(old.debugDescription) -> \(new.debugDescription): \(String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))")
                XCTAssertEqual(try Data(contentsOf: file), Data(new.utf8))
            }
        }
    }

    func testExpiredSessionCanBeTrackedAndExpiredAgain() async throws {
        try write("a.txt", "a")
        let clock = Clock()
        let t = tracker(now: { clock.now })
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        clock.now = clock.now.addingTimeInterval(40 * 86_400)
        _ = try await t.snapshot(sessionID: "other")
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: true)
        let restored = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(restored.info?.expired, false)
        clock.now = clock.now.addingTimeInterval(40 * 86_400)
        _ = try await t.snapshot(sessionID: "other")
        let expired = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(expired.info?.expired, true)
        XCTAssertTrue(expired.roots.isEmpty)
    }

    func testUnreadableRootDoesNotInventDeletions() async throws {
        try write("a.txt", "a")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        XCTAssertEqual(chmod(workspace.path, 0), 0)
        defer { chmod(workspace.path, 0o700) }
        try await t.refreshNow(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        XCTAssertTrue(snapshot.changes.isEmpty)
        XCTAssertTrue(snapshot.roots[0].latestPartial)
    }

    func testFIFOIsMetadataAndCannotBlockCapture() async throws {
        XCTAssertEqual(mkfifo(workspace.appendingPathComponent("pipe").path, 0o600), 0)
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let store = SessionChangesStore(rootDirectory: storeDir)
        try store.open()
        let root = try XCTUnwrap(store.roots(for: "s").first)
        XCTAssertEqual(try store.files(rootID: root.id, side: "base")["pipe"]?.kind, .other)
    }

    func testCaseInsensitiveSecretExclusions() {
        XCTAssertTrue(SessionChangesScanner.isExcludedFile(".ENV"))
        XCTAssertTrue(SessionChangesScanner.isExcludedFile(".ENV.production"))
        XCTAssertTrue(SessionChangesScanner.isExcludedFile("ID_RSA"))
        XCTAssertTrue(SessionChangesScanner.isExcludedFile(".DS_Store"))
    }

    func testDeletedChatWaitsForActiveToolThenRemovesSnapshots() async throws {
        try write("a.txt", "a")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        t.beforeTool(sessionID: "s")
        t.deleteAfterChatRemoval(sessionID: "s")
        t.drain()
        t.afterTool(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        XCTAssertTrue(snapshot.roots.isEmpty)
        XCTAssertTrue(try blobFiles().isEmpty)
    }

    func testReplacedTrackingRootCannotFollowExternalSymlink() async throws {
        try write("a.txt", "a")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let moved = tempRoot.appendingPathComponent("moved")
        try FileManager.default.moveItem(at: workspace, to: moved)
        let outside = tempRoot.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("private".utf8).write(to: outside.appendingPathComponent("secret.txt"))
        try FileManager.default.createSymbolicLink(at: workspace, withDestinationURL: outside)
        try await t.refreshNow(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        XCTAssertTrue(snapshot.changes.isEmpty)
        XCTAssertTrue(snapshot.roots[0].coverage.rootMissing)
    }

    @MainActor
    func testSwitchingChangesSessionIgnoresOldDiffResults() async throws {
        try write("a.txt", "old")
        let t = tracker()
        try await t.addRoot(sessionID: "first", path: workspace.path, sessionHasTurns: false)
        try write("a.txt", "new")
        try await t.refreshNow(sessionID: "first")
        let model = SessionChangesViewModel(sessionKey: "first", tracker: t)
        model.reload()
        for _ in 0..<100 {
            if model.snapshot != nil { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let id = try XCTUnwrap(model.snapshot?.changes.first?.id)
        model.select(id)
        model.switchSession(to: "second")
        for _ in 0..<100 {
            if model.snapshot?.sessionID == "second" { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(model.snapshot?.sessionID, "second")
        XCTAssertNil(model.selectedChangeID)
        guard case .none = model.diffState else { return XCTFail("stale diff reached the new session") }
    }

    @MainActor
    func testNativeDiffSurfaceStaysBoundedAndSelectable() {
        let diff = SessionDiffEngine.preview(SessionDiffEngine.diff(old: "a\n", new: String(repeating: "b", count: 8_000) + "\n"))
        let host = NSHostingView(rootView: SessionDiffTextView(diff: diff, colorScheme: .dark))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 260)
        host.layoutSubtreeIfNeeded()
        func scroll(in view: NSView) -> NSScrollView? {
            if let result = view as? NSScrollView { return result }
            return view.subviews.compactMap { scroll(in: $0) }.first
        }
        guard let scroller = scroll(in: host) else { return XCTFail("native scroller missing") }
        XCTAssertLessThanOrEqual(scroller.frame.width, 480)
        XCTAssertLessThanOrEqual(scroller.frame.height, 260)
        XCTAssertTrue(scroller.hasHorizontalScroller)
        XCTAssertTrue(scroller.hasVerticalScroller)
        XCTAssertNotNil(scroller.documentView)
    }

    func testDiffRenderedUTF16RangesAreCorrectForUnicode() {
        let diff = SessionDiffEngine.diff(old: "😀\n", new: "é😀\n")
        let rendered = SessionDiffTextView.render(diff)
        let text = rendered.text as NSString
        for (range, _) in rendered.kinds {
            XCTAssertLessThanOrEqual(NSMaxRange(range), text.length)
            XCTAssertFalse(text.substring(with: range).contains("\n"))
        }
    }

    func testCaptureErrorsSurviveStoreReopen() throws {
        let first = SessionChangesStore(rootDirectory: storeDir)
        try first.open()
        try first.ensureSession("s")
        try first.setCaptureError("s", message: "Disk full")
        let reopened = SessionChangesStore(rootDirectory: storeDir)
        try reopened.open()
        XCTAssertEqual(try reopened.captureError("s"), "Disk full")
        try reopened.setCaptureError("s", message: nil)
        XCTAssertNil(try reopened.captureError("s"))
    }

    func testUnreadableFileDoesNotDisableOtherAdditionsAndDeletions() async throws {
        try write("unreadable.txt", "private")
        try write("deleted.txt", "before")
        let unreadable = workspace.appendingPathComponent("unreadable.txt")
        XCTAssertEqual(chmod(unreadable.path, 0), 0)
        defer { chmod(unreadable.path, 0o600) }
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        try write("added.txt", "after")
        try FileManager.default.removeItem(at: workspace.appendingPathComponent("deleted.txt"))
        try await t.refreshNow(sessionID: "s")
        let snapshot = try await t.snapshot(sessionID: "s")
        XCTAssertFalse(snapshot.roots[0].baselinePartial)
        XCTAssertEqual(snapshot.roots[0].coverage.unreadable, 1)
        let added = try XCTUnwrap(change(snapshot, "added.txt"))
        XCTAssertEqual(added.status, .added)
        XCTAssertEqual(change(snapshot, "deleted.txt")?.status, .deleted)
        guard case .text = try await t.loadDiff(for: added) else { return XCTFail("read failure in unrelated file disabled addition") }
    }

    func testOverlappingTurnTokensProtectUntilEachCompletes() async throws {
        try write("a.txt", "a")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let first = t.beginTurn(sessionID: "s")
        let second = t.beginTurn(sessionID: "s")
        t.reconcileEndOfTurn(sessionID: "s", turnID: first)
        t.reconcileEndOfTurn(sessionID: "s", turnID: first)
        do { try await t.deleteSnapshots(sessionID: "s"); XCTFail("second turn lost protection") }
        catch { XCTAssertTrue(error.localizedDescription.contains("running")) }
        t.reconcileEndOfTurn(sessionID: "s", turnID: second)
        t.drain()
        try await t.deleteSnapshots(sessionID: "s")
    }

    // MARK: Baseline & net diff

    func testSharedTrackerIsDisabledInTests() {
        XCTAssertFalse(SessionChangeTracker.shared.isEnabled)
    }

    func testUntrackedSessionNeverCreatesStore() async {
        let t = tracker()
        await Task.detached {
            t.beforeTool(sessionID: "s")
            t.afterTool(sessionID: "s")
        }.value
        XCTAssertFalse(FileManager.default.fileExists(atPath: storeDir.path))
    }

    func testDirtyBaselineAndMultiTurnNetDiff() async throws {
        try write("a.txt", "one\ntwo\nthree\n")   // dirty, never committed anywhere
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)

        t.beforeTool(sessionID: "s")
        try write("a.txt", "one\nTWO\nthree\n")
        t.afterTool(sessionID: "s")
        t.beforeTool(sessionID: "s")
        try write("a.txt", "one\nTWO\nthree\nfour\n")
        t.afterTool(sessionID: "s")

        let snap = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(snap.roots.first?.baselineLabel, .sessionStart)
        let c = try XCTUnwrap(change(snap, "a.txt"))
        XCTAssertEqual(c.status, .modified)
        XCTAssertEqual(c.attribution, .toolWindow)
        let diff = try await textDiff(t, c)
        XCTAssertEqual(diff.added, 2)
        XCTAssertEqual(diff.removed, 1)
        XCTAssertEqual(diff.lines.first?.text, "@@ -1,3 +1,4 @@")
        XCTAssertTrue(diff.lines.contains { $0.kind == .removed && $0.text == "two" && $0.oldNumber == 2 })
        XCTAssertTrue(diff.lines.contains { $0.kind == .added && $0.text == "four" && $0.newNumber == 4 })
    }

    func testRevertToBaselineShowsNoChange() async throws {
        try write("a.txt", "x\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: true)
        t.beforeTool(sessionID: "s"); try write("a.txt", "y\n"); t.afterTool(sessionID: "s")
        t.beforeTool(sessionID: "s"); try write("a.txt", "x\n"); t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        XCTAssertTrue(snap.changes.isEmpty)
        XCTAssertEqual(snap.roots.first?.baselineLabel, .trackingStart)
    }

    func testAddDeleteAndEmptyVersusMissing() async throws {
        try write("gone.txt", "bye\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        t.beforeTool(sessionID: "s")
        try FileManager.default.removeItem(at: workspace.appendingPathComponent("gone.txt"))
        try write("new.txt", "hello\n")
        try write("empty.txt", "")
        t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(change(snap, "gone.txt")?.status, .deleted)
        XCTAssertEqual(change(snap, "new.txt")?.status, .added)
        let empty = try XCTUnwrap(change(snap, "empty.txt"))
        XCTAssertEqual(empty.status, .added)
        XCTAssertEqual(empty.latest?.size, 0)
        let emptyDiff = try await textDiff(t, empty)
        XCTAssertTrue(emptyDiff.lines.isEmpty)
        let deleted = try await textDiff(t, try XCTUnwrap(change(snap, "gone.txt")))
        XCTAssertEqual(deleted.removed, 1)
        XCTAssertEqual(deleted.added, 0)
    }

    func testObservedVersusToolWindowAttribution() async throws {
        try write("a.txt", "1\n")
        try write("b.txt", "1\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        try write("a.txt", "user edit\n")   // between tool runs
        t.beforeTool(sessionID: "s")
        try write("b.txt", "agent edit\n")
        t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(change(snap, "a.txt")?.attribution, .observed)
        XCTAssertEqual(change(snap, "b.txt")?.attribution, .toolWindow)
    }

    // MARK: Binary / metadata / symlink

    func testBinaryModeAndSymlinkAreHonestCards() async throws {
        try write("bin.dat", Data([0, 1, 2, 3]))
        try write("script.sh", "echo hi\n")
        let outside = tempRoot.appendingPathComponent("secret.txt")
        try Data("top secret".utf8).write(to: outside)
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        t.beforeTool(sessionID: "s")
        try write("bin.dat", Data([0, 9, 9, 9, 9]))
        try FileManager.default.setAttributes([.posixPermissions: 0o755],
                                              ofItemAtPath: workspace.appendingPathComponent("script.sh").path)
        try FileManager.default.createSymbolicLink(atPath: workspace.appendingPathComponent("link").path,
                                                   withDestinationPath: outside.path)
        t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")

        let bin = try XCTUnwrap(change(snap, "bin.dat"))
        XCTAssertEqual(bin.status, .modified)
        guard case .card = try await t.loadDiff(for: bin) else { return XCTFail("binary must be a card") }

        XCTAssertEqual(change(snap, "script.sh")?.status, .modeChanged)

        let link = try XCTUnwrap(change(snap, "link"))
        XCTAssertEqual(link.latest?.kind, .symlink)
        XCTAssertEqual(link.latest?.linkTarget, outside.path)
        XCTAssertNotEqual(link.latest?.size, Int64("top secret".utf8.count + 1000))
        guard case .card = try await t.loadDiff(for: link) else { return XCTFail("symlink must be a card") }
        XCTAssertEqual(snap.roots.first?.coverage.symlinksNotFollowed, 1)
    }

    // MARK: Persistence, dedup

    func testRestartReloadsFromStoreIndependentOfLiveFiles() async throws {
        try write("a.txt", "before\n")
        let first = tracker()
        try await first.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        first.beforeTool(sessionID: "s"); try write("a.txt", "after\n"); first.afterTool(sessionID: "s")
        // The live file changes again with no capture; then a "restart".
        try write("a.txt", "much later\n")
        let second = tracker()
        let snap = try await second.snapshot(sessionID: "s")
        let c = try XCTUnwrap(change(snap, "a.txt"))
        let diff = try await textDiff(second, c)
        XCTAssertTrue(diff.lines.contains { $0.kind == .added && $0.text == "after" })
        XCTAssertFalse(diff.lines.contains { $0.text == "much later" })
    }

    func testBlobsAreDeduplicatedAcrossSessions() async throws {
        try write("a.txt", "same\n")
        try write("b.txt", "same\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s1", path: workspace.path, sessionHasTurns: false)
        try await t.addRoot(sessionID: "s2", path: workspace.path, sessionHasTurns: false)
        let blobs = try blobFiles()
        XCTAssertEqual(blobs.count, 1)
    }

    private func blobFiles() throws -> [String] {
        let dir = storeDir.appendingPathComponent("blobs")
        let fm = FileManager.default
        return try fm.contentsOfDirectory(atPath: dir.path).flatMap { prefix in
            (try? fm.contentsOfDirectory(atPath: dir.appendingPathComponent(prefix).path)) ?? []
        }
    }

    func testStorePermissionsAreOwnerOnly() async throws {
        try write("a.txt", "x\n")
        try await tracker().addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let attrs = try FileManager.default.attributesOfItem(atPath: storeDir.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        let db = try FileManager.default.attributesOfItem(atPath: storeDir.appendingPathComponent("changes.sqlite").path)
        XCTAssertEqual((db[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testOrphanBlobsAreSweptOnOpen() async throws {
        try write("a.txt", "x\n")
        try await tracker().addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let strayDir = storeDir.appendingPathComponent("blobs/zz")
        try FileManager.default.createDirectory(at: strayDir, withIntermediateDirectories: true)
        try Data("junk".utf8).write(to: strayDir.appendingPathComponent("zzzz.lzfse"))
        try Data("tmp".utf8).write(to: strayDir.appendingPathComponent(".tmp-abc"))
        _ = try await tracker().snapshot(sessionID: "s")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: strayDir.path), [])
    }

    // MARK: Exclusions & limits

    func testDefaultExclusionsAreSkippedAndCounted() async throws {
        try write(".env", "SECRET=1\n")
        try write("node_modules/x/index.js", "x\n")
        try write(".git/config", "x\n")
        try write("key.pem", "x\n")
        try write("src/main.swift", "print(1)\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        t.beforeTool(sessionID: "s")
        try write(".env", "SECRET=2\n")
        try write("src/main.swift", "print(2)\n")
        t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(snap.changes.map(\.relPath), ["src/main.swift"])
        let coverage = try XCTUnwrap(snap.roots.first?.coverage)
        XCTAssertEqual(coverage.excludedEntries, 4)
        XCTAssertTrue(coverage.excludedNames.contains(".env"))
        XCTAssertTrue(coverage.excludedNames.contains("node_modules/"))
    }

    func testOversizeFileIsVisibleWithoutContent() async throws {
        let t = tracker()
        var settings = SessionChangesSettings.default
        settings.perFileLimitBytes = 16
        try write("small.txt", "x\n")
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        try await t.updateSettings(settings)
        t.beforeTool(sessionID: "s")
        try write("big.txt", String(repeating: "a", count: 100))
        t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        let big = try XCTUnwrap(change(snap, "big.txt"))
        XCTAssertEqual(big.latest?.state, .oversize)
        XCTAssertFalse(big.contentAvailable)
        guard case let .card(reason) = try await t.loadDiff(for: big) else { return XCTFail("expected card") }
        XCTAssertTrue(reason.contains("per-file"))
    }

    func testPartialScanDoesNotInventDeletions() async throws {
        for index in 0..<5 { try write("f\(index).txt", "\(index)\n") }
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        var settings = SessionChangesSettings.default
        settings.maxFilesPerRoot = 2
        try await t.updateSettings(settings)
        t.beforeTool(sessionID: "s")
        t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        XCTAssertTrue(snap.changes.isEmpty, "unseen files must not be reported deleted")
        XCTAssertEqual(snap.roots.first?.latestPartial, true)
        XCTAssertEqual(snap.roots.first?.coverage.hitFileLimit, true)
    }

    func testBudgetExhaustionIsVisibleAndNothingIsEvicted() async throws {
        try write("a.txt", "baseline content\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        var settings = SessionChangesSettings.default
        settings.budgetBytes = 1   // already exceeded by the baseline blob
        try await t.updateSettings(settings)
        t.beforeTool(sessionID: "s")
        try write("a.txt", "new content that cannot be stored\n")
        t.afterTool(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        let c = try XCTUnwrap(change(snap, "a.txt"))
        XCTAssertEqual(c.latest?.state, .budgetExceeded)
        XCTAssertTrue(snap.budgetExhausted)
        // The baseline blob is a live reference and is still readable.
        XCTAssertEqual(try blobFiles().count, 1)
    }

    // MARK: Retention, pinning, deletion

    func testRetentionExpiresUnpinnedButKeepsPinned() async throws {
        try write("a.txt", "x\n")
        let clock = Clock()
        let t = tracker(now: { clock.now })
        try await t.addRoot(sessionID: "old", path: workspace.path, sessionHasTurns: false)
        try await t.addRoot(sessionID: "pinned", path: workspace.path, sessionHasTurns: false)
        try await t.setPinned(sessionID: "pinned", pinned: true)
        clock.now = clock.now.addingTimeInterval(40 * 86_400)
        let viewer = try await t.snapshot(sessionID: "other")   // triggers pruning
        XCTAssertTrue(viewer.roots.isEmpty)
        let old = try await t.snapshot(sessionID: "old")
        XCTAssertEqual(old.info?.expired, true)
        XCTAssertTrue(old.roots.isEmpty)
        let pinned = try await t.snapshot(sessionID: "pinned")
        XCTAssertEqual(pinned.roots.count, 1)
        XCTAssertEqual(try blobFiles().count, 1, "pinned session keeps its shared blob")
    }

    func testDeleteSnapshotsRemovesOnlyThatSession() async throws {
        try write("a.txt", "shared\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s1", path: workspace.path, sessionHasTurns: false)
        try await t.addRoot(sessionID: "s2", path: workspace.path, sessionHasTurns: false)
        try await t.deleteSnapshots(sessionID: "s1")
        let hoisted1 = try await t.snapshot(sessionID: "s1")
        XCTAssertTrue(hoisted1.roots.isEmpty)
        let hoisted2 = try await t.snapshot(sessionID: "s2")
        XCTAssertEqual(hoisted2.roots.count, 1)
        XCTAssertEqual(try blobFiles().count, 1)
        try await t.deleteSnapshots(sessionID: "s2")
        XCTAssertEqual(try blobFiles().count, 0)
    }

    // MARK: Roots & pending sessions

    func testReAddingRootKeepsOriginalBaseline() async throws {
        try write("a.txt", "original\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let hoisted3 = try await t.snapshot(sessionID: "s")
        let root = try XCTUnwrap(hoisted3.roots.first)
        try await t.deactivateRoot(sessionID: "s", rootID: root.id)
        try write("a.txt", "changed while paused\n")
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: true)
        try await t.refreshNow(sessionID: "s")
        let snap = try await t.snapshot(sessionID: "s")
        XCTAssertEqual(snap.roots.count, 1)
        XCTAssertEqual(snap.roots.first?.baselineLabel, .sessionStart)
        XCTAssertEqual(change(snap, "a.txt")?.status, .modified)
    }

    func testPausedRootIsNotCaptured() async throws {
        try write("a.txt", "1\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let hoisted4 = try await t.snapshot(sessionID: "s")
        let root = try XCTUnwrap(hoisted4.roots.first)
        try await t.deactivateRoot(sessionID: "s", rootID: root.id)
        t.beforeTool(sessionID: "s"); try write("a.txt", "2\n"); t.afterTool(sessionID: "s")
        let hoisted5 = try await t.snapshot(sessionID: "s")
        XCTAssertTrue(hoisted5.changes.isEmpty)
    }

    func testPendingSessionMigratesToRealID() async throws {
        try write("a.txt", "1\n")
        let t = tracker()
        try await t.addRoot(sessionID: SessionChangeTracker.pendingSessionKey, path: workspace.path, sessionHasTurns: false)
        t.migratePending(to: "real")
        t.beforeTool(sessionID: "real"); try write("a.txt", "2\n"); t.afterTool(sessionID: "real")
        let snap = try await t.snapshot(sessionID: "real")
        XCTAssertEqual(snap.roots.count, 1)
        XCTAssertEqual(change(snap, "a.txt")?.status, .modified)
        let hoisted6 = try await t.snapshot(sessionID: SessionChangeTracker.pendingSessionKey)
        XCTAssertTrue(hoisted6.roots.isEmpty)
    }

    func testEndOfTurnReconcileCapturesAfterCancellation() async throws {
        try write("a.txt", "1\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        // A cancelled tool's child process writes after afterTool returned.
        t.beforeTool(sessionID: "s"); t.afterTool(sessionID: "s")
        try write("a.txt", "late write\n")
        t.reconcileEndOfTurn(sessionID: "s")
        t.drain()
        let hoisted7 = try await t.snapshot(sessionID: "s")
        let c = try XCTUnwrap(change(hoisted7, "a.txt"))
        XCTAssertEqual(c.attribution, .observed)
    }

    // MARK: Runner lifecycle

    @MainActor
    func testRunnerCapturesAroundFailingShellCommand() async throws {
        try write("a.txt", "1\n")
        let t = tracker()
        try await t.addRoot(sessionID: "s", path: workspace.path, sessionHasTurns: false)
        let file = workspace.appendingPathComponent("a.txt")
        let final = expectation(description: "final")
        let socket = ScriptedSocket(script: "touch a.txt")
        ChatSessionRunner.shared.startAgentWebSocketSession(
            url: URL(string: "ws://localhost/unused")!, sessionID: "s", jwt: "",
            originalText: "go", groupName: nil, allowReauth: false, handle: ChatSessionRunHandle(),
            onBlock: { _ in }, onSteeringEvent: { _ in }, onFinal: { _ in final.fulfill() },
            onError: { XCTFail("unexpected error \($0)") },
            socket: socket,
            executeShell: { _, _ in
                try? Data("2\n".utf8).write(to: file)
                return ("failed", 1)
            },
            changeTracker: t
        )
        await fulfillment(of: [final], timeout: 10)
        let hoisted8 = try await t.snapshot(sessionID: "s")
        let c = try XCTUnwrap(change(hoisted8, "a.txt"))
        XCTAssertEqual(c.attribution, .toolWindow)
    }

    // MARK: Diff engine

    func testDiffHandlesCRLFAndMissingFinalNewline() {
        let crlf = SessionDiffEngine.diff(old: "a\nb\n", new: "a\r\nb\n")
        XCTAssertEqual(crlf.removed, 1)
        XCTAssertEqual(crlf.added, 1)
        XCTAssertTrue(crlf.lines.contains { $0.kind == .added && $0.text == "a\r" })

        let noNewline = SessionDiffEngine.diff(old: "a\nb\n", new: "a\nb")
        XCTAssertEqual(noNewline.added, 1)
        XCTAssertEqual(noNewline.removed, 1)
        XCTAssertEqual(noNewline.lines.last?.kind, .noNewline)

        XCTAssertTrue(SessionDiffEngine.diff(old: "same\n", new: "same\n").lines.isEmpty)
        XCTAssertEqual(SessionDiffEngine.diff(old: nil, new: "x\ny\n").added, 2)
    }

    func testDiffMatchesMinimalEditsAndPatchIsExact() {
        let old = (1...50).map { "line \($0)" }.joined(separator: "\n") + "\n"
        var newLines = (1...50).map { "line \($0)" }
        newLines[9] = "changed 10"
        newLines.insert("inserted", at: 40)
        let diff = SessionDiffEngine.diff(old: old, new: newLines.joined(separator: "\n") + "\n")
        XCTAssertEqual(diff.added, 2)
        XCTAssertEqual(diff.removed, 1)
        XCTAssertEqual(diff.lines.filter { $0.kind == .hunkHeader }.count, 2)
        XCTAssertFalse(diff.approximate)
        let patch = SessionDiffEngine.unifiedPatch(path: "f.txt", diff: diff, oldExists: true, newExists: true)
        XCTAssertTrue(patch.hasPrefix("--- a/f.txt\n+++ b/f.txt\n@@ -7,7 +7,7 @@\n"))
        XCTAssertTrue(patch.contains("-line 10\n+changed 10\n"))
    }

    func testPreviewBoundsDiscloseTruncation() {
        let new = (1...100).map { "l\($0)" }.joined(separator: "\n") + "\n" + String(repeating: "z", count: 50) + "\n"
        let full = SessionDiffEngine.diff(old: nil, new: new)
        let preview = SessionDiffEngine.preview(full, maxLines: 10, maxLineLength: 20)
        XCTAssertTrue(preview.previewTruncated)
        XCTAssertEqual(preview.lines.count, 10)
        XCTAssertEqual(preview.added, full.added, "counts describe the full diff, not the preview")
        let longOnly = SessionDiffEngine.preview(SessionDiffEngine.diff(old: nil, new: String(repeating: "q", count: 50)),
                                                 maxLines: 10, maxLineLength: 20)
        XCTAssertTrue(longOnly.lines.contains { $0.text.contains("more characters") })
    }

    func testBinaryDetection() {
        XCTAssertNil(SessionTextDecoding.text(from: Data([0x41, 0x00])))
        XCTAssertNil(SessionTextDecoding.text(from: Data([0xFF, 0xFE, 0xFD])))
        XCTAssertEqual(SessionTextDecoding.text(from: Data("ok".utf8)), "ok")
    }

    func testRenderedDiffKeepsGutterAndMarkers() {
        let diff = SessionDiffEngine.diff(old: "a\n", new: "b\n")
        let rendered = SessionDiffTextView.render(diff).text
        XCTAssertTrue(rendered.contains("@@ -1,1 +1,1 @@"))
        XCTAssertTrue(rendered.contains("  1     │ -a"))
        XCTAssertTrue(rendered.contains("      1 │ +b"))
    }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date()
    var now: Date {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// Delivers one shell-script request, then a final answer after the
/// terminal output is sent back.
private final class ScriptedSocket: ChatSessionSocket, @unchecked Sendable {
    typealias Receiver = @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    private let lock = NSLock()
    private var inbox: [String]
    private var receiver: Receiver?

    init(script: String) {
        inbox = [Self.message("<shell_script>\(script)</shell_script>")]
    }

    static func message(_ content: String) -> String {
        let payload: [String: Any] = ["session_id": "s", "sender": "agent", "content": content]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return String(decoding: data, as: UTF8.self)
    }

    func resume() {}
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {}

    func receive(completionHandler: @escaping Receiver) {
        lock.lock()
        if !inbox.isEmpty {
            let next = inbox.removeFirst()
            lock.unlock()
            DispatchQueue.global().async { completionHandler(.success(.string(next))) }
        } else {
            receiver = completionHandler
            lock.unlock()
        }
    }

    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable (Error?) -> Void) {
        completionHandler(nil)
        guard case let .string(text) = message, text.contains("\"is_terminal_output\":true") else { return }
        let final = Self.message("<final_answer>done</final_answer>")
        lock.lock()
        if let receiver {
            self.receiver = nil
            lock.unlock()
            DispatchQueue.global().async { receiver(.success(.string(final))) }
        } else {
            inbox.append(final)
            lock.unlock()
        }
    }
}
