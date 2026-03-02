import SwiftUI

struct TaskInstructionsView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var instructions: String = ""
    @State private var originalInstructions: String = ""
    @State private var statusMessage: String = ""
    @State private var isLoading: Bool = false
    @State private var hasPendingChanges: Bool = false
    @State private var selectedTemplateIndex: Int = 0

    private let apiClient = APIClient()
    private let templates: [TaskTemplate] = [
        TaskTemplate(
            name: "Existing instructions",
            content: "",
            usesExisting: true
        ),
        TaskTemplate(
            name: "Start from scratch",
            content: ""
        ),
        EditorPolishTemplate.template,
        SQLTemplate.template
    ]

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Welcome to OmniKey")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))

                    Text("""
Use OmniKey shortcuts to instantly enhance your writing:
• ⌘E – Fix and enhance prompts
• ⌘G – Fix grammar and clarity
• ⌘T – Run your custom task
""")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                    Text("Write custom task instructions")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                        .padding(.top, 4)

                    HStack(alignment: .bottom, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Template")
                                .font(.system(size: 11))
                                .foregroundColor(NordTheme.secondaryText(colorScheme))

                            Picker("Template", selection: $selectedTemplateIndex) {
                                ForEach(templates.indices, id: \.self) { index in
                                    Text(templates[index].name)
                                        .tag(index)
                                }
                            }
                            .labelsHidden()
                            .frame(maxWidth: 260)
                        }
                    }

                    instructionTextEditor()
                }
                .padding(20)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(NordTheme.panelBackground(colorScheme))
                        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
                )

                HStack(spacing: 8) {
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

                    Button("Save Instructions") {
                        saveInstructions()
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isLoading)
                    .tint(NordTheme.accent(colorScheme))
                }
                .padding(.horizontal, 4)
                .padding(.top, 10)
            }
            .padding(24)
            .frame(maxWidth: 780, maxHeight: .infinity, alignment: .top)
        }
        .frame(minWidth: 840, minHeight: 640)
        .onAppear {
            fetchInstructions()
        }
        .onChange(of: selectedTemplateIndex) { newValue in
            guard templates.indices.contains(newValue) else { return }
            let template = templates[newValue]
            if template.usesExisting {
                instructions = originalInstructions
                statusMessage = "Existing instructions loaded."
            } else {
                instructions = template.content
                statusMessage = template.content.isEmpty ? "Blank template loaded." : "Template \"\(template.name)\" applied."
            }
        }
        .onChange(of: instructions) { newValue in
            guard !isLoading else { return }

            if newValue != originalInstructions {
                hasPendingChanges = true
                statusMessage = "Pending changes to save."
            } else {
                hasPendingChanges = false
            }
        }
    }

    // MARK: - Networking

    private func fetchInstructions() {
        isLoading = true
        statusMessage = "Loading instructions..."

        apiClient.fetchTaskInstructions { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let text):
                    self.originalInstructions = text
                    self.instructions = text
                    self.hasPendingChanges = false
                    self.statusMessage = text.isEmpty ? "No instructions set yet." : "Instructions loaded."

                case .failure(let error):
                    self.statusMessage = "Failed to load: \(error.localizedDescription)"
                }

                self.isLoading = false
            }
        }
    }

    private func saveInstructions() {
        isLoading = true
        statusMessage = "Saving..."

        let text = instructions
        apiClient.saveTaskInstructions(text) { result in
            DispatchQueue.main.async {
                switch result {
                case .success:
                    self.originalInstructions = self.instructions
                    self.hasPendingChanges = false
                    self.statusMessage = "Instructions saved."

                case .failure(let error):
                    self.statusMessage = "Failed to save: \(error.localizedDescription)"
                }

                self.isLoading = false
            }
        }
    }

    // MARK: - Subviews

    @ViewBuilder
    private func instructionTextEditor() -> some View {
        ZStack(alignment: .topLeading) {
            if instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Describe the role, context, and task you want OmniKey to apply to your selected text…")
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .padding(.top, 8)
                    .padding(.leading, 5)
            }

            TextEditor(text: $instructions)
                .font(.system(size: 12, design: .monospaced))
                .scrollContentBackground(.hidden)
                .background(NordTheme.editorBackground(colorScheme))
        }
        .frame(minHeight: 340)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(NordTheme.border(colorScheme))
        )
    }
}