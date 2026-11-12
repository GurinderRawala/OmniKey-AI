import Foundation

// MARK: - Literal shell command analysis

/// Conservative, literal reading of a `<shell_script>` for Git provenance.
/// It never executes, expands or evaluates anything: a word containing
/// `$`, backticks, globs or process substitution is opaque, and any
/// construct it cannot read literally makes attribution impossible.
enum GitShellCommandAnalyzer {
    struct Analysis: Equatable, Sendable {
        /// Directories (absolute, unresolved) in which `git commit` ran.
        var commitDirectories: [String] = []
        /// Additional literal directories touched via `cd` / `git -C`.
        var observedDirectories: [String] = []
        /// True when the script also moves HEAD in other ways (checkout,
        /// reset, pull, …) or contains an unreadable git invocation.
        var hasDisqualifyingGitActivity = false

        var canAttribute: Bool { !commitDirectories.isEmpty && !hasDisqualifyingGitActivity }
    }

    /// Git subcommands that can move HEAD or create commits other than a
    /// plain `git commit`; their presence forbids attribution.
    static let headMovingSubcommands: Set<String> = [
        "checkout", "switch", "reset", "rebase", "merge", "pull", "cherry-pick", "revert", "am",
        "stash", "update-ref", "commit-tree", "replace", "filter-branch", "filter-repo", "worktree",
        "bisect", "symbolic-ref", "fetch", "clone", "init", "restore", "apply", "branch", "tag", "notes",
    ]

    static func analyze(_ script: String, initialDirectory: String?, homeDirectory: String = NSHomeDirectory()) -> Analysis {
        var analysis = Analysis()
        guard let commands = splitCommands(script) else {
            // Unbalanced quoting etc.: only disqualify if git is mentioned.
            if script.contains("git") { analysis.hasDisqualifyingGitActivity = true }
            return analysis
        }
        var cwd = initialDirectory
        for words in commands {
            var words = words
            // Git environment overrides can redirect repository identity.
            // Do not attribute a command whose effective Git target is opaque.
            while let first = words.first, isAssignment(first) {
                if first.hasPrefix("GIT_") { analysis.hasDisqualifyingGitActivity = true }
                words.removeFirst()
            }
            if words.first == "export", words.dropFirst().contains(where: { $0.hasPrefix("GIT_") }) {
                analysis.hasDisqualifyingGitActivity = true
            }
            guard let command = words.first else { continue }
            if command == "cd" || command == "pushd" {
                let target = words.dropFirst().first(where: { !$0.hasPrefix("-") || $0 == "-" })
                cwd = resolve(target ?? "~", from: cwd, home: homeDirectory)
                if let cwd { analysis.observedDirectories.append(cwd) }
                continue
            }
            if command == "popd" { cwd = nil; continue }
            let name = (command as NSString).lastPathComponent
            guard name == "git" else {
                if words.contains(where: { $0 == "git" || $0.hasSuffix("/git") }) {
                    // e.g. `xargs git …`, `sudo git …`, `env git …`.
                    analysis.hasDisqualifyingGitActivity = true
                }
                continue
            }
            guard command == "git" || command.hasPrefix("/") else {
                analysis.hasDisqualifyingGitActivity = true
                continue
            }
            guard let invocation = parseGit(Array(words.dropFirst()), cwd: cwd, home: homeDirectory) else {
                analysis.hasDisqualifyingGitActivity = true
                continue
            }
            if let dir = invocation.directory { analysis.observedDirectories.append(dir) }
            if invocation.subcommand == "commit" {
                guard let dir = invocation.directory else {
                    analysis.hasDisqualifyingGitActivity = true
                    continue
                }
                if invocation.arguments.contains(where: { $0 == "--amend" || $0.hasPrefix("--fixup") || $0.hasPrefix("--squash") }) {
                    analysis.hasDisqualifyingGitActivity = true
                    continue
                }
                analysis.commitDirectories.append(dir)
            } else if headMovingSubcommands.contains(invocation.subcommand) {
                analysis.hasDisqualifyingGitActivity = true
            }
        }
        return analysis
    }

    private struct GitInvocation {
        let subcommand: String
        let arguments: [String]
        let directory: String?
    }

