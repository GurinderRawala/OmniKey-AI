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

            VStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Task templates for ⌘T")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))

                    Text("You can save up to 5 task instruction templates. Choose one as the default to run whenever you press ⌘T.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                    // Compact layout: first row = heading + saved templates, second row (when new) = examples
                    VStack(spacing: 8) {
                        HStack(alignment: .center, spacing: 16) {
                            TextField("Template heading", text: $templateHeadingInput)
                                .textFieldStyle(.roundedBorder)
                                .frame(maxWidth: 400)

                            Picker("Template", selection: $selectedTemplateId) {
                                ForEach(savedTemplates) { template in
                                    Text(template.isDefault ? "★ \(template.heading)" : template.heading)
                                        .tag(Optional(template.id))
                                }
                                if savedTemplates.count < 5 {
                                    Text(savedTemplates.isEmpty ? "No templates yet" : "New template")
                                        .tag(Optional<String>.none)
                                }
                            }
                            .labelsHidden()
                            .frame(maxWidth: 260)
                            .onChange(of: selectedTemplateId) { _ in
                                loadSelectedTemplateIntoEditor()
                            }

                            Spacer(minLength: 0)
                        }

                        if selectedTemplateId == nil {
                            HStack {
                                Picker("Example", selection: $selectedExampleIndex) {
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

                        templateTextEditor()
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 16)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(NordTheme.panelBackground(colorScheme))
                        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
                )

                HStack(spacing: 8) {
                    Button("Delete Template") {
                        deleteCurrentTemplate()
                    }
                    .disabled(selectedTemplateId == nil)

                    Text(statusMessage)
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                    if isLoading {
                        ProgressView()
                            .scaleEffect(0.7)
                    }

                    Spacer()

                    Button("Close") {
                        NSApp.keyWindow?.performClose(nil)
                    }

                    Button("Use for ⌘T") {
                        setCurrentTemplateAsDefault()
                    }
                    .disabled(selectedTemplateId == nil)

                    Button("Save Template") {
                        saveCurrentTemplate()
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isLoading || templateHeadingInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || savedTemplates.count >= 5 && selectedTemplateId == nil)
                    .tint(NordTheme.accent(colorScheme))
                }
                .padding(.horizontal, 4)
                .padding(.top, 10)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
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
        // Only allow applying example templates when creating a new template.
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
                        APIClient.TaskTemplateDTO(
                            id: tpl.id,
                            heading: tpl.heading,
                            instructions: tpl.instructions,
                            isDefault: tpl.id == updatedDefault.id
                        )
                    }
                    self.statusMessage = "Default template set for ⌘T."

                case let .failure(error):
                    self.statusMessage = "Failed to set default: \(error.localizedDescription)"
                }
            }
        }
    }

    private func loadSelectedTemplateIntoEditor() {
        // When a template is selected from the dropdown, load it into the editor.
        if let id = selectedTemplateId,
           let template = savedTemplates.first(where: { $0.id == id }) {
            templateHeadingInput = template.heading
            templateInstructionsInput = template.instructions
            // Reset example picker when switching to an existing template.
            selectedExampleIndex = -1
        } else {
            // "New template" selection clears the editor.
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
                Text("Describe the role, context, and task this template should apply when you press ⌘T…")
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.8))
                    .padding(.top, 8)
                    .padding(.leading, 5)
            }

            TextEditor(text: $templateInstructionsInput)
                .font(.system(size: 12, design: .monospaced))
                .scrollContentBackground(.hidden)
                .background(NordTheme.editorBackground(colorScheme))
        }
            .frame(minHeight: 260)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(NordTheme.border(colorScheme))
        )
    }
}
