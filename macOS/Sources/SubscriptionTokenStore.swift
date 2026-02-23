import Foundation

enum SubscriptionTokenStore {
    private static let tokenKey = "OmniKeySubscriptionJWT"

    static var token: String? {
        get {
            UserDefaults.standard.string(forKey: tokenKey)
        }
        set {
            let defaults = UserDefaults.standard
            if let value = newValue {
                defaults.set(value, forKey: tokenKey)
            } else {
                defaults.removeObject(forKey: tokenKey)
            }
        }
    }
}
