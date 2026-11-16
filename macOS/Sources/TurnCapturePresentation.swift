import Foundation

// MARK: - Shared turn-capture presentation
//
// One coverage-aware description used by the live pill, live/saved cards and
// the inspector header so they never disagree. Derived only from counts and
// the existing per-root coverage (`complete | partial | late | unavailable`).
// Filesystem captures compare bytes against this run's starting snapshot;
// zero patches only mean "no changes" when every captured root is complete.

/// Aggregate per-root coverage. Unknown status strings are treated as
/// partial: they are never evidence of a complete scan.
struct TurnCaptureCoverageSummary: Equatable, Sendable {
    var complete = 0
    var partial = 0
    var late = 0
    var unavailable = 0

    init(_ coverage: [TurnRootCoverage]) {
        for root in coverage {
            switch root.status {
            case "complete": complete += 1
            case "late": late += 1
            case "unavailable": unavailable += 1
            default: partial += 1
            }
        }
    }

    var total: Int { complete + partial + late + unavailable }
    /// Roots whose bytes were actually compared (in full, partly or late).
    var usable: Int { complete + partial + late }
}

enum TurnCaptureState: Equatable, Sendable {
    /// Legacy Git/recovered snapshot: keep its own semantics and wording.
    case legacy
    /// Changes captured; `coverage` qualifies how much was compared.
    case changes(TurnCaptureCoverage)
    /// Zero patches and every captured root fully compared.
    case noChangesDetected
    /// Zero patches but at least one root only partly compared (or a mix of
    /// captured and unavailable roots).
    case noChangesIncomplete
    /// Zero patches, every root compared but at least one only from a later
    /// baseline or a checkpoint retained from before removal.
    case noChangesLate
    /// No usable root: coverage missing, empty, or entirely unavailable.
    case unavailable
}

enum TurnCaptureCoverage: Equatable, Sendable {
    case complete
    case late
    case incomplete
    /// Filesystem capture without any coverage report (older payload).
    case unreported
}

struct TurnCapturePresentation: Equatable, Sendable {
    static let turnTitle = "Turn changes"
    static let scopeHelp = "Changes since this turn's baseline. A pull request may include earlier turns."

    let files: Int
    let additions: Int?
    let deletions: Int?
    let isFilesystem: Bool
    let coverage: [TurnRootCoverage]?
    let state: TurnCaptureState
    /// Legacy-only wording supplied by the saved snapshot.
    private let legacyTitle: String?
    private let legacyHelp: String?

    init(files: Int, additions: Int?, deletions: Int?, isFilesystem: Bool, coverage: [TurnRootCoverage]?,
         legacyTitle: String? = nil, legacyHelp: String? = nil) {
        self.files = max(0, files)
        self.additions = additions
        self.deletions = deletions
        self.isFilesystem = isFilesystem
        self.coverage = coverage
        self.legacyTitle = legacyTitle
        self.legacyHelp = legacyHelp
        self.state = Self.state(files: max(0, files), isFilesystem: isFilesystem, coverage: coverage)
    }

    init(saved diff: SavedSessionDiff) {
        let filesystem = diff.filesystem == true
        self.init(files: diff.fileCount, additions: diff.additions, deletions: diff.deletions,
                  isFilesystem: filesystem, coverage: diff.coverage,
                  legacyTitle: filesystem ? nil : diff.headerTitle,
                  legacyHelp: filesystem ? nil : diff.helpText)
    }

    /// Live and captured diffs always come from the native filesystem tracker.
    init(live diff: LiveTurnDiff) {
        let counts = DiffLineCounts(patches: diff.repositories.map(\.patch))
        self.init(files: counts.files, additions: counts.additions, deletions: counts.deletions,
                  isFilesystem: true, coverage: diff.coverage)
    }

    static func state(files: Int, isFilesystem: Bool, coverage: [TurnRootCoverage]?) -> TurnCaptureState {
        guard isFilesystem else { return .legacy }
        guard let coverage, !coverage.isEmpty else { return files > 0 ? .changes(.unreported) : .unavailable }
        let summary = TurnCaptureCoverageSummary(coverage)
        if files > 0 {
            if summary.partial > 0 || summary.unavailable > 0 { return .changes(.incomplete) }
            return .changes(summary.late > 0 ? .late : .complete)
        }
        if summary.usable == 0 { return .unavailable }
        if summary.partial > 0 || summary.unavailable > 0 { return .noChangesIncomplete }
        if summary.late > 0 { return .noChangesLate }
        return .noChangesDetected
    }

    // MARK: Text

    var title: String { legacyTitle ?? Self.turnTitle }

    var help: String {
        if let legacyHelp { return legacyHelp }
        return Self.scopeHelp + " Compared with captured starting file contents, including pre-existing edits; this does not identify who made each change."
    }

    /// Replaces the count label when there are no captured changes.
    var emptySummary: String? {
        switch state {
        case .legacy, .changes: return nil
        case .noChangesDetected: return "No changes detected in captured folders"
        case .noChangesIncomplete: return "No changes captured · incomplete coverage"
        case .noChangesLate: return "No changes captured · late baseline or checkpoint"
        case .unavailable: return "Capture unavailable"
        }
    }

    /// Short qualifier shown after counts; nil when coverage is complete.
    var coverageQualifier: String? {
        guard case .changes(let coverage) = state else { return nil }
        switch coverage {
        case .complete: return nil
        case .late: return "late baseline or checkpoint"
        case .incomplete: return "incomplete coverage"
        case .unreported: return "coverage not reported"
        }
    }

    /// Whether a zero-file snapshot deserves a card: only when there is a
    /// coverage caveat to surface. Complete-empty and legacy-empty turns stay quiet.
    var showsCard: Bool {
        switch state {
        case .changes: return true
        case .legacy: return files > 0
        case .noChangesIncomplete, .noChangesLate, .unavailable: return true
        case .noChangesDetected: return false
        }
    }

    var accessibilityLabel: String {
        var parts = [title]
        if let emptySummary {
            parts.append(emptySummary.replacingOccurrences(of: " · ", with: ", "))
        } else {
            parts.append("\(files) \(files == 1 ? "file" : "files")")
            if let additions { parts.append("\(additions) \(additions == 1 ? "line" : "lines") added") }
            if let deletions { parts.append("\(deletions) \(deletions == 1 ? "line" : "lines") removed") }
            if let coverageQualifier { parts.append(coverageQualifier) }
        }
        return parts.joined(separator: ", ")
    }

    /// Subtle one-line inspector notice; per-root reasons are rendered in the document.
    var inspectorNotice: String? {
        guard isFilesystem else { return nil }
        guard let coverage, !coverage.isEmpty else {
            return files > 0 ? "Coverage was not reported for this capture." : "No folder contents were captured for this turn, so changes can't be shown."
        }
        let summary = TurnCaptureCoverageSummary(coverage)
        var notes: [String] = []
        if summary.partial > 0 {
            notes.append("\(summary.partial) of \(summary.total) \(summary.total == 1 ? "folder was" : "folders were") only partly compared; some changes may be missing.")
        }
        if summary.unavailable > 0 {
            notes.append(summary.unavailable == summary.total
                ? "Capture unavailable for every folder."
                : "\(summary.unavailable) of \(summary.total) \(summary.total == 1 ? "folder" : "folders") could not be captured.")
        }
        if summary.late > 0 {
            notes.append("\(summary.late) \(summary.late == 1 ? "folder uses" : "folders use") a baseline captured after the turn started or a checkpoint retained before removal.")
        }
        return notes.isEmpty ? nil : notes.joined(separator: " ")
    }
}
