import Foundation

// MARK: - Skills v1 wire models (mirror docs/skills-contract.md)
//
// Skills are owned by the backend. The app keeps no local copy and never
// matches keywords itself; it only renders what the API returns.

enum SkillLimits {
    static let saved = 100
    static let nameCodePoints = 80
    static let keywordCodePoints = 80
    static let instructionCodePoints = 8_000
    static let instructionBytes = 32_768
}

/// List row. The list endpoint never includes instruction text.
struct SkillSummary: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let keyword: String
    let enabled: Bool
    let revision: Int
    /// Display-only; tolerated when absent so older fixtures still decode.
    let createdAt: String?
    let updatedAt: String?
}

/// Full skill returned by item/create/patch endpoints.
struct SkillDTO: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let keyword: String
    let instructions: String
    let enabled: Bool
    let revision: Int
    let createdAt: String?
    let updatedAt: String?

    var summary: SkillSummary {
        SkillSummary(
            id: id, name: name, keyword: keyword, enabled: enabled,
            revision: revision, createdAt: createdAt, updatedAt: updatedAt
        )
    }
}

/// Reference carried in live status notices. Never contains instructions.
struct AppliedSkillRef: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let keyword: String
    let revision: Int
}

struct SkillWarning: Codable, Equatable, Sendable {
    let code: String
    let skillId: String?
    let message: String?
}

/// Editable fields for create/edit forms.
struct SkillDraft: Equatable, Sendable {
    var name: String = ""
    var keyword: String = ""
    var instructions: String = ""
    var enabled: Bool = true

    init(name: String = "", keyword: String = "", instructions: String = "", enabled: Bool = true) {
        self.name = name
        self.keyword = keyword
        self.instructions = instructions
        self.enabled = enabled
    }

    init(_ skill: SkillDTO) {
        self.init(
            name: skill.name, keyword: skill.keyword,
            instructions: skill.instructions, enabled: skill.enabled
        )
    }
}

/// Three-way merge used after a revision conflict. For each field:
/// untouched locally → adopt the latest server value; edited locally only →
/// keep the draft; edited on both sides to different values → keep the
/// draft and report the field so the user can reconcile explicitly.
struct SkillDraftRebase: Equatable, Sendable {
    enum Field: String, CaseIterable, Sendable {
        case name, keyword, instructions, enabled

        var label: String {
            switch self {
            case .name: return "Name"
            case .keyword: return "Keyword"
            case .instructions: return "Instructions"
            case .enabled: return "Enabled"
            }
        }
    }

    let draft: SkillDraft
    /// Fields changed both here and elsewhere, in display order.
    let conflicts: [Field]
    /// Fields that took the newer server value because they were untouched.
    let adopted: [Field]

    static func merge(draft: SkillDraft, original: SkillDTO, latest: SkillDTO) -> SkillDraftRebase {
        var merged = draft
        var conflicts: [Field] = []
        var adopted: [Field] = []

        func resolve<Value: Equatable>(
            _ field: Field, _ mine: Value, _ base: Value, _ theirs: Value, assign: (Value) -> Void
        ) {
            if mine == base {
                if theirs != base { adopted.append(field) }
                assign(theirs)
            } else if theirs != base, theirs != mine {
                conflicts.append(field)
            }
        }

        resolve(.name, draft.name, original.name, latest.name) { merged.name = $0 }
        resolve(.keyword, draft.keyword, original.keyword, latest.keyword) { merged.keyword = $0 }
        resolve(.instructions, draft.instructions, original.instructions, latest.instructions) {
            merged.instructions = $0
        }
        resolve(.enabled, draft.enabled, original.enabled, latest.enabled) { merged.enabled = $0 }
        return SkillDraftRebase(draft: merged, conflicts: conflicts, adopted: adopted)
    }
}

/// Partial update; nil fields are omitted from the PATCH body.
struct SkillPatch: Equatable, Sendable {
    var name: String?
    var keyword: String?
    var instructions: String?
    var enabled: Bool?

    var isEmpty: Bool { name == nil && keyword == nil && instructions == nil && enabled == nil }

