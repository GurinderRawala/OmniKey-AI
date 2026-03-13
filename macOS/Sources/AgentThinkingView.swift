import SwiftUI

struct AgentThinkingView: View {
    @ObservedObject var model: AgentThinkingModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 12) {
                Text("OmniAgent Session")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Text("You can keep working while the agent plans and runs any commands it needs.")
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                Divider()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if model.log.isEmpty {
                            Text("Waiting for the agent to respond…")
                                .font(.system(size: 10))
                                .foregroundColor(NordTheme.secondaryText(colorScheme))
                        } else {
                            // Initial user input
                            if !model.initialRequest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Initial input")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                                    Text(model.initialRequest)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundColor(NordTheme.primaryText(colorScheme))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(8)
                                        .background(
                                            RoundedRectangle(cornerRadius: 6)
                                                .fill(NordTheme.editorBackground(colorScheme).opacity(0.95))
                                        )
                                }
                            }

                            // OmniKey reasoning / responses
                            if !model.agentMessages.isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("OmniKey reasoning & responses")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                                    VStack(alignment: .leading, spacing: 8) {
                                        ForEach(Array(model.agentMessages.enumerated()), id: \.offset) { index, message in
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text("Step \(index + 1)")
                                                    .font(.system(size: 9, weight: .medium))
                                                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                                                Text(message)
                                                    .font(.system(size: 10, design: .monospaced))
                                                    .foregroundColor(NordTheme.primaryText(colorScheme))
                                                    .frame(maxWidth: .infinity, alignment: .leading)
                                                    .padding(6)
                                                    .background(
                                                        RoundedRectangle(cornerRadius: 4)
                                                            .fill(NordTheme.editorBackground(colorScheme).opacity(0.9))
                                                    )
                                            }
                                        }
                                    }
                                }
                            }

                            // Terminal command output
                            if !model.terminalOutputs.isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Terminal command output")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                                    VStack(alignment: .leading, spacing: 8) {
                                        ForEach(Array(model.terminalOutputs.enumerated()), id: \.offset) { _, entry in
                                            let lines = entry.components(separatedBy: "\n")
                                            let header = lines.first ?? ""
                                            let body = lines.dropFirst().joined(separator: "\n")

                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(header)
                                                    .font(.system(size: 10, weight: .medium))
                                                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                                                if !body.isEmpty {
                                                    Text(body)
                                                        .font(.system(size: 10, design: .monospaced))
                                                        .foregroundColor(NordTheme.primaryText(colorScheme))
                                                        .frame(maxWidth: .infinity, alignment: .leading)
                                                        .padding(6)
                                                        .background(
                                                            RoundedRectangle(cornerRadius: 4)
                                                                .strokeBorder(NordTheme.secondaryText(colorScheme).opacity(0.3), lineWidth: 1)
                                                        )
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(NordTheme.editorBackground(colorScheme))
                )

                HStack {
                    if model.isRunning {
                        Button("Cancel") {
                            // First cancel any in-flight shell command and
                            // close the active WebSocket session, then mark
                            // the local model as no longer running.
                            AgentRunner.shared.cancelCurrentSession()
                            model.isRunning = false
                        }
                        .font(.system(size: 10))
                    }

                    Spacer()

                    Text(model.isRunning ? "Running…" : "Finished")
                        .font(.system(size: 10))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
            }
            .padding(16)
            .frame(minWidth: 520, minHeight: 320)
        }
    }
}
