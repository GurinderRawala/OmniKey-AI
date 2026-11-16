import XCTest
@testable import OmniKeyAI

final class TurnSnapshotStoreTests: XCTestCase {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("turn-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url.resolvingSymlinksInPath()
    }
    private func mode(_ path: String) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    func testInlineAndSpilledBlobsRoundTripWithPrivatePermissionsAndDedup() throws {
        let store = TurnSnapshotStore()
        let small = try store.put(Data("small".utf8), pin: true)
        XCTAssertNil(store.directory, "Small files never touch disk")
        let bytes = Data(repeating: 7, count: 10_000)
        let large = try store.put(bytes, pin: true)
        let again = try store.put(bytes, pin: false)
        XCTAssertEqual(large, again)
        XCTAssertEqual(store.diskUsed, 10_000)
        XCTAssertEqual(try store.data(small), Data("small".utf8))
        XCTAssertEqual(try store.data(large), bytes)
        let directory = try XCTUnwrap(store.directory)
        XCTAssertEqual(try mode(directory.path), 0o700)
        XCTAssertEqual(try mode(directory.appendingPathComponent(large.digest).path), 0o600)
        store.removeAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertThrowsError(try store.data(large))
    }

    func testQuotaIsHardAndInlineBudgetSpills() throws {
        var limits = TurnSnapshotStore.Limits()
        limits.diskBytes = 5_000; limits.inlineBytes = 10; limits.inlineFileBytes = 8
        let store = TurnSnapshotStore(limits: limits)
        _ = try store.put(Data("12345678".utf8), pin: true)
        _ = try store.put(Data("abcdefgh".utf8), pin: true) // over inline budget: spills
        XCTAssertEqual(store.inlineUsed, 8)
        XCTAssertEqual(store.diskUsed, 8)
        XCTAssertThrowsError(try store.put(Data(repeating: 1, count: 6_000), pin: true)) {
            XCTAssertEqual($0 as? TurnSnapshotStore.Failure, .quotaExceeded)
        }
        XCTAssertEqual(store.diskUsed, 8)
    }

    func testPruneKeepsPinnedAndReferencedBlobsOnly() throws {
        var limits = TurnSnapshotStore.Limits(); limits.inlineFileBytes = 0
        let store = TurnSnapshotStore(limits: limits)
        let pinned = try store.put(Data("pinned".utf8), pin: true)
        let kept = try store.put(Data("kept".utf8), pin: false)
        let dropped = try store.put(Data("dropped".utf8), pin: false)
        store.prune(keeping: [kept.digest])
        XCTAssertNoThrow(try store.data(pinned))
        XCTAssertNoThrow(try store.data(kept))
        XCTAssertThrowsError(try store.data(dropped))
        XCTAssertEqual(store.diskUsed, 10)
    }

    func testTamperedBlobIsRejectedAndForeignFilesAreNeverDeleted() throws {
        var limits = TurnSnapshotStore.Limits(); limits.inlineFileBytes = 0
        let store = TurnSnapshotStore(limits: limits)
        let blob = try store.put(Data("original".utf8), pin: true)
        let directory = try XCTUnwrap(store.directory)
        try Data("tampered".utf8).write(to: directory.appendingPathComponent(blob.digest))
        XCTAssertThrowsError(try store.data(blob))
        let foreign = directory.appendingPathComponent("foreign")
        try Data("not ours".utf8).write(to: foreign)
        store.removeAll()
        XCTAssertTrue(FileManager.default.fileExists(atPath: foreign.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent(blob.digest).path))
        try FileManager.default.removeItem(at: directory)
    }

    func testTrackerStorageQuotaMarksFilesUnknownNeverEmpty() throws {
        let root = try folder()
        try Data(repeating: UInt8(ascii: "a"), count: 9_000).write(to: root.appendingPathComponent("big"))
        try Data("small\n".utf8).write(to: root.appendingPathComponent("small"))
        let tracker = TurnChangeTracker()
        tracker.limits.store.diskBytes = 1_000
        _ = tracker.baseline(GitDiffRequestPayload(requestID: "b", candidatePaths: [root.path], phase: .baseline, baselineSource: .turnStart, filesystem: true))
        try Data("replaced\n".utf8).write(to: root.appendingPathComponent("big"))
        try Data("edited\n".utf8).write(to: root.appendingPathComponent("small"))
        let result = tracker.capture(status: "final")
        let patch = result.repositories.map(\.patch).joined()
        XCTAssertTrue(patch.contains("+edited"))
        XCTAssertFalse(patch.contains("a/big"), "No fabricated empty starting bytes")
        XCTAssertEqual(result.coverage.first?.status, "partial")
        XCTAssertTrue(result.coverage.first?.reason.contains("storage limit") == true)
    }

