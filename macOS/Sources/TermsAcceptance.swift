import Foundation

/// Tracks whether the user has accepted the current version of the Terms &
/// Conditions bundled with the app. Persisted in `UserDefaults`, keyed by
/// the accepted terms version so future revisions re-prompt users on next
/// launch.
///
/// The current terms version is `TermsContent.currentVersion` — bump it
/// whenever `TERMS.md` / `TermsContent.text` changes materially.
enum TermsAcceptance {
    private static let versionDefaultsKey = "OmniKeyTermsAcceptedVersion"
    private static let acceptedAtDefaultsKey = "OmniKeyTermsAcceptedAt"

    /// True when the user has accepted the version currently shipped with
    /// this build. Any older accepted version returns false so we prompt
    /// again on updates.
    static var hasAcceptedCurrent: Bool {
        let accepted = UserDefaults.standard.string(forKey: versionDefaultsKey)
        return accepted == TermsContent.currentVersion
    }

    /// Marks the current terms version as accepted and records the
    /// acceptance timestamp (ISO-8601) for auditability.
    static func recordAcceptance() {
        let defaults = UserDefaults.standard
        defaults.set(TermsContent.currentVersion, forKey: versionDefaultsKey)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        defaults.set(formatter.string(from: Date()), forKey: acceptedAtDefaultsKey)
        defaults.synchronize()
    }

    /// Test/debug helper — clears any prior acceptance so the next launch
    /// re-prompts the user. Not currently exposed in the UI.
    static func reset() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: versionDefaultsKey)
        defaults.removeObject(forKey: acceptedAtDefaultsKey)
    }
}
