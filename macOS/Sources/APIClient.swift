import Foundation

class APIClient {
    private let enhancePromptURL = URL(string: "http://localhost:7172/api/enhance")!
    private let enhanceGrammarURL = URL(string: "http://localhost:7172/api/grammar")!
    private let customTaskURL = URL(string: "http://localhost:7172/api/custom-task")!
    private let getTaskInstructionsURL = URL(string: "http://localhost:7172/api/get-task-instructions")!
    private let createTaskInstructionsURL = URL(string: "http://localhost:7172/api/create-task-instructions")!

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
        
        let payload: [String: String] = ["text": text]
        
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
            
            guard let data = data else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "No data received"])))
                return
            }
            
            do {
                if let httpResponse = response as? HTTPURLResponse,
                   !(200...299).contains(httpResponse.statusCode) {
                    let error = NSError(
                        domain: "APIClient",
                        code: httpResponse.statusCode,
                        userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"]
                    )

                    if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
                        // Mark the current JWT as invalid and notify the
                        // app so it can reopen the key window and update
                        // any status indicators.
                        SubscriptionManager.shared.invalidateToken()
                        NotificationCenter.default.post(name: .subscriptionUnauthorized, object: nil)
                    }

                    completion(.failure(error))
                    return
                }

                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let enhancedText = json["result"] as? String {
                    completion(.success(enhancedText))
                } else if let enhancedText = String(data: data, encoding: .utf8) {
                    completion(.success(enhancedText))
                } else {
                    completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Could not parse response"])))
                }
            } catch {
                completion(.failure(error))
            }
        }
        
        task.resume()
    }

    /// Fetches existing custom task instructions from the backend.
    /// If no instructions exist, the backend is expected to return an empty string
    /// or an empty JSON field, which this method normalizes to an empty string.
    func fetchTaskInstructions(completion: @escaping (Result<String, Error>) -> Void) {
        var request = URLRequest(url: getTaskInstructionsURL)
        request.httpMethod = "GET"

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "APIClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])))
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
                    if let instruction = json["instruction"] as? String { // legacy singular field name
                        completion(.success(instruction))
                        return
                    }
                    if let prompt = json["prompt"] as? String { // alternative field name
                        completion(.success(prompt))
                        return
                    }
                    if let result = json["result"] as? String { // last-resort generic field
                        completion(.success(result))
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

    /// Persists custom task instructions to the backend.
    func saveTaskInstructions(_ instructions: String, completion: @escaping (Result<Void, Error>) -> Void) {
        var request = URLRequest(url: createTaskInstructionsURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

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

            guard (200...299).contains(httpResponse.statusCode) else {
                completion(.failure(NSError(domain: "APIClient", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(httpResponse.statusCode)"])) )
                return
            }

            completion(.success(()))
        }

        task.resume()
    }
}