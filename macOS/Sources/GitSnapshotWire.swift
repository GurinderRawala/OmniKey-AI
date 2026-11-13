import Foundation

// MARK: - Git diff wire contract (v2 + v3 turn mode)
//
// v3 (`supports_git_turn_diff`): the server first sends a `phase:"baseline"`
// request (before the first model/tool step, and before forwarding a shell
// for a newly discovered directory); the client answers with the HEAD of
// each resolved repository. The `phase:"final"` request echoes the recorded
// baselines and the client diffs baseline HEAD -> current working tree. A
// request without `phase` is the unchanged legacy v2 collection.
//
// Server → client control frame sent on the authenticated turn socket before
// the final answer: `git_diff_request`. The client replies with a dedicated
// `git_diff_response` frame. Neither is a model, tool or transcript message.
// Shell requests may carry `git_diff_context`; terminal replies may carry
// `git_commit_observations` (commits observed to be created by that shell).

enum GitSnapshotScope: String, Codable, Equatable, Sendable {
    case workingTree = "working_tree"
    case commit
    /// Net changes from the turn baseline HEAD to the current working tree.
    case turn
}

enum GitDiffPhase: String, Codable, Equatable, Sendable {
    case baseline
    case final
    /// Legacy checkpoint recovery (`supports_diff_recovery`, no longer
    /// advertised). Still decoded so a stale server gets a prompt
    /// `unsupported_recovery` reply instead of a timeout; never served.
    case recover
}

enum GitTurnBaselineSource: String, Codable, Equatable, Sendable {
    case turnStart = "turn_start"
    case beforeTool = "before_tool"
}

/// HEAD of one repository captured once per turn. `head` is nil for an
/// unborn branch and always encoded (explicit `null`).
struct GitTurnBaseline: Codable, Equatable, Sendable {
    let root: String
    let head: String?
    let capturedAt: String
    let source: GitTurnBaselineSource

    enum CodingKeys: String, CodingKey { case root, head, capturedAt, source }

    init(root: String, head: String?, capturedAt: String, source: GitTurnBaselineSource) {
        self.root = root
        self.head = head
        self.capturedAt = capturedAt
        self.source = source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        root = try c.decode(String.self, forKey: .root)
        head = try c.decodeIfPresent(String.self, forKey: .head)
        capturedAt = try c.decode(String.self, forKey: .capturedAt)
        source = try c.decode(GitTurnBaselineSource.self, forKey: .source)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(root, forKey: .root)
        if let head { try c.encode(head, forKey: .head) } else { try c.encodeNil(forKey: .head) }
        try c.encode(capturedAt, forKey: .capturedAt)
        try c.encode(source, forKey: .source)
    }

    /// Structural validity only; existence/ancestry is checked against Git.
    var isWellFormed: Bool {
        root.hasPrefix("/") && root.utf8.count <= 4096 && !root.contains("\0")
            && (head.map(GitOID.isValid) ?? true)
            && !capturedAt.isEmpty && capturedAt.utf8.count <= 64
    }

    static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

struct GitEligibleCommit: Codable, Equatable, Sendable {
    let root: String
    let commit: String
}

struct GitDiffRequestPayload: Codable, Equatable, Sendable {
    let requestID: String
    let candidatePaths: [String]
    let eligibleCommits: [GitEligibleCommit]?
    /// nil = legacy v2 collection.
    let phase: GitDiffPhase?
    /// True when `phase` was present but not a known value: fail closed.
    let hasUnsupportedPhase: Bool
    /// Final phase: the server-recorded baselines for this turn.
    let baselines: [GitTurnBaseline]?
    /// Baseline phase: the source the server expects echoed.
    let baselineSource: GitTurnBaselineSource?
    let displayLimit: Int?