    /// Only fields the user actually changed relative to the loaded skill.
    static func diff(from base: SkillDTO, to draft: SkillDraft) -> SkillPatch {
        var patch = SkillPatch()
        if draft.name != base.name { patch.name = draft.name }
        if draft.keyword != base.keyword { patch.keyword = draft.keyword }
        if draft.instructions != base.instructions { patch.instructions = draft.instructions }
        if draft.enabled != base.enabled { patch.enabled = draft.enabled }
        return patch
    }

    var jsonObject: [String: Any] {
        var payload: [String: Any] = [:]
        if let name { payload["name"] = name }
        if let keyword { payload["keyword"] = keyword }
        if let instructions { payload["instructions"] = instructions }
        if let enabled { payload["enabled"] = enabled }
        return payload
    }
}

// MARK: - Live skill_status notices

enum SkillStatusKind: String, Codable, Equatable, Sendable {
    case applied
    case warning
    case blocked
}

struct SkillStatusError: Codable, Equatable, Sendable {
    let code: String
    let message: String?
}

/// `skill_status` metadata on a nonterminal agent notice. Arrays default to
/// empty so a sparse but well-typed notice still decodes.
struct SkillStatus: Decodable, Equatable, Sendable {
    let inputID: String
    let status: SkillStatusKind
    let skills: [AppliedSkillRef]
    let warnings: [SkillWarning]
    let error: SkillStatusError?

    init(
        inputID: String,
        status: SkillStatusKind,
        skills: [AppliedSkillRef] = [],
        warnings: [SkillWarning] = [],
        error: SkillStatusError? = nil
    ) {
        self.inputID = inputID
        self.status = status
        self.skills = skills
        self.warnings = warnings
        self.error = error
    }

    enum CodingKeys: String, CodingKey {
        case inputID = "input_id"
        case status, skills, warnings, error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputID = try c.decode(String.self, forKey: .inputID)
        status = try c.decode(SkillStatusKind.self, forKey: .status)
        skills = try c.decodeIfPresent([AppliedSkillRef].self, forKey: .skills) ?? []
        warnings = try c.decodeIfPresent([SkillWarning].self, forKey: .warnings) ?? []
        error = try c.decodeIfPresent(SkillStatusError.self, forKey: .error)
    }
}

enum SkillNoticeClassification: Equatable, Sendable {
    /// Ordinary agent frame; continue with existing parsing.
    case notSkillNotice
    /// Carries `skill_status` but it could not be decoded. Still consumed so
    /// it never reaches shell/final-answer parsing.
    case malformed
    case status(SkillStatus)
}

/// Per-turn dedup of notices by input id + status. Created fresh for every
/// run, so nothing survives a new turn, completion, stop, or disconnect.
final class SkillStatusTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: Set<String> = []

    /// True the first time an (input id, status) pair is offered.
    func shouldPresent(_ status: SkillStatus) -> Bool {
        let key = "\(status.inputID)\u{0}\(status.status.rawValue)"
        return lock.withLock { seen.insert(key).inserted }
    }
}

enum SkillNoticeInterceptor {
    /// Classify one raw WebSocket text frame. Must run before any tool,
    /// steering, shell-script, or final-answer handling.
    ///
    /// Key presence is detected with the same `JSONDecoder` the runners use
    /// to decode agent frames, so the two can never disagree about whether a
    /// frame is a notice. If the decoder rejects the whole frame (e.g. a lone
    /// surrogate it cannot represent), the runners' own decode fails too and
    /// the frame is dropped as undecodable — it can never execute or complete.
    static func classify(_ data: Data) -> SkillNoticeClassification {
        guard let probe = try? JSONDecoder().decode(NoticeProbe.self, from: data) else {
            return .notSkillNotice
        }
        return probe.classification
    }

    /// Decodes only `skill_status`. Present but `null`, wrongly typed or
    /// incomplete → `.malformed` (still consumed; the server never sends
    /// those, but a present key always marks a status notice).
    private struct NoticeProbe: Decodable {
        let classification: SkillNoticeClassification

