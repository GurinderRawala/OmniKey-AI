import Foundation

class APIClient {
    private let enhancePromptURL = URL(string: "http://localhost:7172/api/enhance")!
    private let enhanceGrammarURL = URL(string: "http://localhost:7172/api/grammar")!
    private let customTaskURL = URL(string: "http://localhost:7172/api/custom-task")!

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
}
