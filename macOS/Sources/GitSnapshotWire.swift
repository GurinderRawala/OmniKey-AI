import Foundation

// MARK: - Git diff wire contract (v2)
//
// Server → client control frame sent on the authenticated turn socket before
// the final answer: `git_diff_request`. The client replies with a dedicated
// `git_diff_response` frame. Neither is a model, tool or transcript message.
// Shell requests may carry `git_diff_context`; terminal replies may carry
// `git_commit_observations` (commits observed to be created by that shell).

enum GitSnapshotScope: String, Codable, Equatable, Sendable {
    case workingTree = "working_tree"
    case commit
}

struct GitEligibleCommit: Codable, Equatable, Sendable {
    let root: String
    let commit: String
}

struct GitDiffRequestPayload: Codable, Equatable, Sendable {
    let requestID: String
    let candidatePaths: [String]
    let eligibleCommits: [GitEligibleCommit]?

    init(requestID: String, candidatePaths: [String], eligibleCommits: [GitEligibleCommit]? = nil) {
        self.requestID = requestID
        self.candidatePaths = candidatePaths
        self.eligibleCommits = eligibleCommits
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case candidatePaths = "candidate_paths"
        case eligibleCommits = "eligible_commits"
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

    init(root: String, patch: String, scope: GitSnapshotScope = .workingTree, commit: String? = nil) {
        self.root = root
        self.patch = patch
        self.scope = scope
        self.commit = commit
    }
}

struct GitDiffResponsePayload: Codable, Equatable, Sendable {
    let requestID: String
    let status: GitDiffResponseStatus
    let repositories: [GitDiffRepositoryPatch]
    let reason: String?

    init(requestID: String, status: GitDiffResponseStatus, repositories: [GitDiffRepositoryPatch] = [], reason: String? = nil) {
        self.requestID = requestID
        self.status = status
        // Never report partial data with a failure status.
        self.repositories = status == .ok ? repositories : []
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case status
        case repositories
        case reason
    }
}

struct GitDiffContext: Codable, Equatable, Sendable {
    let candidatePaths: [String]

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
}

/// Immutable server-side snapshot bound to exactly one final answer.
struct SavedSessionDiff: Codable, Equatable, Hashable, Sendable {
    let id: String
    let fileCount: Int
    let repositoryCount: Int
    let createdAt: String
    let scope: SavedSessionDiffScope
    let commit: String?

    init(
        id: String,
        fileCount: Int,
        repositoryCount: Int,
        createdAt: String,
        scope: SavedSessionDiffScope = .workingTree,
        commit: String? = nil
    ) {
        self.id = id
        self.fileCount = fileCount
        self.repositoryCount = repositoryCount
        self.createdAt = createdAt
        self.scope = scope
        self.commit = commit
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

    var buttonTitle: String {
        switch scope {
        case .commit: return "View commit changes"
        case .workingTree, .mixed: return "View working-tree snapshot"
        }
    }

    var detailText: String {
        let files = "\(fileCount) \(fileCount == 1 ? "file" : "files")"
        let repos = repositoryCount > 1 ? " in \(repositoryCount) repositories" : ""
        switch scope {
        case .commit:
            if let short = shortCommit { return "Commit \(short) · \(files)\(repos)" }
            return "Agent commit · \(files)\(repos)"
        case .mixed:
            return "Working tree + agent commit · \(files)\(repos)"
        case .workingTree:
            return "\(files)\(repos) · includes pre-existing uncommitted edits"
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
