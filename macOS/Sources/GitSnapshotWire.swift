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
    /// Agent-assisted recovery (`supports_diff_recovery`): replay locally
    /// stored, previously emitted evidence patches for the current turn.
    case recover
}

/// `git_diff_request.recovery` for `phase:"recover"`.
struct GitDiffRecoveryRequest: Codable, Equatable, Sendable {
    let turnID: String
    let evidenceIDs: [String]

    enum CodingKeys: String, CodingKey {
        case turnID = "turn_id"
        case evidenceIDs = "evidence_ids"
    }
}

/// `git_diff_response.recovery`: echoes the exact selection; `omitted`
/// counts selected IDs that no longer have a patch (reverted to baseline).
struct GitDiffRecoveryResponse: Codable, Equatable, Sendable {
    let turnID: String
    let evidenceIDs: [String]
    let omitted: Int

    enum CodingKeys: String, CodingKey {
        case turnID = "turn_id"
        case evidenceIDs = "evidence_ids"
        case omitted
    }
}

enum DiffRecoveryRecordKind: String, Codable, Equatable, Sendable {
    case git
    case file
}

/// Metadata only (never patch or file content). `before`/`after` are Git
/// object names for `git` records and SHA-256 content hashes for `file`
/// records; `null` means unborn/absent/deleted. Always encoded.
struct DiffRecoveryRecord: Codable, Equatable, Sendable {
    let id: String
    let toolCallId: String
    let root: String
    let paths: [String]
    let kind: DiffRecoveryRecordKind
    let before: String?
    let after: String?
    let complete: Bool

    enum CodingKeys: String, CodingKey { case id, toolCallId, root, paths, kind, before, after, complete }

    init(id: String, toolCallId: String, root: String, paths: [String], kind: DiffRecoveryRecordKind,
         before: String?, after: String?, complete: Bool) {
        self.id = id
        self.toolCallId = toolCallId
        self.root = root
        self.paths = paths
        self.kind = kind
        self.before = before
        self.after = after
        self.complete = complete
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        toolCallId = try c.decode(String.self, forKey: .toolCallId)
        root = try c.decode(String.self, forKey: .root)
        paths = try c.decode([String].self, forKey: .paths)
        kind = try c.decode(DiffRecoveryRecordKind.self, forKey: .kind)
        before = try c.decodeIfPresent(String.self, forKey: .before)
        after = try c.decodeIfPresent(String.self, forKey: .after)
        complete = try c.decode(Bool.self, forKey: .complete)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(toolCallId, forKey: .toolCallId)
        try c.encode(root, forKey: .root)
        try c.encode(paths, forKey: .paths)
        try c.encode(kind, forKey: .kind)
        if let before { try c.encode(before, forKey: .before) } else { try c.encodeNil(forKey: .before) }
        if let after { try c.encode(after, forKey: .after) } else { try c.encodeNil(forKey: .after) }
        try c.encode(complete, forKey: .complete)
    }
}

/// Terminal-reply `diff_recovery_evidence` for one shell tool call.
struct DiffRecoveryEvidence: Codable, Equatable, Sendable {
    let turnID: String
    let records: [DiffRecoveryRecord]
    let omitted: Int?

    enum CodingKeys: String, CodingKey {
        case turnID = "turn_id"
        case records
        case omitted
    }
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
    /// Recover phase only.
    let recovery: GitDiffRecoveryRequest?