    init(
        requestID: String,
        candidatePaths: [String],
        eligibleCommits: [GitEligibleCommit]? = nil,
        phase: GitDiffPhase? = nil,
        baselines: [GitTurnBaseline]? = nil,
        baselineSource: GitTurnBaselineSource? = nil,
        displayLimit: Int? = nil
    ) {
        self.requestID = requestID
        self.candidatePaths = candidatePaths
        self.eligibleCommits = eligibleCommits
        self.phase = phase
        self.hasUnsupportedPhase = false
        self.baselines = baselines
        self.baselineSource = baselineSource
        self.displayLimit = displayLimit
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case candidatePaths = "candidate_paths"
        case eligibleCommits = "eligible_commits"
        case phase
        case baselines
        case baselineSource = "baseline_source"
        case displayLimit = "display_limit"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestID = try c.decode(String.self, forKey: .requestID)
        candidatePaths = try c.decode([String].self, forKey: .candidatePaths)
        eligibleCommits = try c.decodeIfPresent([GitEligibleCommit].self, forKey: .eligibleCommits)
        // The request id must survive so a malformed v3 request is still
        // answered (as unavailable) instead of silently timing out.
        let rawPhase = try? c.decodeIfPresent(String.self, forKey: .phase)
        let hasPhaseKey = c.contains(.phase) && (try? c.decodeNil(forKey: .phase)) != true
        phase = rawPhase.flatMap(GitDiffPhase.init(rawValue:))
        let badPhase = hasPhaseKey && phase == nil
        let decodedBaselines = try? c.decodeIfPresent([GitTurnBaseline].self, forKey: .baselines)
        let badBaselines = c.contains(.baselines) && (try? c.decodeNil(forKey: .baselines)) != true && decodedBaselines == nil
        baselines = decodedBaselines ?? nil
        let rawSource = try? c.decodeIfPresent(String.self, forKey: .baselineSource)
        baselineSource = rawSource.flatMap(GitTurnBaselineSource.init(rawValue:))
        let badSource = rawSource != nil && baselineSource == nil
        displayLimit = (try? c.decodeIfPresent(Int.self, forKey: .displayLimit)) ?? nil
        hasUnsupportedPhase = badPhase || badBaselines || badSource
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requestID, forKey: .requestID)
        try c.encode(candidatePaths, forKey: .candidatePaths)
        try c.encodeIfPresent(eligibleCommits, forKey: .eligibleCommits)
        try c.encodeIfPresent(phase, forKey: .phase)
        try c.encodeIfPresent(baselines, forKey: .baselines)
        try c.encodeIfPresent(baselineSource, forKey: .baselineSource)
        try c.encodeIfPresent(displayLimit, forKey: .displayLimit)
    }
}

enum GitDiffResponseStatus: String, Codable, Equatable, Sendable {
    case ok
    case notRepository = "not_repository"
    case unavailable
}

struct GitDiffRepositoryPatch: Codable, Equatable, Sendable {
    let root: String
    let patch: String
    let scope: GitSnapshotScope
    let commit: String?
    /// Turn scope only (always encoded, `null` for an unborn baseline/HEAD).
    let baselineHead: String?
    let head: String?
    let baselineCapturedAt: String?
    let baselineSource: GitTurnBaselineSource?

    init(root: String, patch: String, scope: GitSnapshotScope = .workingTree, commit: String? = nil) {
        self.root = root
        self.patch = patch
        self.scope = scope
        self.commit = commit
        self.baselineHead = nil
        self.head = nil
        self.baselineCapturedAt = nil
        self.baselineSource = nil
    }

    init(root: String, patch: String, baseline: GitTurnBaseline, head: String?) {
        self.root = root
        self.patch = patch
        self.scope = .turn
        self.commit = nil
        self.baselineHead = baseline.head
        self.head = head
        self.baselineCapturedAt = baseline.capturedAt
        self.baselineSource = baseline.source
    }

