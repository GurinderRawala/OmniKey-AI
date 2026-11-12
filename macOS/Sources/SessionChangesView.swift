import AppKit
import CodeEditTextView
import SwiftUI

// MARK: - Header button

/// Accessible "Changes" button for the chat header (pending chats included).
struct SessionChangesHeaderButton: View {
    @ObservedObject var model: ChatModel
    @State private var isPresented = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button { isPresented = true } label: {
            Image(systemName: "plusminus.circle")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.85))
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Changes")
        .accessibilityLabel("Session changes")
        .accessibilityHint("Shows file changes in folders tracked for this chat")
        .keyboardShortcut("d", modifiers: [.command, .shift])
        .sheet(isPresented: $isPresented) {
            SessionChangesSheet(
                sessionKey: model.changesSessionKey,
                sessionHasTurns: model.activeSessionHasTurns,
                isRunning: model.isRunning,
                onClose: { isPresented = false }
            )
        }
    }
}

// MARK: - Sheet

struct SessionChangesSheet: View {
    let sessionKey: String
    let sessionHasTurns: Bool
    let isRunning: Bool
    let onClose: () -> Void

    @StateObject private var viewModel: SessionChangesViewModel
    @State private var showSettings = false
    @State private var confirmDelete = false
    @Environment(\.colorScheme) private var colorScheme

