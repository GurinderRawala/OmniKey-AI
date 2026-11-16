import Foundation

/// Resolve every descendant from a pinned root descriptor. O_NOFOLLOW on just
/// the leaf is insufficient: an ancestor could have been replaced by a symlink
/// between directory enumeration and reading. Metadata and reads use openat /
/// fstatat / readlinkat against the same directory descriptors.
final class TurnFileReader {
    struct DirectoryIdentity: Equatable, Hashable { let device: dev_t; let inode: ino_t }
    var directoryIdentity: DirectoryIdentity { DirectoryIdentity(device: identity.st_dev, inode: identity.st_ino) }

    enum Failure: Error { case absent, unavailable, tooLarge(Int64) }
    enum Entry {
        case directory
        case excluded
        case file(TurnChangeTracker.File)
    }
    private let root: String
    private let descriptor: Int32
    private let identity: stat

    init(root: String) throws {
        self.root = root
        descriptor = try Self.openDirectory(root, from: nil)
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { close(descriptor); throw Failure.unavailable }
        identity = info
    }
    deinit { close(descriptor) }

    /// Only called during initial root discovery, never to follow a changed
    /// root/ancestor during a later scan. Missing descendants retain their names.
    static func physicalPath(_ path: String) -> String? {
        guard path.hasPrefix("/"), !path.contains("\0") else { return nil }
        var current = path
        var missing: [String] = []
        while true {
            if let resolved = realpath(current, nil) {
                defer { free(resolved) }
                return missing.reversed().reduce(String(cString: resolved)) { ($0 as NSString).appendingPathComponent($1) }
            }
            guard errno == ENOENT, current != "/" else { return nil }
            missing.append((current as NSString).lastPathComponent)
            current = (current as NSString).deletingLastPathComponent
            if current.isEmpty { return nil }
        }
    }

    private static func openDirectory(_ path: String, from parent: Int32?) throws -> Int32 {
        let parts = path.split(separator: "/").map(String.init)
        guard parent != nil || path.hasPrefix("/") else { throw Failure.unavailable }
        guard !parts.contains("."), !parts.contains(".."), !path.contains("\0") else { throw Failure.unavailable }
        var fd = parent.map { dup($0) } ?? open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unavailable }
        for component in parts {
            let next = openat(fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            let failure = errno
            close(fd)
            guard next >= 0 else { throw failure == ENOENT ? Failure.absent : Failure.unavailable }
            fd = next
        }
        return fd
    }

    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }

    func isStillAtRoot() -> Bool {
        guard let current = try? Self.openDirectory(root, from: nil) else { return false }
        defer { close(current) }
        var info = stat()
        return fstat(current, &info) == 0 && info.st_dev == identity.st_dev && info.st_ino == identity.st_ino
    }

    func read(_ relative: String, limit: Int) throws -> Entry {
        guard !relative.hasPrefix("/"), !relative.isEmpty,
              !relative.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { throw Failure.unavailable }
        let name = (relative as NSString).lastPathComponent
        let parentPath = (relative as NSString).deletingLastPathComponent
        let parent = try Self.openDirectory(parentPath, from: descriptor)
        defer { close(parent) }
        var before = stat()
        guard fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) == 0 else { throw errno == ENOENT ? Failure.absent : Failure.unavailable }
        let type = before.st_mode & S_IFMT
        if type == S_IFDIR { return .directory }
        guard type == S_IFREG || type == S_IFLNK else { return .excluded }
        guard before.st_size >= 0 else { throw Failure.unavailable }
        guard before.st_size <= limit else { throw Failure.tooLarge(before.st_size) }
        let bytes: Data
        let mode: String
        if type == S_IFLNK {
            var buffer = [UInt8](repeating: 0, count: max(1, min(limit + 1, Int(PATH_MAX) + 1)))
            let count = buffer.withUnsafeMutableBytes { readlinkat(parent, name, $0.baseAddress!, $0.count) }
            guard count >= 0, count < buffer.count else { throw Failure.unavailable }
            bytes = Data(buffer.prefix(count)); mode = "120000"
        } else {
            let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw Failure.unavailable }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            defer { try? handle.close() }
            var opened = stat()
            guard fstat(fd, &opened) == 0, Self.same(before, opened) else { throw Failure.unavailable }
            // Size is already validated against limit; avoid allocating the full
            // per-file budget for every tiny file in a large workspace.
            bytes = try handle.read(upToCount: Int(before.st_size) + 1) ?? Data()
            guard fstat(fd, &opened) == 0, Self.same(before, opened) else { throw Failure.unavailable }
            mode = before.st_mode & 0o111 == 0 ? "100644" : "100755"
        }
        guard bytes.count == before.st_size else { throw Failure.unavailable }
        // Re-resolve the ancestor chain as well: a pinned parent may have been
        // renamed/replaced while the original descriptor remained readable.
        let currentParent = try Self.openDirectory(parentPath, from: descriptor)
        defer { close(currentParent) }
        var after = stat()
        guard fstatat(currentParent, name, &after, AT_SYMLINK_NOFOLLOW) == 0, Self.same(before, after) else { throw Failure.unavailable }
        return .file(TurnChangeTracker.File(bytes: bytes, mode: mode))
    }
}
