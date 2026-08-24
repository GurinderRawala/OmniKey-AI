import Darwin
import Foundation

enum SelfHostedProvider: String, CaseIterable, Identifiable {
    case openai
    case anthropic
    case gemini
    case nemotron

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .openai: return "OpenAI"
        case .anthropic: return "Anthropic (Claude)"
        case .gemini: return "Google Gemini"
        case .nemotron: return "Open Model"
        }
    }

    var apiKeyEnvName: String {
        switch self {
        case .openai: return "OPENAI_API_KEY"
        case .anthropic: return "ANTHROPIC_API_KEY"
        case .gemini: return "GEMINI_API_KEY"
        case .nemotron: return "OPEN_MODEL_API_KEY"
        }
    }

    var keyPlaceholder: String {
        switch self {
        case .openai: return "sk-..."
        case .anthropic: return "sk-ant-..."
        case .gemini: return "AIza..."
        case .nemotron: return "API key or local placeholder"
        }
    }

    var supportsBaseURL: Bool { self == .nemotron }
    var supportsResponsesAPI: Bool { self == .nemotron }
}

struct CLIInstallResult: Sendable {
    let message: String
    let output: String
}

struct CLIUpdateStatus: Sendable {
    let currentVersion: String?
    let latestVersion: String?
    let isUpdateAvailable: Bool
}

enum SelfHostedBootstrap {
    private final class ProbeResult: @unchecked Sendable {
        var isRunning = false
    }

    private struct BootstrapError: LocalizedError {
        let message: String

        var errorDescription: String? { message }
    }

