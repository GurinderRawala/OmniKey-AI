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

/// One compact control above the composer; never render coverage diagnostics here.
struct TurnChangesPill: View {
    @ObservedObject var model: ChatModel
    @AppStorage(AgentDiffViewSetting.defaultsKey) private var enabled = true
    @State private var historicalCounts: SessionDiffHTMLResponse?
    private var block: ChatBlock? { model.currentChangeBlock }
    private var liveCounts: DiffLineCounts? { block?.liveDiff.map { DiffLineCounts(patches: $0.repositories.map(\.patch)) } }
    private var saved: SavedSessionDiff? { block?.sessionDiff }
    private var files: Int { liveCounts?.files ?? (saved?.isEligibleForViewer == true ? saved?.fileCount ?? 0 : 0) }

    var body: some View {
        Group {
            if enabled, files > 0 {
                Button {
                    if let saved { model.toggleSessionDiff(saved) }
                    else {
                        let open = model.showsLiveChanges
                        model.closeSessionDiff()
                        model.showsLiveChanges = !open
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus.forwardslash.minus")
                        ChangeCountsLabel(files: files,
                            additions: liveCounts?.additions ?? saved?.additions ?? historicalCounts?.additions,
                            deletions: liveCounts?.deletions ?? saved?.deletions ?? historicalCounts?.deletions)
                        Image(systemName: "sidebar.right").foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(.quaternary.opacity(0.5), in: Capsule())
                    .overlay(Capsule().strokeBorder(.secondary.opacity(0.18)))
                }
                .buttonStyle(.plain)
                .help("Open changes")
                .accessibilityLabel("View changes in \(files) files")
            }
        }
        .task(id: "\(model.activeSessionId ?? ""):\(saved?.id ?? "")") {
            historicalCounts = nil
            guard enabled, let saved, saved.fileCount > 0, saved.additions == nil,
                  let session = model.activeSessionId else { return }
            let response = try? await SessionDiffHTTPFetcher().fetch(sessionId: session, diffId: saved.id, theme: .dark, layout: .unified)
            guard !Task.isCancelled, response?.id == saved.id else { return }
            historicalCounts = response
        }
    }
}

/// Live content belongs exclusively in the right-hand drawer.
struct LiveTurnDiffView: View {
    let diff: LiveTurnDiff
    let isRunning: Bool
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(diff.repositories, id: \.root) { repository in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(URL(fileURLWithPath: repository.root).lastPathComponent)
                            .font(.system(size: 12, weight: .semibold))
                        LivePatchView(patch: repository.patch)
                    }
                }
                if diff.repositories.isEmpty {
                    Text("No changes").font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.top, 40)
                }
            }.padding(16)
        }
    }
}

struct LiveChangesDrawer: View {
    @ObservedObject var model: ChatModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Changes").font(.system(size: 13, weight: .semibold))
                if model.isRunning { Text("Live").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button { model.closeSessionDiff() } label: { Image(systemName: "xmark").frame(width: 24, height: 24) }
                    .buttonStyle(.plain).help("Close changes").keyboardShortcut(.cancelAction)
            }.padding(.horizontal, 14).frame(height: 52)
            Divider()
            if let diff = model.currentLiveDiff { LiveTurnDiffView(diff: diff, isRunning: model.isRunning) }
            else { Text("No changes").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
    }
}

private struct LivePatchView: View {
    let patch: String
    var body: some View {
        ScrollView(.horizontal) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(patch.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(line.hasPrefix("+") ? Color.green : line.hasPrefix("-") ? Color.red : Color.primary)
                        .textSelection(.enabled)
                }
            }
        }
    }
}
