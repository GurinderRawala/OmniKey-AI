import Foundation

// MARK: - Skills HTTP client
//
// Authenticated /api/skills helpers. Mirrors APIClient's auth behaviour: a
// 401/403 triggers one stored-key re-activation and a single retry; a second
// failure invalidates the token and posts the usual subscription notices.
// Never logs request bodies, instructions, or tokens.

struct SkillsAPIError: Error, Equatable, LocalizedError, Sendable {
    enum Kind: Equatable, Sendable {
        /// GET /api/skills returned 404: the backend predates Skills.
        case upgradeRequired
        case notFound
        case validation
        case keywordConflict
        case revisionConflict
        case revisionRequired
        case quotaExceeded
        case limitExceeded
        case unauthenticated
        case storeUnavailable
        case server
        case network
        case cancelled
        case invalidResponse
        /// The backend or subscription changed after this client was bound;
        /// nothing was sent for the new identity.
        case accountChanged
    }

    let kind: Kind
    let status: Int?
    let code: String?
    let message: String
    let fields: [String: String]

    init(kind: Kind, status: Int? = nil, code: String? = nil, message: String, fields: [String: String] = [:]) {
        self.kind = kind
        self.status = status
        self.code = code
        self.message = message
        self.fields = fields
    }

    var errorDescription: String? { message }

    static let upgradeMessage =
        "This OmniKey backend does not support Skills yet. Update the OmniKey CLI/daemon (or hosted backend) and try again."

    static let accountChanged = SkillsAPIError(
        kind: .accountChanged,
        message: "Your OmniKey subscription or backend changed. Reopen Skills to continue."
    )
}

enum SkillsReauthOutcome: Sendable {
    case retry
    case failed
}

/// Operations the Skills UI needs. Abstracted so view-model tests can drive
/// responses deterministically without a network.
protocol SkillsService: Sendable {
    func list() async throws -> [SkillSummary]
    func get(id: String) async throws -> SkillDTO
    func create(_ draft: SkillDraft) async throws -> SkillDTO
    func update(id: String, revision: Int, patch: SkillPatch) async throws -> SkillDTO
    func delete(id: String, revision: Int) async throws
}

/// A client bound to one backend + subscription identity. Every attempt
/// (including the retry after re-authentication) re-reads identity, backend
/// and token together and refuses to send once the identity differs, so
/// a draft or mutation started for one subscription never reaches another.
/// A refreshed JWT for the same identity is used normally.
struct SkillsAPI: SkillsService {
    var identity: SubscriptionIdentity?
    var credentials: @Sendable () -> SubscriptionAuthSnapshot
    var session: URLSession
    var reauthenticate: @Sendable () async -> SkillsReauthOutcome
    var onFinalUnauthorized: @Sendable () -> Void
    var timeout: TimeInterval = 30

    /// `manager` is injectable for tests; production uses `.shared`.
    static func live(
        for identity: SubscriptionIdentity?, manager: SubscriptionManager = .shared
    ) -> SkillsAPI {
        SkillsAPI(
            identity: identity,
            credentials: { manager.authSnapshot() },
            session: .shared,
            reauthenticate: { await SkillsAPI.liveReauthenticate(for: identity, manager: manager) },
            onFinalUnauthorized: {
                // Atomic: only the bound identity's token is dropped, and the
                // notice is scoped so a newer subscription is left alone.
                if manager.invalidateToken(ifCurrent: identity) {
                    SubscriptionManager.postNotice(.subscriptionUnauthorized, identity: identity)
                }
            }
        )
    }

