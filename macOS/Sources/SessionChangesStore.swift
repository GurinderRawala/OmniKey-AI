import CryptoKit
import Foundation
import SQLite3

// MARK: - Models

/// State of one file record on one side (baseline or latest) of a root.
/// Anything other than `.present` / `.missing` means the content is *not*
/// known, and the UI must say so instead of inventing a diff.
enum SessionFileState: String, Codable, Sendable {
    /// Content captured (or symlink target / metadata recorded).
    case present
    /// Confirmed absent by a complete scan.
    case missing
    /// Larger than the per-file capture limit; only size/mode recorded.
    case oversize
    /// Could not be read (permissions, race with deletion, I/O error).
    case unreadable
    /// The global storage budget was exhausted; content not stored.
    case budgetExceeded = "budget_exceeded"
}

enum SessionFileKind: String, Codable, Sendable {
    case file
    case symlink
    case other
}

/// Which observation last changed the latest record. Never a claim of
/// authorship: tool-window changes may include concurrent external writes.
enum SessionChangeAttribution: String, Codable, Sendable {
    case baseline
    /// Changed while an agent shell command was running for this session.
    case toolWindow = "tool_window"
    /// Changed between tool runs (user, editor, other processes).
    case observed
}

struct SessionFileRecord: Equatable, Sendable {
    var relPath: String
    var state: SessionFileState
    var kind: SessionFileKind
    var size: Int64
    var mode: Int
    /// SHA-256 hex of the content (regular files) or of the link target.
    var hash: String?
    var linkTarget: String?
    var attribution: SessionChangeAttribution
    /// Modification time; used only to skip re-reading unchanged files.
    var mtime: Double = 0

    /// Identity used to decide whether a file changed between two records.
    var fingerprint: String {
        "\(state.rawValue)|\(kind.rawValue)|\(size)|\(mode)|\(hash ?? "-")|\(linkTarget ?? "-")"
    }
}

enum SessionBaselineLabel: String, Sendable {
    /// Tracking was enabled before the session's first turn.
    case sessionStart = "session_start"
    /// Tracking was enabled after the session already had turns.
    case trackingStart = "tracking_start"
}

struct SessionRootInfo: Equatable, Sendable, Identifiable {
    let id: Int64
    let sessionID: String
    let path: String
    var active: Bool
    var baselineAt: Date
    var baselineLabel: SessionBaselineLabel
    var baselinePartial: Bool
    var latestAt: Date
    var latestPartial: Bool
    var coverage: SessionScanCoverage
}

/// What a scan did and did not see. Shown verbatim in the UI.
struct SessionScanCoverage: Codable, Equatable, Sendable {
    var filesSeen: Int = 0
    var excludedEntries: Int = 0
    var excludedNames: [String] = []
    var unreadable: Int = 0
    var oversize: Int = 0
    var budgetSkipped: Int = 0
    var symlinksNotFollowed: Int = 0
    var hitFileLimit: Bool = false
    var hitByteLimit: Bool = false
    var rootMissing: Bool = false

    var isPartial: Bool { hitFileLimit || hitByteLimit || rootMissing }
}

struct SessionChangesSettings: Equatable, Sendable {
    var budgetBytes: Int64 = 1 << 30            // 1 GiB of compressed blobs
    var perFileLimitBytes: Int64 = 4 << 20      // 4 MiB per captured file
    var retentionDays: Int = 30
    var maxFilesPerRoot: Int = 20_000
    var maxScanBytesPerRoot: Int64 = 512 << 20  // bytes read per scan

    static let `default` = SessionChangesSettings()
}

struct SessionChangesSessionInfo: Equatable, Sendable {
    var sessionID: String
    var pinned: Bool
    var expired: Bool
    var lastActivity: Date
}

enum SessionChangesStoreError: LocalizedError {
    case sqlite(String)
    case io(String)

    var errorDescription: String? {
        switch self {
        case let .sqlite(message): return "Changes database error: \(message)"
        case let .io(message): return "Changes storage error: \(message)"
        }
    }
}

// MARK: - Store

/// Durable session -> root -> file metadata in SQLite plus a
/// content-addressed, LZFSE-compressed blob directory shared by every
/// session (identical bytes are stored once).
///
/// Thread-safety: every method must be called on the owner's serial queue
/// (`SessionChangeTracker` guarantees this). The store never touches the
/// main thread. Opening is lazy; nothing is created until `open()`.
final class SessionChangesStore: @unchecked Sendable {
    let rootDirectory: URL
    private var db: OpaquePointer?
    private var cachedStoredBytes: Int64?

