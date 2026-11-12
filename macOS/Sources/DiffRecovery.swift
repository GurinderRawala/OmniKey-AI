import CryptoKit
import Darwin
import Foundation

// MARK: - Diff recovery (supports_diff_recovery)
//
// When the normal final turn capture produces no summary, the server may
// ask this client to replay evidence it recorded around each shell tool
// call of the *current* outer run. Evidence is produced only here, from
// bounded read-only Git invocations and explicit literal file paths; the
// model only ever selects opaque evidence IDs and never supplies a path,
// patch, object name or command that this client would act on.
//
// Supported literal shapes (anything else is simply not observed):
// - Git roots: the structured `git_diff_context.candidate_paths`, the
//   structured working directory, literal `cd`/`pushd` targets, `git -C
//   DIR`, `git worktree add|remove|move DIR`, and absolute literal words
//   naming an existing directory. `NAME=/literal` assignments (and
//   `export NAME=…`) are expanded in later `$NAME`/`${NAME}` words of the
//   same script. Nothing is evaluated or executed for discovery.
// - New worktrees: `git worktree list --porcelain` for already-known
//   repositories only (never a machine-wide scan), before and after a shell.
// - Non-Git files: explicitly quoted absolute paths that are the target of
//   `>`/`>>`, `tee`, `touch`, `rm`, `cp`/`mv`/`install` (last operand),
//   `sed -i`/`perl -i`, or a Python `Path('…')`/`open('…')` literal.
//   Regular, non-executable, non-symlink files ≤256 KiB (or a verified
//   absence) only. Directories, `/`, the home directory itself, files
//   directly in home, system locations and sensitive paths are rejected.

/// Literal reading of one script for recovery candidates.
enum DiffRecoveryScriptAnalyzer {
    struct Intent: Equatable, Sendable {
        var directories: [String] = []
        var files: [String] = []
        var mentionsWorktree = false
    }

    static let maxDirectories = 16
    static let maxFiles = 16

