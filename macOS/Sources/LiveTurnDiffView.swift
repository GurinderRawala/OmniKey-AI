import SwiftUI

struct DiffLineCounts: Equatable, Sendable {
    var additions = 0
    var deletions = 0
    var files = 0

    init(patches: [String]) {
        for patch in patches {
            var inHunk = false
            for line in patch.components(separatedBy: "\n") {
                if line.hasPrefix("diff --git ") { files += 1; inHunk = false }
                else if line.hasPrefix("@@ ") { inHunk = true }
                else if inHunk && line.hasPrefix("+") { additions += 1 }
                else if inHunk && line.hasPrefix("-") { deletions += 1 }
            }
        }
    }
}

extension LiveTurnDiff {
    /// Shared presentation; a zero-file live/captured card is worth showing
    /// only when it carries a coverage caveat (see `showsCard`).
    var capturePresentation: TurnCapturePresentation { TurnCapturePresentation(live: self) }
}

extension ChatModel {
    var currentChangeBlock: ChatBlock? {
        // Do not fall back to a previous turn when the current turn has no edits.
        for message in messages.reversed() {
            if message.role == .user {
                if message.isSteering { continue }
                return nil
            }
            if message.role == .assistant {
                return message.blocks.last { $0.liveDiff != nil || $0.sessionDiff != nil }
            }
        }
        return nil
    }
    var currentLiveDiff: LiveTurnDiff? { currentChangeBlock?.liveDiff }
}

struct ChangeCountsLabel: View {
    let files: Int
    let additions: Int?
    let deletions: Int?
    var body: some View {
        HStack(spacing: 9) {
            Text("\(files) \(files == 1 ? "file" : "files")")
            if let additions { Text("+\(additions)").foregroundStyle(.green).monospacedDigit() }
            if let deletions { Text("−\(deletions)").foregroundStyle(.red).monospacedDigit() }
        }
    }
}

/// Counts plus a neutral coverage qualifier, or the coverage-aware empty state.
struct TurnCaptureSummaryLabel: View {
    let presentation: TurnCapturePresentation
    var body: some View {
        if let empty = presentation.emptySummary {
            Text(empty)
        } else {
            HStack(spacing: 9) {
                ChangeCountsLabel(files: presentation.files, additions: presentation.additions, deletions: presentation.deletions)
                if let qualifier = presentation.coverageQualifier { Text("· " + qualifier) }
            }
        }
    }
}

/// One compact control above the composer; never render coverage diagnostics here.
struct TurnChangesPill: View {
    @ObservedObject var model: ChatModel
    @AppStorage(AgentDiffViewSetting.defaultsKey) private var enabled = true
    private var presentation: TurnCapturePresentation? { model.currentLiveDiff.map(TurnCapturePresentation.init(live:)) }

    var body: some View {
        Group {
            if enabled, model.isRunning, let presentation, presentation.files > 0 {
                Button {
                    let open = model.showsLiveChanges
                    model.closeSessionDiff()
                    model.showsLiveChanges = !open
                } label: {
                    HStack(spacing: 10) {
                        Circle().fill(Color.accentColor).frame(width: 6, height: 6)
                        Text(presentation.title)
                        ChangeCountsLabel(files: presentation.files, additions: presentation.additions, deletions: presentation.deletions)
                        Image(systemName: "sidebar.right").foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(.quaternary.opacity(0.5), in: Capsule())
                    .overlay(Capsule().strokeBorder(.secondary.opacity(0.18)))
                }
                .buttonStyle(.plain)
                .help("Open turn changes. " + TurnCapturePresentation.scopeHelp)
                .accessibilityLabel(presentation.accessibilityLabel)
                .accessibilityHint("Opens the changes inspector")
            }
        }
    }
}

struct LiveChangesDrawer: View {
    @ObservedObject var model: ChatModel
    var body: some View {
        if let diff = model.currentLiveDiff, let session = model.activeSessionId {
            ChangesInspectorView(model: model, source: .preview(sessionID: session, diff: diff))
        } else {
            ContentUnavailableView("Capture unavailable", systemImage: "doc.text")
        }
    }
}
