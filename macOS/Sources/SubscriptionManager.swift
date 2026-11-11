import CryptoKit
import Foundation

extension Notification.Name {
    static let subscriptionUnauthorized = Notification.Name("SubscriptionUnauthorizedNotification")
    static let subscriptionExpired = Notification.Name("SubscriptionExpiredNotification")
}

/// Who backend requests act for: the backend plus the subscription (a
/// fingerprint of the stored key, or the single self-hosted owner). It is
/// deliberately independent of the short-lived JWT, so refreshing a token
/// for the same key keeps the identity while changing or clearing the key,
/// or switching backend, does not. Never contains the key itself.
struct SubscriptionIdentity: Hashable, Sendable {
    let backend: String
    let subscription: String

    /// `nil` when no subscription is selected (hosted mode without a key).
    static func make(baseURL: URL, isSelfHosted: Bool, userKey: String?) -> SubscriptionIdentity? {
        var backend = baseURL.absoluteString
        while backend.hasSuffix("/") { backend.removeLast() }
        if isSelfHosted { return SubscriptionIdentity(backend: backend, subscription: "self-hosted") }
        guard let userKey, !userKey.isEmpty else { return nil }
        let digest = SHA256.hash(data: Data(userKey.utf8)).map { String(format: "%02x", $0) }.joined()
        return SubscriptionIdentity(backend: backend, subscription: "key:" + digest)
    }

    static func make(backend: BackendSelection, userKey: String?) -> SubscriptionIdentity? {
        make(baseURL: backend.baseURL, isSelfHosted: backend.isSelfHosted, userKey: userKey)
    }
}

/// The backend selection from a single configuration read, so the URL and
/// the self-hosted flag always agree.
struct BackendSelection: Equatable, Sendable {
    let baseURL: URL
    let isSelfHosted: Bool
}

/// Identity, backend and token read together, so a request never pairs one
/// subscription's identity with another's token. `token` is only ever the
/// token issued for `identity` (same backend and subscription), else nil.
struct SubscriptionAuthSnapshot: Sendable {
    let identity: SubscriptionIdentity?
    let baseURL: URL
    let token: String?
}

/// What an activation request was started for: the key it sends, the
/// backend it is sent to (captured once) and the key generation. Its result
/// may only be installed while all of these are still current.
struct SubscriptionActivationTicket: Sendable {
    /// Sent as-is to `/activate` (empty for self-hosted). Never logged.
    let key: String
    let backend: BackendSelection
    let identity: SubscriptionIdentity
    fileprivate let epoch: Int
}

/// Lock-guarded key/token state. Pure (no I/O): the backend is passed in,
/// so every rule is unit-testable. Each token is stored with the identity
/// it was issued for and is handed out only for that identity, so a token
/// can never be sent to another backend or subscription.
final class SubscriptionAuthState: @unchecked Sendable {
    private let lock = NSLock()
    private var key: String?
    private var token: String?
    private var tokenIdentity: SubscriptionIdentity?
    /// Bumped whenever a key is accepted (even the same key again) or the
    /// subscription is cleared, so an activation started earlier can't
    /// install its result afterwards.
    private var epoch = 0

    init(key: String? = nil) {
        self.key = key
    }

    var storedKey: String? { lock.withLock { key } }

    func snapshot(backend: BackendSelection) -> SubscriptionAuthSnapshot {
        lock.withLock {
            let identity = SubscriptionIdentity.make(backend: backend, userKey: key)
            let bound = identity != nil && tokenIdentity == identity ? token : nil
            return SubscriptionAuthSnapshot(identity: identity, baseURL: backend.baseURL, token: bound)
        }
    }

    /// Ticket to re-activate the stored key (or self-hosted owner) against
    /// `backend`; nil in hosted mode without a key.
    func beginActivation(backend: BackendSelection) -> SubscriptionActivationTicket? {
        lock.withLock {
            guard let identity = SubscriptionIdentity.make(backend: backend, userKey: key) else { return nil }
            return SubscriptionActivationTicket(
                key: backend.isSelfHosted ? "" : (key ?? ""), backend: backend, identity: identity, epoch: epoch
            )
        }
    }

