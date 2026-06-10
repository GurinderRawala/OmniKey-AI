import SwiftUI

/// Smart-tier model choices for OpenAI. The fast model (gpt-4o-mini) is fixed.
/// gpt-5.5 uses the Responses API; gpt-5.1 uses Chat Completions.
private let openAISmartModels: [(id: String, label: String)] = [
    ("gpt-5.5", "gpt-5.5"),
    ("gpt-5.1", "gpt-5.1"),
]

private enum ProviderKind: String, CaseIterable, Identifiable {
    case openai, anthropic, gemini, nemotron
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .openai:    return "OpenAI"
        case .anthropic: return "Anthropic (Claude)"
        case .gemini:    return "Google Gemini"
        case .nemotron:  return "NVIDIA Nemotron"
        }
    }
    var keyPlaceholder: String {
        switch self {
        case .openai:    return "sk-..."
        case .anthropic: return "sk-ant-..."
        case .gemini:    return "AIza..."
        case .nemotron:  return "nvapi-..."
        }
    }
    var supportsBaseUrl: Bool { self == .nemotron }
    var baseUrlPlaceholder: String { "https://integrate.api.nvidia.com/v1" }
}

private struct ProviderRowState: Identifiable {
    let kind: ProviderKind
    let dto: APIClient.AIProviderDTO
    var id: String { kind.rawValue }
}