    static func analyze(_ script: String, initialDirectory: String?, homeDirectory: String) -> Intent {
        var intent = Intent()
        intent.mentionsWorktree = script.contains("worktree")
        let quoted = quotedAbsoluteLiterals(script)
        for path in pythonPathLiterals(script) { appendFile(path, &intent) }
        guard let commands = GitShellCommandAnalyzer.splitCommands(script) else { return intent }

        var variables: [String: String] = ["HOME": homeDirectory]
        if let tmp = ProcessInfo.processInfo.environment["TMPDIR"], tmp.hasPrefix("/"), GitShellCommandAnalyzer.isLiteral(tmp) {
            variables["TMPDIR"] = tmp
        }
        var cwd = initialDirectory

        func expand(_ word: String) -> String? {
            var result = ""
            let chars = Array(word)
            var i = 0
            while i < chars.count {
                guard chars[i] == "$" else { result.append(chars[i]); i += 1; continue }
                var j = i + 1
                let braced = j < chars.count && chars[j] == "{"
                if braced { j += 1 }
                var name = ""
                while j < chars.count, chars[j].isASCII, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" {
                    name.append(chars[j]); j += 1
                }
                if braced {
                    guard j < chars.count, chars[j] == "}" else { return nil }
                    j += 1
                }
                guard !name.isEmpty, let value = variables[name] else { return nil }
                result += value
                i = j
            }
            return GitShellCommandAnalyzer.isLiteral(result) ? result : nil
        }
        func resolve(_ word: String) -> String? {
            guard let literal = expand(word) else { return nil }
            return GitShellCommandAnalyzer.resolve(literal, from: cwd, home: homeDirectory)
        }
        func addDirectory(_ path: String?) {
            guard let path, intent.directories.count < maxDirectories, !intent.directories.contains(path) else { return }
            intent.directories.append(path)
        }
        func record(assignment word: String) -> Bool {
            guard let eq = word.firstIndex(of: "="), eq != word.startIndex else { return false }
            let name = String(word[..<eq])
            guard name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }),
                  !(name.first?.isNumber ?? true) else { return false }
            let raw = String(word[word.index(after: eq)...])
            if let value = expand(raw), value.hasPrefix("/") || value.hasPrefix("~") {
                variables[name] = GitShellCommandAnalyzer.resolve(value, from: cwd, home: homeDirectory) ?? value
            } else {
                variables.removeValue(forKey: name)
            }
            return true
        }

        for original in commands {
            var words = original
            while let first = words.first, record(assignment: first) { words.removeFirst() }
            guard let command = words.first else { continue }
            let name = (command as NSString).lastPathComponent
            let args = Array(words.dropFirst())
            if name == "export" || name == "declare" || name == "local" || name == "readonly" {
                for arg in args where !arg.hasPrefix("-") { _ = record(assignment: arg) }
                continue
            }
            if name == "cd" || name == "pushd" {
                let target = args.first(where: { !$0.hasPrefix("-") }) ?? "~"
                cwd = resolve(target)
                addDirectory(cwd)
                continue
            }
            if name == "popd" { cwd = nil; continue }
            if name == "git" {
                var index = 0
                var directory = cwd
                while index < args.count {
                    let arg = args[index]
                    if arg == "-C", index + 1 < args.count {
                        directory = resolve(args[index + 1]).map { $0 } ?? directory
                        addDirectory(resolve(args[index + 1]))
                        index += 2
                    } else if arg == "-c", index + 1 < args.count {
                        index += 2
                    } else if arg.hasPrefix("-") {
                        index += 1
                    } else {
                        break
                    }
                }
                if index < args.count, args[index] == "worktree" {
                    intent.mentionsWorktree = true
                    let rest = args[(index + 1)...].dropFirst().filter { !$0.hasPrefix("-") }
                    let base = cwd
                    cwd = directory
                    for operand in rest { addDirectory(resolve(operand)) }
                    cwd = base
                }
                continue
            }
            // Absolute literal directory operands (verified against Git later).
            for arg in args {
                guard let path = resolve(arg), path.hasPrefix("/") else { continue }
                var isDirectory: ObjCBool = false
                if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue {
                    addDirectory(path)
                }
            }
            // File write targets: only literally quoted absolute paths.
            for target in writeTargets(name: name, args: args, words: original) where quoted.contains(target) {
                appendFile(target, &intent)
            }
        }
        return intent
    }

    private static func appendFile(_ path: String, _ intent: inout Intent) {
        let standardized = URL(fileURLWithPath: path).standardizedFileURL.path
        guard intent.files.count < maxFiles, !intent.files.contains(standardized) else { return }
        intent.files.append(standardized)
    }

    private static func writeTargets(name: String, args: [String], words: [String]) -> [String] {
        var targets: [String] = []
        // Redirections anywhere in the simple command.
        for (index, word) in words.enumerated() {
            if [">", ">>", "1>", "1>>", ">|"].contains(word), index + 1 < words.count {
                targets.append(words[index + 1])
            } else if word.hasPrefix(">>") {
                targets.append(String(word.dropFirst(2)))
            } else if word.hasPrefix(">") && word.count > 1 {
                targets.append(String(word.dropFirst()))
            }
        }
        let operands = args.filter { !$0.hasPrefix("-") && !$0.hasPrefix(">") }
        switch name {
        case "tee", "touch", "rm", "truncate":
            targets += operands
        case "cp", "mv", "install":
            if let last = operands.last, operands.count >= 2 { targets.append(last) }
        case "sed", "perl":
            if args.contains(where: { $0 == "-i" || $0.hasPrefix("-i") || $0 == "-pi" }) {
                targets += operands.filter { $0.hasPrefix("/") }
            }
        default:
            break
        }
        return targets.filter { $0.hasPrefix("/") }
    }

    /// `'/abs'` and `"/abs"` literals (no expansion characters) in the raw text.
    static func quotedAbsoluteLiterals(_ script: String) -> Set<String> {
        var result = Set<String>()
        let pattern = #"'(/[^'\n\\$`]*)'|"(/[^"\n\\$`]*)""#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return result }
        let range = NSRange(script.startIndex..., in: script)
        for match in regex.matches(in: script, range: range) {
            for group in 1...2 {
                if let r = Range(match.range(at: group), in: script) { result.insert(String(script[r])) }
            }
        }
        return result
    }

    /// Python `Path('/abs')` / `open('/abs'…)` literals (bounded path intent).
    static func pythonPathLiterals(_ script: String) -> [String] {
        let pattern = #"(?:\bPath|\bopen)\(\s*(?:r?)(['"])(/[^'"\n\\$`{}]+)\1"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(script.startIndex..., in: script)
        return regex.matches(in: script, range: range).compactMap { match in
            Range(match.range(at: 2), in: script).map { String(script[$0]) }
        }
    }
}

// MARK: - Patch helpers

enum DiffRecoveryPatch {
    /// Splits a Git patch into per-file sections keyed by their
    /// `diff --git` header line.
    static func sections(_ patch: String) -> [String: String] {
        var result: [String: String] = [:]
        var currentKey: String?
        var current = ""
        func flush() {
            if let key = currentKey { result[key, default: ""] += current }
            current = ""
        }
        var lines = patch.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        for line in lines {
            if line.hasPrefix("diff --git ") {
                flush()
                currentKey = line
            }
            if currentKey != nil { current += line + "\n" }
        }
        flush()
        return result
    }

    static func join(_ sections: [String: String]) -> String {
        sections.keys.sorted().map { sections[$0]! }.joined()
    }

    /// Repository-relative path named by a section header (the `b/` side),
    /// or nil when it is not a safe relative path.
    static func path(fromHeader header: String) -> String? {
        let body = header.dropFirst("diff --git ".count)
        var candidate: String
        if body.hasSuffix("\""), let open = body.range(of: " \"b/", options: .backwards) {
            candidate = String(body[open.upperBound...].dropLast())
        } else if let open = body.range(of: " b/", options: .backwards) {
            candidate = String(body[open.upperBound...])
        } else {
            return nil
        }
        candidate = candidate.trimmingCharacters(in: .whitespaces)
        let components = candidate.split(separator: "/", omittingEmptySubsequences: false)
        guard !candidate.isEmpty, !candidate.hasPrefix("/"), !candidate.contains("\0"),
              !components.contains(where: { $0.isEmpty || $0 == ".." || $0 == "." })
        else { return nil }
        return candidate
    }

