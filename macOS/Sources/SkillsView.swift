import SwiftUI
import Textual

/// Manage backend Skills: keyword-triggered guidance applied to agent turns.
/// Labels stay literal; saved instructions use the app’s selectable Markdown renderer.
struct SkillsView: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var model: SkillsViewModel

    init(model: SkillsViewModel) {
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme).ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.horizontal, 24)
                    .padding(.top, 20)
                    .padding(.bottom, 14)

                Rectangle().fill(NordTheme.border(colorScheme)).frame(height: 1)

                if model.isUpgradeRequired {
                    upgradeRequired
                } else {
                    HStack(spacing: 0) {
                        listPane
                            .frame(width: 320)
                        Rectangle().fill(NordTheme.border(colorScheme)).frame(width: 1)
                        detailPane
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }

                statusBar
            }
        }
        .onAppear { model.onAppear() }
        .alert("Save changes to this skill?", isPresented: $model.showsUnsavedChanges) {
            Button("Save") { model.saveAndNavigate() }
            Button("Discard Changes", role: .destructive) { model.discardAndNavigate() }
            Button("Cancel", role: .cancel) { model.keepEditing() }
        } message: {
            Text("You have unsaved changes. Save or discard them before leaving this skill.")
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: Binding(
                get: { model.pendingDelete != nil },
                set: { if !$0 { model.pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Skill", role: .destructive) { model.confirmDelete() }
            Button("Cancel", role: .cancel) { model.pendingDelete = nil }
        } message: {
            Text("This permanently deletes the skill for this backend. It cannot undo work already done. A task that is already running keeps the version it started with — use Stop to end it.")
        }
    }

    /// Plain String (not a LocalizedStringKey) so names stay literal.
    private var deleteTitle: String {
        let name = model.pendingDelete.map { SkillStatusPresentation.displayName($0.name) } ?? ""
        return "Delete “" + name + "”?"
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))
                    .accessibilityHidden(true)
                Text("Skills")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .accessibilityAddTraits(.isHeader)

                Spacer()

                Button(action: model.refresh) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                }
                .buttonStyle(.bordered)
                .tint(NordTheme.accentBlue(colorScheme))
                .keyboardShortcut("r", modifiers: .command)
                .disabled(model.isListLoading)
                .help("Reload skills from the backend (⌘R)")

                Button(action: model.startCreate) {
                    Label("New Skill", systemImage: "plus")
                        .font(.system(size: 13, weight: .medium))
                }
                .buttonStyle(.borderedProminent)
                .tint(NordTheme.accent(colorScheme))
                .keyboardShortcut("n", modifiers: .command)
                .disabled(model.editor?.isSaving == true || model.isUpgradeRequired)
                .help("Create a skill (⌘N)")
            }

            Text("When a message you send to the agent contains a skill's keyword or phrase (whole words, case-insensitive), its instructions are added as guidance for that task only. Enabled instructions are sent to your selected AI provider when they match. Skills never grant extra tool or terminal permissions.")
                .font(.system(size: 12))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var upgradeRequired: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.up.circle")
                .font(.system(size: 36))
                .foregroundColor(NordTheme.accentAmber(colorScheme))
                .accessibilityHidden(true)
            Text("Backend update required")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))
            Text(SkillsAPIError.upgradeMessage)
                .font(.system(size: 13))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
            Button("Check Again", action: model.refresh)
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    // MARK: - List

    private var listPane: some View {
        Group {
            if model.isListLoading && model.skills.isEmpty {
                VStack { ProgressView("Loading skills…").padding() }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if case let .failed(error) = model.listState, model.skills.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 28))
                        .foregroundColor(NordTheme.accentAmber(colorScheme))
                        .accessibilityHidden(true)
                    Text(error.message)
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .multilineTextAlignment(.center)
                    Button("Retry", action: model.refresh).buttonStyle(.bordered)
                }
                .padding(20)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.skills.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 32))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .accessibilityHidden(true)
                    Text("No skills yet")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Text("Create a skill with a distinctive keyword, such as “sql review”. Skills created with the omnikey CLI on this backend appear here after Refresh.")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .multilineTextAlignment(.center)
                }
                .padding(20)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: Binding(
                    get: { model.sidebarSelection },
                    set: { id in model.select(id) }
                )) {
                    ForEach(model.skills) { skill in
                        row(skill).tag(skill.id)
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                .disabled(model.editor?.isSaving == true)
                .accessibilityLabel("Skills")
            }
        }
    }

    private func row(_ skill: SkillSummary) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(skill.enabled ? NordTheme.accentGreen(colorScheme) : NordTheme.secondaryText(colorScheme).opacity(0.5))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .lineLimit(1)
                Text(skill.keyword)
                    .font(.system(size: 11).monospaced())
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
                    .lineLimit(1)
            }
            Spacer()
            if model.busyIDs.contains(skill.id) {
                ProgressView().controlSize(.small)
            } else if !skill.enabled {
                Text("Disabled")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(skill.name), keyword \(skill.keyword), \(skill.enabled ? "enabled" : "disabled")"
                + (model.busyIDs.contains(skill.id) ? ", updating" : "")
        )
    }

    // MARK: - Detail / editor

    @ViewBuilder
    private var detailPane: some View {
        if let editor = model.editor {
            SkillEditorForm(model: model, editor: editor)
                .id(editor.sessionID)
        } else if let summary = model.selectedSummary {
            detailView(summary)
        } else {
            VStack(spacing: 6) {
                if !model.skills.isEmpty {
                    Text("Select a skill to view its instructions.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func detailView(_ summary: SkillSummary) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(summary.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                        .textSelection(.enabled)
                    HStack(spacing: 6) {
                        Text("Keyword")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                        Text(summary.keyword)
                            .font(.system(size: 12).monospaced())
                            .foregroundColor(NordTheme.accentPurple(colorScheme))
                            .textSelection(.enabled)
                    }
                }
                Spacer()
                if model.busyIDs.contains(summary.id) {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Updating")
                }
                Toggle("Enabled", isOn: Binding(
                    get: { summary.enabled },
                    set: { _ in model.toggleEnabled(summary) }
                ))
                .toggleStyle(.switch)
                .disabled(model.busyIDs.contains(summary.id) || !model.isDetailCurrent)
                .accessibilityHint("Disabled skills are ignored for new messages.")
            }

            HStack(spacing: 10) {
                Button("Edit") { model.startEdit() }
                    .keyboardShortcut("e", modifiers: .command)
                    .disabled(!model.isDetailCurrent || model.busyIDs.contains(summary.id))
                    .help("Edit this skill (⌘E)")
                Button("Delete…", role: .destructive) { model.requestDelete(summary) }
                    .keyboardShortcut(.delete, modifiers: .command)
                    .disabled(model.busyIDs.contains(summary.id) || !model.isDetailCurrent)
                    .help("Delete this skill (⌘⌫)")
                Spacer()
                Text("Revision \(summary.revision)")
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }

            Text("Instructions")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(NordTheme.secondaryText(colorScheme))

            Group {
                if let detail = model.detail, model.isDetailCurrent {
                    ScrollView {
                        SkillInstructionsPreview(instructions: detail.instructions)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                    .accessibilityLabel("Instructions")
                } else if case let .failed(error) = model.detailState {
                    VStack(spacing: 8) {
                        Text(error.message)
                            .font(.system(size: 12))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                        Button("Retry", action: model.refresh).buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(NordTheme.panelBackground(colorScheme))
            .cornerRadius(8)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(NordTheme.border(colorScheme), lineWidth: 1))

            Text("Changes affect the next message you send. A running task keeps the skills it started with; use Stop to end it.")
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
        .padding(20)
    }

    // MARK: - Status

    @ViewBuilder
    private var statusBar: some View {
        if let error = model.actionError {
            Text(error)
                .font(.system(size: 12))
                .foregroundColor(.red)
                .padding(.horizontal, 24)
                .padding(.vertical, 8)
                .accessibilityLabel("Error: \(error)")
        } else if let status = model.statusMessage {
            Text(status)
                .font(.system(size: 12))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .padding(.horizontal, 24)
                .padding(.vertical, 8)
        } else if case let .failed(error) = model.listState, !model.skills.isEmpty {
            Text("Couldn't refresh: \(error.message)")
                .font(.system(size: 12))
                .foregroundColor(.red)
                .padding(.horizontal, 24)
                .padding(.vertical, 8)
        }
    }
}

/// Height of the instructions editor inside the scrolling Skills form.
enum SkillEditorLayout {
    /// Preferred minimum when the viewport has room for it.
    static let minimumEditorHeight: CGFloat = 200
    /// Absolute floor, so the editor stays usable in tiny viewports.
    static let floorEditorHeight: CGFloat = 60
    /// Most of the form viewport the editor may take when the form has to
    /// scroll. The editor is a nested scroll view that keeps wheel events
    /// while its text overflows, so the rest of the viewport must stay
    /// outer form under the pointer, to scroll back to Name and Keyword.
    static let maximumViewportFraction: CGFloat = 0.6

    /// Fills the space left by `chrome` (the rest of the form) when that
    /// is at least the preferred minimum. Otherwise the form scrolls, and
    /// the editor gets the preferred minimum capped to a fraction of the
    /// viewport (never below the floor).
    static func instructionsHeight(viewport: CGFloat, chrome: CGFloat) -> CGFloat {
        let viewport = viewport.isFinite ? max(0, viewport) : 0
        let chrome = chrome.isFinite ? max(0, chrome) : 0
        let fill = (viewport - chrome).rounded(.down)
        if fill >= minimumEditorHeight { return fill }
        let cap = (viewport * maximumViewportFraction).rounded(.down)
        return max(floorEditorHeight, min(minimumEditorHeight, cap))
    }
}

/// Create/edit form. Drafts live in the view model so failures never lose text.
private struct SkillEditorForm: View {
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject var model: SkillsViewModel
    let editor: SkillsViewModel.EditorState

    private var isCreate: Bool { editor.mode == .create }

    private func binding<T>(_ keyPath: WritableKeyPath<SkillDraft, T>) -> Binding<T> {
        Binding(
            get: { model.editor?.draft[keyPath: keyPath] ?? editor.draft[keyPath: keyPath] },
            set: { value in
                guard model.editor?.isSaving != true else { return }
                model.editor?.draft[keyPath: keyPath] = value
            }
        )
    }

    /// Measured height of everything in the scrolling form except the
    /// instructions editor, so the editor can fill the rest of the viewport.
    @State private var formHeight: CGFloat = 0
    @State private var editorHeight: CGFloat = 0

    private func targetEditorHeight(viewport: CGFloat) -> CGFloat {
        SkillEditorLayout.instructionsHeight(viewport: viewport, chrome: max(0, formHeight - editorHeight))
    }

    /// Fields scroll; the Save/Cancel bar stays pinned below them, so both
    /// remain reachable in the smallest supported window (640×400 display).
    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { viewport in
                ScrollView(.vertical) {
                    form(editorHeight: targetEditorHeight(viewport: viewport.size.height))
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { formHeight = $0 }
                }
                .scrollIndicators(.automatic)
            }
            Rectangle().fill(NordTheme.border(colorScheme)).frame(height: 1)
            actionBar
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
        }
    }

    private func form(editorHeight target: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(isCreate ? "New Skill" : "Edit Skill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .accessibilityAddTraits(.isHeader)

            if let notice = editor.notice {
                banner(notice, color: NordTheme.accentBlue(colorScheme))
            }
            if let error = editor.error {
                banner(error.message, color: .red)
            }
            if editor.hasConflict, !isCreate {
                HStack {
                    Text("Your edits are kept. Reload the latest version, review, then save again.")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Spacer()
                    Button("Reload Latest", action: model.reloadLatestKeepingDraft)
                        .disabled(editor.isSaving)
                }
            }

            HStack(alignment: .top, spacing: 14) {
                field("Name", error: message(for: .name)) {
                    TextField("e.g. SQL review", text: binding(\.name))
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Skill name")
                }
                field("Keyword or phrase", error: message(for: .keyword)) {
                    TextField("e.g. sql review", text: binding(\.keyword))
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 13).monospaced())
                        .accessibilityLabel("Trigger keyword")
                }
            }
            .disabled(editor.isSaving)

            Text("Matches whole words in the text you type, ignoring case and extra spaces. “sql” matches “(SQL)” but not “nosql”. Quoted text and code count too, so prefer a distinctive phrase.")
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .fixedSize(horizontal: false, vertical: true)

            Toggle("Enabled", isOn: binding(\.enabled))
                .toggleStyle(.switch)
                .disabled(editor.isSaving)
            if let enabledNote = message(for: .enabled) {
                Text(enabledNote)
                    .font(.system(size: 11))
                    .foregroundColor(.red)
                    .accessibilityLabel("Enabled: \(enabledNote)")
            }

            field("Instructions", error: message(for: .instructions)) {
                MarkdownTextEditor(
                    text: binding(\.instructions),
                    sessionKey: "skill-editor-\(editor.sessionID.uuidString)",
                    colorScheme: colorScheme,
                    editorLabel: "Skill instructions"
                )
                .frame(maxWidth: .infinity)
                .frame(height: target)
                .background(NordTheme.editorBackground(colorScheme))
                .cornerRadius(6)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(NordTheme.border(colorScheme), lineWidth: 1))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { editorHeight = $0 }
            }
        }
    }

    /// Count and actions side by side, or stacked when the pane is narrow,
    /// so the buttons are never clipped.
    private var actionBar: some View {
        let count = (model.editor?.draft.instructions ?? editor.draft.instructions).codePointCount
        let counter = Text("\(count) / \(SkillLimits.instructionCodePoints) characters")
            .font(.system(size: 10).monospacedDigit())
            .foregroundColor(count > SkillLimits.instructionCodePoints ? .red : NordTheme.secondaryText(colorScheme))
        return ViewThatFits(in: .horizontal) {
            HStack {
                counter
                Spacer(minLength: 8)
                actionButtons
            }
            VStack(alignment: .trailing, spacing: 6) {
                counter.frame(maxWidth: .infinity, alignment: .leading)
                actionButtons
            }
        }
    }

    private var actionButtons: some View {
        HStack(spacing: 8) {
            if editor.isSaving { ProgressView().controlSize(.small) }
            Button("Cancel", action: model.requestCloseEditor)
                .keyboardShortcut(.cancelAction)
                .disabled(editor.isSaving)
            Button(isCreate ? "Create Skill" : "Save Changes", action: model.save)
                .buttonStyle(.borderedProminent)
                .tint(NordTheme.accent(colorScheme))
                .keyboardShortcut("s", modifiers: .command)
                .disabled(editor.isSaving)
                .help("Save (⌘S)")
        }
        .fixedSize()
    }

    /// Server/local field error first, then a same-field conflict note.
    private func message(for field: SkillDraftRebase.Field) -> String? {
        if let error = editor.fieldErrors[field.rawValue] { return error }
        guard editor.conflictFields.contains(field) else { return nil }
        return "Also changed elsewhere. Your version is kept and will replace it on save."
    }

    private func banner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundColor(color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(color.opacity(0.08)))
    }

    private func field<Content: View>(
        _ label: String, error: String?, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
            content()
            if let error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundColor(.red)
                    .accessibilityLabel("\(label) error: \(error)")
            }
        }
    }
}


/// Read-only counterpart to MarkdownTextEditor: render the saved source without
/// rewriting it, while retaining headings, lists, code blocks and selection.
struct SkillInstructionsPreview: View {
    let instructions: String

    var body: some View {
        StructuredText(markdown: instructions)
            .chatStructuredTextStyle()
            .textual.textSelection(.enabled)
            .font(.system(size: 13))
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
