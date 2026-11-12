import Foundation

/// Bounded, symlink-safe walk of one user-selected tracking root.
///
/// - Never follows symlinks (they are recorded as metadata with their
///   target string; a link pointing outside the root is never read).
/// - Skips default-excluded directories/files (VCS internals, dependency
///   and build caches, secrets) and counts what it skipped.
/// - Stops at `maxFiles` entries or `maxScanBytes` read bytes and marks the
///   scan partial. Callers must not infer deletions from a partial scan.
/// - Reads at most `perFileLimit + 1` bytes per file, so memory stays
///   bounded even if a file grows during the scan.
struct SessionChangesScanner {
    struct Limits: Sendable {
        var maxFiles: Int
        var maxScanBytes: Int64
        var perFileLimit: Int64

        init(settings: SessionChangesSettings) {
            maxFiles = settings.maxFilesPerRoot
            maxScanBytes = settings.maxScanBytesPerRoot
            perFileLimit = settings.perFileLimitBytes
        }

        init(maxFiles: Int, maxScanBytes: Int64, perFileLimit: Int64) {
            self.maxFiles = maxFiles
            self.maxScanBytes = maxScanBytes
            self.perFileLimit = perFileLimit
        }
    }

    /// A scanned file plus its captured bytes (regular files only).
    struct Entry {
        var record: SessionFileRecord
        var content: Data?
    }

    struct Result {
        var entries: [String: Entry]
        var coverage: SessionScanCoverage
    }

    /// Directory names never descended into.
    static let excludedDirectoryNames: Set<String> = [
        ".git", ".hg", ".svn", "node_modules", ".build", "build", "DerivedData", "dist", ".next",
        ".nuxt", ".cache", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
        "Pods", "Carthage", "target", ".gradle", ".idea", ".terraform", ".aws", ".ssh", ".gnupg",
        ".swiftpm",
    ]

    /// Exact file names never captured (secrets / credentials).
    static let excludedFileNames: Set<String> = [
        ".env", ".netrc", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "credentials",
        ".ds_store",
    ]

    /// Suffixes never captured (keys / certificates / env variants).
    static let excludedSuffixes: [String] = [".pem", ".key", ".p12", ".pfx", ".keychain", ".keystore"]

    static func isExcludedFile(_ name: String) -> Bool {
        if excludedFileNames.contains(name.lowercased()) { return true }
        if name.lowercased().hasPrefix(".env.") { return true }
        let lower = name.lowercased()
        return excludedSuffixes.contains { lower.hasSuffix($0) }
    }

    static var exclusionSummary: [String] {
        Array(excludedDirectoryNames).sorted().map { $0 + "/" }
            + Array(excludedFileNames).sorted()
            + [".env.*"] + excludedSuffixes.map { "*" + $0 }
    }

    let limits: Limits

