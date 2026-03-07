import Foundation

final class APIClient: @unchecked Sendable {
    /// Base URL resolution order:
    /// 1. Environment variable `OMNIKEY_BACKEND_URL` at runtime
    /// 2. Info.plist key `OMNIKEY_BACKEND_URL` (set by build_release_dmg.sh)
    /// 3. Fallback to local development server at http://localhost:7071
    static let baseURL: URL = {
        if let env = ProcessInfo.processInfo.environment["OMNIKEY_BACKEND_URL"], !env.isEmpty,
           let url = URL(string: env)
        {
            return url
        }

        if let plistValue = Bundle.main.object(forInfoDictionaryKey: "OMNIKEY_BACKEND_URL") as? String,
           !plistValue.isEmpty,
           let url = URL(string: plistValue)
        {
            return url
        }

        // Default local backend for development
        return URL(string: "http://localhost:7071")!
    }()

    private let enhancePromptURL = APIClient.baseURL.appendingPathComponent("api/feature/enhance")
    private let enhanceGrammarURL = APIClient.baseURL.appendingPathComponent("api/feature/grammar")
    private let customTaskURL = APIClient.baseURL.appendingPathComponent("api/feature/custom-task")
    private let taskTemplatesBaseURL = APIClient.baseURL.appendingPathComponent("api/instructions/templates")

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

    func enhance(_ text: String, cmd: String, completion: @escaping @Sendable (Result<String, Error>) -> Void) {
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
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        let handler: @Sendable (Data?, URLResponse?, Error?) -> Void = { [weak self, request, allowReauth] data, response, error in
            Task { @MainActor [weak self, data, response, error] in
                guard let self else { return }

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

                guard (200 ... 299).contains(httpResponse.statusCode) else {
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
        }

        let task = URLSession.shared.dataTask(with: request, completionHandler: handler)
        task.resume()
    }

    @discardableResult
    private func handleAuthFailure<T>(
        statusCode: Int,
        allowReauth: Bool,
        onRetry: @escaping @Sendable () -> Void,
        completion: @escaping @Sendable (Result<T, Error>) -> Void
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
        completion: @escaping @Sendable (Result<T, Error>) -> Void
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

    // MARK: - Task templates

    struct TaskTemplateDTO: Codable, Identifiable {
        let id: String
        let heading: String
        let instructions: String
        let isDefault: Bool
    }

    func fetchTaskTemplates(completion: @escaping @Sendable (Result<[TaskTemplateDTO], Error>) -> Void) {
        fetchTaskTemplates(allowReauth: true, completion: completion)
    }

    private func fetchTaskTemplates(
        allowReauth: Bool,
        completion: @escaping @Sendable (Result<[TaskTemplateDTO], Error>) -> Void
    ) {
        var request = URLRequest(url: taskTemplatesBaseURL)
        request.httpMethod = "GET"

        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let handler: @Sendable (Data?, URLResponse?, Error?) -> Void = { [weak self, allowReauth] data, response, error in
            Task { @MainActor [weak self, data, response, error] in
                guard let self else { return }

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
                        self.fetchTaskTemplates(allowReauth: false, completion: completion)
                    },
                    completion: completion
                ) {
                    return
                }

                guard (200 ... 299).contains(httpResponse.statusCode) else {
                    completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])))
                    return
                }

                guard let data = data, !data.isEmpty else {
                    completion(.success([]))
                    return
                }

                do {
                    struct ResponseEnvelope: Codable {
                        let templates: [TaskTemplateDTO]
                    }

                    let decoded = try JSONDecoder().decode(ResponseEnvelope.self, from: data)
                    completion(.success(decoded.templates))
                } catch {
                    completion(.failure(error))
                }
            }
        }

        let task = URLSession.shared.dataTask(with: request, completionHandler: handler)
        task.resume()
    }

    func createTaskTemplate(
        heading: String,
        instructions: String,
        completion: @escaping @Sendable (Result<TaskTemplateDTO, Error>) -> Void
    ) {
        var request = URLRequest(url: taskTemplatesBaseURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let payload: [String: String] = [
            "heading": heading,
            "instructions": instructions,
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
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
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }

            if !(200 ... 299).contains(httpResponse.statusCode) {
                completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])))
                return
            }

            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data received"])))
                return
            }

            do {
                let decoded = try JSONDecoder().decode(TaskTemplateDTO.self, from: data)
                completion(.success(decoded))
            } catch {
                completion(.failure(error))
            }
        }

        task.resume()
    }

    func updateTaskTemplate(
        id: String,
        heading: String,
        instructions: String,
        completion: @escaping @Sendable (Result<TaskTemplateDTO, Error>) -> Void
    ) {
        let url = taskTemplatesBaseURL.appendingPathComponent(id)
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let payload: [String: String] = [
            "heading": heading,
            "instructions": instructions,
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
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
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }

            if !(200 ... 299).contains(httpResponse.statusCode) {
                completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])))
                return
            }

            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data received"])))
                return
            }

            do {
                let decoded = try JSONDecoder().decode(TaskTemplateDTO.self, from: data)
                completion(.success(decoded))
            } catch {
                completion(.failure(error))
            }
        }

        task.resume()
    }

    func deleteTaskTemplate(id: String, completion: @escaping @Sendable (Result<Void, Error>) -> Void) {
        let url = taskTemplatesBaseURL.appendingPathComponent(id)
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"

        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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

            if !(200 ... 299).contains(httpResponse.statusCode) && httpResponse.statusCode != 204 {
                completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])))
                return
            }

            completion(.success(()))
        }

        task.resume()
    }

    func setDefaultTaskTemplate(id: String, completion: @escaping @Sendable (Result<TaskTemplateDTO, Error>) -> Void) {
        let url = taskTemplatesBaseURL.appendingPathComponent("\(id)/set-default")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

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

            if !(200 ... 299).contains(httpResponse.statusCode) {
                completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])))
                return
            }

            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data received"])))
                return
            }

            do {
                let decoded = try JSONDecoder().decode(TaskTemplateDTO.self, from: data)
                completion(.success(decoded))
            } catch {
                completion(.failure(error))
            }
        }

        task.resume()
    }
}
