import Combine
import Foundation

// MARK: - Session metadata returned by GET /api/agent/sessions

struct AgentSessionInfo: Identifiable, Decodable {
    let id: String
    let title: String
    let platform: String?
    let turns: Int
    let totalTokensUsed: Int
    let remainingContextTokens: Int
    let contextBudget: Int
    let lastActiveAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, platform, turns
        case totalTokensUsed
        case remainingContextTokens
        case contextBudget
        case lastActiveAt
    }
}

@MainActor
final class AgentThinkingModel: ObservableObject {
    static let shared = AgentThinkingModel()

    @Published var log: String = ""
    @Published var isRunning: Bool = false
    @Published var initialRequest: String = ""
    @Published var agentMessages: [String] = []
    @Published var terminalOutputs: [String] = []
    @Published var webCalls: [String] = []

    // ── Session picker state ──────────────────────────────────────────────────
    /// Sessions fetched from the backend before the run starts.
    @Published var availableSessions: [AgentSessionInfo] = []
    /// The session the user chose (nil = start a new one).
    @Published var selectedSessionId: String? = nil
    /// Whether the session picker sheet / panel is shown.
    @Published var isShowingSessionPicker: Bool = false
    /// Remaining context tokens for the currently active session.
    @Published var remainingContextTokens: Int = 0
    /// Human-readable name of the current session.
    @Published var currentSessionTitle: String = "New Session"

    private init() {}

    func reset(with initialText: String? = nil) {
        log = ""
        initialRequest = ""
        agentMessages = []
        terminalOutputs = []
        webCalls = []
        availableSessions = []
        selectedSessionId = nil
        isShowingSessionPicker = false
        remainingContextTokens = 0
        currentSessionTitle = "New Session"

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

    // MARK: - Session picker helpers

    /// Fetch the current user's sessions from the backend and update
    /// `availableSessions`. Requires a valid JWT in `SubscriptionManager`.
    func fetchSessions(completion: (@Sendable () -> Void)? = nil) {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else {
            completion?()
            return
        }
        let url = APIClient.baseURL.appendingPathComponent("api/agent/sessions")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data else {
                DispatchQueue.main.async { completion?() }
                return
            }
            let decoder = JSONDecoder()
            if let sessions = try? decoder.decode([AgentSessionInfo].self, from: data) {
                DispatchQueue.main.async {
                    self.availableSessions = sessions
                    completion?()
                }
            } else {
                DispatchQueue.main.async { completion?() }
            }
        }.resume()
    }

    /// Fetch context info for the given session ID and update the published
    /// `remainingContextTokens` / `currentSessionTitle` properties.
    func fetchContextBudget(for sessionId: String) {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else { return }
        let url = APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("context")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data else { return }
            struct Ctx: Decodable {
                let title: String
                let remainingContextTokens: Int
            }
            if let ctx = try? JSONDecoder().decode(Ctx.self, from: data) {
                DispatchQueue.main.async {
                    self.remainingContextTokens = ctx.remainingContextTokens
                    self.currentSessionTitle = ctx.title
                }
            }
        }.resume()
    }

    /// Delete a session from the backend and remove it from `availableSessions`.
    func deleteSession(id: String, completion: (@Sendable (Bool) -> Void)? = nil) {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else {
            completion?(false)
            return
        }
        let url = APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(id)
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let success = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                if success {
                    self?.availableSessions.removeAll { $0.id == id }
                    // If the user had this session selected, clear the selection.
                    if self?.selectedSessionId == id {
                        self?.selectedSessionId = nil
                        self?.currentSessionTitle = "New Session"
                        self?.remainingContextTokens = 0
                    }
                }
                completion?(success)
            }
        }.resume()
    }
}