    /// Ticket to validate a newly entered key against `backend`.
    func beginActivation(newKey: String, backend: BackendSelection) -> SubscriptionActivationTicket? {
        lock.withLock {
            guard let identity = SubscriptionIdentity.make(backend: backend, userKey: newKey) else { return nil }
            return SubscriptionActivationTicket(key: newKey, backend: backend, identity: identity, epoch: epoch)
        }
    }

    private func isCurrentLocked(_ ticket: SubscriptionActivationTicket, backend: BackendSelection) -> Bool {
        epoch == ticket.epoch && backend == ticket.backend
            && SubscriptionIdentity.make(backend: backend, userKey: key) == ticket.identity
    }

    /// Same key generation, backend and identity as when `ticket` was issued.
    func isCurrent(_ ticket: SubscriptionActivationTicket, backend: BackendSelection) -> Bool {
        lock.withLock { isCurrentLocked(ticket, backend: backend) }
    }

    /// Install a re-activation result (nil clears the token) only if the
    /// ticket is still current. Returns false and changes nothing otherwise.
    @discardableResult
    func commit(token newToken: String?, for ticket: SubscriptionActivationTicket, backend: BackendSelection) -> Bool {
        lock.withLock {
            guard isCurrentLocked(ticket, backend: backend) else { return false }
            token = newToken
            tokenIdentity = newToken == nil ? nil : ticket.identity
            return true
        }
    }

    /// An explicit (newly entered) key ticket is current while no clear or
    /// other accepted key happened since it was issued and the backend is
    /// unchanged. The stored key is irrelevant: the ticket is for `newKey`.
    private func isExplicitCurrentLocked(_ ticket: SubscriptionActivationTicket, backend: BackendSelection) -> Bool {
        epoch == ticket.epoch && backend == ticket.backend
    }

    /// Whether an explicit key ticket may still report its result.
    func isExplicitCurrent(_ ticket: SubscriptionActivationTicket, backend: BackendSelection) -> Bool {
        lock.withLock { isExplicitCurrentLocked(ticket, backend: backend) }
    }

    /// A newly entered key was accepted: store it with its token, bound to
    /// the backend that issued it. Refused (nothing changes) if the
    /// subscription was cleared, another key was accepted, or the backend
    /// changed since `ticket` was issued. Every accepted key, even the same
    /// key again, starts a new generation so older tickets can't commit.
    /// `persist` runs under the lock so a concurrent clear can't be undone
    /// by a late save.
    @discardableResult
    func install(
        key newKey: String, token newToken: String, for ticket: SubscriptionActivationTicket,
        backend: BackendSelection, persist: (String) -> Void = { _ in }
    ) -> Bool {
        lock.withLock {
            guard isExplicitCurrentLocked(ticket, backend: backend) else { return false }
            epoch += 1
            key = newKey
            token = newToken
            tokenIdentity = ticket.identity
            persist(newKey)
            return true
        }
    }

    /// Unconditional token drop (legacy callers that are not identity-bound).
    func invalidateToken() {
        lock.withLock {
            token = nil
            tokenIdentity = nil
        }
    }

    /// Drop the token only if `identity` is still the current one. Returns
    /// whether it was current; a stale caller changes nothing.
    @discardableResult
    func invalidateToken(ifCurrent identity: SubscriptionIdentity?, backend: BackendSelection) -> Bool {
        lock.withLock {
            guard let identity, SubscriptionIdentity.make(backend: backend, userKey: key) == identity else { return false }
            if tokenIdentity == identity {
                token = nil
                tokenIdentity = nil
            }
            return true
        }
    }

    /// `persist` runs under the lock (see `install`).
    func clear(persist: () -> Void = {}) {
        lock.withLock {
            epoch += 1
            key = nil
            token = nil
            tokenIdentity = nil
            persist()
        }
    }

    /// Clear only if `identity` is still the current one.
    @discardableResult
    func clear(ifCurrent identity: SubscriptionIdentity?, backend: BackendSelection, persist: () -> Void = {}) -> Bool {
        lock.withLock {
            guard let identity, SubscriptionIdentity.make(backend: backend, userKey: key) == identity else { return false }
            epoch += 1
            key = nil
            token = nil
            tokenIdentity = nil
            persist()
            return true
        }
    }
}

