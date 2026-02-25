import Foundation
import Combine
import StoreKit
import AppKit

@MainActor
final class SubscriptionManager: NSObject, ObservableObject, SKRequestDelegate {
    static let shared = SubscriptionManager()

    @Published private(set) var isSubscribed: Bool = false
    @Published private(set) var isLoading: Bool = false
    @Published var errorMessage: String?

    // Replace with your real product identifier from App Store Connect
    private let productIdentifiers: [String] = ["com.example.omnikey.pro.monthly"]

    private let backendBaseURL = URL(string: "http://localhost:7172")!

    // In-flight receipt refresh state for SKReceiptRefreshRequest
    private var receiptRefreshContinuation: CheckedContinuation<Void, Error>?
    private var currentReceiptRefreshRequest: SKReceiptRefreshRequest?

    private override init() {
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
    /// sends the resulting App Store receipt to the backend for validation.
    /// On success, stores the JWT from the backend and marks the user as subscribed.
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
                guard case .verified(let transaction) = verificationResult else {
                    errorMessage = "Unable to verify App Store transaction."
                    return false
                }

                // Ensure we have a fresh App Store receipt (requesting one from Apple
                // if necessary) and send it to the backend for validation.
                let receiptBase64: String
                do {
                    receiptBase64 = try await refreshAppStoreReceiptIfNeeded()
                } catch {
                    errorMessage = "Unable to refresh App Store receipt: \(error.localizedDescription)"
                    return false
                }

                let token = try await sendPurchaseToBackend(receiptData: receiptBase64, email: email)
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

    /// Opens the App Store subscriptions page so the user can
    /// manage or cancel their OmniKey subscription at any time.
    func manageSubscription() {
        errorMessage = nil

        guard let url = URL(string: "https://apps.apple.com/account/subscriptions") else {
            errorMessage = "Unable to open subscription management. Please open the App Store > Account > Subscriptions to manage or cancel."
            return
        }

        if !NSWorkspace.shared.open(url) {
            errorMessage = "Unable to open subscription management. Please open the App Store > Account > Subscriptions to manage or cancel."
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

    private func sendPurchaseToBackend(receiptData: String, email: String?) async throws -> String {
        var request = URLRequest(url: backendBaseURL.appendingPathComponent("/api/subscription/purchase"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "receipt_data": receiptData,
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

    /// Ensures there is a current App Store receipt for this app. If the
    /// receipt is missing or empty, this will issue an SKReceiptRefreshRequest
    /// to ask the App Store to provide a new one, then load and return it as
    /// a Base64-encoded string.
    private func refreshAppStoreReceiptIfNeeded() async throws -> String {
        if let receiptURL = Bundle.main.appStoreReceiptURL,
           let data = try? Data(contentsOf: receiptURL),
           !data.isEmpty {
            return data.base64EncodedString()
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let request = SKReceiptRefreshRequest()
            self.receiptRefreshContinuation = continuation
            self.currentReceiptRefreshRequest = request
            request.delegate = self
            request.start()
        }

        guard let refreshedURL = Bundle.main.appStoreReceiptURL else {
            throw NSError(domain: "SubscriptionManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Missing appStoreReceiptURL after refresh"])
        }

        let refreshedData = try Data(contentsOf: refreshedURL)
        if refreshedData.isEmpty {
            throw NSError(domain: "SubscriptionManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Empty App Store receipt after refresh"])
        }

        return refreshedData.base64EncodedString()
    }
    func requestDidFinish(_ request: SKRequest) {
        receiptRefreshContinuation?.resume()
        receiptRefreshContinuation = nil
        currentReceiptRefreshRequest = nil
    }

    func request(_ request: SKRequest, didFailWithError error: Error) {
        receiptRefreshContinuation?.resume(throwing: error)
        receiptRefreshContinuation = nil
        currentReceiptRefreshRequest = nil
    }
}

extension Notification.Name {
    static let showSubscriptionPaywall = Notification.Name("ShowSubscriptionPaywall")
}
