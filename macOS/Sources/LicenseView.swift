import SwiftUI

struct LicenseView: View {
    @Environment(\.colorScheme) private var colorScheme

    private enum ScreenMode {
        case checking
        case onboarding
        case subscription
    }

    private enum SetupTab: String, CaseIterable, Identifiable {
        case selfHosted = "Self-hosted"
        case saas = "SaaS"

        var id: String { rawValue }
    }

    @State private var screenMode: ScreenMode = .checking
    @State private var selectedTab: SetupTab = .selfHosted
    @State private var setupStep: Int = 0
    @State private var selectedProvider: SelfHostedProvider = .openai
    @State private var providerKey: String = ""
    @State private var openModelBaseURL: String = ""
    @State private var openModelResponsesAPIEnabled: Bool = false

    @State private var key: String = SubscriptionManager.shared.userKey ?? ""
    @State private var statusMessage: String = ""
    @State private var isLoading: Bool = false

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            Group {
                switch screenMode {
                case .checking:
                    checkingView
                case .onboarding:
                    onboardingView
                case .subscription:
                    subscriptionView
                }
            }
            .padding(28)
        }
        .frame(minWidth: 820, minHeight: 700)
        .onAppear(perform: resolveInitialScreen)
    }

    private var checkingView: some View {
        VStack(spacing: 14) {
            ProgressView()
                .scaleEffect(0.85)
            Text("Checking local OmniKey setup...")
                .font(OKFont.bodyEmphasized)
                .foregroundColor(NordTheme.primaryText(colorScheme))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var onboardingView: some View {
        VStack(spacing: 0) {
            setupHeader(
                title: "Set up OmniKey",
                subtitle: "Use the free local daemon with your own provider key."
            )

            Divider().overlay(NordTheme.border(colorScheme))

            VStack(alignment: .leading, spacing: 18) {
                Picker("", selection: $selectedTab) {
                    ForEach(SetupTab.allCases) { tab in
                        Text(tab.rawValue).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                if selectedTab == .selfHosted {
                    selfHostedSetupView
                } else {
                    saasUnavailableView
                }

                statusView
            }
            .padding(24)
        }
        .frame(maxWidth: 760)
        .background(cardBackground(cornerRadius: 16))
    }

    private var selfHostedSetupView: some View {
        VStack(alignment: .leading, spacing: 18) {
            stepIndicator

            if setupStep == 0 {
                VStack(alignment: .leading, spacing: 14) {
                    actionRow(
                        icon: "terminal.fill",
                        title: "Install the local daemon tools",
                        subtitle: "OmniKey will check omnikey-cli and install or update it in the background."
                    )

                    HStack {
                        Button(action: installCLI) {
                            Label(
                                isLoading ? "Checking omnikey-cli..." : "Install omnikey-cli",
                                systemImage: isLoading ? "hourglass" : "arrow.down.circle.fill"
                            )
                                .font(OKFont.bodyEmphasized)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(NordTheme.accent(colorScheme))
                        .disabled(isLoading)

                        Spacer()

                        Button(action: { setupStep = 1 }) {
                            Label("Next", systemImage: "arrow.right")
                                .font(OKFont.bodyEmphasized)
                        }
                        .buttonStyle(.bordered)
                        .tint(NordTheme.accentBlue(colorScheme))
                        .disabled(isLoading)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    actionRow(
                        icon: "key.fill",
                        title: "Connect an AI provider",
                        subtitle: "Your key is saved locally in ~/.omnikey/config.json and read only by the local daemon."
                    )

                    HStack(alignment: .top, spacing: 18) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Provider")
                                .font(OKFont.captionSmall)
                                .foregroundColor(NordTheme.secondaryText(colorScheme))
                            Picker("Provider", selection: $selectedProvider) {
                                ForEach(SelfHostedProvider.allCases) { provider in
                                    Text(provider.displayName).tag(provider)
                                }
                            }
                            .pickerStyle(.menu)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        if selectedProvider.supportsResponsesAPI {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Responses API")
                                    .font(OKFont.captionSmall)
                                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                                Toggle("Use /v1/responses", isOn: $openModelResponsesAPIEnabled)
                                    .toggleStyle(.switch)
                                    .font(OKFont.bodyEmphasized)
                                Text("Enable only when your gateway supports it.")
                                    .font(OKFont.captionSmall)
                                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                            }
                            .frame(width: 250, alignment: .leading)
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("API Key")
                            .font(OKFont.captionSmall)
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                        SecureField(selectedProvider.keyPlaceholder, text: $providerKey)
                            .textFieldStyle(.roundedBorder)
                            .font(OKFont.monoInline)
                    }

                    if selectedProvider.supportsBaseURL {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Base URL (optional)")
                                .font(OKFont.captionSmall)
                                .foregroundColor(NordTheme.secondaryText(colorScheme))
                            TextField("http://localhost:8000/v1", text: $openModelBaseURL)
                                .textFieldStyle(.roundedBorder)
                                .font(OKFont.monoInline)
                            Text("Leave blank for the default OpenAI-compatible gateway.")
                                .font(OKFont.captionSmall)
                                .foregroundColor(NordTheme.secondaryText(colorScheme))
                        }
                    }

                    HStack {
                        Button(action: { setupStep = 0 }) {
                            Label("Back", systemImage: "arrow.left")
                                .font(OKFont.bodyEmphasized)
                        }
                        .buttonStyle(.bordered)
                        .disabled(isLoading)

                        Spacer()

                        if isLoading {
                            ProgressView()
                                .scaleEffect(0.75)
                        }

                        Button(action: startDaemon) {
                            Label("Start Daemon", systemImage: "play.fill")
                                .font(OKFont.bodyEmphasized)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(NordTheme.accentGreen(colorScheme))
                        .disabled(isLoading || providerKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private var saasUnavailableView: some View {
        VStack(alignment: .leading, spacing: 14) {
            actionRow(
                icon: "cloud.slash.fill",
                title: "SaaS is unavailable",
                subtitle: "Omnikey is not offering SaaS right now; please run the local daemon."
            )

            VStack(alignment: .leading, spacing: 8) {
                Text("License Key")
                    .font(OKFont.captionSmall)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                TextField("SaaS activation is currently disabled", text: .constant(""))
                    .textFieldStyle(.roundedBorder)
                    .disabled(true)
            }
        }
    }

    private var subscriptionView: some View {
        VStack(spacing: 0) {
            setupHeader(
                title: "Activate OmniKey",
                subtitle: "Enter your subscription key to unlock all features."
            )

            Divider().overlay(NordTheme.border(colorScheme))

            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Subscription Key", systemImage: "key.fill")
                        .font(OKFont.captionSmall)
                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                    HStack(spacing: 8) {
                        Image(systemName: "key")
                            .font(.system(size: 13))
                            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.6))
                            .frame(width: 16)

                        TextField("Paste your subscription key here", text: $key)
                            .textFieldStyle(.plain)
                            .font(OKFont.monoInline)
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

                statusView
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 20)

            Divider().overlay(NordTheme.border(colorScheme))

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
                .font(OKFont.body)
                .foregroundColor(NordTheme.secondaryText(colorScheme))

                Button(action: activate) {
                    Label("Activate", systemImage: "checkmark.seal.fill")
                        .font(OKFont.bodyEmphasized)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(isLoading || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .tint(NordTheme.accentBlue(colorScheme))
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 16)
        }
        .frame(maxWidth: 540)
        .background(cardBackground(cornerRadius: 16))
    }

    private var stepIndicator: some View {
        HStack(spacing: 10) {
            setupStepPill(number: 1, title: "Install", isActive: setupStep == 0)
            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)
            setupStepPill(number: 2, title: "Configure", isActive: setupStep == 1)
        }
    }

    private var statusView: some View {
        Group {
            if !statusMessage.isEmpty {
                HStack(spacing: 8) {
                    let isSuccess = statusMessage.localizedCaseInsensitiveContains("ready")
                        || statusMessage.localizedCaseInsensitiveContains("successful")
                    let isFailure = statusMessage.localizedCaseInsensitiveContains("failed")
                        || statusMessage.localizedCaseInsensitiveContains("could not")

                    Image(systemName: isSuccess ? "checkmark.circle.fill" : isFailure ? "xmark.circle.fill" : "info.circle.fill")
                        .font(.system(size: 13))
                        .foregroundColor(isSuccess ? NordTheme.accentGreen(colorScheme) : isFailure ? Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255) : NordTheme.secondaryText(colorScheme))

                    Text(statusMessage)
                        .font(OKFont.caption)
                        .foregroundColor(isSuccess ? NordTheme.accentGreen(colorScheme) : isFailure ? Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255) : NordTheme.secondaryText(colorScheme))
                        .lineLimit(5)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(NordTheme.editorBackground(colorScheme))
                )
            }
        }
    }

    private func setupHeader(title: String, subtitle: String) -> some View {
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
                Text(title)
                    .font(OKFont.title)
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Text(subtitle)
                    .font(OKFont.caption)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
    }

    private func setupStepPill(number: Int, title: String, isActive: Bool) -> some View {
        HStack(spacing: 6) {
            Text("\(number)")
                .font(OKFont.captionSmall)
                .foregroundColor(.white)
                .frame(width: 20, height: 20)
                .background(Circle().fill(isActive ? NordTheme.accent(colorScheme) : NordTheme.secondaryText(colorScheme).opacity(0.35)))

            Text(title)
                .font(OKFont.captionSmall)
                .foregroundColor(isActive ? NordTheme.primaryText(colorScheme) : NordTheme.secondaryText(colorScheme))
        }
    }

    private func actionRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(NordTheme.accent(colorScheme))
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(OKFont.headline)
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Text(subtitle)
                    .font(OKFont.caption)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(NordTheme.editorBackground(colorScheme))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(NordTheme.border(colorScheme), lineWidth: 1)
                )
        )
    }

    private func cardBackground(cornerRadius: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(NordTheme.panelBackground(colorScheme))
            LinearGradient(
                gradient: Gradient(colors: [
                    NordTheme.accentBlue(colorScheme).opacity(colorScheme == .dark ? 0.04 : 0.02),
                    Color.clear,
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.12), radius: 18, x: 0, y: 14)
    }

    private func resolveInitialScreen() {
        guard case .checking = screenMode else { return }
        SelfHostedBootstrap.shouldShowFirstRunOnboarding { shouldShowOnboarding in
            Task { @MainActor in
                screenMode = shouldShowOnboarding ? .onboarding : .subscription
                if shouldShowOnboarding {
                    statusMessage = ""
                }
            }
        }
    }

    private func installCLI() {
        isLoading = true
        statusMessage = "Checking omnikey-cli and installing the latest version if needed..."

        SelfHostedBootstrap.installOrUpdateCLI { result in
            Task { @MainActor in
                isLoading = false

                switch result {
                case let .success(installResult):
                    statusMessage = installResult.message

                case let .failure(error):
                    statusMessage = "Install failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func startDaemon() {
        let trimmedKey = providerKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty else { return }

        isLoading = true
        let port = SelfHostedBootstrap.findAvailablePort()
        statusMessage = "Checking omnikey-cli before starting the daemon..."

        SelfHostedBootstrap.installOrUpdateCLI { result in
            Task { @MainActor in
                switch result {
                case .success:
                    launchDaemon(port: port, apiKey: trimmedKey)

                case let .failure(error):
                    isLoading = false
                    statusMessage = "Install failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func launchDaemon(port: Int, apiKey: String) {
        statusMessage = "Preparing local config and starting the daemon in the background on port \(port)..."

        do {
            try SelfHostedBootstrap.writeSelfHostedConfig(
                provider: selectedProvider,
                apiKey: apiKey,
                openModelBaseURL: openModelBaseURL,
                openModelResponsesAPIEnabled: openModelResponsesAPIEnabled,
                port: port
            )
        } catch {
            isLoading = false
            statusMessage = "Daemon config failed: \(error.localizedDescription)"
            return
        }

        SelfHostedBootstrap.startDaemonInBackground(port: port) { result in
            Task { @MainActor in
                switch result {
                case .success:
                    statusMessage = "Daemon start requested. Checking local server..."
                    finishWhenDaemonIsReady(port: port)

                case let .failure(error):
                    isLoading = false
                    statusMessage = "Daemon failed to start: \(error.localizedDescription)"
                }
            }
        }
    }

    private func finishWhenDaemonIsReady(port: Int) {
        SelfHostedBootstrap.waitForDaemon(port: port, timeout: 60) { isRunning in
            Task { @MainActor in
                guard isRunning else {
                    isLoading = false
                    statusMessage = "Could not reach the local daemon. Check ~/.omnikey/daemon-bootstrap.log and ~/.omnikey/daemon-error.log."
                    return
                }

                statusMessage = "Daemon is ready. Finishing local sign-in..."
                SubscriptionManager.shared.activateStoredKey { success in
                    DispatchQueue.main.async {
                        isLoading = false
                        if success {
                            statusMessage = "Local setup successful. OmniKey is ready."
                            AppDelegate.shared?.handleSuccessfulAuthorization()
                        } else {
                            statusMessage = "Daemon is running, but local sign-in failed. Try Start Daemon again."
                        }
                    }
                }
            }
        }
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