    /// Include both sides of renames. Unsupported quoted names fail closed.
    static func paths(fromHeader header: String) -> [String]? {
        guard header.hasPrefix("diff --git a/"), !header.contains("\\"), !header.contains("\"") else { return nil }
        let body = String(header.dropFirst("diff --git a/".count))
        guard let divider = body.range(of: " b/") else { return nil }
        let paths = [String(body[..<divider.lowerBound]), String(body[divider.upperBound...])]
        guard paths.allSatisfy({ path in
            !path.isEmpty && !path.hasPrefix("/") && !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
            && !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
        }) else { return nil }
        return Array(Set(paths)).sorted()
    }

    // MARK: Native unified diff for non-Git files

    static func isText(_ data: Data) -> Bool {
        !data.contains(0) && String(data: data, encoding: .utf8) != nil
    }

    /// Deterministic unified diff of two verified images of one file
    /// (`nil` = verified absence). Binary content yields a summary only.
    static func unifiedDiff(name: String, old: Data?, new: Data?, context: Int = 3) -> String {
        var header = "diff --git a/\(name) b/\(name)\n"
        if old == nil { header += "new file mode 100644\n" }
        if new == nil { header += "deleted file mode 100644\n" }
        let oldLabel = old == nil ? "/dev/null" : "a/\(name)"
        let newLabel = new == nil ? "/dev/null" : "b/\(name)"
        if let old, !isText(old) { return header + "Binary files \(oldLabel) and \(newLabel) differ\n" }
        if let new, !isText(new) { return header + "Binary files \(oldLabel) and \(newLabel) differ\n" }
        let a = lines(old)
        let b = lines(new)
        let ops = editScript(a, b)
        guard ops.contains(where: { $0.kind != " " }) else { return "" }
        var out = header + "--- \(oldLabel)\n+++ \(newLabel)\n"

        // Group changes into hunks with `context` lines around them.
        let changeIndices = ops.indices.filter { ops[$0].kind != " " }
        var hunks: [(Int, Int)] = []
        for index in changeIndices {
            let start = max(0, index - context)
            let end = min(ops.count - 1, index + context)
            if let last = hunks.last, start <= last.1 + 1 {
                hunks[hunks.count - 1].1 = max(last.1, end)
            } else {
                hunks.append((start, end))
            }
        }
        // Prefix row counts avoid rescanning all previous lines per hunk.
        var oldRows = [Int](repeating: 0, count: ops.count + 1)
        var newRows = [Int](repeating: 0, count: ops.count + 1)
        for i in ops.indices {
            oldRows[i + 1] = oldRows[i] + (ops[i].kind == "+" ? 0 : 1)
            newRows[i + 1] = newRows[i] + (ops[i].kind == "-" ? 0 : 1)
        }
        for (start, end) in hunks {
            let slice = ops[start...end]
            let oldCount = slice.filter { $0.kind != "+" }.count
            let newCount = slice.filter { $0.kind != "-" }.count
            let oldStart = oldRows[start] + (oldCount > 0 ? 1 : 0)
            let newStart = newRows[start] + (newCount > 0 ? 1 : 0)
            out += "@@ -\(range(oldStart, oldCount)) +\(range(newStart, newCount)) @@\n"
            for op in slice {
                out += String(op.kind) + op.text
                if !op.text.hasSuffix("\n") { out += "\n\\ No newline at end of file\n" }
            }
        }
        return out
    }

    private static func range(_ start: Int, _ count: Int) -> String {
        count == 1 ? "\(start)" : "\(start),\(count)"
    }

    /// Lines including their terminator, so a missing final newline differs.
    private static func lines(_ data: Data?) -> [String] {
        guard let data, let text = String(data: data, encoding: .utf8), !text.isEmpty else { return [] }
        var result: [String] = []
        var current = ""
        for ch in text {
            current.append(ch)
            if ch == "\n" { result.append(current); current = "" }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    private struct Op { let kind: Character; let text: String }

    /// LCS over the region between the common prefix and suffix; a region
    /// too large for the bounded table is shown as a full replacement.
    private static func editScript(_ a: [String], _ b: [String]) -> [Op] {
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix,
              a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        let midA = Array(a[prefix..<(a.count - suffix)])
        let midB = Array(b[prefix..<(b.count - suffix)])
        var ops = a[..<prefix].map { Op(kind: " ", text: $0) }
        let n = midA.count, m = midB.count
        if n > 0, m > 0, n * m <= 4_000_000 {
            var table = [Int32](repeating: 0, count: (n + 1) * (m + 1))
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    table[i * (m + 1) + j] = midA[i] == midB[j]
                        ? table[(i + 1) * (m + 1) + j + 1] + 1
                        : max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1])
                }
            }
            var i = 0, j = 0
            while i < n || j < m {
                if i < n, j < m, midA[i] == midB[j] {
                    ops.append(Op(kind: " ", text: midA[i])); i += 1; j += 1
                } else if j < m, i == n || table[i * (m + 1) + j + 1] >= table[(i + 1) * (m + 1) + j] {
                    ops.append(Op(kind: "+", text: midB[j])); j += 1
                } else {
                    ops.append(Op(kind: "-", text: midA[i])); i += 1
                }
            }
            // Conventional order: deletions before insertions within a run.
            ops = normalize(ops)
        } else {
            ops += midA.map { Op(kind: "-", text: $0) }
            ops += midB.map { Op(kind: "+", text: $0) }
        }
        ops += a[(a.count - suffix)...].map { Op(kind: " ", text: $0) }
        return ops
    }

    private static func normalize(_ ops: [Op]) -> [Op] {
        var result: [Op] = []
        var minus: [Op] = [], plus: [Op] = []
        for op in ops {
            switch op.kind {
            case "-": minus.append(op)
            case "+": plus.append(op)
            default:
                result += minus + plus; minus = []; plus = []
                result.append(op)
            }
        }
        return result + minus + plus
    }
}

