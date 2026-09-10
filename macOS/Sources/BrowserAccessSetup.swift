import Foundation

enum BrowserAccessSetup {
    enum Method: String, CaseIterable, Identifiable {
        case debugProfile = "debug-profile"
        case javascriptEvents = "javascript-events"

        var id: String { rawValue }
        var label: String {
            switch self {
            case .debugProfile: return "Debug profile"
            case .javascriptEvents: return "JavaScript Events"
            }
        }
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func configure(
        method: Method,
        browser: String,
        profile: String,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        var arguments = [
            "grant-browser-access", "--non-interactive",
            "--method", method.rawValue,
        ]
        switch method {
        case .debugProfile:
            arguments += ["--browser", browser, "--profile", profile]
        case .javascriptEvents:
            arguments += ["--browsers", browser]
        }

        let invocation = (["omnikey"] + arguments).map(shellQuote).joined(separator: " ")
        let command = """
        export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.yarn/bin:$HOME/.config/yarn/global/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
        cd "$HOME"
        \(invocation)
        """

        DispatchQueue.global(qos: .userInitiated).async {
            // A private registrar keeps this settings command out of the active
            // agent-session process slot while still using the onboarding login shell.
            let result = runShellCommandWithStatus(command, processRegistrar: { _ in })
            let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                if result.status == 0 {
                    completion(.success(output))
                } else {
                    let message = output.split(separator: "\n").last.map(String.init)
                        ?? "Browser access setup failed."
                    completion(.failure(NSError(
                        domain: "BrowserAccessSetup",
                        code: Int(result.status),
                        userInfo: [NSLocalizedDescriptionKey: message]
                    )))
                }
            }
        }
    }
}