    init(
        requestID: String,
        candidatePaths: [String],
        eligibleCommits: [GitEligibleCommit]? = nil,
        phase: GitDiffPhase? = nil,
        baselines: [GitTurnBaseline]? = nil,
        baselineSource: GitTurnBaselineSource? = nil,
        displayLimit: Int? = nil,
        recovery: GitDiffRecoveryRequest? = nil
    ) {
        self.requestID = requestID
        self.candidatePaths = candidatePaths
        self.eligibleCommits = eligibleCommits
        self.phase = phase
        self.hasUnsupportedPhase = phase == .recover && recovery == nil
        self.baselines = baselines
        self.baselineSource = baselineSource
        self.displayLimit = displayLimit
        self.recovery = recovery
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case candidatePaths = "candidate_paths"
        case eligibleCommits = "eligible_commits"
        case phase
        case baselines
        case baselineSource = "baseline_source"
        case displayLimit = "display_limit"
        case recovery
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
        let decodedRecovery = try? c.decodeIfPresent(GitDiffRecoveryRequest.self, forKey: .recovery)
        recovery = decodedRecovery ?? nil
        // A recover request must carry a well-formed selection; recovery
        // metadata on any other phase is equally unexpected.
        let badRecovery = (phase == .recover) != (recovery != nil)
            || (c.contains(.recovery) && (try? c.decodeNil(forKey: .recovery)) != true && recovery == nil)
        hasUnsupportedPhase = badPhase || badBaselines || badSource || badRecovery
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
        try c.encodeIfPresent(recovery, forKey: .recovery)
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
    /// Recover phase only, and only with `status == .ok`.
    let recovery: GitDiffRecoveryResponse?

    init(
        requestID: String,
        status: GitDiffResponseStatus,
        repositories: [GitDiffRepositoryPatch] = [],
        baselines: [GitTurnBaseline]? = nil,
        reason: String? = nil,
        recovery: GitDiffRecoveryResponse? = nil
    ) {
        self.requestID = requestID
        self.status = status
        // Never report partial data with a failure status.
        self.repositories = status == .ok ? repositories : []
        self.baselines = baselines.map { status == .ok ? $0 : [] }
        self.reason = reason
        self.recovery = status == .ok ? recovery : nil
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case status
        case repositories
        case baselines
        case reason
        case recovery
    }
}

struct GitDiffContext: Codable, Equatable, Sendable {
    let candidatePaths: [String]
    /// Diff recovery: the outer run ID and the issued shell tool call ID.
    /// Both are opaque; malformed values are dropped (no evidence recorded).
    let turnID: String?
    let toolCallID: String?

    init(candidatePaths: [String], turnID: String? = nil, toolCallID: String? = nil) {
        self.candidatePaths = candidatePaths
        self.turnID = turnID
        self.toolCallID = toolCallID
    }

    enum CodingKeys: String, CodingKey {
        case candidatePaths = "candidate_paths"
        case turnID = "turn_id"
        case toolCallID = "tool_call_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        candidatePaths = try c.decode([String].self, forKey: .candidatePaths)
        turnID = ((try? c.decodeIfPresent(String.self, forKey: .turnID)) ?? nil).flatMap(Self.opaqueID)
        toolCallID = ((try? c.decodeIfPresent(String.self, forKey: .toolCallID)) ?? nil).flatMap(Self.opaqueID)
    }

    /// Short printable ASCII without whitespace; anything else is ignored.
    static func opaqueID(_ raw: String) -> String? {
        guard !raw.isEmpty, raw.utf8.count <= 128,
              raw.unicodeScalars.allSatisfy({ $0.isASCII && $0.value > 0x20 && $0.value < 0x7f })
        else { return nil }
        return raw
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
    /// Agent-assisted recovery from stored tool evidence (not a normal
    /// turn capture); `recoveryIncomplete` marks an honest partial result.
    let recovered: Bool?
    let recoveryIncomplete: Bool?
    /// AI reconstruction is not a verified native before/after checkpoint.
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

    var shortCommit: String? {
        guard let commit, GitOID.isValid(commit) else { return nil }
        return String(commit.prefix(7))
    }

    var isTurnSnapshot: Bool { scope == .turn || displayLimit != nil || baselineUnavailable == true }

    var isRecovered: Bool { recovered == true }
    var isAIReconstructed: Bool { isRecovered && recoveryMethod == "ai_reconstructed" }

    var recoveryWarning: String? {
        if isAIReconstructed { return "AI reconstruction · unverified and potentially incomplete" }
        guard isRecovered, recoveryIncomplete == true else { return nil }
        return "partial: some changes could not be recovered"
    }

    var buttonTitle: String {
        if isAIReconstructed { return "View AI-reconstructed changes" }
        if isRecovered { return "View recovered turn changes" }
        if isTurnSnapshot { return "View turn changes" }
        switch scope {
        case .commit: return "View commit changes"
        case .turn: return "View turn changes"
        case .workingTree, .mixed: return "View working-tree snapshot"
        }
    }

    var headerTitle: String {
        if isAIReconstructed { return "AI-reconstructed turn changes" }
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
            var text = "\(isAIReconstructed ? "AI reconstruction of this turn" : "Recovered from this turn's tool evidence") · \(files)\(repos)\(shown)"
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
        if isAIReconstructed { return "AI-generated reconstruction from write scripts in this turn, not a verified filesystem diff. May be incomplete; review against the actual files." }
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