// MARK: - Per-run store

/// Native recovery evidence for exactly one outer run (one
/// `startAgentWebSocketSession`). Patches stay on this Mac; only metadata
/// is emitted, and only patches of previously emitted IDs for the same
/// turn can be replayed.
final class DiffRecoveryStore: @unchecked Sendable {
    struct Limits: Sendable {
        var maxRecords = 32
        var maxRoots = 8
        var maxPathsPerRecord = 50
        var maxTotalPatchBytes = 2 * 1024 * 1024
        var maxFileBytes = 256 * 1024
        var maxFileReadBytesPerHook = 2 * 1024 * 1024
        var hookTimeout: TimeInterval = 2
        var maxRecoverIDs = 32
    }

    let runner: GitCommandRunner?
    let limits: Limits
    let homeDirectory: String

    init(runner: GitCommandRunner? = GitCommandRunner(), limits: Limits = Limits(), homeDirectory: String = NSHomeDirectory()) {
        self.runner = runner
        self.limits = limits
        self.homeDirectory = URL(fileURLWithPath: homeDirectory).resolvingSymlinksInPath().path
    }

    private struct RootState {
        let canonical: String
        let reported: String
        let baselineHead: String?
        let commonDir: String?
        /// False when first seen after earlier shells of this run could
        /// already have modified it (it cannot claim the turn start).
        let claimsStart: Bool
        var touched: Set<String> = []
        var lastSections: [String: String]?
        var recordID: String?
        var deleted = false
    }

    private struct FileState {
        let root: String
        let name: String
        let original: Data?
        var recordID: String?
    }

    private struct Stored {
        var record: DiffRecoveryRecord
        var patch: String
        var sequence: Int
    }

    fileprivate struct FileImage {
        let path: String
        let data: Data?
    }

    struct Checkpoint {
        fileprivate let generation: Int
        fileprivate let turnID: String
        fileprivate let toolCallID: String
        fileprivate let intent: DiffRecoveryScriptAnalyzer.Intent
        fileprivate let rootBefore: [String: [String: String]]
        fileprivate let staleRoots: Set<String>
        fileprivate let worktrees: [String: Set<String>]
        fileprivate let files: [FileImage]
    }

    private let lock = NSLock()
    private var generation = 0
    private var turnID: String?
    private var roots: [String: RootState] = [:]
    private var rootOrder: [String] = []
    private var files: [String: FileState] = [:]
    private var records: [String: Stored] = [:]
    private var emitted = Set<String>()
    private var retired = Set<String>()
    private var sequence = 0
    private var shellCount = 0

    // MARK: Hooks

    /// Runs before the shell. Never executes the script; bounded by
    /// `hookTimeout`. Nil when the request is not a recovery-capable shell.
    func before(script: String, context: GitDiffContext?, initialDirectory: String?) -> Checkpoint? {
        guard let context, let turn = context.turnID, let tool = context.toolCallID else { return nil }
        return lock.withLock {
            if turnID != turn {
                // A different outer run never sees this run's records.
                resetLocked()
                turnID = turn
            }
            let deadline = Date().addingTimeInterval(limits.hookTimeout)
            let intent = DiffRecoveryScriptAnalyzer.analyze(script, initialDirectory: initialDirectory, homeDirectory: homeDirectory)
            if let runner {
                let candidates = Array(context.candidatePaths.prefix(8)) + intent.directories
                for candidate in candidates where Date() < deadline {
                    registerLocked(candidate: candidate, runner: runner, deadline: deadline, claimsStart: shellCount == 0, newWorktree: false)
                }
            }
            var rootBefore: [String: [String: String]] = [:]
            var stale = Set<String>()
            for root in rootOrder {
                guard var state = roots[root], !state.deleted else { continue }
                if let runner, let captured = try? captureLocked(state, runner: runner, deadline: deadline) {
                    state.lastSections = captured.sections
                    rootBefore[root] = captured.sections
                } else {
                    stale.insert(root)
                    if let last = state.lastSections { rootBefore[root] = last }
                }
                roots[root] = state
            }
            var worktrees: [String: Set<String>] = [:]
            if let runner {
                for (commonDir, root) in commonDirectoriesLocked() {
                    if let list = try? worktreeList(root: root, runner: runner, deadline: deadline) { worktrees[commonDir] = list }
                }
            }
            var budget = limits.maxFileReadBytesPerHook
            var images: [FileImage] = []
            for path in intent.files {
                guard let safe = safeFilePathLocked(path) else { continue }
                if case let .image(data) = readFile(safe, budget: &budget) { images.append(FileImage(path: safe, data: data)) }
            }
            return Checkpoint(generation: generation, turnID: turn, toolCallID: tool, intent: intent,
                              rootBefore: rootBefore, staleRoots: stale, worktrees: worktrees, files: images)
        }
    }

