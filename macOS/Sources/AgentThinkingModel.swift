import Foundation
import Combine

@MainActor
final class AgentThinkingModel: ObservableObject {
    static let shared = AgentThinkingModel()

    @Published var log: String = ""
    @Published var isRunning: Bool = false
    @Published var initialRequest: String = ""
    @Published var agentMessages: [String] = []
    @Published var terminalOutputs: [String] = []

    private init() {}

    func reset(with initialText: String? = nil) {
        log = ""
        initialRequest = ""
        agentMessages = []
        terminalOutputs = []

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
        } else {
            agentMessages.append(trimmed)
        }
    }
}