    static var configURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".omnikey")
            .appendingPathComponent("config.json")
    }

    static func configExists() -> Bool {
        FileManager.default.fileExists(atPath: configURL.path)
    }

    static func shouldShowFirstRunOnboarding(completion: @escaping @Sendable (Bool) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard configExists() else {
                DispatchQueue.main.async { completion(true) }
                return
            }

            guard let port = configuredDaemonPort() else {
                DispatchQueue.main.async { completion(true) }
                return
            }

            let configuredDaemonRunning = probeHealth(port: port, timeout: 1.0)
            DispatchQueue.main.async {
                completion(!configuredDaemonRunning)
            }
        }
    }

    static func configuredDaemonPort() -> Int? {
        guard let data = try? Data(contentsOf: configURL),
              let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
        else {
            return nil
        }

        if let port = json["OMNIKEY_PORT"] as? Int, port > 0 {
            return port
        }

        if let raw = json["OMNIKEY_PORT"] as? String,
           let port = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           port > 0
        {
            return port
        }

        return nil
    }

    static func checkCLIUpdate(completion: @escaping @Sendable (Result<CLIUpdateStatus, Error>) -> Void) {
        let command = """
        /bin/bash -lc '
        set -euo pipefail
        export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.yarn/bin:$HOME/.config/yarn/global/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

        package="omnikey-cli"

        have() { command -v "$1" >/dev/null 2>&1; }
        clean_version() {
          grep -Eo "[0-9]+([.][0-9]+){1,3}" | head -n 1
        }

        if ! have omnikey; then
          echo "OMNIKEY_CLI_INSTALLED=false"
          exit 0
        fi

        current="$(omnikey --version 2>/dev/null | clean_version || true)"
        latest=""
        if have npm; then
          latest="$(npm view "$package" version 2>/dev/null | head -n 1 || true)"
        fi

        echo "OMNIKEY_CLI_INSTALLED=true"
        echo "OMNIKEY_CLI_CURRENT_VERSION=$current"
        echo "OMNIKEY_CLI_LATEST_VERSION=$latest"
        '
        """
        DispatchQueue.global(qos: .utility).async {
            let result = runShellCommandWithStatus(command)
            let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)

            DispatchQueue.main.async {
                guard result.status == 0 else {
                    completion(.failure(BootstrapError(message: installFailureMessage(from: output))))
                    return
                }

                let current = nonEmptyMarker("OMNIKEY_CLI_CURRENT_VERSION", in: output)
                let latest = nonEmptyMarker("OMNIKEY_CLI_LATEST_VERSION", in: output)
                let hasUpdate: Bool
                if let current, let latest {
                    hasUpdate = compareVersions(latest, current) == .orderedDescending
                } else {
                    hasUpdate = false
                }

                completion(.success(CLIUpdateStatus(
                    currentVersion: current,
                    latestVersion: latest,
                    isUpdateAvailable: hasUpdate
                )))
            }
        }
    }

    static func findAvailablePort() -> Int {
        let fallback = Int.random(in: 7200 ... 7999)
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return fallback }
        defer { close(fd) }

        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { return fallback }

        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &length)
            }
        }
        guard nameResult == 0 else { return fallback }

        return Int(UInt16(bigEndian: address.sin_port))
    }

    static func writeSelfHostedConfig(
        provider: SelfHostedProvider,
        apiKey: String,
        openModelBaseURL: String?,
        openModelResponsesAPIEnabled: Bool,
        port: Int
    ) throws {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let configDir = home.appendingPathComponent(".omnikey")
        let sqlitePath = configDir.appendingPathComponent("omnikey-selfhosted.sqlite").path

        try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)

        var config: [String: Any] = [
            "AI_PROVIDER": provider.rawValue,
            provider.apiKeyEnvName: apiKey,
            "IS_SELF_HOSTED": true,
            "SQLITE_PATH": sqlitePath,
            "OMNIKEY_PORT": port,
            "TERMINAL_PLATFORM": "macos",
        ]

        if provider == .nemotron {
            if let openModelBaseURL,
               !openModelBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                config["OPEN_MODEL_BASE_URL"] = openModelBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            config["OPEN_MODEL_RESPONSES_API_ENABLED"] = String(openModelResponsesAPIEnabled)
        }

        let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: configURL, options: [.atomic])
        chmod(configURL.path, S_IRUSR | S_IWUSR)
    }

    static func installOrUpdateCLI(completion: @escaping @Sendable (Result<CLIInstallResult, Error>) -> Void) {
        let command = """
        /bin/bash -lc '
        set -euo pipefail
        export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.yarn/bin:$HOME/.config/yarn/global/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

        package="omnikey-cli"
        formula="omnikey-cli"
        tap="GurinderRawala/omnikey-ai"
        tap_url="https://github.com/GurinderRawala/OmniKey-AI.git"

        have() { command -v "$1" >/dev/null 2>&1; }
        clean_version() {
          grep -Eo "[0-9]+([.][0-9]+){1,3}" | head -n 1
        }
        current_version() {
          if have omnikey; then
            omnikey --version 2>/dev/null | clean_version || true
          fi
        }

        echo "Checking omnikey-cli..."
        current="$(current_version)"
        path="$(command -v omnikey 2>/dev/null || true)"
        if [[ -n "$current" ]]; then
          echo "Current version: $current"
          echo "Current path: $path"
        else
          echo "omnikey-cli is not installed yet."
        fi

        latest=""
        if have npm; then
          latest="$(npm view "$package" version 2>/dev/null || true)"
          if [[ -n "$latest" ]]; then
            echo "Latest npm version: $latest"
          fi
        fi

        if [[ -n "$current" && -n "$latest" && "$current" == "$latest" ]]; then
          echo "OMNIKEY_INSTALL_RESULT=already_latest"
          echo "OMNIKEY_INSTALL_VERSION=$current"
          exit 0
        fi

        install_with_npm() {
          echo "Installing latest omnikey-cli with npm..."
          npm install -g "$package@latest"
        }

        install_with_brew() {
          echo "Installing latest omnikey-cli with Homebrew..."
          brew tap "$tap" "$tap_url" >/dev/null 2>&1 || true
          brew update --quiet >/dev/null 2>&1 || true
          if brew list --formula "$formula" >/dev/null 2>&1; then
            brew upgrade "$formula" || brew reinstall "$formula"
          else
            brew install "$formula"
          fi
        }

        if have npm; then
          install_with_npm || {
            if have brew; then
              echo "npm install failed; trying Homebrew instead..."
              install_with_brew
            else
              echo "npm install failed and Homebrew is not available." >&2
              exit 1
            fi
          }
        elif have brew; then
          install_with_brew
        else
          echo "Homebrew or npm is required to install omnikey-cli." >&2
          echo "Install Homebrew or Node.js, then run this step again." >&2
          exit 127
        fi

        refreshed="$({ hash -r 2>/dev/null || true; current_version; })"
        if [[ -z "$refreshed" ]]; then
          echo "Installed, but the omnikey command is not on PATH." >&2
          exit 1
        fi

        if [[ -n "$latest" && "$refreshed" != "$latest" ]]; then
          echo "Installed version $refreshed, but latest npm version is $latest." >&2
          echo "PATH resolves omnikey at: $(command -v omnikey 2>/dev/null || echo unknown)" >&2
          exit 1
        fi

        echo "OMNIKEY_INSTALL_RESULT=installed_or_updated"
        echo "OMNIKEY_INSTALL_VERSION=$refreshed"
        '
        """
        DispatchQueue.global(qos: .userInitiated).async {
            let result = runShellCommandWithStatus(command)
            let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)

            DispatchQueue.main.async {
                guard result.status == 0 else {
                    completion(.failure(BootstrapError(message: installFailureMessage(from: output))))
                    return
                }

                completion(.success(CLIInstallResult(
                    message: installSuccessMessage(from: output),
                    output: output
                )))
            }
        }
    }

    static func startDaemonInBackground(
        port: Int,
        restartExisting: Bool = false,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        let command = """
        /bin/bash -lc '
        set -euo pipefail
        export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.yarn/bin:$HOME/.config/yarn/global/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

        if ! command -v omnikey >/dev/null 2>&1; then
          echo "omnikey-cli is not on PATH. Run Install omnikey-cli first." >&2
          exit 127
        fi

        mkdir -p "$HOME/.omnikey"
        bootstrap_log="$HOME/.omnikey/daemon-bootstrap.log"
        pid_file="$HOME/.omnikey/daemon-bootstrap.pid"

        if [[ "\(restartExisting)" == "true" ]]; then
          echo "Restarting OmniKey daemon on port \(port) at $(date)" >> "$bootstrap_log"
          if [[ -f "$pid_file" ]]; then
            old_pid="$(cat "$pid_file" 2>/dev/null || true)"
            if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
              kill "$old_pid" >/dev/null 2>&1 || true
              for _ in {1..20}; do
                kill -0 "$old_pid" >/dev/null 2>&1 || break
                sleep 0.15
              done
              kill -9 "$old_pid" >/dev/null 2>&1 || true
            fi
          fi
          if command -v pgrep >/dev/null 2>&1; then
            while IFS= read -r old_pid; do
              if [[ "$old_pid" =~ ^[0-9]+$ ]] && [[ "$old_pid" != "$$" ]]; then
                kill "$old_pid" >/dev/null 2>&1 || true
              fi
            done < <(pgrep -f "[o]mnikey[[:space:]]+daemon[[:space:]]+--port[[:space:]]+\(port)" || true)
            sleep 0.3
          fi
        fi

        echo "Starting OmniKey daemon on port \(port) at $(date)" >> "$bootstrap_log"
        nohup omnikey daemon --port \(port) >> "$bootstrap_log" 2>&1 &
        pid=$!
        echo "$pid" > "$pid_file"
        disown "$pid" 2>/dev/null || true

        echo "OMNIKEY_DAEMON_BOOTSTRAP_PID=$pid"
        echo "OMNIKEY_DAEMON_BOOTSTRAP_LOG=$bootstrap_log"
        '
        """
        DispatchQueue.global(qos: .userInitiated).async {
            let result = runShellCommandWithStatus(command)
            let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)

            DispatchQueue.main.async {
                guard result.status == 0 else {
                    completion(.failure(BootstrapError(message: daemonStartFailureMessage(from: output))))
                    return
                }

                completion(.success(output))
            }
        }
    }

    static func waitForDaemon(
        port: Int,
        timeout: TimeInterval = 180,
        completion: @escaping @Sendable (Bool) -> Void
    ) {
        let deadline = Date().addingTimeInterval(timeout)

        @Sendable func poll() {
            if probeHealth(port: port, timeout: 1.0) {
                DispatchQueue.main.async { completion(true) }
                return
            }

            guard Date() < deadline else {
                DispatchQueue.main.async { completion(false) }
                return
            }

            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.0) {
                poll()
            }
        }

        DispatchQueue.global(qos: .userInitiated).async {
            poll()
        }
    }

    private static func probeHealth(port: Int, timeout: TimeInterval) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }

        let result = ProbeResult()
        let semaphore = DispatchSemaphore(value: 0)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: configuration)
        let task = session.dataTask(with: url) { _, response, _ in
            result.isRunning = (response as? HTTPURLResponse)?.statusCode == 200
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + timeout + 0.5)
        session.invalidateAndCancel()
        return result.isRunning
    }

    private static func installSuccessMessage(from output: String) -> String {
        let version = installMarker("OMNIKEY_INSTALL_VERSION", in: output)

        if output.contains("OMNIKEY_INSTALL_RESULT=already_latest") {
            if let version {
                return "omnikey-cli \(version) is already up to date. Click Next to continue."
            }
            return "omnikey-cli is already up to date. Click Next to continue."
        }

        if let version {
            return "omnikey-cli \(version) is installed and ready. Click Next to continue."
        }

        return "omnikey-cli is installed and ready. Click Next to continue."
    }

    private static func installFailureMessage(from output: String) -> String {
        guard !output.isEmpty else {
            return "Could not install omnikey-cli. Install Homebrew or Node.js, then try again."
        }

        let lines = output
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        if let finalLine = lines.suffix(4).first(where: { line in
            line.localizedCaseInsensitiveContains("required") ||
                line.localizedCaseInsensitiveContains("failed") ||
                line.localizedCaseInsensitiveContains("not available") ||
                line.localizedCaseInsensitiveContains("not on PATH") ||
                line.localizedCaseInsensitiveContains("latest npm version")
        }) {
            return finalLine
        }

        return lines.last ?? "Could not install omnikey-cli. Check your Homebrew or npm setup and try again."
    }

    private static func installMarker(_ key: String, in output: String) -> String? {
        output
            .split(separator: "\n")
            .compactMap { line -> String? in
                let prefix = "\(key)="
                guard line.hasPrefix(prefix) else { return nil }
                return String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .last
    }

    private static func nonEmptyMarker(_ key: String, in output: String) -> String? {
        guard let value = installMarker(key, in: output),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return value
    }

    private static func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = lhs.split(separator: ".").map(String.init)
        let right = rhs.split(separator: ".").map(String.init)
        let count = max(left.count, right.count)

        for index in 0..<count {
            let leftPart = index < left.count ? left[index] : "0"
            let rightPart = index < right.count ? right[index] : "0"

            if let leftNumber = Int(leftPart), let rightNumber = Int(rightPart) {
                if leftNumber != rightNumber {
                    return leftNumber < rightNumber ? .orderedAscending : .orderedDescending
                }
            } else {
                let comparison = leftPart.compare(rightPart)
                if comparison != .orderedSame {
                    return comparison
                }
            }
        }

        return .orderedSame
    }

    private static func daemonStartFailureMessage(from output: String) -> String {
        guard !output.isEmpty else {
            return "Could not start the local daemon. Run Install omnikey-cli, then try again."
        }

        let lines = output
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        return lines.last ?? "Could not start the local daemon. Check ~/.omnikey/daemon-bootstrap.log."
    }
}