        enum CodingKeys: String, CodingKey { case skillStatus = "skill_status" }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            guard container.contains(.skillStatus) else {
                classification = .notSkillNotice
                return
            }
            if (try? container.decodeNil(forKey: .skillStatus)) == true {
                classification = .malformed
            } else if let status = try? container.decode(SkillStatus.self, forKey: .skillStatus) {
                classification = .status(status)
            } else {
                classification = .malformed
            }
        }
    }

    /// `.passThrough` lets the caller continue normal parsing. `.consumed`
    /// means the frame is a Skills notice and must go no further; `display`
    /// is literal text to show, or nil (duplicate, malformed, or empty).
    static func intercept(_ data: Data, tracker: SkillStatusTracker) -> SkillNoticeOutcome {
        switch classify(data) {
        case .notSkillNotice:
            return .passThrough
        case .malformed:
            return .consumed(display: nil)
        case let .status(status):
            guard tracker.shouldPresent(status) else { return .consumed(display: nil) }
            return .consumed(display: SkillStatusPresentation.text(for: status))
        }
    }
}

enum SkillNoticeOutcome: Equatable, Sendable {
    case passThrough
    case consumed(display: String?)
}

/// Plain-text formatting for notices. Output is always a single line built
/// from fixed wording plus sanitized names; no server message, keyword, or
/// instruction text is interpolated. Views must render it as literal text.
enum SkillStatusPresentation {
    static let appliedPrefix = "Skills applied: "

    static func text(for status: SkillStatus) -> String? {
        switch status.status {
        case .applied:
            var seenIDs: Set<String> = []
            let names = status.skills
                .filter { seenIDs.insert($0.id).inserted }
                .map { displayName($0.name) }
            guard !names.isEmpty else { return nil }
            return appliedPrefix + names.joined(separator: ", ")

        case .warning:
            let count = max(status.warnings.count, 1)
            let noun = count == 1 ? "1 saved skill was invalid and was" : "\(count) saved skills were invalid and were"
            return "Some skills were skipped: \(noun) skipped. Review them in Skills."

        case .blocked:
            return "Skills could not be applied: \(blockedReason(code: status.error?.code))"
        }
    }

    /// Fixed reason text by error code (mirrors the backend table).
    static func blockedReason(code: String?) -> String {
        switch code {
        case "STORE_UNAVAILABLE":
            return "Skills are temporarily unavailable. Please retry."
        case "ACTIVE_LIMIT_EXCEEDED":
            return "Too many skills matched. Use fewer keywords or disable some skills."
        case "CONTEXT_LIMIT_EXCEEDED":
            return "Matched skill instructions exceed the context budget. Shorten or disable skills."
        default:
            return "Check settings and try again."
        }
    }

    /// Collapse controls, line/paragraph separators and format characters
    /// (bidi overrides, zero-width) to spaces, trim, and cap the length.
    static func displayName(_ raw: String) -> String {
        var scalars = String.UnicodeScalarView()
        var lastWasSpace = false
        for scalar in raw.unicodeScalars {
            let category = scalar.properties.generalCategory
            let isBreaking = category == .control || category == .format
                || category == .lineSeparator || category == .paragraphSeparator
                || scalar.properties.isWhitespace
            if isBreaking {
                if !lastWasSpace { scalars.append(" ") }
                lastWasSpace = true
            } else {
                scalars.append(scalar)
                lastWasSpace = false
            }
        }
        var name = String(scalars).trimmingCharacters(in: .whitespaces)
        if name.unicodeScalars.count > SkillLimits.nameCodePoints {
            // Cut on whole characters so emoji/combining sequences stay intact.
            var kept = ""
            var used = 0
            for character in name {
                let size = character.unicodeScalars.count
                guard used + size <= SkillLimits.nameCodePoints else { break }
                kept.append(character)
                used += size
            }
            name = kept + "…"
        }
        return name.isEmpty ? "Unnamed skill" : name
    }
}

extension String {
    /// Unicode scalar count, matching the backend's code-point limits.
    var codePointCount: Int { unicodeScalars.count }
}