/// Persistence for the subscription key (injectable for tests).
///
/// No re-entry: `save` runs while `SubscriptionAuthState` holds its
/// non-reentrant lock, so that a late save can't undo a concurrent clear.
/// Neither `save` nor anything it triggers synchronously may read
/// `SubscriptionManager` or `SubscriptionAuthState` (`userKey`,
/// `authSnapshot`, `currentIdentity`, ...) on the same thread, or it
/// deadlocks. `UserDefaults` posts `didChangeNotification` synchronously on
/// the writing thread, so an observer of that notification must not read
/// subscription state inline. It must hop to another queue first.
struct SubscriptionKeyStore: @unchecked Sendable {
    var load: () -> String?
    var save: (String?) -> Void

    static func userDefaults(_ defaults: UserDefaults, key: String = "SubscriptionUserKey") -> SubscriptionKeyStore {
        SubscriptionKeyStore(
            load: { defaults.string(forKey: key) },
            save: { value in
                if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
        )
    }
}

/// Manages the persisted user subscription key and the in‑memory
/// JWT used to authenticate requests to the OmniKey backend.
final class SubscriptionManager: @unchecked Sendable {
    /// POSTs `key` to `<baseURL>/api/subscription/activate`.
    typealias Activator = @Sendable (
        _ key: String, _ baseURL: URL, _ completion: @escaping (Result<String, Error>) -> Void
    ) -> Void

    static let shared = SubscriptionManager(
        keyStore: .userDefaults(.standard),
        backend: { APIClient.backendSelection },
        activator: SubscriptionManager.liveActivate
    )

    /// `userInfo` key on subscription notices naming the identity they are
    /// about. A notice for an identity that is no longer current is ignored.
    static let noticeIdentityKey = "SubscriptionIdentity"

    private let state: SubscriptionAuthState
    private let keyStore: SubscriptionKeyStore
    private let backend: @Sendable () -> BackendSelection
    private let activator: Activator
    private let post: @Sendable (Notification.Name, SubscriptionIdentity?) -> Void

    init(
        keyStore: SubscriptionKeyStore,
        backend: @escaping @Sendable () -> BackendSelection,
        activator: @escaping Activator,
        post: @escaping @Sendable (Notification.Name, SubscriptionIdentity?) -> Void = {
            SubscriptionManager.postNotice($0, identity: $1)
        }
    ) {
        self.keyStore = keyStore
        self.backend = backend
        self.activator = activator
        self.post = post
        state = SubscriptionAuthState(key: keyStore.load())
    }

    /// The user-entered subscription key, persisted across launches.
    var userKey: String? { state.storedKey }

    /// The short-lived JWT issued by the current backend for the current
    /// subscription (nil if it was issued for another one). Kept in memory
    /// only and refreshed by re-activating the stored key.
    var jwtToken: String? { authSnapshot().token }

    var hasStoredKey: Bool {
        userKey != nil
    }

    /// The identity requests made now would act for.
    var currentIdentity: SubscriptionIdentity? { authSnapshot().identity }

    func authSnapshot() -> SubscriptionAuthSnapshot {
        state.snapshot(backend: backend())
    }

    // MARK: Notices

    /// A notice scoped to `identity` (unscoped/legacy when nil).
    static func notice(_ name: Notification.Name, identity: SubscriptionIdentity?) -> Notification {
        Notification(name: name, object: nil, userInfo: identity.map { [noticeIdentityKey: $0] })
    }

    static func postNotice(_ name: Notification.Name, identity: SubscriptionIdentity?) {
        let send: @Sendable () -> Void = {
            NotificationCenter.default.post(notice(name, identity: identity))
        }
        if Thread.isMainThread { send() } else { DispatchQueue.main.async(execute: send) }
    }

    /// The identity a notice is scoped to; nil for unscoped (legacy) notices.
    static func noticeIdentity(_ notification: Notification) -> SubscriptionIdentity? {
        notification.userInfo?[noticeIdentityKey] as? SubscriptionIdentity
    }

    /// Whether a notice still applies: unscoped, or scoped to the current identity.
    func noticeApplies(_ notification: Notification) -> Bool {
        guard let scope = Self.noticeIdentity(notification) else { return true }
        return scope == currentIdentity
    }

