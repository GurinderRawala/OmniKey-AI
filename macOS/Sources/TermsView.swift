import SwiftUI

/// First-launch Terms & Conditions acceptance UI. Modelled on
/// `LicenseView` for visual consistency: Nord-themed card, centered
/// header, scrollable body, primary "I Accept" action on the right.
///
/// The user must explicitly click "I Accept" — closing the window with
/// the traffic light or the "Decline & Quit" button terminates the app.
struct TermsView: View {
    @Environment(\.colorScheme) private var colorScheme

    /// Called on the main queue after the user accepts. The window
    /// controller uses this to close itself and hand off to whatever
    /// gating logic normally follows first launch (subscription check,
    /// manual, etc.).
    let onAccept: () -> Void

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                // ── Header ────────────────────────────────────────────
                VStack(spacing: 10) {
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
                        Text("Terms & Conditions")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        Text("Please review and accept the terms before using OmniKey AI.")
                            .font(.system(size: 12))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                .padding(.horizontal, 28)

                Divider()
                    .overlay(NordTheme.secondaryText(colorScheme).opacity(0.15))

                // ── Body ──────────────────────────────────────────────
                // Render TERMS.md via the same markdown pipeline used by
                // the chat transcript so headings, lists, bold/italic, and
                // links match the rest of the app. `baseFontSize: 12`
                // keeps the terms visually calmer than an assistant reply.
                ScrollView {
                    ChatMarkdownView(text: TermsContent.text, baseFontSize: 12)
                        .padding(20)
                }
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(NordTheme.windowBackground(colorScheme))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(NordTheme.secondaryText(colorScheme).opacity(0.2), lineWidth: 1)
                        )
                )
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 12)

                // ── Summary ───────────────────────────────────────────
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "info.circle.fill")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.accentBlue(colorScheme))
                        .padding(.top, 2)

                    Text("OmniKey AI is open-source software released under the MIT License. It is provided AS-IS, without warranty. OmniKey and its contributors are not liable for any damages, data loss, third-party charges, or issues arising from AI-generated content.")
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 28)
                .padding(.top, 4)
                .padding(.bottom, 12)

                Divider()
                    .overlay(NordTheme.secondaryText(colorScheme).opacity(0.15))

                // ── Actions ───────────────────────────────────────────
                HStack(spacing: 10) {
                    Spacer()

                    Button("Decline & Quit") {
                        NSApplication.shared.terminate(nil)
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                    Button(action: accept) {
                        Label("I Accept", systemImage: "checkmark.seal.fill")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .tint(NordTheme.accentBlue(colorScheme))
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 14)
            }
            .frame(maxWidth: 640)
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
        // Room above and below the card so the acceptance dialog doesn't
        // feel cramped against the window chrome — matches the standard
        // macOS system-dialog top/bottom margin.
        .frame(minWidth: 720, minHeight: 620)
        .padding(.top, 24)
        .padding(.bottom, 24)
    }

    private func accept() {
        TermsAcceptance.recordAcceptance()
        onAccept()
    }
}
