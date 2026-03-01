import SwiftUI

struct LicenseView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var key: String = SubscriptionManager.shared.userKey ?? ""
    @State private var statusMessage: String = ""
    @State private var isLoading: Bool = false

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 14) {
                Text("Activate OmniKey")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Text("Enter your OmniKey subscription key to unlock enhancements.")
                    .font(.system(size: 13))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                Text("Subscription Key")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                TextField("Paste your subscription key here", text: $key)
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                    .font(.system(size: 13, design: .monospaced))

                Text(statusMessage)
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .lineLimit(2)

                HStack {
                    Spacer()

                    if isLoading {
                        ProgressView()
                            .scaleEffect(0.7)
                    }

                    Button("Quit") {
                        NSApplication.shared.terminate(nil)
                    }

                    Button("Activate") {
                        activate()
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isLoading || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .tint(NordTheme.accent(colorScheme))
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(NordTheme.panelBackground(colorScheme))
                    .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
            )
            .padding(24)
        }
        .frame(minWidth: 520, minHeight: 260)
    }

    private func activate() {
        isLoading = true
        statusMessage = "Activating key..."

        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)

        SubscriptionManager.shared.updateUserKey(trimmedKey) { result in
            DispatchQueue.main.async {
                self.isLoading = false

                switch result {
                case .success:
                    self.statusMessage = "Activation successful. OmniKey is unlocked."
                    AppDelegate.shared?.handleSuccessfulAuthorization()

                case .failure(let error):
                    self.statusMessage = "Activation failed: \(error.localizedDescription)"
                }
            }
        }
    }
}
