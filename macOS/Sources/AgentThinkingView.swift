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
                    VStack(alignment: .leading, spacing: 12) {
                        if model.log.isEmpty {
                            Text("Waiting for the agent to respond…")
                                .font(.system(size: 10))
                                .foregroundColor(NordTheme.secondaryText(colorScheme))
                        } else {
                            Text(model.log)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(NordTheme.editorBackground(colorScheme))
                )

                HStack {
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