struct AIProvidersSettingsView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var rows: [ProviderRowState] = []
    @State private var activeProvider: String = ""
    @State private var runtimeProvider: String? = nil
    @State private var isLoading: Bool = false
    @State private var statusMessage: String = ""

    // Editor sheet
    @State private var isEditing: Bool = false
    @State private var editingKind: ProviderKind = .openai
    @State private var apiKeyInput: String = ""
    @State private var baseUrlInput: String = ""

    // Dialog state
    @State private var pendingDelete: ProviderRowState? = nil
    @State private var pendingActivate: ProviderRowState? = nil

    // OpenAI model picker state
    @State private var openaiModelSelected: String = openAISmartModels[0].id
    @State private var pendingModelChange: String? = nil

    private let apiClient = APIClient()

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                headerSection
                    .padding(.horizontal, 24)
                    .padding(.top, 20)
                    .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)

                if isEditing {
                    ScrollView { editPanel.padding(24) }
                } else {
                    providerListSection
                        .padding(.horizontal, 24)
                        .padding(.top, 16)
                }

                Spacer()

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .padding(.horizontal, 24)
                        .padding(.bottom, 12)
                }
            }
        }
        .onAppear { loadProviders() }
        .confirmationDialog(
            "Remove key for \(pendingDelete?.kind.displayName ?? "")?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let row = pendingDelete { pendingDelete = nil; deleteKey(row) }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("This clears the API key for this provider from ~/.omnikey/config.json. The active provider cannot be removed.")
        }
        .confirmationDialog(
            "Activate \(pendingActivate?.kind.displayName ?? "")?",
            isPresented: Binding(
                get: { pendingActivate != nil },
                set: { if !$0 { pendingActivate = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Activate & Restart Server") {
                if let row = pendingActivate { pendingActivate = nil; activateProvider(row) }
            }
            Button("Cancel", role: .cancel) { pendingActivate = nil }
        } message: {
            Text("AI_PROVIDER will be set to \(pendingActivate?.kind.rawValue ?? "") in ~/.omnikey/config.json and the OmniKey daemon will restart. In-flight agent sessions will be interrupted.")
        }
        .confirmationDialog(
            "Apply model \"\(pendingModelChange ?? "")\"?",
            isPresented: Binding(
                get: { pendingModelChange != nil },
                set: { if !$0 { pendingModelChange = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Apply & Restart Server") {
                if let model = pendingModelChange { pendingModelChange = nil; applyModel(model) }
            }
            Button("Cancel", role: .cancel) { pendingModelChange = nil }
        } message: {
            Text("OPENAI_MODEL will be set to \"\(pendingModelChange ?? "")\" in ~/.omnikey/config.json and the server will restart to apply the change.")
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "key.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))

                Text("Settings · AI Providers")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Spacer()

                if !isEditing {
                    Button(action: loadProviders) {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .tint(NordTheme.accentBlue(colorScheme))
                    .disabled(isLoading)
                }
            }

            Text("Save an API key for each provider you want to use. Activating a provider sets AI_PROVIDER and restarts the local server.")
                .font(.system(size: 13))
                .foregroundColor(NordTheme.secondaryText(colorScheme))

            if let runtime = runtimeProvider, !activeProvider.isEmpty, runtime != activeProvider {
                Text("Note: server is currently running with \"\(runtime)\" but config.json has AI_PROVIDER=\"\(activeProvider)\". Activate again to apply.")
                    .font(.system(size: 12))
                    .foregroundColor(.orange)
                    .padding(.top, 2)
            }
        }
    }

    // MARK: - Provider list

    private var providerListSection: some View {
        Group {
            if isLoading && rows.isEmpty {
                HStack { Spacer(); ProgressView().padding(); Spacer() }
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(rows) { row in
                            providerRow(row)
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
        }
    }

    private func providerRow(_ row: ProviderRowState) -> some View {
        let isActive = row.kind.rawValue == activeProvider
        let dto = row.dto

        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Circle()
                    .fill(dto.isConfigured
                          ? (isActive ? NordTheme.accentGreen(colorScheme) : NordTheme.accentBlue(colorScheme))
                          : NordTheme.secondaryText(colorScheme).opacity(0.5))
                    .frame(width: 8, height: 8)

                Text(row.kind.displayName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Text(row.kind.rawValue)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().stroke(NordTheme.border(colorScheme), lineWidth: 1))

                Spacer()

                // OpenAI-only: compact model picker in the card header
                if row.kind == .openai {
                    Picker("", selection: $openaiModelSelected) {
                        ForEach(openAISmartModels, id: \.id) { m in
                            Text(m.label).tag(m.id)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .font(.system(size: 12))

                    let currentModel = dto.model ?? openAISmartModels[0].id
                    if openaiModelSelected != currentModel {
                        Button("Apply") { pendingModelChange = openaiModelSelected }
                            .buttonStyle(.borderedProminent)
                            .tint(NordTheme.accentBlue(colorScheme))
                            .controlSize(.mini)
                    }
                }

                if isActive {
                    Text("Active")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(NordTheme.accentGreen(colorScheme))
                } else if !dto.isConfigured {
                    Text("Not configured")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
            }

            HStack(spacing: 8) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                if dto.isConfigured {
                    Text(dto.apiKeyMasked ?? "••••••••")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                } else {
                    Text("No key saved")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.8))
                }
                if let baseUrl = dto.baseUrl, !baseUrl.isEmpty {
                    Text("· \(baseUrl)")
                        .font(.system(size: 12))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.85))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            HStack(spacing: 8) {
                if dto.isConfigured && !isActive {
                    Button("Activate") { pendingActivate = row }
                        .buttonStyle(.borderedProminent)
                        .tint(NordTheme.accent(colorScheme))
                        .controlSize(.small)
                }
                Button(dto.isConfigured ? "Update Key" : "Set Key") { startEditing(row.kind) }
                    .buttonStyle(.bordered)
                    .tint(NordTheme.accentBlue(colorScheme))
                    .controlSize(.small)
                if dto.isConfigured {
                    Button("Remove") { pendingDelete = row }
                        .buttonStyle(.bordered)
                        .tint(.red)
                        .controlSize(.small)
                        .disabled(isActive)
                }
                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isActive
                        ? NordTheme.accentGreen(colorScheme)
                        : NordTheme.border(colorScheme),
                        lineWidth: isActive ? 1.5 : 1)
        )
    }

    // MARK: - Edit panel

    private var editPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Set API key for \(editingKind.displayName)")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))

            VStack(alignment: .leading, spacing: 6) {
                Text("API Key").font(.system(size: 12, weight: .medium))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                SecureField(editingKind.keyPlaceholder, text: $apiKeyInput)
                    .textFieldStyle(.roundedBorder)
                Text("The key is written to ~/.omnikey/config.json and read by the local daemon on startup.")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.85))
            }

            if editingKind.supportsBaseUrl {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Base URL (optional)").font(.system(size: 12, weight: .medium))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                    TextField(editingKind.baseUrlPlaceholder, text: $baseUrlInput)
                        .textFieldStyle(.roundedBorder)
                    Text("Leave blank to use NVIDIA's public NIM endpoint.")
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.85))
                }
            }

            HStack {
                Button("Cancel") { cancelEditing() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Save") { saveKey() }
                    .buttonStyle(.borderedProminent)
                    .tint(NordTheme.accent(colorScheme))
                    .disabled(isLoading || apiKeyInput.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 18)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(10)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(NordTheme.border(colorScheme), lineWidth: 1))
        .frame(maxWidth: 560, alignment: .leading)
    }

    // MARK: - Actions

    private func startEditing(_ kind: ProviderKind) {
        editingKind = kind
        apiKeyInput = ""
        let existing = rows.first(where: { $0.kind == kind })?.dto.baseUrl ?? ""
        baseUrlInput = existing
        statusMessage = ""
        isEditing = true
    }

    private func cancelEditing() {
        isEditing = false
        statusMessage = ""
    }

    private func loadProviders() {
        isLoading = true
        statusMessage = ""
        apiClient.fetchAIProviders { result in
            DispatchQueue.main.async {
                isLoading = false
                switch result {
                case .success(let response):
                    let byKind: [String: APIClient.AIProviderDTO] = Dictionary(
                        uniqueKeysWithValues: response.providers.map { ($0.provider, $0) }
                    )
                    rows = ProviderKind.allCases.map { kind in
                        let dto = byKind[kind.rawValue] ?? APIClient.AIProviderDTO(
                            provider: kind.rawValue,
                            isConfigured: false,
                            apiKeyMasked: nil,
                            baseUrl: nil,
                            model: nil
                        )
                        return ProviderRowState(kind: kind, dto: dto)
                    }
                    activeProvider = response.activeProvider
                    runtimeProvider = response.runtimeProvider
                    // Sync the model picker to whatever the server reports.
                    if let openaiRow = byKind["openai"], let m = openaiRow.model {
                        openaiModelSelected = m
                    } else {
                        openaiModelSelected = openAISmartModels[0].id
                    }
                case .failure(let error):
                    statusMessage = "Failed to load providers: \(error.localizedDescription)"
                }
            }
        }
    }

    private func saveKey() {
        let trimmedKey = apiKeyInput.trimmingCharacters(in: .whitespaces)
        let trimmedBase = baseUrlInput.trimmingCharacters(in: .whitespaces)
        guard !trimmedKey.isEmpty else { return }

        isLoading = true
        statusMessage = "Saving \(editingKind.displayName) key…"

        let input = APIClient.AIProviderInput(
            apiKey: trimmedKey,
            baseUrl: trimmedBase.isEmpty ? nil : trimmedBase
        )
        let providerRaw = editingKind.rawValue

        apiClient.saveAIProviderKey(provider: providerRaw, input: input) { result in
            DispatchQueue.main.async {
                isLoading = false
                switch result {
                case .success(let resp):
                    if resp.restartScheduled == true {
                        statusMessage = "Saved. Server is restarting to pick up the new key…"
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { loadProviders() }
                    } else {
                        statusMessage = "Saved \(editingKind.displayName) key."
                        loadProviders()
                    }
                    isEditing = false
                case .failure(let error):
                    statusMessage = "Failed to save: \(error.localizedDescription)"
                }
            }
        }
    }

    private func deleteKey(_ row: ProviderRowState) {
        isLoading = true
        statusMessage = "Removing \(row.kind.displayName) key…"
        apiClient.deleteAIProviderKey(provider: row.kind.rawValue) { result in
            DispatchQueue.main.async {
                isLoading = false
                switch result {
                case .success:
                    statusMessage = "Removed \(row.kind.displayName) key."
                    loadProviders()
                case .failure(let error):
                    statusMessage = "Failed to remove: \(error.localizedDescription)"
                }
            }
        }
    }

    private func applyModel(_ model: String) {
        isLoading = true
        statusMessage = "Applying model \"\(model)\" — server will restart…"
        apiClient.updateProviderModel(provider: "openai", model: model) { result in
            DispatchQueue.main.async {
                switch result {
                case .success:
                    statusMessage = "Model set to \"\(model)\". Waiting for daemon restart…"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { loadProviders() }
                case .failure(let error):
                    isLoading = false
                    statusMessage = "Failed to apply model: \(error.localizedDescription)"
                }
            }
        }
    }

    private func activateProvider(_ row: ProviderRowState) {
        isLoading = true
        statusMessage = "Activating \(row.kind.displayName) — server will restart…"
        apiClient.activateAIProvider(provider: row.kind.rawValue) { result in
            DispatchQueue.main.async {
                switch result {
                case .success:
                    statusMessage = "\(row.kind.displayName) activated. Waiting for daemon restart…"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                        loadProviders()
                    }
                case .failure(let error):
                    isLoading = false
                    statusMessage = "Failed to activate: \(error.localizedDescription)"
                }
            }
        }
    }
}
