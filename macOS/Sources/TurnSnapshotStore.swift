import CryptoKit
import Foundation

/// Private, per-turn, content-addressed storage for captured file bytes.
/// Manifests hold only digests/sizes; small files stay inline within a bounded
/// memory budget and everything else spills to `0600` blobs inside a `0700`
/// directory created exclusively by this store. Only blobs this store wrote are
/// ever unlinked. Callers must exclude sensitive paths before calling `put`.
///
/// Not thread-safe: owned by `TurnChangeTracker` and used on its serial queue.
final class TurnSnapshotStore {
    struct Limits {
        /// Hard per-turn disk quota for spilled blobs.
        var diskBytes = 1024 * 1_048_576
        /// Total bytes of pinned (baseline) files kept in memory.
        var inlineBytes = 16 * 1_048_576
        /// Files at or below this size may stay in memory.
        var inlineFileBytes = 4096
    }

    enum Failure: Error, Equatable { case quotaExceeded, unavailable, corrupt }

    /// Equality is content identity (digest + size); the inline copy is a cache.
    struct Blob: Hashable {
        let digest: String
        let size: Int
        fileprivate let inline: Data?
        static func == (a: Blob, b: Blob) -> Bool { a.digest == b.digest && a.size == b.size }
        func hash(into hasher: inout Hasher) { hasher.combine(digest); hasher.combine(size) }
    }

