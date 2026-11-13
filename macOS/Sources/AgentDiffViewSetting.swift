import CryptoKit
import Foundation

/// Client mirror of the backend `agent_settings.diffViewEnabled` toggle.
///
/// The backend row is authoritative and its turn runner refuses diff work
/// when the setting is off, even for a stale client. This UserDefaults copy
/// lets the Mac (a) advertise no diff capabilities on the initial frame and
/// (b) skip all native Git snapshot and commit-provenance work without a
/// network round trip. (No per-shell recovery checkpoints exist at all.)
///
/// The mirror is scoped to the `SubscriptionIdentity` (backend + opaque key
/// fingerprint) the value was read or saved for, so a value saved for one
/// subscription or backend never applies to another. Each run reads the
/// value for the identity it connects as, once at start, so toggling never
/// changes the protocol of a turn already in flight. An identity with no
/// mirrored value yet uses the historical default (on); the server gate
/// still refuses diff work when its row says off.
///
/// `defaultsKey` stays the unscoped display mirror observed by
/// `@AppStorage` (card visibility). It is re-synced to the current
/// identity's value whenever a run starts or settings are loaded/saved.
enum AgentDiffViewSetting {
    static let defaultsKey = "agentDiffViewEnabled"
    static let explanation = "May use additional AI tokens to recover missing file changes."

    /// Prefix of identity-scoped keys; the suffix is a hash, never an ID.
    static let scopedKeyPrefix = "agentDiffViewEnabled.scope."
    /// Set once the legacy unscoped value has been attributed to an identity.
    static let migrationKey = "agentDiffViewEnabled.scopedMigrated"

    /// Opaque, stable defaults key for one identity. Hashes the backend and
    /// the (already hashed) subscription so neither appears in plain text.
    static func scopedKey(for identity: SubscriptionIdentity?) -> String {
        let material = identity.map { "v1\n\($0.backend)\n\($0.subscription)" } ?? "v1\nnone"
        let digest = SHA256.hash(data: Data(material.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return scopedKeyPrefix + digest
    }

    /// Unscoped display mirror. Missing key means enabled (historical behavior).
    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? true
    }

    /// Writes the unscoped display mirror only.
    static func store(_ enabled: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: defaultsKey)
    }

    /// Mirrored value for `identity` (default on when never mirrored).
    static func isEnabled(for identity: SubscriptionIdentity?, in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: scopedKey(for: identity)) as? Bool ?? true
    }

    /// Records the server value for `identity`. The display mirror follows
    /// only when `identity` is still the current one, so a late reply for
    /// a previous subscription cannot change what the current one sees.
    static func store(
        _ enabled: Bool,
        for identity: SubscriptionIdentity?,
        current: SubscriptionIdentity?,
        in defaults: UserDefaults = .standard
    ) {
        defaults.set(enabled, forKey: scopedKey(for: identity))
        defaults.set(true, forKey: migrationKey)
        if identity == current { store(enabled, in: defaults) }
    }

    /// The value a run started for `identity` snapshots. Also re-syncs the
    /// display mirror so card visibility matches that identity.
    ///
    /// One-time migration: a legacy unscoped value from before scoping is
    /// attributed to the identity current at the first read after upgrade.
    static func runValue(for identity: SubscriptionIdentity?, in defaults: UserDefaults = .standard) -> Bool {
        let key = scopedKey(for: identity)
        if !defaults.bool(forKey: migrationKey), let legacy = defaults.object(forKey: defaultsKey) as? Bool {
            defaults.set(true, forKey: migrationKey)
            if defaults.object(forKey: key) == nil { defaults.set(legacy, forKey: key) }
        }
        let enabled = isEnabled(for: identity, in: defaults)
        // Nothing is written while everything is unset (default on).
        if isEnabled(defaults) != enabled {
            // From now on the unscoped key is only a display mirror.
            defaults.set(true, forKey: migrationKey)
            store(enabled, in: defaults)
        }
        return enabled
    }

    /// `runValue` for the identity requests made now would act for.
    static func currentRunValue(
        _ defaults: UserDefaults = .standard,
        identity: SubscriptionIdentity? = SubscriptionManager.shared.currentIdentity
    ) -> Bool {
        runValue(for: identity, in: defaults)
    }

    /// Backend values of `diffViewEnabled` that are absent (older servers)
    /// keep the feature on; only an explicit `false` disables it.
    static func resolve(serverValue: Bool?) -> Bool { serverValue ?? true }

    /// Capability flags advertised on the initial agent frame. The legacy
    /// `supports_diff_recovery` checkpoint protocol is never advertised.
    struct Capabilities: Equatable, Sendable {
        let gitDiff: Bool
        let gitTurnDiff: Bool
        /// `supports_agent_patches`: the server may ask the agent for a
        /// unified patch when native Git capture cannot cover the turn.
        let agentPatches: Bool
    }

    static func capabilities(enabled: Bool) -> Capabilities {
        Capabilities(gitDiff: enabled, gitTurnDiff: enabled, agentPatches: enabled)
    }
}