    /// Runs after the shell exits. Returns the metadata of every record this
    /// shell created or updated, or nil when there is nothing to report.
    func after(_ checkpoint: Checkpoint) -> DiffRecoveryEvidence? {
        lock.withLock {
            guard checkpoint.generation == generation, turnID == checkpoint.turnID else { return nil }
            defer { shellCount += 1 }
            let deadline = Date().addingTimeInterval(limits.hookTimeout)
            var updated: [String] = []
            var omitted = 0
            var newRoots = Set<String>()

            if let runner {
                // New worktrees of already-known repositories only.
                for (commonDir, beforeList) in checkpoint.worktrees {
                    guard let anchor = rootOrder.first(where: { roots[$0]?.commonDir == commonDir && roots[$0]?.deleted == false }),
                          let afterList = try? worktreeList(root: anchor, runner: runner, deadline: deadline)
                    else { continue }
                    for path in afterList.subtracting(beforeList).sorted() where roots[path] == nil {
                        if let root = registerLocked(candidate: path, runner: runner, deadline: deadline, claimsStart: true, newWorktree: true) {
                            newRoots.insert(root)
                        }
                    }
                }
            }

            for root in rootOrder {
                guard var state = roots[root], !state.deleted else { continue }
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: root, isDirectory: &isDirectory), isDirectory.boolValue else {
                    // Deleted worktree: keep the last verified patch; this
                    // shell may have changed it before deleting, so the
                    // retained record is marked incomplete.
                    state.deleted = true
                    roots[root] = state
                    if let id = state.recordID, var stored = records[id] {
                        stored.record = rebuilt(stored.record, tool: checkpoint.toolCallID, after: nil, complete: false)
                        stored.sequence = nextSequence()
                        records[id] = stored
                        updated.append(id)
                    }
                    continue
                }
                guard let runner else { continue }
                let isNew = newRoots.contains(root)
                guard let before = isNew ? [:] : checkpoint.rootBefore[root] else { continue }
                guard let captured = try? captureLocked(state, runner: runner, deadline: deadline) else {
                    if let id = state.recordID, var stored = records[id], stored.record.complete {
                        stored.record = rebuilt(stored.record, tool: checkpoint.toolCallID, after: stored.record.after, complete: false)
                        records[id] = stored
                        updated.append(id)
                    }
                    continue
                }
                state.lastSections = captured.sections
                let keys = Set(before.keys).union(captured.sections.keys)
                let changed = keys.filter { before[$0] != captured.sections[$0] }
                guard !changed.isEmpty else { roots[root] = state; continue }
                state.touched.formUnion(changed)
                let kept = captured.sections.filter { state.touched.contains($0.key) }
                let patch = DiffRecoveryPatch.join(kept)
                if patch.isEmpty {
                    // Net change reverted to baseline: no record.
                    state.touched = []
                    if let id = state.recordID { retireLocked(id) }
                    state.recordID = nil
                    roots[root] = state
                    continue
                }
                var safeSections: [String: String] = [:]
                var selectedPaths = Set<String>()
                for header in kept.keys.sorted() {
                    guard let paths = DiffRecoveryPatch.paths(fromHeader: header),
                          selectedPaths.union(paths).count <= limits.maxPathsPerRecord else { continue }
                    selectedPaths.formUnion(paths)
                    safeSections[header] = kept[header]
                }
                let safePatch = DiffRecoveryPatch.join(safeSections)
                let complete = state.claimsStart && !checkpoint.staleRoots.contains(root) && captured.excluded == 0
                    && safeSections.count == kept.count
                let id = state.recordID ?? Self.makeID(prefix: "g")
                let record = DiffRecoveryRecord(
                    id: id, toolCallId: checkpoint.toolCallID, root: state.reported,
                    paths: selectedPaths.sorted(), kind: .git,
                    before: state.baselineHead, after: captured.head, complete: complete
                )
                guard !safePatch.isEmpty else { roots[root] = state; omitted += 1; continue }
                if storeLocked(id: id, record: record, patch: safePatch) {
                    state.recordID = id
                    updated.append(id)
                } else {
                    omitted += 1
                    if let existing = state.recordID, var stored = records[existing], stored.record.complete {
                        stored.record = rebuilt(stored.record, tool: checkpoint.toolCallID, after: stored.record.after, complete: false)
                        records[existing] = stored
                        updated.append(existing)
                    }
                }
                roots[root] = state
            }

            var budget = limits.maxFileReadBytesPerHook
            for image in checkpoint.files {
                // A path that became part of a known repository is covered there.
                guard !isInsideKnownRootLocked(image.path) else { continue }
                guard case let .image(now) = readFile(image.path, budget: &budget) else {
                    if let id = files[image.path]?.recordID, var stored = records[id], stored.record.complete {
                        stored.record = rebuilt(stored.record, tool: checkpoint.toolCallID, after: stored.record.after, complete: false)
                        records[id] = stored
                        updated.append(id)
                    } else {
                        omitted += 1
                    }
                    continue
                }
                guard now != image.data else { continue }
                let parent = (image.path as NSString).deletingLastPathComponent
                let name = (image.path as NSString).lastPathComponent
                var state = files[image.path] ?? FileState(root: parent, name: name, original: image.data)
                if now == state.original {
                    if let id = state.recordID { retireLocked(id) }
                    state.recordID = nil
                    files[image.path] = state
                    continue
                }
                let patch = DiffRecoveryPatch.unifiedDiff(name: name, old: state.original, new: now)
                let id = state.recordID ?? Self.makeID(prefix: "f")
                let record = DiffRecoveryRecord(
                    id: id, toolCallId: checkpoint.toolCallID, root: parent, paths: [name], kind: .file,
                    before: state.original.map(Self.hash), after: now.map(Self.hash), complete: true
                )
                if !patch.isEmpty, storeLocked(id: id, record: record, patch: patch) {
                    state.recordID = id
                    updated.append(id)
                } else {
                    omitted += 1
                }
                files[image.path] = state
            }

            var seen = Set<String>()
            let ids = updated.filter { seen.insert($0).inserted }
            let emittedRecords = ids.compactMap { records[$0]?.record }
            emitted.formUnion(emittedRecords.map(\.id))
            guard !emittedRecords.isEmpty || omitted > 0 else { return nil }
            return DiffRecoveryEvidence(turnID: checkpoint.turnID, records: emittedRecords, omitted: omitted > 0 ? omitted : nil)
        }
    }

    // MARK: Recover

    /// Replays stored patches for exactly the selected, previously emitted
    /// IDs of this turn. Executes nothing; reads no model-provided path.
    func recover(_ request: GitDiffRequestPayload) -> GitDiffResponsePayload {
        let requestID = request.requestID
        func unavailable(_ reason: String) -> GitDiffResponsePayload {
            GitDiffResponsePayload(requestID: requestID, status: .unavailable, reason: reason)
        }
        guard request.phase == .recover, !request.hasUnsupportedPhase, let selection = request.recovery else {
            return unavailable("Unsupported Git diff request.")
        }
        guard request.candidatePaths.isEmpty, (request.eligibleCommits ?? []).isEmpty, (request.baselines ?? []).isEmpty else {
            return unavailable("Recovery requests cannot name paths or commits.")
        }
        let ids = selection.evidenceIDs
        guard !ids.isEmpty, ids.count <= limits.maxRecoverIDs, Set(ids).count == ids.count else {
            return unavailable("Invalid recovery selection.")
        }
        return lock.withLock {
            guard let turnID, selection.turnID == turnID else { return unavailable("Recovery evidence belongs to a different turn.") }
            guard ids.allSatisfy(emitted.contains) else { return unavailable("Unknown recovery evidence.") }
            var omitted = 0
            var incomplete = false
            var order: [String] = []
            var byRoot: [String: [Stored]] = [:]
            for id in ids {
                guard let stored = records[id] else { omitted += 1; continue }
                if stored.record.kind == .file {
                    guard let relative = stored.record.paths.first else { omitted += 1; continue }
                    let path = (stored.record.root as NSString).appendingPathComponent(relative)
                    var budget = limits.maxFileBytes
                    guard case let .image(data) = readFile(path, budget: &budget),
                          data.map(Self.hash) == stored.record.after else { omitted += 1; continue }
                }
                if !stored.record.complete { incomplete = true }
                if byRoot[stored.record.root] == nil { order.append(stored.record.root) }
                byRoot[stored.record.root, default: []].append(stored)
            }
            var total = 0
            var repositories: [GitDiffRepositoryPatch] = []
            for root in order {
                // Combine without duplicate file sections; latest checkpoint wins.
                var sections: [String: String] = [:]
                for stored in byRoot[root]!.sorted(by: { $0.sequence < $1.sequence }) {
                    sections.merge(DiffRecoveryPatch.sections(stored.patch)) { _, latest in latest }
                }
                let patch = DiffRecoveryPatch.join(sections)
                total += patch.utf8.count
                guard total <= limits.maxTotalPatchBytes else { return unavailable("Changes exceed the snapshot size limit.") }
                if !patch.isEmpty { repositories.append(GitDiffRepositoryPatch(root: root, patch: patch, scope: .workingTree)) }
            }
            var notices: [String] = []
            if incomplete { notices.append("Some selected evidence is incomplete.") }
            if omitted > 0 { notices.append("\(omitted) selected \(omitted == 1 ? "record has" : "records have") no remaining changes.") }
            return GitDiffResponsePayload(
                requestID: requestID, status: .ok, repositories: repositories,
                reason: notices.isEmpty ? nil : notices.joined(separator: " "),
                recovery: GitDiffRecoveryResponse(turnID: turnID, evidenceIDs: ids, omitted: omitted)
            )
        }
    }

    // MARK: Internals (lock held)

    private func resetLocked() {
        generation += 1
        roots = [:]
        rootOrder = []
        files = [:]
        records = [:]
        emitted = []
        retired = []
        shellCount = 0
    }

    private func nextSequence() -> Int {
        sequence += 1
        return sequence
    }

    private func rebuilt(_ r: DiffRecoveryRecord, tool: String, after: String?, complete: Bool) -> DiffRecoveryRecord {
        DiffRecoveryRecord(id: r.id, toolCallId: tool, root: r.root, paths: r.paths, kind: r.kind,
                           before: r.before, after: after, complete: complete)
    }

    private func storeLocked(id: String, record: DiffRecoveryRecord, patch: String) -> Bool {
        let existing = records[id]?.patch.utf8.count ?? 0
        let total = records.values.reduce(0) { $0 + $1.patch.utf8.count } - existing + patch.utf8.count
        guard total <= limits.maxTotalPatchBytes else { return false }
        guard records[id] != nil || records.count < limits.maxRecords else { return false }
        records[id] = Stored(record: record, patch: patch, sequence: nextSequence())
        retired.remove(id)
        return true
    }

    private func retireLocked(_ id: String) {
        records.removeValue(forKey: id)
        retired.insert(id)
    }

    /// Registers the repository behind `candidate` once; returns the
    /// canonical root when a new one was recorded.
    @discardableResult
    private func registerLocked(candidate: String, runner: GitCommandRunner, deadline: Date, claimsStart: Bool, newWorktree: Bool) -> String? {
        guard roots.count < limits.maxRoots,
              let directory = GitSnapshotCollector.canonicalDirectory(candidate),
              let root = try? GitSnapshotCollector.repositoryRoot(of: directory, runner: runner, deadline: deadline),
              root != "/", root != homeDirectory, roots[root] == nil,
              let head = try? GitSnapshotCollector.headState(root: root, runner: runner, deadline: deadline)
        else { return nil }
        var claims = claimsStart
        if newWorktree {
            // A worktree created by this shell may also have committed in
            // the same shell. Its baseline is only trustworthy when HEAD
            // has not moved since creation: every (bounded) HEAD reflog
            // entry names the current HEAD.
            let current = GitSnapshotCollector.oid(head)
            claims = (try? headReflog(root: root, runner: runner, deadline: deadline))
                .map { entries in current != nil && !entries.isEmpty && entries.allSatisfy { $0 == current } } ?? false
        }
        let reported = GitSnapshotCollector.reportedRoot(root, candidates: [candidate])
        roots[root] = RootState(
            canonical: root, reported: reported, baselineHead: GitSnapshotCollector.oid(head),
            commonDir: try? commonDirectory(root: root, runner: runner, deadline: deadline),
            claimsStart: claims
        )
        rootOrder.append(root)
        return root
    }

    private func commonDirectoriesLocked() -> [(String, String)] {
        var seen = Set<String>()
        var result: [(String, String)] = []
        for root in rootOrder {
            guard let state = roots[root], !state.deleted, let common = state.commonDir, seen.insert(common).inserted else { continue }
            result.append((common, root))
        }
        return result
    }

    private func captureLocked(_ state: RootState, runner: GitCommandRunner, deadline: Date) throws -> (sections: [String: String], head: String?, excluded: Int) {
        let collector = GitSnapshotCollector(runner: runner)
        let current = try GitSnapshotCollector.headState(root: state.canonical, runner: runner, deadline: deadline)
        let base = try state.baselineHead ?? collector.emptyTreeOID(root: state.canonical, runner: runner, deadline: deadline)
        var budget = limits.maxTotalPatchBytes
        let patch = try collector.worktreePatch(base: base, root: state.canonical, runner: runner, budget: &budget, deadline: deadline)
        let after = try GitSnapshotCollector.headState(root: state.canonical, runner: runner, deadline: deadline)
        guard after == current else { throw GitSnapshotCollector.CollectionError.unavailable("HEAD moved during capture.") }
        return (DiffRecoveryPatch.sections(patch.text), GitSnapshotCollector.oid(current), patch.excluded)
    }

    private func commonDirectory(root: String, runner: GitCommandRunner, deadline: Date) throws -> String? {
        let result = try runner.run(["rev-parse", "--git-common-dir"], in: root, maxStdout: 8192, deadline: deadline)
        guard result.status == 0 else { return nil }
        let text = String(decoding: result.stdout, as: UTF8.self).trimmingCharacters(in: .newlines)
        guard !text.isEmpty else { return nil }
        let absolute = text.hasPrefix("/") ? text : (root as NSString).appendingPathComponent(text)
        return URL(fileURLWithPath: absolute).standardizedFileURL.resolvingSymlinksInPath().path
    }

    private func worktreeList(root: String, runner: GitCommandRunner, deadline: Date) throws -> Set<String> {
        var result = try runner.run(["worktree", "list", "--porcelain", "-z"], in: root, maxStdout: 256 * 1024, deadline: deadline)
        var separator: UInt8 = 0
        if result.status != 0 {
            // Older Git without `-z`: newline-separated porcelain.
            result = try runner.run(["worktree", "list", "--porcelain"], in: root, maxStdout: 256 * 1024, deadline: deadline)
            separator = UInt8(ascii: "\n")
        }
        guard result.status == 0 else { throw GitSnapshotCollector.CollectionError.unavailable("Could not list worktrees.") }
        var paths = Set<String>()
        for field in result.stdout.split(separator: separator) {
            let line = String(decoding: field, as: UTF8.self)
            guard line.hasPrefix("worktree /") else { continue }
            let path = String(line.dropFirst("worktree ".count))
            paths.insert(URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path)
            if paths.count >= 64 { break }
        }
        return paths
    }

    /// Up to 8 newest HEAD reflog object names; more means "moved".
    private func headReflog(root: String, runner: GitCommandRunner, deadline: Date) throws -> [String]? {
        let result = try runner.run(["reflog", "show", "-n", "9", "--format=%H", "HEAD", "--"], in: root, maxStdout: 4096, deadline: deadline)
        guard result.status == 0 else { return nil }
        let entries = String(decoding: result.stdout, as: UTF8.self).split(separator: "\n").map(String.init)
        return entries.count <= 8 ? entries : nil
    }

    private func isInsideKnownRootLocked(_ path: String) -> Bool {
        roots.keys.contains { path == $0 || path.hasPrefix($0 + "/") }
    }

    // MARK: Files

    private enum FileRead { case image(Data?), unsupported }

    private static let deniedPrefixes = [
        "/System", "/usr", "/bin", "/sbin", "/etc", "/dev", "/private/etc", "/Library", "/Applications", "/opt", "/cores",
    ]

    /// Canonical absolute file path that is safe to observe, or nil.
    private func safeFilePathLocked(_ raw: String) -> String? {
        guard raw.hasPrefix("/"), raw.utf8.count <= 1024,
              !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0 == "\"" || $0 == "\\" })
        else { return nil }
        let standardized = URL(fileURLWithPath: raw).standardizedFileURL.path
        let name = (standardized as NSString).lastPathComponent
        let literalParent = (standardized as NSString).deletingLastPathComponent
        // Foundation may preserve the /tmp spelling on macOS. Resolve to
        // the physical parent before our component-wise O_NOFOLLOW read.
        guard let resolvedParent = realpath(literalParent, nil) else { return nil }
        let parent = String(cString: resolvedParent)
        free(resolvedParent)
        var isDirectory: ObjCBool = false
        guard !name.isEmpty, name != ".", name != "..",
              FileManager.default.fileExists(atPath: parent, isDirectory: &isDirectory), isDirectory.boolValue,
              parent != "/", parent != homeDirectory
        else { return nil }
        let path = (parent as NSString).appendingPathComponent(name)
        guard path != homeDirectory,
              !Self.deniedPrefixes.contains(where: { path == $0 || path.hasPrefix($0 + "/") }),
              !path.hasPrefix(homeDirectory + "/Library/"),
              !GitSensitivePathPolicy.isSensitive(path)
        else { return nil }
        // Only the home directory, temporary locations and mounted volumes.
        let temporary = ["/private/tmp/", "/private/var/folders/", "/tmp/", "/Volumes/"]
        guard path.hasPrefix(homeDirectory + "/") || temporary.contains(where: path.hasPrefix) else { return nil }
        // Files inside a repository are covered by Git evidence.
        guard !isInsideKnownRootLocked(path) else { return nil }
        if let attributes = try? FileManager.default.attributesOfItem(atPath: path) {
            guard attributes[.type] as? FileAttributeType == .typeRegular else { return nil }
            // Executables are skipped: they are tools, not project edits.
            if let mode = attributes[.posixPermissions] as? Int, mode & 0o111 != 0 { return nil }
        }
        return path
    }

    /// Bounded read; never follows a symlink, never reads a directory.
    private func readFile(_ path: String, budget: inout Int) -> FileRead {
        // Walk canonical components with openat/O_NOFOLLOW so a parent or
        // final-component symlink swap cannot expose a different file. The
        // nonblocking flag prevents a concurrent FIFO substitution hanging.
        let parts = path.split(separator: "/").map(String.init)
        guard path.hasPrefix("/"), let name = parts.last else { return .unsupported }
        var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directory >= 0 else { return .unsupported }
        for part in parts.dropLast() {
            let next = Darwin.openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            Darwin.close(directory)
            guard next >= 0 else { return .unsupported }
            directory = next
        }
        defer { Darwin.close(directory) }
        let descriptor = Darwin.openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return errno == ENOENT ? .image(nil) : .unsupported }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
              before.st_size >= 0, before.st_size <= limits.maxFileBytes, before.st_size <= budget
        else { return .unsupported }
        var bytes = [UInt8](repeating: 0, count: Int(before.st_size) + 1)
        var count = 0
        while count < bytes.count {
            let n = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(descriptor, buffer.baseAddress!.advanced(by: count), buffer.count - count)
            }
            if n < 0 { return .unsupported }
            if n == 0 { break }
            count += n
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0, count == before.st_size,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec
        else { return .unsupported }
        budget -= count
        return .image(Data(bytes.prefix(count)))
    }

    // MARK: IDs and hashes

    static func makeID(prefix: String) -> String {
        "\(prefix)_" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    }

    static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Test support

    var emittedIDs: Set<String> { lock.withLock { emitted } }
}