    func testTrackerUnreadableStoredBaselineIsPartialNotEmpty() throws {
        let root = try folder()
        try Data(repeating: UInt8(ascii: "a"), count: 9_000).write(to: root.appendingPathComponent("big"))
        let tracker = TurnChangeTracker()
        _ = tracker.baseline(GitDiffRequestPayload(requestID: "b", candidatePaths: [root.path], phase: .baseline, baselineSource: .turnStart, filesystem: true))
        let directory = try XCTUnwrap(tracker.store.directory)
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            try Data("corrupt".utf8).write(to: directory.appendingPathComponent(name))
        }
        try Data("changed\n".utf8).write(to: root.appendingPathComponent("big"))
        let result = tracker.capture(status: "final")
        XCTAssertTrue(result.repositories.isEmpty)
        XCTAssertEqual(result.coverage.first?.status, "partial")
        XCTAssertTrue(result.coverage.first?.reason.contains("could not be read back") == true)
    }

    func testStopKeepsStorageAndReleaseCleansUpWithoutBreakingPatches() throws {
        let root = try folder()
        try Data(repeating: UInt8(ascii: "a"), count: 9_000).write(to: root.appendingPathComponent("big"))
        var tracker: TurnChangeTracker? = TurnChangeTracker()
        _ = tracker!.baseline(GitDiffRequestPayload(requestID: "b", candidatePaths: [root.path], phase: .baseline, baselineSource: .turnStart, filesystem: true))
        let directory = try XCTUnwrap(tracker!.store.directory)
        try Data("changed\n".utf8).write(to: root.appendingPathComponent("big"))
        tracker!.stop()
        let captured = tracker!.capture(status: "final")
        XCTAssertTrue(captured.repositories.first?.patch.contains("+changed") == true)
        tracker = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertTrue(captured.repositories.first?.patch.contains("+changed") == true)
    }
}


extension TurnSnapshotStoreTests {
    func testUnpinnedInlineBytesAreBoundedDeduplicatedAndPruned() throws {
        var limits = TurnSnapshotStore.Limits()
        limits.inlineBytes = 8; limits.inlineFileBytes = 8
        let store = TurnSnapshotStore(limits: limits)
        let one = try store.put(Data("12345678".utf8), pin: false)
        let again = try store.put(Data("12345678".utf8), pin: true)
        XCTAssertEqual(one, again)
        XCTAssertEqual(store.inlineUsed, 8)
        let two = try store.put(Data("abcdefgh".utf8), pin: false)
        XCTAssertEqual(store.diskUsed, 8)
        XCTAssertEqual(store.inlineUsed, 8)
        store.prune(keeping: [])
        XCTAssertEqual(store.diskUsed, 0)
        XCTAssertEqual(try store.data(one), Data("12345678".utf8))
        XCTAssertThrowsError(try store.data(two))
        store.removeAll()
        XCTAssertEqual(store.inlineUsed, 0)
    }
}


extension TurnSnapshotStoreTests {
    func testSweeperPreservesLiveLeaseAndRemovesOnlyMarkedAbandonedBlobs() throws {
        var limits = TurnSnapshotStore.Limits(); limits.inlineFileBytes = 0
        let live = TurnSnapshotStore(limits: limits)
        let blob = try live.put(Data("live".utf8), pin: true)
        let liveDirectory = try XCTUnwrap(live.directory)
        TurnSnapshotStore.sweepAbandoned(in: liveDirectory.deletingLastPathComponent())
        XCTAssertEqual(try live.data(blob), Data("live".utf8))
        let parent = try folder()
        let stale = parent.appendingPathComponent("omnikey-turn-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stale, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let marker = stale.appendingPathComponent(".omnikey-turn-store-v1")
        XCTAssertTrue(FileManager.default.createFile(atPath: marker.path, contents: Data(), attributes: [.posixPermissions: 0o600]))
        let data = Data("stale".utf8), file = stale.appendingPathComponent(TurnSnapshotStore.digest(data))
        XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: data, attributes: [.posixPermissions: 0o600]))
        TurnSnapshotStore.sweepAbandoned(in: parent)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
    }
}