    enum CodingKeys: String, CodingKey {
        case root, patch, scope, commit, baselineHead, head, baselineCapturedAt, baselineSource
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        root = try c.decode(String.self, forKey: .root)
        patch = try c.decode(String.self, forKey: .patch)
        scope = try c.decode(GitSnapshotScope.self, forKey: .scope)
        commit = try c.decodeIfPresent(String.self, forKey: .commit)
        baselineHead = try c.decodeIfPresent(String.self, forKey: .baselineHead)
        head = try c.decodeIfPresent(String.self, forKey: .head)
        baselineCapturedAt = try c.decodeIfPresent(String.self, forKey: .baselineCapturedAt)
        baselineSource = try c.decodeIfPresent(GitTurnBaselineSource.self, forKey: .baselineSource)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(root, forKey: .root)
        try c.encode(patch, forKey: .patch)
        try c.encode(scope, forKey: .scope)
        try c.encodeIfPresent(commit, forKey: .commit)
        guard scope == .turn else { return }
        if let baselineHead { try c.encode(baselineHead, forKey: .baselineHead) } else { try c.encodeNil(forKey: .baselineHead) }
        if let head { try c.encode(head, forKey: .head) } else { try c.encodeNil(forKey: .head) }
        try c.encodeIfPresent(baselineCapturedAt, forKey: .baselineCapturedAt)
        try c.encodeIfPresent(baselineSource, forKey: .baselineSource)
    }
}

struct GitDiffResponsePayload: Codable, Equatable, Sendable {
    let requestID: String
    let status: GitDiffResponseStatus
    let repositories: [GitDiffRepositoryPatch]
    /// Baseline phase only (always `[]` with a failure status).
    let baselines: [GitTurnBaseline]?
    let reason: String?

    init(
        requestID: String,
        status: GitDiffResponseStatus,
        repositories: [GitDiffRepositoryPatch] = [],
        baselines: [GitTurnBaseline]? = nil,
        reason: String? = nil
    ) {
        self.requestID = requestID
        self.status = status
        // Never report partial data with a failure status.
        self.repositories = status == .ok ? repositories : []
        self.baselines = baselines.map { status == .ok ? $0 : [] }
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case status
        case repositories
        case baselines
        case reason
    }
}

struct GitDiffContext: Codable, Equatable, Sendable {
    let candidatePaths: [String]

    init(candidatePaths: [String]) {
        self.candidatePaths = candidatePaths
    }

    enum CodingKeys: String, CodingKey {
        case candidatePaths = "candidate_paths"
    }
}

/// A HEAD transition observed around one shell command that literally
/// invoked `git commit` in `root`. `before` is nil for an unborn branch.
struct GitCommitObservation: Codable, Equatable, Sendable {
    let root: String
    let before: String?
    let after: String

    enum CodingKeys: String, CodingKey { case root, before, after }

    init(root: String, before: String?, after: String) {
        self.root = root
        self.before = before
        self.after = after
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        root = try c.decode(String.self, forKey: .root)
        before = try c.decodeIfPresent(String.self, forKey: .before)
        after = try c.decode(String.self, forKey: .after)
    }

    // `before` is always present on the wire, explicitly `null` when unborn.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(root, forKey: .root)
        if let before { try c.encode(before, forKey: .before) } else { try c.encodeNil(forKey: .before) }
        try c.encode(after, forKey: .after)
    }
}

// MARK: - Saved snapshot summary

enum SavedSessionDiffScope: String, Codable, Equatable, Sendable {
    case workingTree = "working_tree"
    case commit
    case mixed
    /// Committed + uncommitted net changes since the turn baseline.
    case turn
}

/// Immutable server-side snapshot bound to exactly one final answer.
struct SavedSessionDiff: Codable, Equatable, Hashable, Sendable {
    let id: String
    let fileCount: Int
    let repositoryCount: Int
    let createdAt: String
    let scope: SavedSessionDiffScope
    let commit: String?
    /// Server-rendered file panels are capped at this many files.
    let displayLimit: Int?
    /// Optional turn-scope hints: a baseline captured only before a later
    /// tool step (not at turn start), or a repository with no baseline at
    /// all (shown as uncommitted changes only).
    let baselineSource: GitTurnBaselineSource?
    let baselineUnavailable: Bool?
    /// Not a normal turn capture: legacy checkpoint recovery
    /// (`recoveryMethod == "checkpoint"`, historical data only) or an
    /// agent-authored patch (`"ai_reconstructed"`). `recoveryIncomplete`
    /// marks an honest partial result.
    let recovered: Bool?
    let recoveryIncomplete: Bool?
    /// An AI-generated patch is never a verified filesystem diff.
    let recoveryMethod: String?

