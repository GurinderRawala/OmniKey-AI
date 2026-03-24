import SwiftUI

struct TaskInstructionsView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var statusMessage: String = ""
    @State private var isLoading: Bool = false
    @State private var savedTemplates: [APIClient.TaskTemplateDTO] = []
    @State private var selectedTemplateId: String?
    @State private var templateHeadingInput: String = ""
    @State private var templateInstructionsInput: String = ""
    @State private var selectedExampleIndex: Int = -1

    private let apiClient = APIClient()
    private let exampleTemplates: [TaskTemplate] = [
        EditorPolishTemplate.template,
        SQLTemplate.template,
    ]

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                // Header area
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        Image(systemName: "list.bullet.rectangle.portrait")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(NordTheme.accent(colorScheme))

                        Text("Task Templates for Cmd+T")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme))
                    }

                    Text("Save up to 5 task instruction templates. Choose one as the default to run whenever you press Cmd+T.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
                .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)
                    .padding(.bottom, 16)

                // Controls row
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .center, spacing: 14) {
                        // Template heading field
                        TextField("Template heading", text: $templateHeadingInput)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 380)

                        // Template picker with label
                        HStack(spacing: 6) {
                            Text("Template:")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(NordTheme.secondaryText(colorScheme))

                            Picker("Template", selection: $selectedTemplateId) {
                                ForEach(savedTemplates) { template in
                                    Text(template.isDefault ? "\(template.heading) (default)" : template.heading)
                                        .tag(Optional(template.id))
                                }
                                if savedTemplates.count < 5 {
                                    Text(savedTemplates.isEmpty ? "No templates yet" : "New template")
                                        .tag(String?.none)
                                }
                            }
                            .labelsHidden()
                            .frame(maxWidth: 240)
                            .onChange(of: selectedTemplateId) { _ in
                                loadSelectedTemplateIntoEditor()
                            }
                        }

                        Spacer(minLength: 0)
                    }

                    // Example picker — only visible when creating new template
                    if selectedTemplateId == nil {
                        HStack(spacing: 6) {
                            Text("Load example:")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(NordTheme.secondaryText(colorScheme))

                            Picker("Load example", selection: $selectedExampleIndex) {
                                Text("None")
                                    .tag(-1)
                                ForEach(exampleTemplates.indices, id: \.self) { index in
                                    Text(exampleTemplates[index].name)
                                        .tag(index)
                                }
                            }
                            .labelsHidden()
                            .frame(maxWidth: 220)
                            .onChange(of: selectedExampleIndex) { newValue in
                                applyExampleTemplate(at: newValue)
                            }

                            Spacer(minLength: 0)
                        }
                    }

                    // Text editor
                    templateTextEditor()
                }
                .padding(16)
                .background(
                    ZStack {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(NordTheme.panelBackground(colorScheme))

                        LinearGradient(
                            gradient: Gradient(colors: [
                                NordTheme.accent(colorScheme).opacity(colorScheme == .dark ? 0.03 : 0.02),
                                Color.clear,
                            ]),
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
                )

                // Bottom button bar
                HStack(spacing: 10) {
                    // Destructive delete
                    Button(role: .destructive) {
                        deleteCurrentTemplate()
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "trash")
                                .font(.system(size: 11))
                            Text("Delete Template")
                                .font(.system(size: 12))
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255).opacity(colorScheme == .dark ? 0.09 : 0.06))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255).opacity(0.22), lineWidth: 1)
                    )
                    .disabled(selectedTemplateId == nil)

                    // Status message
                    if !statusMessage.isEmpty {
                        HStack(spacing: 5) {
                            if isPositiveStatus(statusMessage) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(NordTheme.accentGreen(colorScheme))
                            } else if isNegativeStatus(statusMessage) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255))
                            }

                            Text(statusMessage)
                                .font(.system(size: 11))
                                .foregroundColor(statusMessageColor(statusMessage))
                                .lineLimit(1)
                        }
                    }

                    if isLoading {
                        ProgressView()
                            .scaleEffect(0.7)
                    }

                    Spacer()

                    Button("Close") {
                        NSApp.keyWindow?.performClose(nil)
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                    Button("Use for Cmd+T") {
                        setCurrentTemplateAsDefault()
                    }
                    .disabled(selectedTemplateId == nil)

                    Button("Save Template") {
                        saveCurrentTemplate()
                    }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .tint(NordTheme.accentBlue(colorScheme))
                    .disabled(isLoading || templateHeadingInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || savedTemplates.count >= 5 && selectedTemplateId == nil)
                }
                .padding(.top, 12)
                .padding(.horizontal, 2)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 22)
            .frame(maxWidth: 980, maxHeight: .infinity, alignment: .top)
        }
        .frame(minWidth: 900, minHeight: 640)
        .onAppear {
            fetchTemplates()
        }
        .onChange(of: templateInstructionsInput) { _ in
            guard !isLoading else { return }
            statusMessage = ""
        }
    }

    // MARK: - Status Message Helpers

    private func isPositiveStatus(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower.contains("success") || lower.contains("created") || lower.contains("updated") || lower.contains("loaded") || lower.contains("set")
    }

    private func isNegativeStatus(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower.contains("failed") || lower.contains("error")
    }

    private func statusMessageColor(_ message: String) -> Color {
        if isPositiveStatus(message) {
            return NordTheme.accentGreen(colorScheme)
        } else if isNegativeStatus(message) {
            return Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255)
        } else {
            return NordTheme.secondaryText(colorScheme)
        }
    }

    // MARK: - Networking

    private func fetchTemplates() {
        apiClient.fetchTaskTemplates { result in
            DispatchQueue.main.async {
                switch result {
                case let .success(templates):
                    self.savedTemplates = templates
                    if let currentDefault = templates.first(where: { $0.isDefault }) {
                        self.selectedTemplateId = currentDefault.id
                        self.templateHeadingInput = currentDefault.heading
                        self.templateInstructionsInput = currentDefault.instructions
                    } else if let first = templates.first {
                        self.selectedTemplateId = first.id
                        self.templateHeadingInput = first.heading
                        self.templateInstructionsInput = first.instructions
                    } else {
                        self.selectedTemplateId = nil
                        self.templateHeadingInput = ""
                        self.templateInstructionsInput = ""
                    }
                    self.statusMessage = templates.isEmpty ? "No saved templates yet." : "Templates loaded."

                case let .failure(error):
                    self.statusMessage = "Failed to load templates: \(error.localizedDescription)"
                }
            }
        }
    }

    private func newTemplate() {
        selectedTemplateId = nil
        templateHeadingInput = ""
        templateInstructionsInput = ""
        statusMessage = "Creating new template."
    }

    private func saveCurrentTemplate() {
        let heading = templateHeadingInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = templateInstructionsInput

        guard !heading.isEmpty else { return }

        if let id = selectedTemplateId {
            apiClient.updateTaskTemplate(id: id, heading: heading, instructions: body) { result in
                DispatchQueue.main.async {
                    switch result {
                    case let .success(updated):
                        if let index = self.savedTemplates.firstIndex(where: { $0.id == updated.id }) {
                            self.savedTemplates[index] = updated
                        }
                        self.statusMessage = "Template updated."

                    case let .failure(error):
                        self.statusMessage = "Failed to update template: \(error.localizedDescription)"
                    }
                }
            }
        } else {
            apiClient.createTaskTemplate(heading: heading, instructions: body) { result in
                DispatchQueue.main.async {
                    switch result {
                    case let .success(created):
                        self.savedTemplates.append(created)
                        self.selectedTemplateId = created.id
                        self.statusMessage = "Template created."

                    case let .failure(error):
                        self.statusMessage = "Failed to create template: \(error.localizedDescription)"
                    }
                }
            }
        }
    }

    private func applyExampleTemplate(at index: Int) {
        guard selectedTemplateId == nil, index >= 0, exampleTemplates.indices.contains(index) else { return }

        let example = exampleTemplates[index]

        if templateHeadingInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            templateHeadingInput = example.name
        }

        templateInstructionsInput = example.content
        statusMessage = "Loaded example template \"\(example.name)\"."
    }

    private func setCurrentTemplateAsDefault() {
        guard let id = selectedTemplateId else { return }

        apiClient.setDefaultTaskTemplate(id: id) { result in
            DispatchQueue.main.async {
                switch result {
                case let .success(updatedDefault):
                    self.savedTemplates = self.savedTemplates.map { tpl in
                        if tpl.id == updatedDefault.id {
                            return updatedDefault
                        } else {
                            return APIClient.TaskTemplateDTO(
                                id: tpl.id,
                                heading: tpl.heading,
                                instructions: tpl.instructions,
                                isDefault: false
                            )
                        }
                    }
                    self.statusMessage = "Default template set for Cmd+T."

                case let .failure(error):
                    self.statusMessage = "Failed to set default: \(error.localizedDescription)"
                }
            }
        }
    }

    private func loadSelectedTemplateIntoEditor() {
        if let id = selectedTemplateId,
           let template = savedTemplates.first(where: { $0.id == id })
        {
            templateHeadingInput = template.heading
            templateInstructionsInput = template.instructions
            selectedExampleIndex = -1
        } else {
            newTemplate()
        }
    }

    private func deleteCurrentTemplate() {
        guard let id = selectedTemplateId else { return }

        isLoading = true
        statusMessage = "Deleting template..."

        apiClient.deleteTaskTemplate(id: id) { result in
            DispatchQueue.main.async {
                self.isLoading = false

                switch result {
                case .success:
                    if let index = self.savedTemplates.firstIndex(where: { $0.id == id }) {
                        self.savedTemplates.remove(at: index)
                    }

                    if let first = self.savedTemplates.first {
                        self.selectedTemplateId = first.id
                        self.templateHeadingInput = first.heading
                        self.templateInstructionsInput = first.instructions
                    } else {
                        self.selectedTemplateId = nil
                        self.templateHeadingInput = ""
                        self.templateInstructionsInput = ""
                    }

                    self.statusMessage = "Template deleted."

                case let .failure(error):
                    self.statusMessage = "Failed to delete template: \(error.localizedDescription)"
                }
            }
        }
    }

    // MARK: - Subviews

    private func templateTextEditor() -> some View {
        ZStack(alignment: .topLeading) {
            if templateInstructionsInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Describe the role, context, and task this template should apply when you press Cmd+T...")
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.7))
                    .padding(.top, 10)
                    .padding(.leading, 6)
                    .allowsHitTesting(false)
            }

            if #available(macOS 13.0, *) {
                TextEditor(text: $templateInstructionsInput)
                    .font(.system(size: 13, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .background(Color.clear)
                    .padding(4)
            } else {
                TextEditor(text: $templateInstructionsInput)
                    .font(.system(size: 13, design: .monospaced))
                    .background(Color.clear)
                    .padding(4)
            }
        }
        .frame(minHeight: 280)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(NordTheme.editorBackground(colorScheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(NordTheme.accentBlue(colorScheme).opacity(colorScheme == .dark ? 0.35 : 0.28), lineWidth: 1)
        )
    }
}