    /// Same outcomes as APIClient.handleAuthFailure, scoped to `identity`:
    /// nothing is re-activated, invalidated or expired for another one.
    private static func liveReauthenticate(
        for identity: SubscriptionIdentity?, manager: SubscriptionManager
    ) async -> SkillsReauthOutcome {
        guard let identity, manager.currentIdentity == identity else { return .failed }
        return await withCheckedContinuation { continuation in
            manager.reactivateStoredKeyIfNeeded { outcome in
                switch outcome {
                case .success:
                    // The retry re-checks the identity before sending.
                    continuation.resume(returning: .retry)
                case .superseded:
                    // Another subscription/backend is current now: no retry,
                    // no invalidation, no notice. The send then reports
                    // accountChanged (or unauthenticated if the same key was
                    // re-entered as a new generation).
                    continuation.resume(returning: .failed)
                case .noStoredKey, .expired:
                    SubscriptionManager.postNotice(.subscriptionExpired, identity: identity)
                    continuation.resume(returning: .failed)
                case .failure:
                    if manager.invalidateToken(ifCurrent: identity) {
                        SubscriptionManager.postNotice(.subscriptionUnauthorized, identity: identity)
                    }
                    continuation.resume(returning: .failed)
                }
            }
        }
    }

    // MARK: Endpoints

    func list() async throws -> [SkillSummary] {
        struct Envelope: Decodable { let skills: [SkillSummary] }
        let (data, _) = try await send(method: "GET", path: nil, endpoint: .collection)
        return try decode(Envelope.self, from: data).skills
    }

    func get(id: String) async throws -> SkillDTO {
        struct Envelope: Decodable { let skill: SkillDTO }
        let (data, _) = try await send(method: "GET", path: id, endpoint: .item)
        return try decode(Envelope.self, from: data).skill
    }

    func create(_ draft: SkillDraft) async throws -> SkillDTO {
        struct Envelope: Decodable { let skill: SkillDTO }
        let body: [String: Any] = [
            "name": draft.name,
            "keyword": draft.keyword,
            "instructions": draft.instructions,
            "enabled": draft.enabled,
        ]
        let (data, _) = try await send(method: "POST", path: nil, body: body, endpoint: .create)
        return try decode(Envelope.self, from: data).skill
    }

    func update(id: String, revision: Int, patch: SkillPatch) async throws -> SkillDTO {
        struct Envelope: Decodable { let skill: SkillDTO }
        let (data, _) = try await send(
            method: "PATCH", path: id, body: patch.jsonObject, revision: revision, endpoint: .item
        )
        return try decode(Envelope.self, from: data).skill
    }

    func delete(id: String, revision: Int) async throws {
        _ = try await send(method: "DELETE", path: id, revision: revision, endpoint: .item)
    }

    // MARK: Transport

    enum Endpoint { case collection, create, item }

    static func ifMatch(_ revision: Int) -> String { "\"\(revision)\"" }

