import SwiftUI

struct ManualView: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 16) {
                Text("OmniKey Manual")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Text("Use OmniKey AI anywhere you in your Mac. You can select text and then activate one of the shortcuts below. OmniKey will process your selected text and paste the improved version back in place.")
                    .font(.system(size: 13))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        sectionTitle("Keyboard shortcuts")

                        Text("""
• ⌘E – Enhance prompts
  Improves clarity, structure, and tone of your selected text so it works better as an AI prompt.

• ⌘G – Fix grammar and clarity
  Focuses on grammar, spelling, and readability without changing the core meaning.

• ⌘T – Run your custom task
  Applies your saved task instructions to the selected text. Configure these in “Task Instructions” from the menu bar.
""")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.primaryText(colorScheme))

                        sectionTitle("How OmniKey works")

                        Text("""
1. Select text in any app (editor, browser, email, etc.).
2. Press one of the OmniKey shortcuts (⌘E, ⌘G, or ⌘T).
3. OmniKey sends the text securely to the OmniKey AI service.
4. The result is pasted back in place of your original selection.
""")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.primaryText(colorScheme))

                        sectionTitle("Custom tasks with Task Instructions")

                        Text("""
- Open the “Task Instructions” window from the OmniKey menu bar icon.
- Describe the role, style, and rules you want OmniKey to follow when you press ⌘T.
- OmniKey will apply those instructions every time you trigger the custom task shortcut.
""")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.primaryText(colorScheme))

                        sectionTitle("Asking questions with @omnikeyai")

                        Text("""
You can also ask OmniKey questions related to your current task.

- In your document or editor, write a question starting with “@omnikeyai”.
  Example: “@omnikeyai Can you explain step 3 in simpler terms?”
- Select that question (or the whole block of text around it).
- Press one of the OmniKey shortcuts.

OmniKey will treat anything after “@omnikeyai” as a direct question and answer in the context of your current text or task.
""")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                HStack {
                    Spacer()
                    Button("Close") {
                        NSApp.keyWindow?.performClose(nil)
                    }
                }
                .padding(.top, 8)
            }
            .padding(24)
            .frame(maxWidth: 720, maxHeight: .infinity, alignment: .top)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(NordTheme.panelBackground(colorScheme))
                    .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
            )
            .padding(24)
        }
        .frame(minWidth: 760, minHeight: 520)
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(NordTheme.primaryText(colorScheme))
            .padding(.top, 8)
    }
}
