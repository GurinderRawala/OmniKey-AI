import Foundation
import StoreKit

@MainActor
final class SubscriptionManager: ObservableObject {
    static let shared = SubscriptionManager()

    @Published private(set) var isSubscribed: Bool = false
    @Published private(set) var isLoading: Bool = false
    @Published var errorMessage: String?

    // Replace with your real product identifier from App Store Connect
    private let productIdentifiers: [String] = ["com.example.omnikey.pro.monthly"]

    private let backendBaseURL = URL(string: "http://localhost:7172")!

    private init() {
        // On init, reflect any existing token as a tentative subscription state.
        if SubscriptionTokenStore.token != nil {
            isSubscribed = true
        }
    }

    var currentToken: String? {
        SubscriptionTokenStore.token
    }

    func bootstrapOnLaunch() async {
        _ = await checkExistingSubscription()
    }

    /// Checks with the backend whether the current JWT (if any) still represents an active
    /// subscription. Updates `isSubscribed` accordingly.
    func checkExistingSubscription() async -> Bool {
        guard let token = SubscriptionTokenStore.token else {
            isSubscribed = false
            return false
        }

        isLoading = true
        defer { isLoading = false }

        var request = URLRequest(url: backendBaseURL.appendingPathComponent("/api/subscription/session"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                isSubscribed = false
                SubscriptionTokenStore.token = nil
                return false
            }

            if http.statusCode == 200,
               let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let subscribed = json["subscribed"] as? Bool,
               subscribed == true {
                isSubscribed = true
                return true
            } else {
                isSubscribed = false
                SubscriptionTokenStore.token = nil
                return false
            }
        } catch {
            // On network errors, conservatively treat as not subscribed so we show the paywall.
            isSubscribed = false
            errorMessage = "Unable to verify subscription. Please try again."
            return false
        }
    }

    /// Starts a purchase flow for the subscription product using StoreKit 2 and then
    /// sends the resulting transaction JWS to the backend. On success, stores the
    /// JWT from the backend and marks the user as subscribed.
    func purchase(email: String? = nil) async -> Bool {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let products = try await Product.products(for: productIdentifiers)
            guard let product = products.first else {
                errorMessage = "Subscription product not found."
                return false
            }

            let result = try await product.purchase()

            switch result {
            case .success(let verificationResult):
                let jws = verificationResult.jwsRepresentation

                guard case .verified(let transaction) = verificationResult else {
                    errorMessage = "Unable to verify App Store transaction."
                    return false
                }

                let token = try await sendPurchaseToBackend(transactionJWS: jws, email: email)
                SubscriptionTokenStore.token = token
                isSubscribed = true

                await transaction.finish()
                return true

            case .userCancelled:
                return false

            case .pending:
                errorMessage = "Purchase is pending. Please wait or try again later."
                return false

            @unknown default:
                errorMessage = "Unknown purchase result."
                return false
            }
        } catch {
            errorMessage = "Purchase failed: \(error.localizedDescription)"
            return false
        }
    }

    /// Called when the client receives a 401/403 due to an expired JWT.
    /// Attempts to refresh the subscription status with the backend (which
    /// in turn talks to Apple). On success, stores a new JWT; otherwise
    /// clears the token and marks the user as not subscribed.
    func refreshSubscriptionIfNeeded() async {
        guard let token = SubscriptionTokenStore.token else {
            isSubscribed = false
            return
        }

        var request = URLRequest(url: backendBaseURL.appendingPathComponent("/api/subscription/refresh"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                isSubscribed = false
                SubscriptionTokenStore.token = nil
                return
            }

            if http.statusCode == 200,
               let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let newToken = json["token"] as? String {
                SubscriptionTokenStore.token = newToken
                isSubscribed = true
            } else {
                isSubscribed = false
                SubscriptionTokenStore.token = nil
            }
        } catch {
            isSubscribed = false
            SubscriptionTokenStore.token = nil
        }
    }

    private func sendPurchaseToBackend(transactionJWS: String, email: String?) async throws -> String {
        var request = URLRequest(url: backendBaseURL.appendingPathComponent("/api/subscription/purchase"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "transaction_jws": transactionJWS,
        ]
        if let email, !email.isEmpty {
            body["email"] = email
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "SubscriptionManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid server response"])
        }

        guard (200...299).contains(http.statusCode) else {
            if let msg = String(data: data, encoding: .utf8) {
                throw NSError(domain: "SubscriptionManager", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: msg])
            }
            throw NSError(domain: "SubscriptionManager", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned status code \(http.statusCode)"])
        }

        if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
           let token = json["token"] as? String {
            return token
        }

        throw NSError(domain: "SubscriptionManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Missing token in server response"])
    }
}

extension Notification.Name {
    static let showSubscriptionPaywall = Notification.Name("ShowSubscriptionPaywall")
}
