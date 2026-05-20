import SwiftUI

private enum MCPTransport: String, CaseIterable, Identifiable {
    case stdio, http, sse
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .stdio: return "stdio (local process)"
        case .http:  return "http"
        case .sse:   return "sse"
        }
    }
}

private struct KVRow: Identifiable, Equatable {
    let id = UUID()
    var key: String
    var value: String
}

struct MCPServersView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var servers: [APIClient.MCPServerDTO] = []
    @State private var isLoading: Bool = false
    @State private var statusMessage: String = ""
    @State private var isEditing: Bool = false
    @State private var editingServerId: String? = nil

    // Form fields
    @State private var nameInput: String = ""
    @State private var descriptionInput: String = ""
    @State private var transport: MCPTransport = .stdio
    @State private var commandInput: String = ""
    @State private var argsInput: String = ""
    @State private var urlInput: String = ""
    @State private var envRows: [KVRow] = []
    @State private var headerRows: [KVRow] = []
    @State private var enabledInput: Bool = true

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
                    ScrollView {
                        editPanel
                            .padding(24)
                    }
                } else {
                    serverListSection
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
        .onAppear { loadServers() }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "puzzlepiece.extension.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))

                Text("MCP Servers")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Spacer()

                if !isEditing {
                    Button(action: refreshServers) {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .tint(NordTheme.accentBlue(colorScheme))
                    .disabled(isLoading)

                    Button(action: startAdding) {
                        Label("Install MCP Server", systemImage: "plus")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(NordTheme.accent(colorScheme))
                    .disabled(isLoading)
                }
            }

            Text("Manage Model Context Protocol servers that extend the global agent's capabilities.")
                .font(.system(size: 13))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
    }

    // MARK: - Server list

    private var serverListSection: some View {
        Group {
            if isLoading {
                HStack { Spacer(); ProgressView().padding(); Spacer() }
            } else if servers.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "puzzlepiece.extension")
                        .font(.system(size: 36))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .padding(.top, 32)
                    Text("No MCP servers installed yet.")
                        .font(.system(size: 14))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                    Text("Click \"Install MCP Server\" to add one.")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.7))
                }
                .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(servers) { server in
                            serverRow(server)
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
        }
    }

    private func serverRow(_ server: APIClient.MCPServerDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Circle()
                    .fill(server.isEnabled
                          ? NordTheme.accentGreen(colorScheme)
                          : NordTheme.secondaryText(colorScheme))
                    .frame(width: 8, height: 8)

                Text(server.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                Text(server.transport)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().stroke(NordTheme.border(colorScheme), lineWidth: 1))

                Spacer()

                Text(server.isEnabled ? "Enabled" : "Disabled")
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }

            if let desc = server.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .lineLimit(2)
            }

            if server.transport == "stdio" {
                if let cmd = server.command, !cmd.isEmpty {
                    Text("Command: \(cmd) \(server.args.joined(separator: " "))")
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.accentPurple(colorScheme))
                        .lineLimit(1)
                }
            } else if let url = server.url, !url.isEmpty {
                Text("URL: \(url)")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
                    .lineLimit(1)
            }

            HStack(spacing: 10) {
                Button("Edit") { startEditing(server) }
                    .buttonStyle(.bordered).font(.system(size: 12))

                Button(server.isEnabled ? "Disable" : "Enable") { toggleEnabled(server) }
                    .buttonStyle(.bordered).font(.system(size: 12))
                    .disabled(isLoading)

                Spacer()

                Button("Delete") { deleteServer(server) }
                    .buttonStyle(.bordered).font(.system(size: 12))
                    .foregroundColor(.red)
                    .disabled(isLoading)
            }
        }
        .padding(12)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NordTheme.border(colorScheme), lineWidth: 1))
    }

    // MARK: - Edit Panel

    private var editPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(editingServerId == nil ? "Install MCP Server" : "Edit MCP Server")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))

            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("Name")
                TextField("e.g. github", text: $nameInput)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("Description (optional)")
                TextField("Short description of this MCP server", text: $descriptionInput)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("Transport")
                Picker("", selection: $transport) {
                    ForEach(MCPTransport.allCases) { t in
                        Text(t.displayName).tag(t)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
            }

            if transport == .stdio {
                stdioFields
            } else {
                remoteFields
            }

            Toggle("Enabled", isOn: $enabledInput)
                .toggleStyle(.switch)

            HStack(spacing: 12) {
                Button("Cancel") { cancelEditing() }
                    .buttonStyle(.bordered)

                Button("Save MCP Server") { saveServer() }
                    .buttonStyle(.borderedProminent)
                    .tint(NordTheme.accent(colorScheme))
                    .disabled(
                        nameInput.trimmingCharacters(in: .whitespaces).isEmpty ||
                        (transport == .stdio && commandInput.trimmingCharacters(in: .whitespaces).isEmpty) ||
                        (transport != .stdio && urlInput.trimmingCharacters(in: .whitespaces).isEmpty) ||
                        isLoading
                    )
            }
        }
    }

    private var stdioFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("Command")
                TextField("/usr/local/bin/my-mcp-server", text: $commandInput)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("Arguments (one per line)")
                TextEditor(text: $argsInput)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(height: 70)
                    .padding(6)
                    .background(NordTheme.editorBackground(colorScheme))
                    .cornerRadius(6)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(NordTheme.border(colorScheme), lineWidth: 1))
            }

            kvSection(title: "Environment Variables", rows: $envRows)
        }
        .padding(14)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NordTheme.border(colorScheme), lineWidth: 1))
    }

    private var remoteFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                fieldLabel("URL")
                TextField("https://example.com/mcp", text: $urlInput)
                    .textFieldStyle(.roundedBorder)
            }

            kvSection(title: "Headers", rows: $headerRows)
        }
        .padding(14)
        .background(NordTheme.panelBackground(colorScheme))
        .cornerRadius(8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(NordTheme.border(colorScheme), lineWidth: 1))
    }

    private func kvSection(title: String, rows: Binding<[KVRow]>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                fieldLabel(title)
                Spacer()
                Button {
                    rows.wrappedValue.append(KVRow(key: "", value: ""))
                } label: {
                    Label("Add", systemImage: "plus.circle")
                        .font(.system(size: 11))
                }
                .buttonStyle(.borderless)
            }

            ForEach(rows.wrappedValue.indices, id: \.self) { idx in
                HStack(spacing: 6) {
                    TextField("KEY", text: rows[idx].key)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 180)
                    TextField("VALUE", text: rows[idx].value)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        rows.wrappedValue.remove(at: idx)
                    } label: {
                        Image(systemName: "minus.circle.fill")
                            .foregroundColor(.red)
                    }
                    .buttonStyle(.borderless)
                }
            }

            if rows.wrappedValue.isEmpty {
                Text("None set.")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
        }
    }

    // MARK: - Helpers

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(NordTheme.secondaryText(colorScheme))
    }

    private func dictFromRows(_ rows: [KVRow]) -> [String: String] {
        var out: [String: String] = [:]
        for r in rows {
            let k = r.key.trimmingCharacters(in: .whitespaces)
            if k.isEmpty { continue }
            out[k] = r.value
        }
        return out
    }

    private func rowsFromDict(_ dict: [String: String]) -> [KVRow] {
        dict.sorted { $0.key < $1.key }.map { KVRow(key: $0.key, value: $0.value) }
    }

    // MARK: - Actions

    private func loadServers() {
        isLoading = true
        apiClient.fetchMCPServers { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success(let fetched): self.servers = fetched
                case .failure(let err): self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }

    private func refreshServers() {
        statusMessage = ""
        loadServers()
    }

    private func startAdding() {
        editingServerId = nil
        nameInput = ""
        descriptionInput = ""
        transport = .stdio
        commandInput = ""
        argsInput = ""
        urlInput = ""
        envRows = []
        headerRows = []
        enabledInput = true
        isEditing = true
    }

    private func startEditing(_ s: APIClient.MCPServerDTO) {
        editingServerId = s.id
        nameInput = s.name
        descriptionInput = s.description ?? ""
        transport = MCPTransport(rawValue: s.transport) ?? .stdio
        commandInput = s.command ?? ""
        argsInput = s.args.joined(separator: "\n")
        urlInput = s.url ?? ""
        envRows = rowsFromDict(s.env)
        headerRows = rowsFromDict(s.headers)
        enabledInput = s.isEnabled
        isEditing = true
    }

    private func cancelEditing() {
        isEditing = false
        statusMessage = ""
    }

    private func saveServer() {
        isLoading = true
        statusMessage = ""

        let name = nameInput.trimmingCharacters(in: .whitespaces)
        let description = descriptionInput.trimmingCharacters(in: .whitespaces)
        let args = argsInput
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let env = dictFromRows(envRows)
        let headers = dictFromRows(headerRows)

        let payload = APIClient.MCPServerInput(
            name: name,
            description: description.isEmpty ? nil : description,
            transport: transport.rawValue,
            command: transport == .stdio ? commandInput.trimmingCharacters(in: .whitespaces) : nil,
            args: transport == .stdio ? args : [],
            env: transport == .stdio ? env : [:],
            url: transport != .stdio ? urlInput.trimmingCharacters(in: .whitespaces) : nil,
            headers: transport != .stdio ? headers : [:],
            isEnabled: enabledInput
        )

        let completion: @Sendable (Result<APIClient.MCPServerDTO, Error>) -> Void = { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success:
                    self.isEditing = false
                    self.loadServers()
                    self.statusMessage = "MCP server saved."
                case .failure(let err):
                    self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }

        if let id = editingServerId {
            apiClient.updateMCPServer(id: id, input: payload, completion: completion)
        } else {
            apiClient.createMCPServer(input: payload, completion: completion)
        }
    }

    private func deleteServer(_ server: APIClient.MCPServerDTO) {
        isLoading = true
        apiClient.deleteMCPServer(id: server.id) { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success:
                    self.servers.removeAll { $0.id == server.id }
                    self.statusMessage = "MCP server deleted."
                case .failure(let err):
                    self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }

    private func toggleEnabled(_ server: APIClient.MCPServerDTO) {
        isLoading = true
        let patch = APIClient.MCPServerPatch(isEnabled: !server.isEnabled)
        apiClient.patchMCPServer(id: server.id, patch: patch) { result in
            DispatchQueue.main.async {
                self.isLoading = false
                switch result {
                case .success: self.loadServers()
                case .failure(let err): self.statusMessage = "Error: \(err.localizedDescription)"
                }
            }
        }
    }
}
