import SwiftUI

struct ManualView: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                // Page header
                VStack(alignment: .leading, spacing: 6) {
                    Text("OmniKey Manual")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))

                    Text("Use OmniKey AI anywhere on your Mac. Select text and activate one of the shortcuts below. OmniKey will process your selected text and paste the result back in place.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
                .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)
                    .padding(.bottom, 16)

                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {

                        // Keyboard Shortcuts
                        sectionTitle("Keyboard shortcuts", icon: "keyboard")

                        VStack(alignment: .leading, spacing: 10) {
                            shortcutRow(
                                keys: ["cmd", "E"],
                                label: "Enhance prompt",
                                description: "Improves clarity, structure, and tone of your selected text so it works better as an AI prompt."
                            )
                            shortcutRow(
                                keys: ["cmd", "G"],
                                label: "Fix grammar",
                                description: "Focuses on grammar, spelling, and readability without changing the core meaning."
                            )
                            shortcutRow(
                                keys: ["cmd", "T"],
                                label: "Run custom task",
                                description: "Applies your saved task instructions to the selected text. Configure these in Task Instructions from the menu bar."
                            )
                        }

                        sectionSpacer()

                        // How OmniKey works
                        sectionTitle("How OmniKey works", icon: "arrow.triangle.2.circlepath")

                        VStack(alignment: .leading, spacing: 8) {
                            numberedRow(1, text: "Select text in any app (editor, browser, email, etc.).")
                            numberedRow(2, text: "Press one of the OmniKey shortcuts (Cmd+E, Cmd+G, or Cmd+T).")
                            numberedRow(3, text: "OmniKey sends the text securely to the OmniKey AI service.")
                            numberedRow(4, text: "The result is pasted back in place of your original selection.")
                        }

                        sectionSpacer()

                        // Custom Tasks
                        sectionTitle("Custom tasks with Task Instructions", icon: "list.bullet.rectangle")

                        VStack(alignment: .leading, spacing: 8) {
                            bulletRow(text: "Open the Task Instructions window from the OmniKey menu bar icon.")
                            bulletRow(text: "Describe the role, style, and rules you want OmniKey to follow when you press Cmd+T.")
                            bulletRow(text: "OmniKey will apply those instructions every time you trigger the custom task shortcut.")
                        }

                        sectionSpacer()

                        // Asking questions
                        sectionTitle("Asking questions with @omnikeyai", icon: "questionmark.bubble")

                        Text("You can ask OmniKey questions related to your current task.")
                            .font(.system(size: 13))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        VStack(alignment: .leading, spacing: 8) {
                            bulletRow(text: "In your document or editor, write a question starting with \"@omnikeyai\".")
                            examplePill("@omnikeyai Can you explain step 3 in simpler terms?")
                            bulletRow(text: "Select that question (or the whole block of text around it).")
                            bulletRow(text: "Press one of the OmniKey shortcuts.")
                        }

                        Text("OmniKey will treat anything after \"@omnikeyai\" as a direct question and answer in the context of your current text or task.")
                            .font(.system(size: 13))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        sectionSpacer()

                        // Running tasks with @omniAgent
                        sectionTitle("Running tasks with @omniAgent", icon: "cpu")

                        Text("You can ask the Omni agent to perform tasks for you using the @omniAgent command.")
                            .font(.system(size: 13))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        VStack(alignment: .leading, spacing: 8) {
                            bulletRow(text: "Type \"@omniAgent\" followed by clear instructions for what you want done.")
                            examplePill("@omniAgent Set up a new README section describing the API routes.")
                            bulletRow(text: "Select the text containing your @omniAgent instructions.")
                            bulletRow(text: "Press Cmd+T to run your custom task.")
                        }

                        Text("If you have Task Instructions configured, the agent will combine those with the instructions you provided using \"@omniAgent\" and then execute the task.")
                            .font(.system(size: 13))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        Text("The agent can access your terminal and perform actions through it, browse the web, and fetch content from given URLs. However, it runs with restricted permissions and cannot run commands with \"sudo\" or install additional software needed to complete tasks.")
                            .font(.system(size: 13))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                HStack {
                    Spacer()
                    Button("Close") {
                        NSApp.keyWindow?.performClose(nil)
                    }
                }
                .padding(.top, 14)
            }
            .padding(24)
            .frame(maxWidth: 760, maxHeight: .infinity, alignment: .top)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(NordTheme.panelBackground(colorScheme))
                    .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
            )
            .padding(24)
        }
        .frame(minWidth: 880, minHeight: 580)
    }

    // MARK: - Section Title with Icon and Accent Bar

    private func sectionTitle(_ text: String, icon: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            // Accent bar
            RoundedRectangle(cornerRadius: 2)
                .fill(NordTheme.accent(colorScheme))
                .frame(width: 3, height: 20)

            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(NordTheme.accent(colorScheme))

            Text(text)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))
        }
    }

    // MARK: - Shortcut Row

    private func shortcutRow(keys: [String], label: String, description: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            // Shortcut pill
            HStack(spacing: 3) {
                ForEach(keys, id: \.self) { key in
                    shortcutPill(key)
                }
            }
            .frame(minWidth: 70, alignment: .leading)

            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Text(description)
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func shortcutPill(_ key: String) -> some View {
        let displayKey: String
        switch key {
        case "cmd": displayKey = "\u{2318}"
        case "opt": displayKey = "\u{2325}"
        case "shift": displayKey = "\u{21E7}"
        case "ctrl": displayKey = "\u{2303}"
        default: displayKey = key
        }

        return Text(displayKey)
            .font(.system(size: 12, weight: .medium, design: .monospaced))
            .foregroundColor(NordTheme.primaryText(colorScheme))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(NordTheme.badgeFill(colorScheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
    }

    // MARK: - Numbered Row

    private func numberedRow(_ number: Int, text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundColor(NordTheme.accent(colorScheme))
                .frame(width: 20, height: 20)
                .background(
                    Circle()
                        .fill(NordTheme.sectionFill(accent: NordTheme.accent(colorScheme), scheme: colorScheme))
                )
                .overlay(
                    Circle()
                        .strokeBorder(NordTheme.sectionBorder(accent: NordTheme.accent(colorScheme), scheme: colorScheme), lineWidth: 1)
                )

            Text(text)
                .font(.system(size: 13))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Bullet Row

    private func bulletRow(text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(NordTheme.secondaryText(colorScheme))
                .frame(width: 4, height: 4)
                .padding(.top, 6)

            Text(text)
                .font(.system(size: 13))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Example Pill

    private func examplePill(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, design: .monospaced))
            .foregroundColor(NordTheme.accentBlue(colorScheme))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(NordTheme.sectionFill(accent: NordTheme.accentBlue(colorScheme), scheme: colorScheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(NordTheme.sectionBorder(accent: NordTheme.accentBlue(colorScheme), scheme: colorScheme), lineWidth: 1)
            )
    }

    // MARK: - Section Spacer

    private func sectionSpacer() -> some View {
        Spacer()
            .frame(height: 4)
    }
}
