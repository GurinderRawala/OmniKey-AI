import SwiftUI

/// Stable, in-place view at the bottom of the active assistant turn. It does
/// not fetch immutable historical HTML on every filesystem revision.
struct LiveTurnDiffView: View {
    let diff: LiveTurnDiff
    let isRunning: Bool
    private var files: Int {
        diff.repositories.reduce(0) { $0 + $1.patch.components(separatedBy: "\n").filter { $0.hasPrefix("diff --git ") }.count }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "plus.forwardslash.minus")
                Text(isRunning ? "Changes so far" : "Last captured changes").fontWeight(.medium)
                Spacer()
                Text("\(files) \(files == 1 ? "file" : "files")").foregroundStyle(.secondary)
                if isRunning { ProgressView().controlSize(.small) }
            }
            if diff.coverage.isEmpty {
                Text("No folder captured yet. Select a project folder to track changes from the start of a turn.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(diff.coverage, id: \.root) { coverage in
                LiveRootDiffView(coverage: coverage, patch: diff.repositories.first(where: { $0.root == coverage.root })?.patch)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct LiveRootDiffView: View {
    let coverage: TurnRootCoverage
    let patch: String?
    @State private var expanded = true
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 5) {
            Text(coverage.reason).font(.caption).foregroundStyle(.secondary)
            if !coverage.suggestedFix.isEmpty {
                Text("Suggested fix: " + coverage.suggestedFix).font(.caption)
            }
            if let patch { LivePatchView(patch: patch) }
            else {
                Text(coverage.status == "complete" ? "No net changes." : "No captured changes.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            }.frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(coverage.root + " · " + coverage.status).font(.caption).lineLimit(2)
        }
    }
}

private struct LivePatchView: View {
    let patch: String
    var body: some View {
        let lines = patch.components(separatedBy: "\n")
        ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.prefix(500).enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(line.hasPrefix("+") ? Color.green : line.hasPrefix("-") ? Color.red : Color.primary)
                        .textSelection(.enabled)
                }
            }
        }
        .frame(maxHeight: 260)
        if lines.count > 500 {
            Text("Live preview shows the first 500 lines. The saved diff includes all captured lines.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
