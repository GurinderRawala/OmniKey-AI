import Foundation

extension Notification.Name {
    static let subscriptionUnauthorized = Notification.Name("SubscriptionUnauthorizedNotification")
    static let subscriptionExpired = Notification.Name("SubscriptionExpiredNotification")
}

/// Manages the persisted user subscription key and the in‑memory
/// JWT used to authenticate requests to the OmniKey backend.
final class SubscriptionManager: @unchecked Sendable {
    static let shared = SubscriptionManager()

    private let defaults = UserDefaults.standard
    private let userKeyDefaultsKey = "SubscriptionUserKey"

    /// The user-entered subscription key, persisted across launches.
    private(set) var userKey: String?

    /// The short-lived JWT issued by the backend. This is kept in
    /// memory only and refreshed by re-activating the stored key.
    private(set) var jwtToken: String?

    var hasStoredKey: Bool {
        userKey != nil
    }

    private init() {
        userKey = defaults.string(forKey: userKeyDefaultsKey)
    }

    /// Update (or set) the subscription key based on user input.
    /// This will validate the key with the backend and, on success,
    /// persist the key and store the issued JWT in memory.
    func updateUserKey(_ newKey: String, completion: @escaping (Result<Void, Error>) -> Void) {
        let trimmed = newKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            let error = NSError(
                domain: "SubscriptionManager",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Key cannot be empty."]
            )
            completion(.failure(error))
            return
        }

        activate(key: trimmed) { [weak self] result in
            guard let self else { return }

            switch result {
            case let .success(token):
                self.userKey = trimmed
                self.jwtToken = token
                self.defaults.set(trimmed, forKey: self.userKeyDefaultsKey)
                completion(.success(()))

            case let .failure(error as NSError):
                if error.domain == "SubscriptionManager", error.code == 403 {
                    // Subscription has expired for this key – notify the app
                    // so it can present the subscription window / purchase link.
                    NotificationCenter.default.post(name: .subscriptionExpired, object: nil)
                }
                completion(.failure(error))
            }
        }
    }

    /// Attempt to authenticate using a previously stored key.
    /// When self-hosted the backend issues a JWT without a key, so
    /// we call /activate with an empty string instead of returning early.
    /// Calls completion(true) and stores a JWT on success.
    func activateStoredKey(completion: @escaping (Bool) -> Void) {
        let key: String
        if APIClient.isSelfHosted {
            key = ""
        } else {
            guard let storedKey = userKey else {
                completion(false)
                return
            }
            key = storedKey
        }

        activate(key: key) { [weak self] result in
            guard let self else { return }

            switch result {
            case let .success(token):
                self.jwtToken = token
                completion(true)

            case let .failure(error as NSError):
                self.jwtToken = nil
                if error.domain == "SubscriptionManager", error.code == 403 {
                    // Stored key is now expired; surface the subscription
                    // expired flow so the user can renew.
                    NotificationCenter.default.post(name: .subscriptionExpired, object: nil)
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
    }

    /// Re-activate using the stored key (if any). This is used when
    /// an API request returns 401/403 so we can transparently refresh
    /// the short-lived JWT. When self-hosted the backend issues a JWT
    /// without a key. If there is no stored key on a non-self-hosted
    /// setup, or the server reports the subscription as expired (403),
    /// the caller is informed so it can show appropriate UI.
    func reactivateStoredKeyIfNeeded(completion: @escaping (ReactivationOutcome) -> Void) {
        let key: String
        if APIClient.isSelfHosted {
            key = ""
        } else {
            guard let storedKey = userKey else {
                completion(.noStoredKey)
                return
            }
            key = storedKey
        }

        activate(key: key) { [weak self] result in
            guard let self else { return }

            switch result {
            case let .success(token):
                self.jwtToken = token
                completion(.success)

            case let .failure(error as NSError):
                if error.domain == "SubscriptionManager", error.code == 403 {
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
        jwtToken = nil
    }

    /// Completely forget the subscription, removing the stored key
    /// and any in-memory token.
    func clearSubscription() {
        userKey = nil
        jwtToken = nil
        defaults.removeObject(forKey: userKeyDefaultsKey)
    }

    // MARK: - Networking

    private struct ActivateResponse: Decodable {
        let token: String?
        let subscriptionStatus: String?
        let expiresAt: String?
        let error: String?
    }

    private func activate(key: String, completion: @escaping (Result<String, Error>) -> Void) {
        let url = APIClient.baseURL.appendingPathComponent("api/subscription/activate")

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
