import SwiftUI

struct SubscriptionPaywallView: View {
    @ObservedObject var manager: SubscriptionManager
    var onSubscribed: () -> Void

    @State private var isPurchasing = false

    var body: some View {
        VStack(spacing: 24) {
            VStack(spacing: 8) {
                Text("Unlock OmniKey Pro")
                    .font(.system(size: 26, weight: .bold))

                Text("7-day free trial, then continue with your subscription to keep supercharging your writing.")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "bolt.fill")
                        .foregroundColor(.yellow)
                    Text("Instant prompt enhancement for code and writing.")
                        .font(.system(size: 13))
                }
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.badge.checkmark")
                        .foregroundColor(.green)
                    Text("One-tap grammar and clarity fixes across apps.")
                        .font(.system(size: 13))
                }
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "sparkles")
                        .foregroundColor(.blue)
                    Text("Custom tasks tailored to your own workflows.")
                        .font(.system(size: 13))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 6) {
                Text("7 days free, then subscription continues until cancelled.")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)

                Text("You can cancel anytime in your App Store account settings.")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }

            if let error = manager.errorMessage {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundColor(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
            }

            HStack(spacing: 12) {
                Button {
                    NSApplication.shared.keyWindow?.performClose(nil)
                } label: {
                    Text("Quit")
                }
                .accessibilityLabel("Quit OmniKey")

                Spacer()

                Button {
                    Task {
                        isPurchasing = true
                        let success = await manager.purchase()
                        isPurchasing = false
                        if success {
                            onSubscribed()
                        }
                    }
                } label: {
                    if isPurchasing || manager.isLoading {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle())
                            .scaleEffect(0.8)
                            .frame(width: 80)
                            .accessibilityLabel("Processing purchase")
                    } else {
                        Text("Start 7-day free trial")
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isPurchasing || manager.isLoading)
                .accessibilityLabel("Start 7-day free trial subscription")
                .accessibilityHint("Starts your OmniKey Pro subscription with a 7-day free trial.")
            }
        }
        .padding(24)
        .frame(minWidth: 520, minHeight: 360)
    }
}