    private static func parseGit(_ args: [String], cwd: String?, home: String) -> GitInvocation? {
        var directory = cwd
        var index = 0
        while index < args.count {
            let arg = args[index]
            if arg == "-C" {
                guard index + 1 < args.count else { return nil }
                directory = resolve(args[index + 1], from: directory, home: home)
                if directory == nil { return nil }
                index += 2
            } else if arg == "-c" || arg == "--git-dir" || arg == "--work-tree" || arg == "--namespace" {
                // A different git/work dir cannot be attributed safely.
                if arg != "-c" { return nil }
                guard index + 1 < args.count else { return nil }
                let configuration = args[index + 1].lowercased()
                if configuration.hasPrefix("core.worktree=") || configuration.hasPrefix("include.")
                    || configuration.hasPrefix("includeif.") || configuration.hasPrefix("alias.") { return nil }
                index += 2
            } else if arg.hasPrefix("--git-dir=") || arg.hasPrefix("--work-tree=") {
                return nil
            } else if arg.hasPrefix("-") {
                index += 1
            } else {
                return GitInvocation(subcommand: arg, arguments: Array(args[(index + 1)...]), directory: directory)
            }
        }
        return nil
    }

    private static func isAssignment(_ word: String) -> Bool {
        guard let eq = word.firstIndex(of: "="), eq != word.startIndex else { return false }
        return word[..<eq].allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }
    }

    /// Literal path resolution only (`~` and relative-to-known-cwd).
    static func resolve(_ raw: String, from cwd: String?, home: String) -> String? {
        guard !raw.isEmpty, raw != "-", isLiteral(raw) else { return nil }
        var path = raw
        if path == "~" { path = home } else if path.hasPrefix("~/") { path = home + path.dropFirst(1) }
        if !path.hasPrefix("/") {
            guard let cwd else { return nil }
            path = (cwd as NSString).appendingPathComponent(path)
        }
        return URL(fileURLWithPath: path).standardizedFileURL.path
    }

    static func isLiteral(_ word: String) -> Bool {
        !word.contains(where: { "$`*?[]{}<>()!\u{0}".contains($0) })
    }

    /// Splits into simple commands on newlines, `;`, `&&`, `||`, `|`, `&`,
    /// honouring single/double quotes and backslash escapes. Words with
    /// expansions stay marked by keeping their `$`/backtick characters, so
    /// `isLiteral` rejects them. Returns nil for unbalanced quotes or
    /// heredocs (whose bodies cannot be read safely).
    static func splitCommands(_ script: String) -> [[String]]? {
        var commands: [[String]] = []
        var words: [String] = []
        var word = ""
        var inWord = false
        var quote: Character? = nil
        var chars = Array(script)
        var i = 0

        func endWord() {
            if inWord { words.append(word) }
            word = ""
            inWord = false
        }
        func endCommand() {
            endWord()
            if !words.isEmpty { commands.append(words) }
            words = []
        }

        while i < chars.count {
            let c = chars[i]
            if let q = quote {
                if c == q {
                    quote = nil
                } else if q == "\"" && c == "\\" && i + 1 < chars.count {
                    i += 1
                    word.append(chars[i])
                } else {
                    word.append(c)
                }
                i += 1
                continue
            }
            switch c {
            case "'", "\"":
                quote = c
                inWord = true
            case "\\":
                if i + 1 < chars.count {
                    if chars[i + 1] == "\n" { i += 1 } else { i += 1; word.append(chars[i]); inWord = true }
                }
            case "#" where !inWord:
                while i < chars.count && chars[i] != "\n" { i += 1 }
                endCommand()
            case "\n", ";", "&", "|":
                endCommand()
            case "<" where i + 1 < chars.count && chars[i + 1] == "<":
                return nil
            case " ", "\t", "\r":
                endWord()
            default:
                word.append(c)
                inWord = true
            }
            i += 1
        }
        guard quote == nil else { return nil }
        endCommand()
        chars.removeAll()
        return commands
    }
}

// MARK: - Per-shell HEAD observation

