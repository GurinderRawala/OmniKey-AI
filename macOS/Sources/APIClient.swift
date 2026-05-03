import Foundation

final class APIClient: @unchecked Sendable {
        /// Indicates if the self-hosted OmniKey config is detected
    /// Reads the self-hosted config and returns the port if present, else nil
    private static func selfHostedPort() -> String? {
        // Use FileManager and NSHomeDirectory to resolve the config path reliably
        let homeDir = NSHomeDirectory()
        let configPath = (homeDir as NSString).appendingPathComponent(".omnikey/config.json")
        let fileManager = FileManager.default
        print("[OmniKey] Checking for self-hosted config at path: \(configPath)")
        if fileManager.fileExists(atPath: configPath) {
            print("[OmniKey] Config file exists at path: \(configPath)")
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
                if let json = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
                    print("[OmniKey] Config JSON: \(json)")
                    if let port = json["OMNIKEY_PORT"] as? String {
                        print("[OmniKey] Found OMNIKEY_PORT as String: \(port)")
                        return port
                    } else if let portNum = json["OMNIKEY_PORT"] as? Int {
                        let portStr = String(portNum)
                        print("[OmniKey] Found OMNIKEY_PORT as Int: \(portNum), returning as String: \(portStr)")
                        return portStr
                    } else {
                        print("[OmniKey] OMNIKEY_PORT key not found or not a string/int")
                    }
                }
            } catch {
                print("[OmniKey] Error reading or parsing config: \(error)")
            }
        }
        return nil
    }

    static let isSelfHosted: Bool = {
        return selfHostedPort() != nil
    }()
    /// Base URL resolution order:
    /// 1. Check for the self-hosted OmniKey setup in `~/.omnikey/config.json`
    /// 2. Environment variable `OMNIKEY_BACKEND_URL` at runtime
    /// 3. Info.plist key `OMNIKEY_BACKEND_URL` (set by build_release_dmg.sh)
    /// 4. Fallback to local development server at http://localhost:7071
    static let baseURL: URL = {
        if let port = selfHostedPort() {
            return URL(string: "http://localhost:\(port)")!
        }
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
    private let scheduledJobsBaseURL = APIClient.baseURL.appendingPathComponent("api/scheduled-jobs")

    // MARK: - Shared error helpers

    /// Build a user-facing NSError from a non-success HTTP response,
    /// attempting to surface any backend-provided error message.
    static func makeBackendError(
        statusCode: Int,
        data: Data?
    ) -> NSError {
        var message: String?

        if let data, !data.isEmpty {
            // First try to decode as UTF-8 text; many backends return
            // plain-text error descriptions for non-2xx responses.
            if let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty
            {
                message = text
            }

            // If the body looks like JSON, try to pull a common
            // "message" / "error" field out of it.
            if message == nil,
               let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
            {
                let candidateKeys = ["message", "error", "detail", "title", "description"]
                for key in candidateKeys {
                    if let value = json[key] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        message = value.trimmingCharacters(in: .whitespacesAndNewlines)
                        break
                    }
                }
            }
        }

        let fallback = "Server returned status code \(statusCode)"
        let description = (message?.isEmpty == false ? message! : fallback)

        return NSError(
            domain: "APIClient",
            code: statusCode,
            userInfo: [NSLocalizedDescriptionKey: description]
        )
    }

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
                    let error = APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)
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
                    let error = APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)
                    completion(.failure(error))
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
                let error = APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)
                completion(.failure(error))
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
                let error = APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)
                completion(.failure(error))
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

            if !(200 ... 299).contains(httpResponse.statusCode), httpResponse.statusCode != 204 {
                let error = APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: nil)
                completion(.failure(error))
                return
            }

            completion(.success(()))
        }

        task.resume()
    }

    func clearDefaultTaskTemplate(completion: @escaping @Sendable (Result<Void, Error>) -> Void) {
        let url = taskTemplatesBaseURL.appendingPathComponent("clear-default")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

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

            if !(200 ... 299).contains(httpResponse.statusCode), httpResponse.statusCode != 204 {
                let error = APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: nil)
                completion(.failure(error))
                return
            }

            completion(.success(()))
        }

        task.resume()
    }

    // MARK: - Scheduled Jobs

    struct ScheduledJobDTO: Codable, Identifiable {
        let id: String
        let label: String
        let prompt: String
        let cronExpression: String?
        let runAt: String?
        let isActive: Bool
        let lastRunAt: String?
        let nextRunAt: String?
        let sessionId: String?
        let lastRunSessionId: String?
    }

    func fetchScheduledJobs(completion: @escaping @Sendable (Result<[ScheduledJobDTO], Error>) -> Void) {
        var request = URLRequest(url: scheduledJobsBaseURL)
        request.httpMethod = "GET"
        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error { completion(.failure(error)); return }
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }
            guard (200...299).contains(httpResponse.statusCode) else {
                completion(.failure(APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)))
                return
            }
            guard let data = data, !data.isEmpty else { completion(.success([])); return }
            do {
                struct Envelope: Codable { let jobs: [ScheduledJobDTO] }
                let decoded = try JSONDecoder().decode(Envelope.self, from: data)
                completion(.success(decoded.jobs))
            } catch { completion(.failure(error)) }
        }
        task.resume()
    }

    func createScheduledJob(
        label: String,
        prompt: String,
        cronExpression: String?,
        runAt: String?,
        isActive: Bool = true,
        completion: @escaping @Sendable (Result<ScheduledJobDTO, Error>) -> Void
    ) {
        var request = URLRequest(url: scheduledJobsBaseURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        var payload: [String: Any] = ["label": label, "prompt": prompt, "isActive": isActive]
        if let cron = cronExpression { payload["cronExpression"] = cron }
        if let runAt = runAt { payload["runAt"] = runAt }
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Serialization error"])))
            return
        }
        request.httpBody = body
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error { completion(.failure(error)); return }
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }
            guard (200...299).contains(httpResponse.statusCode) else {
                completion(.failure(APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)))
                return
            }
            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data"])))
                return
            }
            do { completion(.success(try JSONDecoder().decode(ScheduledJobDTO.self, from: data))) }
            catch { completion(.failure(error)) }
        }
        task.resume()
    }

    func updateScheduledJob(
        id: String,
        label: String,
        prompt: String,
        cronExpression: String?,
        runAt: String?,
        isActive: Bool? = nil,
        completion: @escaping @Sendable (Result<ScheduledJobDTO, Error>) -> Void
    ) {
        let url = scheduledJobsBaseURL.appendingPathComponent(id)
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        var payload: [String: Any] = ["label": label, "prompt": prompt]
        if let cron = cronExpression { payload["cronExpression"] = cron }
        if let runAt = runAt { payload["runAt"] = runAt }
        if let isActive = isActive { payload["isActive"] = isActive }
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Serialization error"])))
            return
        }
        request.httpBody = body
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error { completion(.failure(error)); return }
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }
            guard (200...299).contains(httpResponse.statusCode) else {
                completion(.failure(APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)))
                return
            }
            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data"])))
                return
            }
            do { completion(.success(try JSONDecoder().decode(ScheduledJobDTO.self, from: data))) }
            catch { completion(.failure(error)) }
        }
        task.resume()
    }

    func deleteScheduledJob(id: String, completion: @escaping @Sendable (Result<Void, Error>) -> Void) {
        let url = scheduledJobsBaseURL.appendingPathComponent(id)
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error { completion(.failure(error)); return }
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }
            if (200...299).contains(httpResponse.statusCode) || httpResponse.statusCode == 204 {
                completion(.success(()))
            } else {
                completion(.failure(APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: nil)))
            }
        }
        task.resume()
    }

    func runScheduledJobNow(id: String, completion: @escaping @Sendable (Result<ScheduledJobDTO, Error>) -> Void) {
        let url = scheduledJobsBaseURL.appendingPathComponent("\(id)/run-now")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let token = SubscriptionManager.shared.jwtToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error { completion(.failure(error)); return }
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
                return
            }
            guard (200...299).contains(httpResponse.statusCode) else {
                completion(.failure(APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)))
                return
            }
            guard let data = data, !data.isEmpty else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data"])))
                return
            }
            do { completion(.success(try JSONDecoder().decode(ScheduledJobDTO.self, from: data))) }
            catch { completion(.failure(error)) }
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
                let error = APIClient.makeBackendError(statusCode: httpResponse.statusCode, data: data)
                completion(.failure(error))
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