    let limits: Limits
    private(set) var diskUsed = 0
    private(set) var inlineUsed = 0
    /// Spilled blob sizes by digest; the exact set of files this store owns.
    private var disk: [String: Int] = [:]
    private var pinned: Set<String> = []
    private var inlineBlobs: [String: Data] = [:]
    private var directoryFD: Int32 = -1
    private var leaseFD: Int32 = -1
    private static let marker = ".omnikey-turn-store-v1"
    /// Also bound aggregate spilled bytes across concurrent turns in this process.
    private final class DiskBudget: @unchecked Sendable {
        let lock = NSLock()
        var used = 0
        func reserve(_ count: Int) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard count <= 1024 * 1_048_576 - used else { return false }
            used += count; return true
        }
        func release(_ count: Int) { lock.lock(); used = max(0, used - count); lock.unlock() }
    }
    private static let budget = DiskBudget()
    private static let startupSweep: Void = sweepAbandoned(in: FileManager.default.temporaryDirectory)
    private var directoryFailed = false
    private(set) var directory: URL?

    init(limits: Limits = Limits()) { self.limits = limits }
    deinit { removeAll() }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Stores bytes and returns their blob. `pin` keeps the blob for the life
    /// of the store (starting contents); unpinned blobs may be pruned.
    func put(_ data: Data, pin: Bool) throws -> Blob {
        let digest = Self.digest(data)
        if pin { pinned.insert(digest) }
        if disk[digest] != nil { return Blob(digest: digest, size: data.count, inline: nil) }
        if let cached = inlineBlobs[digest] { return Blob(digest: digest, size: cached.count, inline: cached) }
        if data.count <= limits.inlineFileBytes, inlineUsed + data.count <= limits.inlineBytes {
            inlineBlobs[digest] = data
            inlineUsed += data.count
            return Blob(digest: digest, size: data.count, inline: data)
        }
        do { try spill(data, digest: digest) }
        catch { if pin, disk[digest] == nil { pinned.remove(digest) }; throw error }
        return Blob(digest: digest, size: data.count, inline: nil)
    }

    /// Loads and verifies bytes. A missing, truncated or modified blob throws:
    /// the caller must treat the path as unknown, never as empty contents.
    func data(_ blob: Blob) throws -> Data {
        if let inline = blob.inline { return inline }
        guard disk[blob.digest] == blob.size, directoryFD >= 0 else { throw Failure.unavailable }
        let fd = openat(directoryFD, blob.digest, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unavailable }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: blob.size + 1) ?? Data()
        guard bytes.count == blob.size, Self.digest(bytes) == blob.digest else { throw Failure.corrupt }
        return bytes
    }

    /// Releases unpinned spilled blobs not referenced by `keeping`.
    func prune(keeping: Set<String>) {
        for (digest, bytes) in inlineBlobs where !pinned.contains(digest) && !keeping.contains(digest) {
            inlineUsed -= bytes.count
            inlineBlobs.removeValue(forKey: digest)
        }
        for (digest, size) in disk where !pinned.contains(digest) && !keeping.contains(digest) {
            if unlinkat(directoryFD, digest, 0) == 0 || errno == ENOENT {
                disk.removeValue(forKey: digest)
                diskUsed -= size
                Self.budget.release(size)
            }
        }
    }

    /// Deletes only blobs written by this store, then its own empty directory.
    /// Safe to call repeatedly. Already rendered patches are plain strings and
    /// are unaffected.
    func removeAll() {
        inlineBlobs.removeAll(); inlineUsed = 0; pinned.removeAll()
        guard directoryFD >= 0 else { return }
        for digest in disk.keys { _ = unlinkat(directoryFD, digest, 0) }
        Self.budget.release(diskUsed)
        disk.removeAll(); diskUsed = 0; pinned.removeAll(); inlineUsed = 0
        _ = unlinkat(directoryFD, Self.marker, 0)
        if leaseFD >= 0 { close(leaseFD); leaseFD = -1 }
        close(directoryFD); directoryFD = -1
        if let directory { _ = rmdir(directory.path) } // fails safely if anything foreign appeared
    }

    private func spill(_ data: Data, digest: String) throws {
        guard diskUsed + data.count <= limits.diskBytes else { throw Failure.quotaExceeded }
        try openDirectory()
        guard Self.budget.reserve(data.count) else { throw Failure.quotaExceeded }
        var committed = false
        defer { if !committed { Self.budget.release(data.count) } }
        let temp = "tmp-" + UUID().uuidString
        let fd = openat(directoryFD, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.unavailable }
        var ok = true
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
                if written <= 0 { if written < 0 && errno == EINTR { continue }; ok = false; break }
                offset += written
            }
        }
        if close(fd) != 0 { ok = false }
        guard ok, renameat(directoryFD, temp, directoryFD, digest) == 0 else {
            _ = unlinkat(directoryFD, temp, 0)
            throw Failure.unavailable
        }
        disk[digest] = data.count
        diskUsed += data.count
        committed = true
    }

    private func openDirectory() throws {
        if directoryFD >= 0 { return }
        guard !directoryFailed else { throw Failure.unavailable }
        let parent = FileManager.default.temporaryDirectory
        _ = Self.startupSweep
        let url = parent.appendingPathComponent("omnikey-turn-store-\(UUID().uuidString)")
        // mkdir never follows or reuses an existing path; the descriptor pins it.
        guard mkdir(url.path, 0o700) == 0 else { directoryFailed = true; throw Failure.unavailable }
        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { _ = rmdir(url.path); directoryFailed = true; throw Failure.unavailable }
        let lease = openat(fd, Self.marker, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lease >= 0, flock(lease, LOCK_EX | LOCK_NB) == 0 else {
            if lease >= 0 { close(lease) }
            _ = unlinkat(fd, Self.marker, 0); close(fd); _ = rmdir(url.path)
            directoryFailed = true; throw Failure.unavailable
        }
        leaseFD = lease
        directory = url
        directoryFD = fd
    }

    /// Only reclaim our version-marked, private directories whose advisory
    /// lease is no longer held. No PID/age heuristics, recursion or symlink
    /// following. A live turn (including in another app process) is preserved.
    static func sweepAbandoned(in parent: URL) {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: parent.path) else { return }
        for name in entries.prefix(10_000) where name.hasPrefix("omnikey-turn-store-") {
            guard UUID(uuidString: String(name.dropFirst("omnikey-turn-store-".count))) != nil else { continue }
            let path = parent.appendingPathComponent(name).path
            let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { continue }
            defer { close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else { continue }
            let lease = openat(fd, marker, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
            guard lease >= 0 else { continue }
            defer { close(lease) }
            var leaseInfo = stat()
            guard fstat(lease, &leaseInfo) == 0, leaseInfo.st_uid == getuid(),
                  leaseInfo.st_mode & S_IFMT == S_IFREG, leaseInfo.st_mode & 0o777 == 0o600,
                  flock(lease, LOCK_EX | LOCK_NB) == 0 else { continue }
            guard let stream = fdopendir(dup(fd)) else { continue }
            defer { closedir(stream) }
            while let item = readdir(stream) {
                let child = withUnsafePointer(to: &item.pointee.d_name) {
                    $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
                }
                let digest = child.count == 64 && child.allSatisfy { $0.isHexDigit && !$0.isUppercase }
                let temporary = child.hasPrefix("tmp-") && UUID(uuidString: String(child.dropFirst(4))) != nil
                guard digest || temporary else { continue }
                var file = stat()
                guard fstatat(fd, child, &file, AT_SYMLINK_NOFOLLOW) == 0,
                      file.st_uid == getuid(), file.st_mode & S_IFMT == S_IFREG,
                      file.st_mode & 0o777 == 0o600 else { continue }
                _ = unlinkat(fd, child, 0)
            }
            _ = unlinkat(fd, marker, 0)
            _ = rmdir(path) // refuses foreign files or anything not empty
        }
    }
}
