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

            VStack(spacing: 0) {
                // Header
                VStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(NordTheme.accentBlue(colorScheme).opacity(0.12))
                            .frame(width: 56, height: 56)

                        Image(nsImage: NSApplication.shared.applicationIconImage)
                            .resizable()
                            .frame(width: 44, height: 44)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    VStack(spacing: 4) {
                        Text("Activate OmniKey")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        Text("Enter your subscription key to unlock all features.")
                            .font(.system(size: 12))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .padding(.horizontal, 28)

                Divider()
                    .overlay(NordTheme.secondaryText(colorScheme).opacity(0.15))

                // Form
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Subscription Key", systemImage: "key.fill")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))

                        HStack(spacing: 8) {
                            Image(systemName: "key")
                                .font(.system(size: 13))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.6))
                                .frame(width: 16)

                            TextField("Paste your subscription key here", text: $key)
                                .textFieldStyle(.plain)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(NordTheme.windowBackground(colorScheme))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(NordTheme.secondaryText(colorScheme).opacity(0.2), lineWidth: 1)
                                )
                        )
                    }

                    // Status message
                    if !statusMessage.isEmpty {
                        HStack(spacing: 6) {
                            let isSuccess = statusMessage.localizedCaseInsensitiveContains("successful")
                            let isFailure = statusMessage.localizedCaseInsensitiveContains("failed")

                            Image(systemName: isSuccess ? "checkmark.circle.fill" : isFailure ? "xmark.circle.fill" : "info.circle.fill")
                                .font(.system(size: 13))
                                .foregroundColor(isSuccess ? NordTheme.accentGreen(colorScheme) : isFailure ? Color(red: 252/255, green: 100/255, blue: 100/255) : NordTheme.secondaryText(colorScheme))

                            Text(statusMessage)
                                .font(.system(size: 12))
                                .foregroundColor(isSuccess ? NordTheme.accentGreen(colorScheme) : isFailure ? Color(red: 252/255, green: 100/255, blue: 100/255) : NordTheme.secondaryText(colorScheme))
                                .lineLimit(2)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(NordTheme.windowBackground(colorScheme).opacity(0.5))
                        )
                    }
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 20)

                Divider()
                    .overlay(NordTheme.secondaryText(colorScheme).opacity(0.15))

                // Actions
                HStack(spacing: 10) {
                    if isLoading {
                        ProgressView()
                            .scaleEffect(0.7)
                            .frame(width: 16, height: 16)
                    }

                    Spacer()

                    Button("Quit") {
                        NSApplication.shared.terminate(nil)
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                    Button(action: activate) {
                        Label("Activate", systemImage: "checkmark.seal.fill")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(isLoading || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .tint(NordTheme.accentBlue(colorScheme))
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 16)
            }
            .frame(maxWidth: 520)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(NordTheme.panelBackground(colorScheme))
                    LinearGradient(
                        gradient: Gradient(colors: [
                            NordTheme.accentBlue(colorScheme).opacity(colorScheme == .dark ? 0.04 : 0.02),
                            Color.clear,
                        ]),
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
            )
        }
        .frame(minWidth: 620, minHeight: 350)
        .padding(.bottom, 28)
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

                case let .failure(error):
                    self.statusMessage = "Activation failed: \(error.localizedDescription)"
                }
            }
        }
    }
}
