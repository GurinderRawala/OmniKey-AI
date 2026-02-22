import SwiftUI

struct TaskInstructionsView: View {
    @State private var instructions: String = ""
    @State private var statusMessage: String = ""
    @State private var isLoading: Bool = false

    private let apiClient = APIClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Welcome to OmniKey")
                .font(.system(size: 20, weight: .semibold))

            Text("""
Use OmniKey shortcuts to instantly enhance your writing:
• ⌘E – Fix and enhance prompts
• ⌘G – Fix grammar and clarity
• ⌘T – Run your custom task
""")
                .font(.system(size: 13))
                .foregroundColor(.secondary)

            Text("Write custom task instructions")
                .font(.system(size: 13, weight: .medium))

            TextEditor(text: $instructions)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 320)
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color(NSColor.separatorColor))
                )

            HStack(spacing: 8) {
                Text(statusMessage)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)

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
            }
        }
        .padding(24)
        .frame(minWidth: 800, minHeight: 560)
        .onAppear {
            fetchInstructions()
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
                    self.instructions = text
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
                    self.statusMessage = "Instructions saved."

                case .failure(let error):
                    self.statusMessage = "Failed to save: \(error.localizedDescription)"
                }

                self.isLoading = false
            }
        }
    }
}
