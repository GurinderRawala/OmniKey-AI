import Foundation

class APIClient {
    /// Base URL resolution order:
    /// 1. Environment variable `OMNIKEY_BACKEND_URL` at runtime
    /// 2. Info.plist key `OMNIKEY_BACKEND_URL` (set by build_release_dmg.sh)
    /// 3. Fallback to local development server at http://localhost:7071
    static let baseURL: URL = {
        if let env = ProcessInfo.processInfo.environment["OMNIKEY_BACKEND_URL"], !env.isEmpty,
           let url = URL(string: env) {
            return url
        }

        if let plistValue = Bundle.main.object(forInfoDictionaryKey: "OMNIKEY_BACKEND_URL") as? String,
           !plistValue.isEmpty,
           let url = URL(string: plistValue) {
            return url
        }

        // Default local backend for development
        return URL(string: "http://localhost:7071")!
    }()

    private let enhancePromptURL = APIClient.baseURL.appendingPathComponent("api/feature/enhance")
    private let enhanceGrammarURL = APIClient.baseURL.appendingPathComponent("api/feature/grammar")
    private let customTaskURL = APIClient.baseURL.appendingPathComponent("api/feature/custom-task")
    private let getTaskInstructionsURL = APIClient.baseURL.appendingPathComponent("api/instructions/get-task-instructions")
    private let createTaskInstructionsURL = APIClient.baseURL.appendingPathComponent("api/instructions/create-task-instructions")

    func getURL(for cmd: String) -> URL? {
        switch cmd {
        case "E":
            return enhancePromptURL
        case "G":
            return enhanceGrammarURL
        case "T":
            return customTaskURL
        default:
            return nil
        }
    }
    
    func enhance(_ text: String, cmd: String, completion: @escaping (Result<String, Error>) -> Void) {
        guard let url = getURL(for: cmd) else {
            completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Unknown command"])))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        // Request streaming behavior from the backend when available.
        request.setValue("true", forHTTPHeaderField: "x-omnikey-stream")
        
        let payload: [String: String] = ["text": text]
        
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        } catch {
            completion(.failure(error))
            return
        }
        
        sendEnhanceRequest(with: request, allowReauth: true, completion: completion)
    }

    /// Internal helper that performs the enhance/grammar/custom-task
    /// request and, on 401/403, optionally re-activates using the
    /// stored subscription key and retries once.
    private func sendEnhanceRequest(
        with request: URLRequest,
        allowReauth: Bool,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }

            // Handle auth failures (401/403) with optional re-activation
            if self.handleAuthFailure(
                statusCode: httpResponse.statusCode,
                allowReauth: allowReauth,
                onRetry: {
                    var retriedRequest = request
                    if let token = SubscriptionManager.shared.jwtToken {
                        retriedRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }
                    self.sendEnhanceRequest(with: retriedRequest, allowReauth: false, completion: completion)
                },
                completion: completion
            ) {
                return
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                let error = NSError(
                    domain: "APIClient",
                    code: httpResponse.statusCode,
                    userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"]
                )
                completion(.failure(error))
                return
            }

            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data received"])))
                return
            }

            if let enhancedText = String(data: data, encoding: .utf8) {
                completion(.success(enhancedText))
                return
            }

            completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Could not parse response"])))
        }

        task.resume()
    }

    /// Fetches existing custom task instructions from the backend.
    /// If no instructions exist, the backend is expected to return an empty string
    /// or an empty JSON field, which this method normalizes to an empty string.
    func fetchTaskInstructions(completion: @escaping (Result<String, Error>) -> Void) {
        fetchTaskInstructions(allowReauth: true, completion: completion)
    }

    private func fetchTaskInstructions(
        allowReauth: Bool,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        var request = URLRequest(url: getTaskInstructionsURL)
        request.httpMethod = "GET"

        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }

            if self.handleAuthFailure(
                statusCode: httpResponse.statusCode,
                allowReauth: allowReauth,
                onRetry: {
                    self.fetchTaskInstructions(allowReauth: false, completion: completion)
                },
                completion: completion
            ) {
                return
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                // If the instructions endpoint is missing or not yet set up, treat it as empty instructions
                if httpResponse.statusCode == 404 {
                    completion(.success(""))
                } else {
                    completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])) )
                }
                return
            }

            guard let data = data, !data.isEmpty else {
                completion(.success(""))
                return
            }

            do {
                // Try to parse JSON first; fall back to plain text.
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let instructions = json["instructions"] as? String {
                        completion(.success(instructions))
                        return
                    }
                }

                if let text = String(data: data, encoding: .utf8) {
                    completion(.success(text))
                    return
                }

                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Could not parse instructions response"])))
            } catch {
                completion(.failure(error))
            }
        }

        task.resume()
    }

    @discardableResult
    private func handleAuthFailure<T>(
        statusCode: Int,
        allowReauth: Bool,
        onRetry: @escaping () -> Void,
        completion: @escaping (Result<T, Error>) -> Void
    ) -> Bool {
        // Only handle auth-related failures here.
        guard statusCode == 401 || statusCode == 403 else {
            return false
        }

        // If we've already attempted reauth for this request,
        // fall back to the standard unauthorized handling.
        guard allowReauth else {
            handleUnauthorized(statusCode: statusCode, completion: completion)
            return true
        }

        SubscriptionManager.shared.reactivateStoredKeyIfNeeded { outcome in
            switch outcome {
            case .success:
                // We have a fresh JWT; let the caller retry once.
                onRetry()

            case .noStoredKey, .expired:
                // No key to re-activate, or server reports the
                // subscription as expired. Notify the app so it can
                // show a purchase link.
                NotificationCenter.default.post(name: .subscriptionExpired, object: nil)
                let error = NSError(
                    domain: "APIClient",
                    code: statusCode,
                    userInfo: [NSLocalizedDescriptionKey: "Subscription expired or missing."]
                )
                completion(.failure(error))

            case .failure:
                // Re-activation failed for a non-expiry reason;
                // treat as a generic unauthorized.
                self.handleUnauthorized(statusCode: statusCode, completion: completion)
            }
        }

        return true
    }

    private func handleUnauthorized<T>(
        statusCode: Int,
        completion: @escaping (Result<T, Error>) -> Void
    ) {
        SubscriptionManager.shared.invalidateToken()
        NotificationCenter.default.post(name: .subscriptionUnauthorized, object: nil)

        let error = NSError(
            domain: "APIClient",
            code: statusCode,
            userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(statusCode)"]
        )
        completion(.failure(error))
    }

    /// Persists custom task instructions to the backend.
    func saveTaskInstructions(_ instructions: String, completion: @escaping (Result<Void, Error>) -> Void) {
        saveTaskInstructions(instructions, allowReauth: true, completion: completion)
    }

    private func saveTaskInstructions(
        _ instructions: String,
        allowReauth: Bool,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        var request = URLRequest(url: createTaskInstructionsURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let payload: [String: String] = ["instructions": instructions]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        } catch {
            completion(.failure(error))
            return
        }

        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }

            if self.handleAuthFailure(
                statusCode: httpResponse.statusCode,
                allowReauth: allowReauth,
                onRetry: {
                    self.saveTaskInstructions(instructions, allowReauth: false, completion: completion)
                },
                completion: completion
            ) {
                return
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])) )
                return
            }

            completion(.success(()))
        }

        task.resume()
    }
}