    // MARK: Activation

    /// Update (or set) the subscription key based on user input.
    /// This will validate the key with the backend and, on success,
    /// persist the key and store the issued JWT in memory.
    func updateUserKey(_ newKey: String, completion: @escaping (Result<Void, Error>) -> Void) {
        let trimmed = newKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let ticket = state.beginActivation(newKey: trimmed, backend: backend()) else {
            let error = NSError(
                domain: "SubscriptionManager",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Key cannot be empty."]
            )
            completion(.failure(error))
            return
        }

        activator(ticket.key, ticket.backend.baseURL) { [weak self] result in
            guard let self else { return }

            switch result {
            case let .success(token):
                // A result for a cleared, replaced or other-backend attempt
                // is not installed, persisted or reported as success.
                let keyStore = self.keyStore
                guard self.state.install(
                    key: trimmed, token: token, for: ticket, backend: self.backend(), persist: { keyStore.save($0) }
                ) else {
                    completion(.failure(Self.supersededError))
                    return
                }
                completion(.success(()))

            case let .failure(error as NSError):
                guard self.state.isExplicitCurrent(ticket, backend: self.backend()) else {
                    completion(.failure(Self.supersededError))
                    return
                }
                // An entered key is not the current subscription (it was never
                // installed), so its failure, expiry (403) included, is only
                // reported to the caller: the license window shows it. No
                // subscription notice is posted. A notice would clear whatever
                // subscription is current when it is delivered, and that may
                // be newer than this attempt.
                if error.domain == "SubscriptionManager", error.code == 403 {
                    completion(.failure(Self.enteredKeyExpiredError))
                    return
                }
                completion(.failure(error))
            }
        }
    }

    /// Attempt to authenticate using a previously stored key.
    /// When self-hosted the backend issues a JWT without a key, so
    /// we call /activate with an empty string instead of returning early.
    /// Calls completion(true) and stores a JWT on success.
    ///
    /// The backend is captured once; a result arriving after the key or
    /// backend changed is discarded and reports the newer state.
    func activateStoredKey(completion: @escaping (Bool) -> Void) {
        guard let ticket = state.beginActivation(backend: backend()) else {
            completion(false)
            return
        }

        activator(ticket.key, ticket.backend.baseURL) { [weak self] result in
            guard let self else { return }

            switch result {
            case let .success(token):
                guard self.state.commit(token: token, for: ticket, backend: self.backend()) else {
                    completion(self.jwtToken != nil)
                    return
                }
                completion(true)

            case let .failure(error as NSError):
                guard self.state.commit(token: nil, for: ticket, backend: self.backend()) else {
                    completion(self.jwtToken != nil)
                    return
                }
                if error.domain == "SubscriptionManager", error.code == 403 {
                    // Stored key is now expired; surface the subscription
                    // expired flow so the user can renew. Scoped, so it is
                    // ignored if another subscription is active by then.
                    self.post(.subscriptionExpired, ticket.identity)
                }
                completion(false)
            }
        }
    }

    enum ReactivationOutcome {
        case success
        case noStoredKey
        case expired
        case failure(Error)
        /// The key, backend or key generation changed while activating, so
        /// the result was discarded. Callers fail the original request with
        /// `supersededError` and must not retry, invalidate, clear or post
        /// a notice: the newer subscription is not theirs to touch.
        case superseded
    }

    /// Whether an `/activate` failure is the backend rejecting the
    /// credentials (401: unknown key). Transport errors, 5xx, malformed
    /// responses and the like are transient and must not sign the user out;
    /// 403 (expired) has its own flow.
    static func isCredentialRejection(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == "SubscriptionManager" && error.code == 401
    }

    /// Returned to the original caller when its re-activation was superseded.
    /// Not `AgentRunner/401`, so it is never replayed.
    static let supersededError = NSError(
        domain: "SubscriptionManager",
        code: -409,
        userInfo: [NSLocalizedDescriptionKey: "Your OmniKey subscription or backend changed. Please try again."]
    )

    /// `updateUserKey` result for an entered key the backend reports as
    /// expired (403). Keeps domain and code; the current subscription is left
    /// untouched.
    static let enteredKeyExpiredError = NSError(
        domain: "SubscriptionManager",
        code: 403,
        userInfo: [NSLocalizedDescriptionKey:
            "This subscription key has expired. Purchase a new subscription to continue using OmniKey."]
    )