    init(
        id: String,
        fileCount: Int,
        repositoryCount: Int,
        createdAt: String,
        scope: SavedSessionDiffScope = .workingTree,
        commit: String? = nil,
        displayLimit: Int? = nil,
        baselineSource: GitTurnBaselineSource? = nil,
        baselineUnavailable: Bool? = nil,
        recovered: Bool? = nil,
        recoveryIncomplete: Bool? = nil,
        recoveryMethod: String? = nil
    ) {
        self.id = id
        self.fileCount = fileCount
        self.repositoryCount = repositoryCount
        self.createdAt = createdAt
        self.scope = scope
        self.commit = commit
        self.displayLimit = displayLimit
        self.baselineSource = baselineSource
        self.baselineUnavailable = baselineUnavailable
        self.recovered = recovered
        self.recoveryIncomplete = recoveryIncomplete
        self.recoveryMethod = recoveryMethod
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fileCount = try c.decode(Int.self, forKey: .fileCount)
        repositoryCount = try c.decode(Int.self, forKey: .repositoryCount)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        // Unknown future scopes degrade to the conservative working-tree label.
        let rawScope = try c.decodeIfPresent(String.self, forKey: .scope)
        scope = rawScope.flatMap(SavedSessionDiffScope.init(rawValue:)) ?? .workingTree
        commit = try c.decodeIfPresent(String.self, forKey: .commit)
        // Optional extras never invalidate an otherwise valid summary.
        let limit = (try? c.decodeIfPresent(Int.self, forKey: .displayLimit)) ?? nil
        displayLimit = limit.flatMap { $0 > 0 ? $0 : nil }
        baselineSource = ((try? c.decodeIfPresent(String.self, forKey: .baselineSource)) ?? nil)
            .flatMap(GitTurnBaselineSource.init(rawValue:))
        baselineUnavailable = (try? c.decodeIfPresent(Bool.self, forKey: .baselineUnavailable)) ?? nil
        recovered = (try? c.decodeIfPresent(Bool.self, forKey: .recovered)) ?? nil
        recoveryIncomplete = (try? c.decodeIfPresent(Bool.self, forKey: .recoveryIncomplete)) ?? nil
        let method = (try? c.decodeIfPresent(String.self, forKey: .recoveryMethod)) ?? nil
        recoveryMethod = ["checkpoint", "ai_reconstructed"].contains(method ?? "") ? method : nil
    }