    var blobsDirectory: URL { rootDirectory.appendingPathComponent("blobs", isDirectory: true) }
    var databaseURL: URL { rootDirectory.appendingPathComponent("changes.sqlite") }

    /// Default location: ~/Library/Application Support/OmniKeyAI/SessionChanges.
    static func defaultRootDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("OmniKeyAI/SessionChanges", isDirectory: true)
    }

    init(rootDirectory: URL) {
        self.rootDirectory = rootDirectory
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    /// True if a store already exists on disk. Used to keep untracked
    /// sessions (and tests) from creating the real store as a side effect.
    var existsOnDisk: Bool {
        FileManager.default.fileExists(atPath: databaseURL.path)
    }

    var isOpen: Bool { db != nil }

    func open() throws {
        guard db == nil else { return }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: blobsDirectory, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: rootDirectory.path)
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: blobsDirectory.path)
        } catch {
            throw SessionChangesStoreError.io(error.localizedDescription)
        }
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(databaseURL.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            if let handle { sqlite3_close(handle) }
            throw SessionChangesStoreError.sqlite(message)
        }
        db = handle
        chmod(databaseURL.path, 0o600)
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA foreign_keys=ON;")
        chmod(databaseURL.path + "-wal", 0o600)
        chmod(databaseURL.path + "-shm", 0o600)
        try exec("""
        CREATE TABLE IF NOT EXISTS sessions(
            session_id TEXT PRIMARY KEY,
            pinned INTEGER NOT NULL DEFAULT 0,
            expired INTEGER NOT NULL DEFAULT 0,
            last_activity REAL NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            capture_error TEXT
        );
        CREATE TABLE IF NOT EXISTS roots(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE ON UPDATE CASCADE,
            path TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            baseline_at REAL NOT NULL,
            baseline_label TEXT NOT NULL,
            baseline_partial INTEGER NOT NULL DEFAULT 0,
            latest_at REAL NOT NULL,
            latest_partial INTEGER NOT NULL DEFAULT 0,
            coverage TEXT NOT NULL DEFAULT '{}',
            UNIQUE(session_id, path)
        );
        CREATE TABLE IF NOT EXISTS files(
            root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
            rel_path TEXT NOT NULL,
            side TEXT NOT NULL,
            state TEXT NOT NULL,
            kind TEXT NOT NULL,
            size INTEGER NOT NULL,
            mode INTEGER NOT NULL,
            hash TEXT,
            link_target TEXT,
            attribution TEXT NOT NULL,
            mtime REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(root_id, rel_path, side)
        );
        CREATE INDEX IF NOT EXISTS files_hash ON files(hash);
        CREATE TABLE IF NOT EXISTS blobs(
            hash TEXT PRIMARY KEY,
            stored_size INTEGER NOT NULL,
            raw_size INTEGER NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        var hasCaptureError = false
        try run("PRAGMA table_info(sessions)") { stmt in
            if Self.text(stmt, 1) == "capture_error" { hasCaptureError = true }
        }
        if !hasCaptureError { try exec("ALTER TABLE sessions ADD COLUMN capture_error TEXT") }

    }

    // MARK: SQL helpers

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let message = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw SessionChangesStoreError.sqlite(message)
        }
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private enum Value {
        case text(String?)
        case int(Int64)
        case real(Double)
    }

    @discardableResult
    private func run(_ sql: String, _ values: [Value] = [], row: ((OpaquePointer) -> Void)? = nil) throws -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw SessionChangesStoreError.sqlite(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        for (index, value) in values.enumerated() {
            let position = Int32(index + 1)
            switch value {
            case let .text(text):
                if let text { sqlite3_bind_text(stmt, position, text, -1, Self.transient) }
                else { sqlite3_bind_null(stmt, position) }
            case let .int(int): sqlite3_bind_int64(stmt, position, int)
            case let .real(real): sqlite3_bind_double(stmt, position, real)
            }
        }
        var rows = 0
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_ROW {
                rows += 1
                row?(stmt)
            } else if rc == SQLITE_DONE {
                break
            } else {
                throw SessionChangesStoreError.sqlite(String(cString: sqlite3_errmsg(db)))
            }
        }
        return rows
    }

    private static func text(_ stmt: OpaquePointer, _ column: Int32) -> String? {
        guard let cString = sqlite3_column_text(stmt, column) else { return nil }
        return String(cString: cString)
    }

    /// Runs `body` in one transaction; rolls back and rethrows on failure.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE;")
        do {
            let result = try body()
            try exec("COMMIT;")
            return result
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    // MARK: Settings

    func loadSettings() throws -> SessionChangesSettings {
        var settings = SessionChangesSettings.default
        try run("SELECT key, value FROM settings") { stmt in
            guard let key = Self.text(stmt, 0), let value = Self.text(stmt, 1) else { return }
            switch key {
            case "budget": settings.budgetBytes = Int64(value) ?? settings.budgetBytes
            case "per_file": settings.perFileLimitBytes = Int64(value) ?? settings.perFileLimitBytes
            case "retention": settings.retentionDays = Int(value) ?? settings.retentionDays
            case "max_files": settings.maxFilesPerRoot = Int(value) ?? settings.maxFilesPerRoot
            case "max_scan": settings.maxScanBytesPerRoot = Int64(value) ?? settings.maxScanBytesPerRoot
            default: break
            }
        }
        return settings
    }

    func saveSettings(_ settings: SessionChangesSettings) throws {
        guard settings.budgetBytes > 0, settings.budgetBytes <= 64 << 30,
              settings.perFileLimitBytes > 0, settings.perFileLimitBytes <= 16 << 20,
              settings.retentionDays > 0, settings.retentionDays <= 3650,
              settings.maxFilesPerRoot > 0, settings.maxFilesPerRoot <= 100_000,
              settings.maxScanBytesPerRoot > 0, settings.maxScanBytesPerRoot <= 512 << 20 else {
            throw SessionChangesStoreError.io("Storage settings exceed supported safety limits.")
        }
        try transaction {
            let pairs: [(String, String)] = [
                ("budget", String(settings.budgetBytes)),
                ("per_file", String(settings.perFileLimitBytes)),
                ("retention", String(settings.retentionDays)),
                ("max_files", String(settings.maxFilesPerRoot)),
                ("max_scan", String(settings.maxScanBytesPerRoot)),
            ]
            for (key, value) in pairs {
                try run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        [.text(key), .text(value)])
            }
        }
    }

    // MARK: Sessions & roots

    func ensureSession(_ sessionID: String, now: Date = Date()) throws {
        try run("""
        INSERT INTO sessions(session_id, last_activity) VALUES(?, ?)
        ON CONFLICT(session_id) DO UPDATE SET last_activity = excluded.last_activity, expired = 0
        """, [.text(sessionID), .real(now.timeIntervalSince1970)])
    }

    func sessionInfo(_ sessionID: String) throws -> SessionChangesSessionInfo? {
        var info: SessionChangesSessionInfo?
        try run("SELECT pinned, expired, last_activity FROM sessions WHERE session_id = ?", [.text(sessionID)]) { stmt in
            info = SessionChangesSessionInfo(
                sessionID: sessionID,
                pinned: sqlite3_column_int(stmt, 0) != 0,
                expired: sqlite3_column_int(stmt, 1) != 0,
                lastActivity: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 2))
            )
        }
        return info
    }

    func setPinned(_ sessionID: String, pinned: Bool) throws {
        try ensureSession(sessionID)
        try run("UPDATE sessions SET pinned = ? WHERE session_id = ?", [.int(pinned ? 1 : 0), .text(sessionID)])
    }

    func setCaptureError(_ sessionID: String, message: String?) throws {
        try run("UPDATE sessions SET capture_error = ? WHERE session_id = ?", [.text(message), .text(sessionID)])
    }

    func captureError(_ sessionID: String) throws -> String? {
        var message: String?
        try run("SELECT capture_error FROM sessions WHERE session_id = ?", [.text(sessionID)]) { stmt in
            message = Self.text(stmt, 0)
        }
        return message
    }

    func sessionRevision(_ sessionID: String) throws -> Int64 {
        var revision: Int64 = 0
        try run("SELECT revision FROM sessions WHERE session_id = ?", [.text(sessionID)]) { stmt in
            revision = sqlite3_column_int64(stmt, 0)
        }
        return revision
    }

    func bumpRevision(_ sessionID: String, now: Date = Date()) throws {
        try run("UPDATE sessions SET revision = revision + 1, expired = 0, last_activity = ? WHERE session_id = ?",
                [.real(now.timeIntervalSince1970), .text(sessionID)])
    }

    /// Moves every record from a pending (not-yet-persisted) chat key to the
    /// real session ID. Refuses to merge into a session that already has data.
    func migrateSession(from oldID: String, to newID: String) throws {
        guard oldID != newID else { return }
        try transaction {
            var exists = false
            try run("SELECT 1 FROM sessions WHERE session_id = ?", [.text(newID)]) { _ in exists = true }
            guard !exists else { throw SessionChangesStoreError.io("This session already has snapshots; pending capture was not merged.") }
            try run("UPDATE sessions SET session_id = ? WHERE session_id = ?", [.text(newID), .text(oldID)])
        }
    }

    func roots(for sessionID: String) throws -> [SessionRootInfo] {
        var result: [SessionRootInfo] = []
        try run("""
        SELECT id, path, active, baseline_at, baseline_label, baseline_partial, latest_at, latest_partial, coverage
        FROM roots WHERE session_id = ? ORDER BY path
        """, [.text(sessionID)]) { stmt in
            let coverageJSON = Self.text(stmt, 8) ?? "{}"
            let coverage = (try? JSONDecoder().decode(SessionScanCoverage.self, from: Data(coverageJSON.utf8)))
                ?? SessionScanCoverage()
            result.append(SessionRootInfo(
                id: sqlite3_column_int64(stmt, 0),
                sessionID: sessionID,
                path: Self.text(stmt, 1) ?? "",
                active: sqlite3_column_int(stmt, 2) != 0,
                baselineAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 3)),
                baselineLabel: SessionBaselineLabel(rawValue: Self.text(stmt, 4) ?? "") ?? .trackingStart,
                baselinePartial: sqlite3_column_int(stmt, 5) != 0,
                latestAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 6)),
                latestPartial: sqlite3_column_int(stmt, 7) != 0,
                coverage: coverage
            ))
        }
        return result
    }

    /// Returns the existing root (re-activating it, never resetting its
    /// baseline) or nil if this path is new for the session.
    func reactivateRoot(sessionID: String, path: String) throws -> SessionRootInfo? {
        try run("UPDATE roots SET active = 1 WHERE session_id = ? AND path = ?", [.text(sessionID), .text(path)])
        return try roots(for: sessionID).first { $0.path == path }
    }

    func setRootActive(_ rootID: Int64, active: Bool) throws {
        try run("UPDATE roots SET active = ? WHERE id = ?", [.int(active ? 1 : 0), .int(rootID)])
    }

    /// Inserts a new root together with its baseline records (both sides
    /// start identical). Blobs must already be written.
    func insertRoot(
        sessionID: String,
        path: String,
        label: SessionBaselineLabel,
        records: [SessionFileRecord],
        coverage: SessionScanCoverage,
        now: Date = Date()
    ) throws -> Int64 {
        try transaction {
            try ensureSession(sessionID, now: now)
            let coverageJSON = String(decoding: (try? JSONEncoder().encode(coverage)) ?? Data("{}".utf8), as: UTF8.self)
            try run("""
            INSERT INTO roots(session_id, path, active, baseline_at, baseline_label, baseline_partial, latest_at, latest_partial, coverage)
            VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?)
            """, [.text(sessionID), .text(path), .real(now.timeIntervalSince1970), .text(label.rawValue),
                  .int(coverage.isPartial ? 1 : 0), .real(now.timeIntervalSince1970),
                  .int(coverage.isPartial ? 1 : 0), .text(coverageJSON)])
            let rootID = sqlite3_last_insert_rowid(db)
            for record in records {
                try upsertFile(rootID: rootID, side: "base", record: record)
                try upsertFile(rootID: rootID, side: "latest", record: record)
            }
            try bumpRevision(sessionID, now: now)
            return rootID
        }
    }

    private func upsertFile(rootID: Int64, side: String, record: SessionFileRecord) throws {
        try run("""
        INSERT INTO files(root_id, rel_path, side, state, kind, size, mode, hash, link_target, attribution, mtime)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root_id, rel_path, side) DO UPDATE SET
            state = excluded.state, kind = excluded.kind, size = excluded.size, mode = excluded.mode,
            hash = excluded.hash, link_target = excluded.link_target, attribution = excluded.attribution,
            mtime = excluded.mtime
        """, [.int(rootID), .text(record.relPath), .text(side), .text(record.state.rawValue), .text(record.kind.rawValue),
              .int(record.size), .int(Int64(record.mode)), .text(record.hash), .text(record.linkTarget),
              .text(record.attribution.rawValue), .real(record.mtime)])
    }

    func files(rootID: Int64, side: String) throws -> [String: SessionFileRecord] {
        var result: [String: SessionFileRecord] = [:]
        try run("""
        SELECT rel_path, state, kind, size, mode, hash, link_target, attribution, mtime FROM files WHERE root_id = ? AND side = ?
        """, [.int(rootID), .text(side)]) { stmt in
            let path = Self.text(stmt, 0) ?? ""
            result[path] = SessionFileRecord(
                relPath: path,
                state: SessionFileState(rawValue: Self.text(stmt, 1) ?? "") ?? .unreadable,
                kind: SessionFileKind(rawValue: Self.text(stmt, 2) ?? "") ?? .other,
                size: sqlite3_column_int64(stmt, 3),
                mode: Int(sqlite3_column_int64(stmt, 4)),
                hash: Self.text(stmt, 5),
                linkTarget: Self.text(stmt, 6),
                attribution: SessionChangeAttribution(rawValue: Self.text(stmt, 7) ?? "") ?? .observed,
                mtime: sqlite3_column_double(stmt, 8)
            )
        }
        return result
    }

    /// Replaces changed latest records for a root. `changed` contains only
    /// records that differ from the previous latest side.
    func updateLatest(
        rootID: Int64,
        sessionID: String,
        changed: [SessionFileRecord],
        coverage: SessionScanCoverage,
        now: Date = Date()
    ) throws {
        try transaction {
            for record in changed {
                try upsertFile(rootID: rootID, side: "latest", record: record)
            }
            let coverageJSON = String(decoding: (try? JSONEncoder().encode(coverage)) ?? Data("{}".utf8), as: UTF8.self)
            try run("UPDATE roots SET latest_at = ?, latest_partial = ?, coverage = ? WHERE id = ?",
                    [.real(now.timeIntervalSince1970), .int(coverage.isPartial ? 1 : 0), .text(coverageJSON), .int(rootID)])
            try bumpRevision(sessionID, now: now)
        }
    }

    /// Explicit user deletion of all snapshots for a session.
    func deleteSnapshots(sessionID: String) throws {
        try transaction {
            try run("DELETE FROM roots WHERE session_id = ?", [.text(sessionID)])
            try run("DELETE FROM sessions WHERE session_id = ?", [.text(sessionID)])
        }
        try sweepOrphanBlobs()
    }

    /// Drops file/root data for unpinned, unprotected sessions inactive for
    /// longer than `retentionDays`. The session row remains, marked
    /// `expired`, so the UI can explain why nothing is shown.
    @discardableResult
    func pruneExpired(retentionDays: Int, protected: Set<String>, now: Date = Date()) throws -> [String] {
        guard retentionDays > 0 else { return [] }
        let cutoff = now.addingTimeInterval(-Double(retentionDays) * 86_400).timeIntervalSince1970
        var candidates: [String] = []
        try run("SELECT session_id FROM sessions WHERE pinned = 0 AND expired = 0 AND last_activity < ?",
                [.real(cutoff)]) { stmt in
            if let id = Self.text(stmt, 0) { candidates.append(id) }
        }
        let expired = candidates.filter { !protected.contains($0) }
        guard !expired.isEmpty else { return [] }
        try transaction {
            for id in expired {
                try run("DELETE FROM roots WHERE session_id = ?", [.text(id)])
                try run("UPDATE sessions SET expired = 1 WHERE session_id = ?", [.text(id)])
            }
        }
        try sweepOrphanBlobs()
        return expired
    }

    // MARK: Blobs

    func blobURL(_ hash: String) -> URL {
        let prefix = String(hash.prefix(2))
        return blobsDirectory.appendingPathComponent(prefix, isDirectory: true).appendingPathComponent(hash + ".lzfse")
    }

    func hasBlob(_ hash: String) throws -> Bool {
        var found = false
        try run("SELECT 1 FROM blobs WHERE hash = ?", [.text(hash)]) { _ in found = true }
        return found && FileManager.default.fileExists(atPath: blobURL(hash).path)
    }

    /// Total compressed bytes retained (pinned sessions included).
    func storedBytes() throws -> Int64 {
        if let cachedStoredBytes { return cachedStoredBytes }
        var total: Int64 = 0
        try run("SELECT COALESCE(SUM(stored_size), 0) FROM blobs") { stmt in total = sqlite3_column_int64(stmt, 0) }
        cachedStoredBytes = total
        return total
    }

    /// Writes compressed content and registers it. Returns stored size, or
    /// nil if the blob already existed (dedup across all sessions).
    @discardableResult
    func putBlob(hash: String, content: Data, budgetBytes: Int64) throws -> Int64? {
        if try hasBlob(hash) { return nil }
        let compressed: Data
        if content.isEmpty {
            compressed = Data()
        } else {
            do {
                compressed = try (content as NSData).compressed(using: .lzfse) as Data
            } catch {
                throw SessionChangesStoreError.io("compression failed: \(error.localizedDescription)")
            }
        }
        let size = Int64(compressed.count)
        let previousStoredBytes = try storedBytes()
        if previousStoredBytes + size > budgetBytes {
            throw BudgetExceeded()
        }
        let url = blobURL(hash)
        let fm = FileManager.default
        if let values = try? rootDirectory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let available = values.volumeAvailableCapacityForImportantUsage, available < size + (256 << 20) {
            throw SessionChangesStoreError.io("Low disk space: capture paused to preserve 256 MB of free space.")
        }
        do {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            let temp = url.deletingLastPathComponent().appendingPathComponent(".tmp-\(UUID().uuidString)")
            defer { try? fm.removeItem(at: temp) }
            guard fm.createFile(atPath: temp.path, contents: compressed, attributes: [.posixPermissions: 0o600]) else {
                throw SessionChangesStoreError.io("could not write blob")
            }
            if fm.fileExists(atPath: url.path) { try? fm.removeItem(at: url) }
            try fm.moveItem(at: temp, to: url)
        } catch let error as SessionChangesStoreError {
            throw error
        } catch {
            throw SessionChangesStoreError.io(error.localizedDescription)
        }
        try run("INSERT OR REPLACE INTO blobs(hash, stored_size, raw_size, created_at) VALUES(?, ?, ?, ?)",
                [.text(hash), .int(size), .int(Int64(content.count)), .real(Date().timeIntervalSince1970)])
        cachedStoredBytes = previousStoredBytes + size
        return size
    }

    struct BudgetExceeded: Error {}

    func readBlob(_ hash: String) throws -> Data {
        let url = blobURL(hash)
        guard let data = FileManager.default.contents(atPath: url.path) else {
            throw SessionChangesStoreError.io("snapshot content is missing from storage")
        }
        if data.isEmpty { return Data() }
        do {
            let raw = try (data as NSData).decompressed(using: .lzfse) as Data
            guard SessionHashing.sha256Hex(raw) == hash else {
                throw SessionChangesStoreError.io("snapshot content failed integrity check")
            }
            return raw
        } catch let error as SessionChangesStoreError {
            throw error
        } catch {
            throw SessionChangesStoreError.io("snapshot content could not be decompressed")
        }
    }

    /// Removes blob rows with no file reference and blob files with no row
    /// (left behind by a failed transaction or crash). Safe to run anytime
    /// on the store queue because inserts happen on the same queue.
    func sweepOrphanBlobs() throws {
        cachedStoredBytes = nil
        var orphans: [String] = []
        try run("SELECT hash FROM blobs WHERE hash NOT IN (SELECT hash FROM files WHERE hash IS NOT NULL)") { stmt in
            if let hash = Self.text(stmt, 0) { orphans.append(hash) }
        }
        for hash in orphans {
            try run("DELETE FROM blobs WHERE hash = ?", [.text(hash)])
            try? FileManager.default.removeItem(at: blobURL(hash))
        }
        var known = Set<String>()
        try run("SELECT hash FROM blobs") { stmt in if let hash = Self.text(stmt, 0) { known.insert(hash) } }
        let fm = FileManager.default
        guard let prefixes = try? fm.contentsOfDirectory(atPath: blobsDirectory.path) else { return }
        for prefix in prefixes {
            let dir = blobsDirectory.appendingPathComponent(prefix)
            guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { continue }
            for name in names {
                let hash = name.replacingOccurrences(of: ".lzfse", with: "")
                if name.hasPrefix(".tmp-") || !known.contains(hash) {
                    try? fm.removeItem(at: dir.appendingPathComponent(name))
                }
            }
        }
    }
}

enum SessionHashing {
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