    /// Re-activate using the stored key (if any). This is used when
    /// an API request returns 401/403 so we can transparently refresh
    /// the short-lived JWT. When self-hosted the backend issues a JWT
    /// without a key. If there is no stored key on a non-self-hosted
    /// setup, or the server reports the subscription as expired (403),
    /// the caller is informed so it can show appropriate UI.
    ///
    /// If the stored key, backend or key generation changes while activating,
    /// the result is discarded (the newer state keeps its token) and the
    /// outcome is `.superseded`, never `.success` for the newer state, so the
    /// original request is not retried as, and nothing expires, clears or
    /// invalidates, the newer subscription.
    func reactivateStoredKeyIfNeeded(completion: @escaping (ReactivationOutcome) -> Void) {
        guard let ticket = state.beginActivation(backend: backend()) else {
            completion(.noStoredKey)
            return
        }

        activator(ticket.key, ticket.backend.baseURL) { [weak self] result in
            guard let self else { return }

            let current = self.backend()

            switch result {
            case let .success(token):
                completion(self.state.commit(token: token, for: ticket, backend: current) ? .success : .superseded)

            case let .failure(error as NSError):
                if !self.state.isCurrent(ticket, backend: current) {
                    completion(.superseded)
                } else if error.domain == "SubscriptionManager", error.code == 403 {
                    completion(.expired)
                } else {
                    completion(.failure(error))
                }
            }
        }
    }

    /// Clear the in-memory JWT so the next API call will re-activate
    /// using the stored key (if any).
    func invalidateToken() {
        state.invalidateToken()
    }

    /// Clear the token only while `identity` is current; returns whether it
    /// was. Lets a stale request's failure leave a newer subscription alone.
    @discardableResult
    func invalidateToken(ifCurrent identity: SubscriptionIdentity?) -> Bool {
        state.invalidateToken(ifCurrent: identity, backend: backend())
    }

    /// Completely forget the subscription, removing the stored key
    /// and any in-memory token.
    func clearSubscription() {
        let keyStore = keyStore
        state.clear(persist: { keyStore.save(nil) })
    }

    /// Handle an expiry notice: clears when it is unscoped or scoped to the
    /// current identity. Returns false (nothing cleared) for a stale notice.
    @discardableResult
    func clearSubscription(forNotice notification: Notification) -> Bool {
        guard let scope = Self.noticeIdentity(notification) else {
            clearSubscription()
            return true
        }
        let keyStore = keyStore
        return state.clear(ifCurrent: scope, backend: backend(), persist: { keyStore.save(nil) })
    }

    // MARK: - Networking

    private struct ActivateResponse: Decodable {
        let token: String?
        let subscriptionStatus: String?
        let expiresAt: String?
        let error: String?
    }

    static func liveActivate(
        key: String, baseURL: URL, completion: @escaping (Result<String, Error>) -> Void
    ) {
        let url = baseURL.appendingPathComponent("api/subscription/activate")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload = ["key": key]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])
        } catch {
            completion(.failure(error))
            return
        }

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                let error = NSError(
                    domain: "SubscriptionManager",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid server response."]
                )
                completion(.failure(error))
                return
            }

            guard let data = data, !data.isEmpty else {
                let error = NSError(
                    domain: "SubscriptionManager",
                    code: httpResponse.statusCode,
                    userInfo: [NSLocalizedDescriptionKey: "Empty response from server."]
                )
                completion(.failure(error))
                return
            }

            do {
                let decoded = try JSONDecoder().decode(ActivateResponse.self, from: data)

                guard (200 ... 299).contains(httpResponse.statusCode),
                      let token = decoded.token
                else {
                    let message = decoded.error
                        ?? HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)
                    let error = NSError(
                        domain: "SubscriptionManager",
                        code: httpResponse.statusCode,
                        userInfo: [NSLocalizedDescriptionKey: message]
                    )
                    completion(.failure(error))
                    return
                }

                completion(.success(token))
            } catch {
                completion(.failure(error))
            }
        }

        task.resume()
    }
}