    /// Valid IDs are opaque, short and URL-path safe; anything else is
    /// dropped so it can never alter the request path.
    var hasSafeID: Bool {
        !id.isEmpty && id.count <= 128
            && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }
            && id.allSatisfy(\.isASCII)
    }

    /// Coverage is distinct from accuracy: an AI-generated patch remains
    /// unverified, but a known partial snapshot is never a viewer candidate.
    var isEligibleForViewer: Bool { hasSafeID && recoveryIncomplete != true && baselineUnavailable != true }

    var shortCommit: String? {
        guard let commit, GitOID.isValid(commit) else { return nil }
        return String(commit.prefix(7))
    }

    var isTurnSnapshot: Bool { scope == .turn || displayLimit != nil || baselineUnavailable == true }

    var isRecovered: Bool { recovered == true }
    var isAIReconstructed: Bool { isRecovered && recoveryMethod == "ai_reconstructed" }

    var recoveryWarning: String? {
        if isAIReconstructed { return "AI-generated · unverified" }
        guard isRecovered, recoveryIncomplete == true else { return nil }
        return "partial: some changes could not be recovered"
    }

    var buttonTitle: String {
        if isAIReconstructed { return "View AI-generated changes" }
        if isRecovered { return "View recovered turn changes" }
        if isTurnSnapshot { return "View turn changes" }
        switch scope {
        case .commit: return "View commit changes"
        case .turn: return "View turn changes"
        case .workingTree, .mixed: return "View working-tree snapshot"
        }
    }

    var headerTitle: String {
        if isAIReconstructed { return "AI-generated turn changes" }
        if isRecovered { return "Recovered turn changes" }
        if isTurnSnapshot { return "Turn changes" }
        switch scope {
        case .commit: return "Commit changes"
        case .turn: return "Turn changes"
        case .mixed: return "Working tree and commit changes"
        case .workingTree: return "Working-tree snapshot"
        }
    }

    /// "Showing 50 of 73 files" when the server capped rendered panels.
    var displayLimitNotice: String? {
        guard let displayLimit, fileCount > displayLimit else { return nil }
        return "Showing \(displayLimit) of \(fileCount) files"
    }

    var detailText: String {
        let files = "\(fileCount) \(fileCount == 1 ? "file" : "files")"
        let repos = repositoryCount > 1 ? " in \(repositoryCount) repositories" : ""
        let shown = displayLimitNotice.map { " · \($0)" } ?? ""
        if isRecovered {
            var text = "\(isAIReconstructed ? "AI-generated patch for this turn" : "Recovered from this turn's tool evidence") · \(files)\(repos)\(shown)"
            if let warning = recoveryWarning { text += " · \(warning)" }
            return text
        }
        if isTurnSnapshot {
            let description = scope == .workingTree ? "Uncommitted changes" : "Commits since baseline + all uncommitted changes"
            var text = "\(description) · \(files)\(repos)\(shown)"
            if let warning = baselineWarning { text += " · \(warning)" }
            return text
        }
        switch scope {
        case .commit:
            if let short = shortCommit { return "Commit \(short) · \(files)\(repos)\(shown)" }
            return "Agent commit · \(files)\(repos)\(shown)"
        case .mixed:
            return "Working tree + agent commit · \(files)\(repos)\(shown)"
        case .workingTree:
            return "\(files)\(repos) · includes pre-existing uncommitted edits\(shown)"
        case .turn:
            var text = "Commits + uncommitted since turn start · \(files)\(repos)\(shown)"
            if let warning = baselineWarning { text += " · \(warning)" }
            return text
        }
    }

    /// Honest caveat for turn snapshots whose baseline was not captured at
    /// the start of the turn.
    var baselineWarning: String? {
        guard isTurnSnapshot, !isRecovered else { return nil }
        if baselineUnavailable == true || scope == .workingTree { return "turn baseline unavailable for some repositories (uncommitted only)" }
        if baselineSource == .beforeTool { return "baseline captured before a later tool step" }
        return nil
    }

    var helpText: String {
        if isAIReconstructed { return "AI-generated patch reported by the agent for this turn, not a verified filesystem diff. May be incomplete; review against the actual files." }
        if isRecovered {
            return "Changes the agent's tool calls were observed making on this Mac, reconstructed from locally recorded before/after checkpoints when the normal turn capture was unavailable. May include uncommitted edits that already existed in touched files. "
                + (recoveryWarning.map { $0.prefix(1).uppercased() + $0.dropFirst() + "." } ?? "All selected evidence was recovered.")
        }
        if isTurnSnapshot {
            return "Net changes across commits from the recorded baseline plus all current uncommitted edits, including pre-existing edits. " + (baselineWarning ?? "Baseline recorded before agent work for this turn.")
        }
        switch scope {
        case .commit:
            return "Show the changes of the commit observed during this run"
        case .turn:
            return "Show every commit and uncommitted change since this turn's baseline HEAD, including uncommitted edits that already existed at the baseline and any edits made outside this run"
        case .workingTree, .mixed:
            return "Show the repository's uncommitted changes when this answer was produced (may include edits made outside this run)"
        }
    }
}

enum GitOID {
    /// Full SHA-1 or SHA-256 object name, lowercase hex.
    static func isValid(_ value: String) -> Bool {
        (value.count == 40 || value.count == 64)
            && value.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}
