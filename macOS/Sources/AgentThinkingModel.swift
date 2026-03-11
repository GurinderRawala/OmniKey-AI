import Foundation
import Combine

@MainActor
final class AgentThinkingModel: ObservableObject {
    static let shared = AgentThinkingModel()

    @Published var log: String = ""
    @Published var isRunning: Bool = false

    private init() {}

    func reset(with initialText: String? = nil) {
        if let initial = initialText, !initial.isEmpty {
            log = initial
        } else {
            log = ""
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
    }
}
