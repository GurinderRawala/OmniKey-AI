import SwiftUI

/// Settings pane that controls how broad the agent's machine access is:
///   • Terminal access mode  — Full vs. Limited (read-only) shell scripts.
///   • Web search             — Enable / disable web_search + web_fetch tools.
///   • Usage recording        — Enable / disable persisted token usage rows.
///   • Authenticated browser  — Enable / disable browser session reading via
///                              the same `omnikey grant-browser-access` flow
///                              the CLI exposes.
///
/// Agent Access values are persisted in the backend's agent_settings table
/// and are read by the agent at turn time, so simple changes do not restart
/// the daemon. Browser setup choices are collected natively and passed to a
/// non-interactive CLI process running in the user's login shell.
struct AgentAccessSettingsView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var terminalAccess: APIClient.TerminalAccessMode = .full
    @State private var webSearchEnabled: Bool = true
    @State private var usageRecordingEnabled: Bool = !APIClient.isSelfHosted
    @State private var browserAccessEnabled: Bool = false
    @State private var browserDebugBrowserName: String? = nil
    @State private var browserDebugPort: Int? = nil
    @State private var browserAccessMethod: String? = nil
    @State private var browserJavascriptEventBrowsers: [String] = []
    @State private var grammarEnhancementModel: String = ""
    @State private var savedGrammarEnhancementModel: String = ""

    @State private var isLoading: Bool = false
    @State private var statusMessage: String = ""

    // Pending dialog state — mirrors the confirmation pattern used by the
    // AI Providers pane so capability changes always require an explicit
    // confirm step.
    @State private var pendingTerminalAccess: APIClient.TerminalAccessMode? = nil
    @State private var pendingWebSearch: Bool? = nil
    @State private var pendingUsageRecording: Bool? = nil
    @State private var pendingBrowserAccess: Bool? = nil
    @State private var showBrowserSetup = false
    @State private var setupBrowserMethod: BrowserAccessSetup.Method = .debugProfile
    @State private var setupBrowser = "Chrome"
    @State private var setupProfile = "default"

    private let apiClient = APIClient()

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.horizontal, 24)
                    .padding(.top, 20)
                    .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)

                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        terminalAccessCard
                        webSearchCard
                        usageRecordingCard
                        writingModelCard
                        browserAccessCard
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 16)
                    .padding(.bottom, 12)
                }

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .padding(.horizontal, 24)
                        .padding(.bottom, 12)
                }
            }
        }
        .onAppear { loadSettings() }
        .confirmationDialog(
            "Switch terminal access?",
            isPresented: Binding(
                get: { pendingTerminalAccess != nil },
                set: { if !$0 { pendingTerminalAccess = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Apply") {
                if let mode = pendingTerminalAccess {
                    pendingTerminalAccess = nil
                    applyTerminalAccess(mode)
                }
            }
            Button("Cancel", role: .cancel) { pendingTerminalAccess = nil }
        } message: {
            let target = pendingTerminalAccess == .limited ? "Limited (read-only)" : "Full"
            Text("Terminal access will be set to \(target) in agent settings and will apply on the next agent turn.")
        }
        .confirmationDialog(
            "Change web search setting?",
            isPresented: Binding(
                get: { pendingWebSearch != nil },
                set: { if !$0 { pendingWebSearch = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Apply") {
                if let enabled = pendingWebSearch {
                    pendingWebSearch = nil
                    applyWebSearch(enabled)
                }
            }
            Button("Cancel", role: .cancel) { pendingWebSearch = nil }
        } message: {
            let target = (pendingWebSearch == true) ? "enabled" : "disabled"
            Text("Web search and web fetch tools will be \(target) on the next agent turn.")
        }
        .confirmationDialog(
            "Change usage recording?",
            isPresented: Binding(
                get: { pendingUsageRecording != nil },
                set: { if !$0 { pendingUsageRecording = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Apply") {
                if let enabled = pendingUsageRecording {
                    pendingUsageRecording = nil
                    applyUsageRecording(enabled)
                }
            }
            Button("Cancel", role: .cancel) { pendingUsageRecording = nil }
        } message: {
            let target = (pendingUsageRecording == true) ? "enabled" : "disabled"
            Text("Detailed token usage recording will be \(target) immediately for future AI calls.")
        }
        .confirmationDialog(
            (pendingBrowserAccess == true)
                ? "Enable authenticated browser access?"
                : "Disable authenticated browser access?",
            isPresented: Binding(
                get: { pendingBrowserAccess != nil },
                set: { if !$0 { pendingBrowserAccess = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button((pendingBrowserAccess == true) ? "Configure" : "Disable") {
                if pendingBrowserAccess == true {
                    pendingBrowserAccess = nil
                    showBrowserSetup = true
                } else {
                    pendingBrowserAccess = nil
                    applyBrowserAccess(false)
                }
            }
            Button("Cancel", role: .cancel) { pendingBrowserAccess = nil }
        } message: {
            if pendingBrowserAccess == true {
                Text("Choose the access method, browser, and debug profile in OmniKey. Setup runs in the background using your login-shell environment.")
            } else {
                Text("This clears authenticated browser access from the settings database and removes the macOS debug-profile LaunchAgent. The debug profile directory itself is preserved so you can re-enable later without signing in again.")
            }
        }
        .sheet(isPresented: $showBrowserSetup) { browserSetupSheet }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))
                Text("Settings · Agent Access")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Spacer()
                Button(action: loadSettings) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                }
                .buttonStyle(.bordered)
                .tint(NordTheme.accentBlue(colorScheme))
                .disabled(isLoading)
            }

            Text("Control which capabilities OmniKey's agent can use on this machine. Changes are saved to agent settings and apply without restarting the daemon.")
                .font(.system(size: 13))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
    }

    // MARK: - Terminal access card

    private var terminalAccessCard: some View {
        settingCard(
            icon: "terminal.fill",
            title: "Terminal access",
            subtitle: "Choose how much shell freedom the agent has when running scripts."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Picker("", selection: Binding(
                    get: { terminalAccess },
                    set: { newValue in
                        if newValue != terminalAccess {
                            pendingTerminalAccess = newValue
                        }
                    }
                )) {
                    Text("Full access").tag(APIClient.TerminalAccessMode.full)
                    Text("Limited (read-only)").tag(APIClient.TerminalAccessMode.limited)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(isLoading)

                Text(terminalAccess == .full
                     ? "Full: the agent can run any shell command — read, write, install, configure, restart services."
                     : "Limited: the agent is told to only run read-only inspection commands (ls, cat, grep, ps, env, …) and to refuse mutating tasks.")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
        }
    }

    // MARK: - Web search card

    private var webSearchCard: some View {
        settingCard(
            icon: "globe",
            title: "Web search",
            subtitle: "Enable the built-in web_search and web_fetch tools."
        ) {
            HStack {
                Toggle(isOn: Binding(
                    get: { webSearchEnabled },
                    set: { newValue in
                        if newValue != webSearchEnabled {
                            pendingWebSearch = newValue
                        }
                    }
                )) {
                    Text(webSearchEnabled ? "Enabled" : "Disabled")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                }
                .toggleStyle(.switch)
                .labelsHidden()
                .disabled(isLoading)
                Text(webSearchEnabled ? "Enabled" : "Disabled")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Spacer()
            }
        }
    }

    // MARK: - Browser access card

    private var usageRecordingCard: some View {
        settingCard(
            icon: "chart.bar.doc.horizontal",
            title: "Usage recording",
            subtitle: "Persist per-call token usage so the Usage page can show consumption and cost trends."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Toggle(isOn: Binding(
                        get: { usageRecordingEnabled },
                        set: { newValue in
                            if newValue != usageRecordingEnabled {
                                pendingUsageRecording = newValue
                            }
                        }
                    )) {
                        Text(usageRecordingEnabled ? "Enabled" : "Disabled")
                    }
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(isLoading)
                    Text(usageRecordingEnabled ? "Enabled" : "Disabled")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Spacer()
                }

                Text(APIClient.isSelfHosted && !usageRecordingEnabled
                     ? "Self-hosted installs keep detailed usage recording off by default. Enable it to populate the Usage page from this point forward."
                     : "When enabled, OmniKey stores model, mode, thread, and token counts for each AI call. Existing context counters are unaffected.")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
        }
    }

    private var browserAccessCard: some View {
        settingCard(
            icon: "safari.fill",
            title: "Authenticated browser access",
            subtitle: "Let the agent read logged-in tabs via a debug profile or JavaScript Events."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Toggle(isOn: Binding(
                        get: { browserAccessEnabled },
                        set: { newValue in
                            if newValue != browserAccessEnabled {
                                pendingBrowserAccess = newValue
                            }
                        }
                    )) {
                        Text(browserAccessEnabled ? "Enabled" : "Disabled")
                    }
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(isLoading)
                    Text(browserAccessEnabled ? "Enabled" : "Disabled")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Spacer()
                }

                if browserAccessEnabled {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 11))
                            .foregroundColor(NordTheme.accentGreen(colorScheme))
                        Text(browserAccessDescription)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                    }
                }

                Text("Enabling asks for the method, browser, and profile in OmniKey, then runs setup in your login shell without opening Terminal or restarting the daemon.")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
        }
    }

    private var writingModelCard: some View {
        settingCard(
            icon: "text.badge.checkmark",
            title: "Grammar & prompt enhancement model",
            subtitle: "Optionally use a custom model for the grammar and prompt-enhancement shortcuts."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Use the provider default", text: $grammarEnhancementModel)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .disabled(isLoading)

                HStack(spacing: 8) {
                    Button("Save") { applyGrammarEnhancementModel(grammarEnhancementModel) }
                        .buttonStyle(.borderedProminent)
                        .tint(NordTheme.accentBlue(colorScheme))
                        .disabled(
                            isLoading ||
                            grammarEnhancementModel.trimmingCharacters(in: .whitespacesAndNewlines)
                                == savedGrammarEnhancementModel
                        )
                    Button("Use Default") {
                        applyGrammarEnhancementModel("")
                    }
                    .buttonStyle(.bordered)
                    .disabled(isLoading || savedGrammarEnhancementModel.isEmpty)
                    Spacer()
                }

                Text("Enter a model identifier supported by the active AI provider. Leave it blank to use OmniKey's fast default model.")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
        }
    }

    private var browserAccessDescription: String {
        if browserAccessMethod == "javascript-events" {
            let browsers = browserJavascriptEventBrowsers.isEmpty
                ? "configured browser"
                : browserJavascriptEventBrowsers.joined(separator: ", ")
            return "JavaScript Events: \(browsers)"
        }
        let browser = browserDebugBrowserName ?? "browser"
        return "Debug profile: \(browser)" + (browserDebugPort.map { "  ·  port \($0)" } ?? "")
    }

    private var debugBrowserChoices: [String] {
        let candidates: [(String, [String])] = [
            ("Chrome", ["/Applications/Google Chrome.app", NSHomeDirectory() + "/Applications/Google Chrome.app"]),
            ("Brave", ["/Applications/Brave Browser.app", NSHomeDirectory() + "/Applications/Brave Browser.app"]),
            ("Edge", ["/Applications/Microsoft Edge.app", NSHomeDirectory() + "/Applications/Microsoft Edge.app"]),
            ("Arc", ["/Applications/Arc.app", NSHomeDirectory() + "/Applications/Arc.app"]),
            ("Vivaldi", ["/Applications/Vivaldi.app", NSHomeDirectory() + "/Applications/Vivaldi.app"]),
            ("Opera", ["/Applications/Opera.app", NSHomeDirectory() + "/Applications/Opera.app"]),
            ("Chromium", ["/Applications/Chromium.app", NSHomeDirectory() + "/Applications/Chromium.app"]),
        ]
        return candidates.filter { candidate in
            candidate.1.contains { FileManager.default.fileExists(atPath: $0) }
        }.map(\.0)
    }

    private var javascriptBrowserChoices: [String] {
        debugBrowserChoices + (FileManager.default.fileExists(atPath: "/Applications/Safari.app") ? ["Safari"] : [])
    }

    private var currentSetupBrowserChoices: [String] {
        setupBrowserMethod == .debugProfile ? debugBrowserChoices : javascriptBrowserChoices
    }

    private var browserSetupSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Authenticated browser setup").font(.title2.weight(.semibold))
            Picker("Access method", selection: $setupBrowserMethod) {
                ForEach(BrowserAccessSetup.Method.allCases) { method in
                    Text(method.label).tag(method)
                }
            }.pickerStyle(.segmented)
            Picker("Browser", selection: $setupBrowser) {
                ForEach(currentSetupBrowserChoices, id: \.self) { Text($0).tag($0) }
            }
            if setupBrowserMethod == .debugProfile {
                TextField("Profile name", text: $setupProfile)
                Text("The selected browser will close and reopen with the dedicated OmniKey profile.")
                    .font(.caption)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            } else {
                Text("Enable “Allow JavaScript from Apple Events” in the selected browser's Developer settings before using this method.")
                    .font(.caption)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            HStack {
                Spacer()
                Button("Cancel") { showBrowserSetup = false }
                    .disabled(isLoading)
                Button("Enable") { runBrowserSetup() }
                    .buttonStyle(.borderedProminent)
                    .disabled(isLoading || currentSetupBrowserChoices.isEmpty || (setupBrowserMethod == .debugProfile && setupProfile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }
        .padding(24)
        .frame(width: 480)
        .interactiveDismissDisabled(isLoading)
        .onAppear {
            if !currentSetupBrowserChoices.contains(setupBrowser), let first = currentSetupBrowserChoices.first {
                setupBrowser = first
            }
        }
        .onChange(of: setupBrowserMethod) { _, _ in
            if !currentSetupBrowserChoices.contains(setupBrowser), let first = currentSetupBrowserChoices.first {
                setupBrowser = first
            }
        }
    }

    // MARK: - Card chrome

    @ViewBuilder
    private func settingCard<Content: View>(
        icon: String,
        title: String,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Spacer()
            }
            Text(subtitle)
                .font(.system(size: 12))
                .foregroundColor(NordTheme.secondaryText(colorScheme))

            content()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(NordTheme.border(colorScheme), lineWidth: 1)
        )
    }

    // MARK: - Actions

    private func loadSettings() {
        isLoading = true
        statusMessage = ""
        apiClient.fetchAppSettings { result in
            DispatchQueue.main.async {
                isLoading = false
                switch result {
                case .success(let response):
                    terminalAccess = response.terminalAccess
                    webSearchEnabled = response.webSearchEnabled
                    usageRecordingEnabled = response.usageRecordingEnabled
                    browserAccessEnabled = response.browserAccessEnabled
                    browserDebugBrowserName = response.browserDebugBrowserName
                    browserDebugPort = response.browserDebugPort
                    browserAccessMethod = response.browserAccessMethod
                    browserJavascriptEventBrowsers = response.browserJavascriptEventBrowsers ?? []
                    grammarEnhancementModel = response.grammarEnhancementModel ?? ""
                    savedGrammarEnhancementModel = response.grammarEnhancementModel ?? ""
                case .failure(let error):
                    statusMessage = "Failed to load settings: \(error.localizedDescription)"
                }
            }
        }
    }

    private func applyTerminalAccess(_ mode: APIClient.TerminalAccessMode) {
        isLoading = true
        statusMessage = "Applying terminal access = \(mode.rawValue)…"
        apiClient.updateAppSettings(terminalAccess: mode, webSearchEnabled: nil) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let resp):
                    terminalAccess = resp.terminalAccess
                    statusMessage = "Terminal access set to \(resp.terminalAccess.rawValue)."
                    loadSettings()
                case .failure(let error):
                    isLoading = false
                    statusMessage = "Failed to apply: \(error.localizedDescription)"
                }
            }
        }
    }

    private func applyWebSearch(_ enabled: Bool) {
        isLoading = true
        statusMessage = "Updating web search…"
        apiClient.updateAppSettings(terminalAccess: nil, webSearchEnabled: enabled) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let resp):
                    webSearchEnabled = resp.webSearchEnabled
                    statusMessage = "Web search \(resp.webSearchEnabled ? "enabled" : "disabled")."
                    loadSettings()
                case .failure(let error):
                    isLoading = false
                    statusMessage = "Failed to apply: \(error.localizedDescription)"
                }
            }
        }
    }

    private func applyUsageRecording(_ enabled: Bool) {
        isLoading = true
        statusMessage = "Updating usage recording…"
        apiClient.updateAppSettings(terminalAccess: nil, webSearchEnabled: nil, usageRecordingEnabled: enabled) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let resp):
                    usageRecordingEnabled = resp.usageRecordingEnabled ?? enabled
                    statusMessage = "Usage recording \(usageRecordingEnabled ? "enabled" : "disabled")."
                    loadSettings()
                case .failure(let error):
                    isLoading = false
                    statusMessage = "Failed to apply: \(error.localizedDescription)"
                }
            }
        }
    }

    private func applyGrammarEnhancementModel(_ model: String) {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        isLoading = true
        statusMessage = trimmed.isEmpty
            ? "Restoring the default grammar and enhancement model…"
            : "Updating the grammar and enhancement model…"
        apiClient.updateGrammarEnhancementModel(trimmed.isEmpty ? nil : trimmed) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let response):
                    let saved = response.grammarEnhancementModel ?? ""
                    grammarEnhancementModel = saved
                    savedGrammarEnhancementModel = saved
                    statusMessage = saved.isEmpty
                        ? "Grammar and prompt enhancement now use the provider default."
                        : "Grammar and prompt enhancement now use \(saved)."
                    isLoading = false
                case .failure(let error):
                    isLoading = false
                    statusMessage = "Failed to update the model: \(error.localizedDescription)"
                }
            }
        }
    }

    private func applyBrowserAccess(_ enabled: Bool) {
        isLoading = true
        statusMessage = "Disabling browser access…"
        apiClient.setBrowserAccessEnabled(enabled) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let resp):
                    browserAccessEnabled = resp.browserAccessEnabled
                    if let message = resp.message, !message.isEmpty {
                        statusMessage = message
                    } else {
                        statusMessage = "Browser access disabled."
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        loadSettings()
                    }
                case .failure(let error):
                    isLoading = false
                    statusMessage = "Failed to toggle browser access: \(error.localizedDescription)"
                }
            }
        }
    }

    private func runBrowserSetup() {
        isLoading = true
        statusMessage = "Configuring browser access in the background…"
        BrowserAccessSetup.configure(
            method: setupBrowserMethod,
            browser: setupBrowser,
            profile: setupProfile.trimmingCharacters(in: .whitespacesAndNewlines)
        ) { result in
            DispatchQueue.main.async {
                isLoading = false
                switch result {
                case .success:
                    showBrowserSetup = false
                    statusMessage = "Authenticated browser access enabled."
                    loadSettings()
                case .failure(let error):
                    statusMessage = "Browser setup failed: \(error.localizedDescription)"
                }
            }
        }
    }
}