/// Records HEAD for literal repositories before a shell command and, after
/// it exits, reports a transition only when the command literally ran
/// `git commit` there, nothing else moved HEAD, the reflog's newest entry
/// is that commit, and the old HEAD is an ancestor of the new one. This is
/// observed execution evidence, not proof against concurrent external
/// writers; anything unverifiable is simply not attributed.
struct GitProvenanceTracker: Sendable {
    static let maxRepositories = 8

    struct Baseline: Sendable {
        fileprivate let entries: [(root: String, head: String?, reportedRoot: String)]
        var isEmpty: Bool { entries.isEmpty }
    }

    let runner: GitCommandRunner?
    var timeout: TimeInterval = 3
    var homeDirectory: String = NSHomeDirectory()

    init(runner: GitCommandRunner? = GitCommandRunner()) {
        self.runner = runner
    }

    /// The shell runs from this process's working directory.
    static var shellWorkingDirectory: String { FileManager.default.currentDirectoryPath }

    /// Captured immediately before launching the script. Empty (and free)
    /// unless the script literally commits in a resolvable repository.
    func baseline(
        script: String,
        context: GitDiffContext?,
        initialDirectory: String? = GitProvenanceTracker.shellWorkingDirectory
    ) -> Baseline {
        guard let runner else { return Baseline(entries: []) }
        let analysis = GitShellCommandAnalyzer.analyze(script, initialDirectory: initialDirectory, homeDirectory: homeDirectory)
        guard analysis.canAttribute else { return Baseline(entries: []) }
        let deadline = Date().addingTimeInterval(timeout)
        let home = URL(fileURLWithPath: homeDirectory).resolvingSymlinksInPath().path
        var entries: [(String, String?, String)] = []
        var seen = Set<String>()
        // Only literal commit target directories can yield attribution.
        // Structured context paths are never used to guess where an
        // unqualified `git commit` ran.
        _ = context
        for directory in analysis.commitDirectories {
            guard entries.count < Self.maxRepositories,
                  let canonical = GitSnapshotCollector.canonicalDirectory(directory),
                  let root = try? GitSnapshotCollector.repositoryRoot(of: canonical, runner: runner, deadline: deadline),
                  root != "/", root != home,
                  seen.insert(root).inserted
            else { continue }
            do {
                let head = try GitSnapshotCollector.headOID(root: root, runner: runner, deadline: deadline)
                entries.append((root, head, GitSnapshotCollector.reportedRoot(root, candidates: [directory])))
            } catch {
                continue
            }
        }
        return Baseline(entries: entries)
    }

    /// Called after the script exits (successfully or not).
    func observations(after baseline: Baseline) -> [GitCommitObservation] {
        guard let runner, !baseline.isEmpty else { return [] }
        let deadline = Date().addingTimeInterval(timeout)
        var result: [GitCommitObservation] = []
        for (root, before, reportedRoot) in baseline.entries {
            guard let after = try? GitSnapshotCollector.headOID(root: root, runner: runner, deadline: deadline),
                  after != before,
                  reflogShowsCommit(root: root, oid: after, runner: runner, deadline: deadline)
            else { continue }
            if let before {
                guard let ancestry = try? runner.run(
                    ["merge-base", "--is-ancestor", before, after], in: root, maxStdout: 1024, deadline: deadline
                ), ancestry.status == 0 else { continue }
            }
            result.append(GitCommitObservation(root: reportedRoot, before: before, after: after))
        }
        return result
    }

    private func reflogShowsCommit(root: String, oid: String, runner: GitCommandRunner, deadline: Date) -> Bool {
        guard let log = try? runner.run(
            ["reflog", "show", "-n", "1", "--format=%H%x00%gs", "HEAD", "--"],
            in: root, maxStdout: 8192, deadline: deadline
        ), log.status == 0 else { return false }
        let fields = String(decoding: log.stdout, as: UTF8.self)
            .trimmingCharacters(in: .newlines)
            .split(separator: "\0", maxSplits: 1, omittingEmptySubsequences: false)
        guard fields.count == 2, fields[0] == oid else { return false }
        let subject = fields[1]
        return subject.hasPrefix("commit: ") || subject.hasPrefix("commit (initial): ")
    }
}
