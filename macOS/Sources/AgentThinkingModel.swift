import Combine
import Foundation

@MainActor
final class AgentThinkingModel: ObservableObject {
    static let shared = AgentThinkingModel()

    @Published var log: String = ""
    @Published var isRunning: Bool = false
    @Published var initialRequest: String = ""
    @Published var agentMessages: [String] = []
    @Published var terminalOutputs: [String] = []
    @Published var webCalls: [String] = []

    private init() {}

    func reset(with initialText: String? = nil) {
        log = ""
        initialRequest = ""
        agentMessages = []
        terminalOutputs = []
        webCalls = []

        if let initial = initialText, !initial.isEmpty {
            log = initial
            initialRequest = initial
        }
        isRunning = false
    }

    func append(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if log.isEmpty {
            log = trimmed
        } else {
            log += "\n\n" + trimmed
        }

        if trimmed.hasPrefix("[terminal ") {
            terminalOutputs.append(trimmed)
        } else if trimmed.hasPrefix("[web_call") {
            webCalls.append(trimmed)
        } else {
            agentMessages.append(trimmed)
        }
    }

    func appendWebCall(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        webCalls.append(trimmed)

        let logEntry = "[web_call] \(trimmed)"
        if log.isEmpty {
            log = logEntry
        } else {
            log += "\n\n" + logEntry
        }
    }
}