    init(sessionKey: String, sessionHasTurns: Bool, isRunning: Bool, onClose: @escaping () -> Void) {
        self.sessionKey = sessionKey
        self.sessionHasTurns = sessionHasTurns
        self.isRunning = isRunning
        self.onClose = onClose
        _viewModel = StateObject(wrappedValue: SessionChangesViewModel(sessionKey: sessionKey))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 520, idealWidth: 880, maxWidth: .infinity, minHeight: 360, idealHeight: 620, maxHeight: .infinity)
        .background(NordTheme.panelBackground(colorScheme))
        .onAppear { viewModel.reload() }
        .onChange(of: sessionKey) { _, newValue in viewModel.switchSession(to: newValue) }
        .onChange(of: isRunning) { _, _ in viewModel.reload() }
        .onReceive(NotificationCenter.default.publisher(for: SessionChangeTracker.didChange)) { event in
            if event.object as? String == sessionKey { viewModel.reload() }
        }
        .confirmationDialog("Delete saved snapshots for this chat?", isPresented: $confirmDelete) {
            Button("Delete Snapshots", role: .destructive) { viewModel.deleteSnapshots() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Baselines, latest captures and tracked folders for this chat are removed. Files on disk are not touched.")
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "plusminus.circle")
                .foregroundColor(NordTheme.accent(colorScheme))
                .accessibilityHidden(true)
            Text("Changes")
                .font(OKFont.headline)
                .foregroundColor(NordTheme.primaryText(colorScheme))
            if let snapshot = viewModel.snapshot, !snapshot.changes.isEmpty {
                Text("\(snapshot.changes.count) files")
                    .font(OKFont.captionSmall)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            Spacer(minLength: 8)
            if viewModel.isBusy { ProgressView().controlSize(.small) }
            Button { viewModel.refreshCapture() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                .labelStyle(.iconOnly)
                .help("Capture current state now (labelled as observed)")
                .accessibilityLabel("Refresh capture")
                .disabled(viewModel.isBusy || (viewModel.snapshot?.roots.isEmpty ?? true))
            Button { showSettings.toggle() } label: { Label("Storage settings", systemImage: "gearshape") }
                .labelStyle(.iconOnly)
                .help("Storage budget, limits and retention")
                .popover(isPresented: $showSettings, arrowEdge: .bottom) {
                    SessionChangesSettingsForm(
                        initial: viewModel.snapshot?.settings ?? .default,
                        storedBytes: viewModel.snapshot?.storedBytes ?? 0,
                        onSave: { viewModel.saveSettings($0); showSettings = false }
                    )
                }
            Button("Done", action: onClose)
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .idle where viewModel.snapshot == nil, .loading where viewModel.snapshot == nil:
            ProgressView("Loading changes…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message) where viewModel.snapshot == nil:
            messageView(icon: "exclamationmark.triangle", title: "Couldn't load changes", detail: message,
                        tint: NordTheme.accentAmber(colorScheme))
        default:
            VStack(spacing: 0) {
                rootsSection
                Divider()
                if let snapshot = viewModel.snapshot, !snapshot.roots.isEmpty {
                    HSplitView {
                        fileList(snapshot)
                            .frame(minWidth: 180, idealWidth: 260, maxWidth: 380)
                        diffPane
                            .frame(minWidth: 280, maxWidth: .infinity)
                    }
                } else {
                    messageView(icon: "folder.badge.plus", title: "No tracked folders",
                                detail: "Choose a folder to start tracking. Its current files—including uncommitted and untracked edits—become this chat's baseline.",
                                tint: NordTheme.accent(colorScheme))
                }
            }
        }
    }

    private var rootsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error = viewModel.actionError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(OKFont.captionSmall)
                    .foregroundColor(NordTheme.accentAmber(colorScheme))
                    .accessibilityLabel("Error: \(error)")
            }
            if let snapshot = viewModel.snapshot {
                if let error = snapshot.captureError {
                    Label("Capture incomplete: " + error, systemImage: "exclamationmark.triangle")
                        .font(OKFont.captionSmall)
                        .foregroundColor(NordTheme.accentAmber(colorScheme))
                }
                if snapshot.info?.expired == true {
                    Label("Snapshots for this chat expired under the retention policy and were removed.",
                          systemImage: "clock.badge.xmark")
                        .font(OKFont.captionSmall)
                        .foregroundColor(NordTheme.accentAmber(colorScheme))
                }
                if snapshot.budgetExhausted {
                    Label("Storage budget reached — some content was not stored. Raise the budget or delete old snapshots.",
                          systemImage: "externaldrive.badge.exclamationmark")
                        .font(OKFont.captionSmall)
                        .foregroundColor(NordTheme.accentAmber(colorScheme))
                }
                ForEach(snapshot.roots) { root in
                    SessionRootRow(root: root, onStop: { viewModel.stopTracking(root) })
                }
            }
            HStack(spacing: 8) {
                Button { viewModel.chooseFolder(sessionHasTurns: sessionHasTurns) } label: {
                    Label("Track Folder…", systemImage: "folder.badge.plus")
                }
                .disabled(viewModel.isBusy)
                if let snapshot = viewModel.snapshot, !snapshot.roots.isEmpty || snapshot.info != nil {
                    Toggle("Pin snapshots", isOn: Binding(
                        get: { snapshot.info?.pinned ?? false },
                        set: { viewModel.setPinned($0) }
                    ))
                    .toggleStyle(.checkbox)
                    .help("Pinned snapshots are exempt from retention but still count toward the storage budget.")
                    Button("Delete Snapshots…", role: .destructive) { confirmDelete = true }
                        .disabled(viewModel.isBusy || isRunning)
                        .help(isRunning ? "Unavailable while a turn is running (active baseline)." : "Delete saved snapshots for this chat")
                }
                Spacer()
            }
            .controlSize(.small)
            Text("Changes are the net difference between the baseline and the latest capture. Captures happen before and after each local shell command and at the end of a turn; writes by you, other apps or background processes cannot be perfectly attributed, and intermediate edits are not recorded. Remote tools (MCP, scheduled jobs) are not captured.")
                .font(OKFont.captionSmall)
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func fileList(_ snapshot: SessionChangesSnapshot) -> some View {
        Group {
            if snapshot.changes.isEmpty {
                messageView(icon: "checkmark.circle", title: "No changes",
                            detail: "Latest capture matches the baseline.", tint: NordTheme.accentGreen(colorScheme))
            } else {
                List(selection: Binding(get: { viewModel.selectedChangeID }, set: { viewModel.select($0) })) {
                    ForEach(snapshot.changes) { change in
                        SessionChangeRow(change: change, showRoot: snapshot.roots.count > 1)
                            .tag(change.id)
                    }
                }
                .listStyle(.sidebar)
                .accessibilityLabel("Changed files")
            }
        }
    }

    @ViewBuilder
    private var diffPane: some View {
        if let change = viewModel.selectedChange {
            VStack(spacing: 0) {
                SessionDiffHeader(change: change, diffState: viewModel.diffState, viewModel: viewModel)
                Divider()
                switch viewModel.diffState {
                case .none, .loading:
                    ProgressView("Computing diff…").frame(maxWidth: .infinity, maxHeight: .infinity)
                case let .failed(message):
                    messageView(icon: "exclamationmark.triangle", title: "Couldn't load this file", detail: message,
                                tint: NordTheme.accentAmber(colorScheme))
                case let .loaded(.card(reason)):
                    SessionMetadataCard(change: change, reason: reason)
                case let .loaded(.text(preview, _)):
                    if preview.lines.isEmpty {
                        messageView(icon: "doc", title: "No line changes",
                                    detail: change.status == .modeChanged ? "Only file permissions changed."
                                        : "Content is identical as text (for example an empty file was added or removed).",
                                    tint: NordTheme.accent(colorScheme))
                    } else {
                        SessionDiffTextView(diff: preview, colorScheme: colorScheme)
                            .accessibilityLabel("Diff of \(change.relPath), \(preview.added) added, \(preview.removed) removed lines")
                    }
                }
            }
        } else {
            messageView(icon: "sidebar.left", title: "Select a file", detail: "Choose a changed file to see its diff.",
                        tint: NordTheme.accent(colorScheme))
        }
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Text("Excluded by default: " + SessionChangesScanner.exclusionSummary.prefix(10).joined(separator: ", ") + ", …")
                .lineLimit(1)
                .truncationMode(.tail)
                .help(SessionChangesScanner.exclusionSummary.joined(separator: ", "))
            Spacer()
            if let snapshot = viewModel.snapshot {
                Text("Storage: \(Self.bytes(snapshot.storedBytes)) of \(Self.bytes(snapshot.settings.budgetBytes))")
                    .accessibilityLabel("Storage used \(Self.bytes(snapshot.storedBytes)) of \(Self.bytes(snapshot.settings.budgetBytes))")
            }
        }
        .font(OKFont.captionSmall)
        .foregroundColor(NordTheme.secondaryText(colorScheme))
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
    }

