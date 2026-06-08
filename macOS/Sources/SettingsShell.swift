import AppKit
import SwiftUI

private enum SettingsTab: String, CaseIterable, Identifiable {
    case providers, updates, manual

    var id: String { rawValue }

    var title: String {
        switch self {
        case .providers: return "AI Providers"
        case .updates:   return "Check for Updates"
        case .manual:    return "Manual"
        }
    }

    var iconName: String {
        switch self {
        case .providers: return "key.fill"
        case .updates:   return "arrow.down.circle.fill"
        case .manual:    return "book.fill"
        }
    }

    var subtitle: String {
        switch self {
        case .providers: return "Manage API keys"
        case .updates:   return "App version & updates"
        case .manual:    return "Shortcuts & usage"
        }
    }
}

/// Top-level Settings window. Provides a fixed-width sidebar on the left and
/// swaps the detail pane on the right based on the selected tab.
struct SettingsView: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var selection: SettingsTab = .providers

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 220)
                .background(NordTheme.panelBackground(colorScheme))

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(width: 1)

            detailPane
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(NordTheme.windowBackground(colorScheme))
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Settings")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Text("Configure OmniKey AI")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 14)

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)
                .padding(.bottom, 8)

            VStack(spacing: 4) {
                ForEach(SettingsTab.allCases) { tab in
                    sidebarRow(tab)
                }
            }
            .padding(.horizontal, 8)

            Spacer()
        }
    }

    private func sidebarRow(_ tab: SettingsTab) -> some View {
        let isSelected = selection == tab
        return Button(action: { selection = tab }) {
            HStack(spacing: 10) {
                Image(systemName: tab.iconName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(isSelected
                                     ? NordTheme.accent(colorScheme)
                                     : NordTheme.secondaryText(colorScheme))
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 1) {
                    Text(tab.title)
                        .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Text(tab.subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }

                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected
                          ? NordTheme.accent(colorScheme).opacity(0.18)
                          : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Detail pane

    @ViewBuilder
    private var detailPane: some View {
        switch selection {
        case .providers:
            AIProvidersSettingsView()
        case .updates:
            UpdatesSettingsView()
        case .manual:
            ManualView()
                .padding(.horizontal, 24)
                .padding(.top, 20)
        }
    }
}

// MARK: - Updates pane

private struct UpdatesSettingsView: View {
    @Environment(\.colorScheme) private var colorScheme

    private var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "Version \(short) (build \(build))"
    }

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(NordTheme.accent(colorScheme))
                        Text("Check for Updates")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme))
                        Spacer()
                    }
                    Text("OmniKey checks for new releases automatically on launch via Sparkle. You can also check on demand — Sparkle's standard update prompt will appear.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
                .padding(.horizontal, 24)
                .padding(.top, 20)
                .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)

                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        Image(systemName: "app.badge.checkmark")
                            .font(.system(size: 28))
                            .foregroundColor(NordTheme.accentBlue(colorScheme))
                        VStack(alignment: .leading, spacing: 4) {
                            Text("OmniKey AI")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                            Text(appVersion)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundColor(NordTheme.secondaryText(colorScheme))
                        }
                        Spacer()
                    }
                    .padding(14)
                    .background(NordTheme.panelBackground(colorScheme))
                    .cornerRadius(8)
                    .overlay(RoundedRectangle(cornerRadius: 8)
                                .stroke(NordTheme.border(colorScheme), lineWidth: 1))

                    HStack {
                        Button(action: triggerUpdate) {
                            Label("Check for Updates", systemImage: "arrow.clockwise")
                                .font(.system(size: 13, weight: .medium))
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(NordTheme.accent(colorScheme))
                        Spacer()
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)

                Spacer()
            }
        }
    }

    /// Hands control to the shared Sparkle updater controller — the exact same
    /// entry point the previous status-bar "Check Updates" menu item used.
    /// Sparkle owns the UI from here on: it shows its own "Checking…" sheet,
    /// the "You're up to date" alert, or the update-available prompt.
    private func triggerUpdate() {
        AppDelegate.shared?.checkForUpdates()
    }
}
