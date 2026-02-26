import SwiftUI

struct LicenseView: View {
    @State private var key: String = SubscriptionManager.shared.userKey ?? ""
    @State private var statusMessage: String = ""
    @State private var isLoading: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Activate OmniKey")
                .font(.system(size: 20, weight: .semibold))

            Text("Enter your OmniKey subscription key to unlock enhancements.")
                .font(.system(size: 13))
                .foregroundColor(.secondary)

            Text("Subscription Key")
                .font(.system(size: 13, weight: .medium))

            TextField("Paste your subscription key here", text: $key)
                .textFieldStyle(RoundedBorderTextFieldStyle())
                .font(.system(size: 13, design: .monospaced))

            Text(statusMessage)
                .font(.system(size: 11))
                .foregroundColor(.secondary)
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
            }
        }
        .padding(24)
        .frame(minWidth: 480, minHeight: 220)
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