    /// Enumerate through pinned directory descriptors, never path-following
    /// descendant links. Contents are rehashed even when timestamps match.
    /// The sink lets the tracker persist one file at a time, rather than
    /// retaining the whole root's contents in memory.
    func scan(root: URL, previous: [String: SessionFileRecord]? = nil,
              isCancelled: () -> Bool = { false },
              consume: ((Entry) throws -> Entry)? = nil) throws -> Result {
        var coverage = SessionScanCoverage()
        var entries: [String: Entry] = [:]
        var excludedNames = Set<String>()
        var bytesRead: Int64 = 0
        var visited = 0
        // The tracker canonicalizes an approved root at opt-in. Do not resolve
        // it again: replacement of the root itself with a link must fail closed.
        let filesystemFD = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard filesystemFD >= 0 else {
            coverage.rootMissing = true
            return Result(entries: [:], coverage: coverage)
        }
        // URL.standardizedFileURL abbreviates /private/var to /var on macOS;
        // preserve the canonical path supplied by opt-in instead.
        let rootFD = Self.openDirectory(rootFD: filesystemFD, relative: root.path)
        close(filesystemFD)
        guard rootFD >= 0 else {
            coverage.rootMissing = true
            return Result(entries: [:], coverage: coverage)
        }
        defer { close(rootFD) }
        var stack = [""]
        walk: while let relDir = stack.popLast() {
            if isCancelled() { coverage.hitFileLimit = true; break }
            let fd = Self.openDirectory(rootFD: rootFD, relative: relDir)
            guard fd >= 0, let directory = fdopendir(fd) else {
                if fd >= 0 { close(fd) }
                coverage.unreadable += 1
                coverage.hitFileLimit = true
                continue
            }
            defer { closedir(directory) }
            while true {
                errno = 0
                guard let item = readdir(directory) else {
                    if errno != 0 { coverage.unreadable += 1; coverage.hitFileLimit = true }
                    break
                }
                let name = withUnsafePointer(to: &item.pointee.d_name) {
                    $0.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(cString: $0) }
                }
                if name == "." || name == ".." { continue }
                visited += 1
                if visited > limits.maxFiles || isCancelled() {
                    coverage.hitFileLimit = true
                    break walk
                }
                let rel = relDir.isEmpty ? name : relDir + "/" + name
                var info = stat()
                guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
                    coverage.unreadable += 1
                    coverage.hitFileLimit = true
                    continue
                }
                let fileType = info.st_mode & S_IFMT
                if fileType == S_IFDIR {
                    if Self.excludedDirectoryNames.contains { $0.lowercased() == name.lowercased() } {
                        coverage.excludedEntries += 1
                        excludedNames.insert(name + "/")
                    } else { stack.append(rel) }
                    continue
                }
                if Self.isExcludedFile(name) {
                    coverage.excludedEntries += 1
                    excludedNames.insert(name)
                    continue
                }
                let mode = Int(info.st_mode & 0o7777)
                let size = Int64(info.st_size)
                let mtime = Double(info.st_mtimespec.tv_sec) + Double(info.st_mtimespec.tv_nsec) / 1e9
                var record = SessionFileRecord(relPath: rel, state: .present, kind: .file,
                                               size: size, mode: mode, hash: nil,
                                               linkTarget: nil, attribution: .observed, mtime: mtime)
                var content: Data?
                if fileType == S_IFLNK {
                    coverage.symlinksNotFollowed += 1
                    var target = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
                    let count = readlinkat(fd, name, &target, target.count - 1)
                    record.kind = .symlink
                    if count >= 0 {
                        let value = String(decoding: target.prefix(count).map { UInt8(bitPattern: $0) }, as: UTF8.self)
                        record.linkTarget = value
                        record.hash = SessionHashing.sha256Hex(Data(value.utf8))
                        record.size = Int64(count)
                    } else { record.state = .unreadable; coverage.unreadable += 1 }
                } else if fileType != S_IFREG {
                    record.kind = .other
                } else if size > limits.perFileLimit {
                    coverage.oversize += 1
                    record.state = .oversize
                } else {
                    guard bytesRead + size <= limits.maxScanBytes else {
                        coverage.hitByteLimit = true
                        break walk
                    }
                    let remaining = min(limits.perFileLimit, limits.maxScanBytes - bytesRead)
                    switch Self.readBounded(directoryFD: fd, name: name, limit: remaining, expected: info) {
                    case let .success(data):
                        bytesRead += Int64(data.count)
                        record.size = Int64(data.count)
                        record.hash = SessionHashing.sha256Hex(data)
                        content = data
                    case .tooLarge:
                        bytesRead += remaining
                        record.state = .oversize
                        coverage.oversize += 1
                        if remaining < limits.perFileLimit { coverage.hitByteLimit = true }
                    case .failed:
                        record.state = .unreadable
                        coverage.unreadable += 1
                    }
                }
                let entry = Entry(record: record, content: content)
                entries[rel] = try consume?(entry) ?? entry
            }
        }
        coverage.filesSeen = entries.count
        coverage.excludedNames = excludedNames.sorted()
        return Result(entries: entries, coverage: coverage)
    }

    /// Reopen each component from a pinned root with O_NOFOLLOW. A directory
    /// replaced with a link during enumeration becomes partial coverage.
    private static func openDirectory(rootFD: Int32, relative: String) -> Int32 {
        var fd = dup(rootFD)
        guard fd >= 0 else { return -1 }
        for component in relative.split(separator: "/") {
            let next = openat(fd, String(component), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            close(fd)
            guard next >= 0 else { return -1 }
            fd = next
        }
        return fd
    }

    enum ReadOutcome {
        case success(Data)
        case tooLarge
        case failed
    }

    /// O_NONBLOCK prevents a raced replacement with a FIFO from hanging.
    private static func readBounded(directoryFD: Int32, name: String, limit: Int64,
                                    expected: stat) -> ReadOutcome {
        let fd = openat(directoryFD, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return .failed }
        defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_dev == expected.st_dev, before.st_ino == expected.st_ino else { return .failed }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let capacity = min(buffer.count, Int(max(0, limit - Int64(data.count))) + 1)
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, capacity) }
            if n < 0 { if errno == EINTR { continue }; return .failed }
            if n == 0 { break }
            data.append(contentsOf: buffer.prefix(n))
            if Int64(data.count) > limit { return .tooLarge }
        }
        var after = stat()
        guard fstat(fd, &after) == 0, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              before.st_mode == after.st_mode else { return .failed }
        return .success(data)
    }
}