    static func makeURL(baseURL: URL, path: String?) -> URL {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        var urlString = base + "/api/skills"
        if let path {
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-_.~")
            urlString += "/" + (path.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
        }
        return URL(string: urlString)!
    }

    /// Current credentials, or `accountChanged` if they no longer belong to
    /// the identity this client was bound to. A client bound to no identity
    /// (opened while signed out) never sends.
    private func boundCredentials() throws -> SubscriptionAuthSnapshot {
        let snapshot = credentials()
        guard let identity, snapshot.identity == identity else { throw SkillsAPIError.accountChanged }
        return snapshot
    }

    private func send(
        method: String,
        path: String?,
        body: [String: Any]? = nil,
        revision: Int? = nil,
        endpoint: Endpoint
    ) async throws -> (Data, HTTPURLResponse) {
        let bodyData = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let attempt = { () async throws -> (Data, HTTPURLResponse) in
            let snapshot = try boundCredentials()
            var request = URLRequest(url: Self.makeURL(baseURL: snapshot.baseURL, path: path), timeoutInterval: timeout)
            request.httpMethod = method
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let bodyData {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = bodyData
            }
            if let revision {
                request.setValue(Self.ifMatch(revision), forHTTPHeaderField: "If-Match")
            }
            return try await perform(request, token: snapshot.token)
        }

        var (data, response) = try await attempt()
        if response.statusCode == 401 || response.statusCode == 403 {
            // Re-authenticate only for the bound identity; the retry is
            // refused if the subscription or backend changed meanwhile.
            _ = try boundCredentials()
            guard await reauthenticate() == .retry else {
                _ = try boundCredentials()
                throw Self.unauthenticated(status: response.statusCode)
            }
            (data, response) = try await attempt()
            if response.statusCode == 401 || response.statusCode == 403 {
                if (try? boundCredentials()) != nil { onFinalUnauthorized() }
                throw Self.unauthenticated(status: response.statusCode)
            }
        }

        guard (200 ... 299).contains(response.statusCode) else {
            throw Self.error(status: response.statusCode, data: data, endpoint: endpoint)
        }
        return (data, response)
    }

    private func perform(_ base: URLRequest, token: String?) async throws -> (Data, HTTPURLResponse) {
        var request = base
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        } else {
            request.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw SkillsAPIError(kind: .cancelled, message: "Request cancelled.")
        } catch let error as URLError where error.code == .cancelled {
            throw SkillsAPIError(kind: .cancelled, message: "Request cancelled.")
        } catch {
            throw SkillsAPIError(
                kind: .network,
                message: "Couldn't reach the OmniKey backend. Check that it is running, then retry."
            )
        }
        guard let http = response as? HTTPURLResponse else {
            throw SkillsAPIError(kind: .invalidResponse, message: "The backend returned an invalid response.")
        }
        return (data, http)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SkillsAPIError(kind: .invalidResponse, message: "The backend returned an unexpected Skills response.")
        }
    }

    private static func unauthenticated(status: Int) -> SkillsAPIError {
        SkillsAPIError(
            kind: .unauthenticated, status: status,
            message: "Your OmniKey session is not authorized. Re-activate your subscription and retry."
        )
    }

    /// Map an HTTP failure by status and structured `error.code`, never by
    /// message wording. Accepts legacy string/HTML bodies safely.
    static func error(status: Int, data: Data, endpoint: Endpoint) -> SkillsAPIError {
        var code: String?
        var serverMessage: String?
        var fields: [String: String] = [:]
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? [String: Any]
        {
            code = error["code"] as? String
            serverMessage = error["message"] as? String
            if let rawFields = error["fields"] as? [String: Any] {
                for (key, value) in rawFields {
                    if let text = value as? String { fields[key] = text }
                }
            }
        }

        switch (status, code) {
        case (404, _) where endpoint != .item:
            return SkillsAPIError(kind: .upgradeRequired, status: status, code: code, message: SkillsAPIError.upgradeMessage)
        case (404, _):
            return SkillsAPIError(
                kind: .notFound, status: status, code: code,
                message: "This skill no longer exists. It may have been deleted elsewhere."
            )
        case (400, _):
            return SkillsAPIError(
                kind: .validation, status: status, code: code,
                message: serverMessage.flatMap { $0.isEmpty ? nil : $0 } ?? "Some fields are invalid.",
                fields: fields
            )
        case (409, "KEYWORD_CONFLICT"?):
            var keywordFields = fields
            if keywordFields["keyword"] == nil {
                keywordFields["keyword"] = "Another skill already uses this keyword (including disabled skills)."
            }
            return SkillsAPIError(
                kind: .keywordConflict, status: status, code: code,
                message: "Another skill already uses this keyword.", fields: keywordFields
            )
        case (409, "SKILL_QUOTA_EXCEEDED"?):
            return SkillsAPIError(
                kind: .quotaExceeded, status: status, code: code,
                message: "You already have the maximum of \(SkillLimits.saved) skills. Delete one before adding another."
            )
        case (409, _):
            return SkillsAPIError(
                kind: .revisionConflict, status: status, code: code,
                message: "This skill changed elsewhere. Reload the latest version before saving again."
            )
        case (413, _):
            return SkillsAPIError(
                kind: .limitExceeded, status: status, code: code,
                message: "The request is too large. Shorten the instructions and try again."
            )
        case (428, _):
            return SkillsAPIError(
                kind: .revisionRequired, status: status, code: code,
                message: "The backend requires the current revision. Reload and try again."
            )
        case (503, _):
            return SkillsAPIError(
                kind: .storeUnavailable, status: status, code: code,
                message: "Skills are temporarily unavailable. Please retry."
            )
        default:
            return SkillsAPIError(
                kind: .server, status: status, code: code,
                message: "The backend could not complete the Skills request (status \(status))."
            )
        }
    }
}

extension APIClient {
    /// Authenticated Skills endpoints for one backend + subscription.
    static func skills(for identity: SubscriptionIdentity?) -> SkillsAPI { .live(for: identity) }
}