    private func messageView(icon: String, title: String, detail: String, tint: Color) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 26)).foregroundColor(tint.opacity(0.8))
                .accessibilityHidden(true)
            Text(title).font(OKFont.bodyEmphasized).foregroundColor(NordTheme.primaryText(colorScheme))
            Text(detail).font(OKFont.captionSmall).foregroundColor(NordTheme.secondaryText(colorScheme))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    static func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }
}

// MARK: - Rows

private struct SessionRootRow: View {
    let root: SessionRootInfo
    let onStop: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: root.active ? "folder.fill" : "folder")
                .foregroundColor(NordTheme.accentBlue(colorScheme))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(root.path).font(OKFont.monoCaption).lineLimit(1).truncationMode(.middle)
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .textSelection(.enabled)
                Text(coverageText).font(OKFont.captionSmall)
                    .foregroundColor(root.coverage.isPartial || root.baselinePartial
                                     ? NordTheme.accentAmber(colorScheme) : NordTheme.secondaryText(colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            if root.active {
                Button("Stop Tracking", action: onStop).controlSize(.small)
                    .help("Stops capturing this folder. The existing baseline is kept and is not reset if re-added.")
            } else {
                Text("Paused").font(OKFont.captionSmall).foregroundColor(NordTheme.secondaryText(colorScheme))
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var coverageText: String {
        let label = root.baselineLabel == .sessionStart ? "Baseline: session start" : "Baseline: tracking start (after session began)"
        var parts = [label + ", " + root.baselineAt.formatted(date: .abbreviated, time: .shortened)]
        let c = root.coverage
        parts.append("\(c.filesSeen) files")
        if c.excludedEntries > 0 { parts.append("\(c.excludedEntries) excluded") }
        if c.oversize > 0 { parts.append("\(c.oversize) over size limit") }
        if c.unreadable > 0 { parts.append("\(c.unreadable) unreadable") }
        if c.symlinksNotFollowed > 0 { parts.append("\(c.symlinksNotFollowed) symlinks not followed") }
        if c.budgetSkipped > 0 { parts.append("\(c.budgetSkipped) not stored (budget)") }
        if c.rootMissing { parts.append("folder not accessible") }
        if c.hitFileLimit || c.hitByteLimit { parts.append("partial scan — deletions not inferred") }
        if root.baselinePartial { parts.append("baseline partial") }
        return parts.joined(separator: " · ")
    }
}

private struct SessionChangeRow: View {
    let change: SessionFileChange
    let showRoot: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 6) {
            Text(SessionChangePresentation.badge(change.status))
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(SessionChangePresentation.tint(change.status, colorScheme))
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(change.relPath).font(OKFont.monoCaption).lineLimit(1).truncationMode(.middle)
                if showRoot || change.attribution == .observed || !change.contentAvailable {
                    Text(subtitle).font(.system(size: 10)).foregroundColor(NordTheme.secondaryText(colorScheme)).lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(change.relPath), \(SessionChangePresentation.label(change.status))\(change.attribution == .observed ? ", observed outside a tool run" : "")")
    }

    private var subtitle: String {
        var parts: [String] = []
        if showRoot { parts.append(URL(fileURLWithPath: change.rootPath).lastPathComponent) }
        if change.attribution == .observed { parts.append("observed") }
        if !change.contentAvailable { parts.append("content unavailable") }
        return parts.joined(separator: " · ")
    }
}

enum SessionChangePresentation {
    static func badge(_ status: SessionChangeStatus) -> String {
        switch status {
        case .added: return "A"
        case .notInBaseline: return "?"
        case .deleted: return "D"
        case .modified: return "M"
        case .modeChanged: return "P"
        case .typeChanged: return "T"
        }
    }

    static func label(_ status: SessionChangeStatus) -> String {
        switch status {
        case .added: return "Added"
        case .notInBaseline: return "Not in partial baseline"
        case .deleted: return "Deleted"
        case .modified: return "Modified"
        case .modeChanged: return "Permissions changed"
        case .typeChanged: return "Type changed"
        }
    }

    static func tint(_ status: SessionChangeStatus, _ scheme: ColorScheme) -> Color {
        switch status {
        case .added: return NordTheme.accentGreen(scheme)
        case .deleted: return Color(nsColor: .systemRed)
        case .modified, .typeChanged: return NordTheme.accentAmber(scheme)
        case .modeChanged, .notInBaseline: return NordTheme.accentPurple(scheme)
        }
    }
}

private struct SessionDiffHeader: View {
    let change: SessionFileChange
    let diffState: SessionChangesViewModel.DiffState
    @ObservedObject var viewModel: SessionChangesViewModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(change.relPath).font(OKFont.monoCaption).lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
                Text(SessionChangePresentation.label(change.status))
                    .font(OKFont.captionSmall)
                    .foregroundColor(SessionChangePresentation.tint(change.status, colorScheme))
                Spacer(minLength: 4)
                if case let .loaded(.text(preview, patch)) = diffState {
                    Text("+\(preview.added) −\(preview.removed)").font(OKFont.monoCaption)
                        .accessibilityLabel("\(preview.added) lines added, \(preview.removed) lines removed")
                    if let patch {
                        Button("Copy Patch") { viewModel.copyPatch(patch) }
                        Button("Export…") { viewModel.exportPatch(patch, suggestedName: URL(fileURLWithPath: change.relPath).lastPathComponent) }
                    }
                }
                if change.latest != nil {
                    Button("Reveal") { viewModel.openOriginal(change) }
                        .help("Reveal the live file in Finder")
                }
            }
            .controlSize(.small)
            if change.attribution == .observed {
                Text("Last change observed outside an agent tool run (you, another app, or a background process).")
                    .font(OKFont.captionSmall).foregroundColor(NordTheme.accentPurple(colorScheme))
            }
            if case let .loaded(.text(preview, _)) = diffState {
                if preview.previewTruncated {
                    Text("Preview truncated (long file or lines). Export the patch for the complete exact diff.")
                        .font(OKFont.captionSmall).foregroundColor(NordTheme.accentAmber(colorScheme))
                }
                if preview.approximate {
                    Text("Too many edits for a minimal diff; the changed region is shown as a whole replacement.")
                        .font(OKFont.captionSmall).foregroundColor(NordTheme.accentAmber(colorScheme))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

private struct SessionMetadataCard: View {
    let change: SessionFileChange
    let reason: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(reason).font(OKFont.bodyCompact).foregroundColor(NordTheme.primaryText(colorScheme))
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    GridRow { Text(""); Text("Baseline").bold(); Text("Latest").bold() }
                    row("State", change.base.map { $0.state.rawValue } ?? "absent", change.latest.map { $0.state.rawValue } ?? "absent")
                    row("Type", change.base?.kind.rawValue ?? "—", change.latest?.kind.rawValue ?? "—")
                    row("Size", change.base.map { SessionChangesSheet.bytes($0.size) } ?? "—",
                        change.latest.map { SessionChangesSheet.bytes($0.size) } ?? "—")
                    row("Mode", change.base.map { String($0.mode, radix: 8) } ?? "—", change.latest.map { String($0.mode, radix: 8) } ?? "—")
                    row("Link", change.base?.linkTarget ?? "—", change.latest?.linkTarget ?? "—")
                    row("SHA-256", change.base?.hash.map { String($0.prefix(16)) + "…" } ?? "—",
                        change.latest?.hash.map { String($0.prefix(16)) + "…" } ?? "—")
                }
                .font(OKFont.monoCaption)
                .textSelection(.enabled)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func row(_ label: String, _ a: String, _ b: String) -> some View {
        GridRow {
            Text(label).foregroundColor(NordTheme.secondaryText(colorScheme))
            Text(a).lineLimit(1).truncationMode(.middle)
            Text(b).lineLimit(1).truncationMode(.middle)
        }
    }
}

// MARK: - Settings

private struct SessionChangesSettingsForm: View {
    @State private var budgetMB: Int
    @State private var perFileMB: Int
    @State private var retentionDays: Int
    @State private var maxFiles: Int
    let storedBytes: Int64
    let onSave: (SessionChangesSettings) -> Void
    private let initial: SessionChangesSettings

    init(initial: SessionChangesSettings, storedBytes: Int64, onSave: @escaping (SessionChangesSettings) -> Void) {
        self.initial = initial
        self.storedBytes = storedBytes
        self.onSave = onSave
        _budgetMB = State(initialValue: Int(initial.budgetBytes >> 20))
        _perFileMB = State(initialValue: max(1, Int(initial.perFileLimitBytes >> 20)))
        _retentionDays = State(initialValue: initial.retentionDays)
        _maxFiles = State(initialValue: initial.maxFilesPerRoot)
    }

    var body: some View {
        Form {
            Stepper("Storage budget: \(budgetMB) MB", value: $budgetMB, in: 64...65_536, step: 64)
            Stepper("Per-file limit: \(perFileMB) MB", value: $perFileMB, in: 1...16)
            Stepper("Keep unpinned for \(retentionDays) days", value: $retentionDays, in: 1...365)
            Stepper("Max files per folder: \(maxFiles)", value: $maxFiles, in: 1_000...200_000, step: 1_000)
            Text("Used: \(SessionChangesSheet.bytes(storedBytes)) (pinned chats included)")
                .font(OKFont.captionSmall)
            HStack {
                Spacer()
                Button("Save") {
                    var settings = initial
                    settings.budgetBytes = Int64(budgetMB) << 20
                    settings.perFileLimitBytes = Int64(perFileMB) << 20
                    settings.retentionDays = retentionDays
                    settings.maxFilesPerRoot = maxFiles
                    onSave(settings)
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(width: 320)
    }
}

// MARK: - Diff text (CodeEditTextView)

/// Read-only, selectable diff rendered with CodeEditTextView. Each row is
/// "old new │ ±text"; semantic colors mark added/removed/hunk rows.
struct SessionDiffTextView: NSViewRepresentable {
    let diff: SessionFileDiff
    let colorScheme: ColorScheme

    static func render(_ diff: SessionFileDiff) -> (text: String, kinds: [(NSRange, SessionDiffLine.Kind)]) {
        let width = max(3, String(diff.lines.compactMap { max($0.oldNumber ?? 0, $0.newNumber ?? 0) }.max() ?? 0).count)
        func pad(_ n: Int?) -> String {
            let s = n.map(String.init) ?? ""
            return String(repeating: " ", count: max(0, width - s.count)) + s
        }
        var text = ""
        var utf16Offset = 0
        var kinds: [(NSRange, SessionDiffLine.Kind)] = []
        for line in diff.lines {
            let marker: String
            switch line.kind {
            case .added: marker = "+"
            case .removed: marker = "-"
            case .context: marker = " "
            case .hunkHeader, .noNewline: marker = ""
            }
            var body = line.text
            if body.hasSuffix("\r") { body.removeLast(); body += "␍" }
            let row = line.kind == .hunkHeader
                ? line.text
                : "\(pad(line.oldNumber)) \(pad(line.newNumber)) │ \(marker)\(body)"
            let length = row.utf16.count
            text += row + "\n"
            kinds.append((NSRange(location: utf16Offset, length: length), line.kind))
            utf16Offset += length + 1
        }
        return (text, kinds)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = TextView(
            string: "",
            font: .monospacedSystemFont(ofSize: 12, weight: .regular),
            textColor: .labelColor,
            wrapLines: false,
            isEditable: false,
            isSelectable: true
        )
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.drawsBackground = false
        scrollView.documentView = textView
        let tint = SessionDiffLineTintView(frame: textView.bounds)
        tint.autoresizingMask = [.width, .height]
        tint.textView = textView
        textView.addSubview(tint)
        context.coordinator.tintView = tint
        context.coordinator.textView = textView
        apply(to: textView, coordinator: context.coordinator)
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = context.coordinator.textView else { return }
        apply(to: textView, coordinator: context.coordinator)
    }

    private func apply(to textView: TextView, coordinator: Coordinator) {
        guard coordinator.lastDiff != diff || coordinator.lastScheme != colorScheme else { return }
        coordinator.lastDiff = diff
        coordinator.lastScheme = colorScheme
        let (text, kinds) = Self.render(diff)
        let storage = NSTextStorage(string: text)
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        storage.addAttributes([.font: font, .foregroundColor: NSColor.labelColor],
                              range: NSRange(location: 0, length: storage.length))
        // setTextStorage re-applies typing attributes over the whole
        // document, so semantic colors are applied afterwards.
        textView.setTextStorage(storage)
        storage.beginEditing()
        let green = NSColor(NordTheme.accentGreen(colorScheme))
        let red = NSColor.systemRed
        let hunk = NSColor(NordTheme.accentBlue(colorScheme))
        for (range, kind) in kinds {
            switch kind {
            case .added: storage.addAttribute(.foregroundColor, value: green, range: range)
            case .removed: storage.addAttribute(.foregroundColor, value: red, range: range)
            case .hunkHeader: storage.addAttribute(.foregroundColor, value: hunk, range: range)
            case .noNewline: storage.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor, range: range)
            case .context: break
            }
        }
        storage.endEditing()
        textView.updateFrameIfNeeded()
        coordinator.tintView?.rows = kinds
        coordinator.tintView?.frame = textView.bounds
        coordinator.tintView?.needsDisplay = true
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var textView: TextView?
        var tintView: SessionDiffLineTintView?
        var lastDiff: SessionFileDiff?
        var lastScheme: ColorScheme?
    }
}

/// A mouse-transparent native tint surface. CodeEditTextView does not render
/// attributed-string background colors; draw visible full-width line tints
/// using its actual CoreText layout instead of guessing line heights.
final class SessionDiffLineTintView: NSView {
    weak var textView: TextView?
    var rows: [(NSRange, SessionDiffLine.Kind)] = []
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        guard let textView, let visible = textView.visibleTextRange else { return }
        for (range, kind) in rows where NSIntersectionRange(range, visible).length > 0 {
            guard kind == .added || kind == .removed,
                  let rect = textView.layoutManager.rectForOffset(range.location) else { continue }
            let color: NSColor = kind == .added ? .systemGreen : .systemRed
            color.withAlphaComponent(0.09).setFill()
            NSRect(x: 0, y: rect.minY, width: bounds.width, height: rect.height).intersection(dirtyRect).fill()
        }
    }
}
