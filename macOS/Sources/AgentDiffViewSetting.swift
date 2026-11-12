import Foundation

/// Client mirror of the backend `agent_settings.diffViewEnabled` toggle.
///
/// The backend row is authoritative and its turn runner refuses diff work
/// when the setting is off, even for a stale client. This UserDefaults copy
/// lets the Mac (a) advertise no diff capabilities on the initial frame and
/// (b) skip all native Git snapshot, provenance and recovery-checkpoint work
/// without a network round trip. It is refreshed on every Agent Access load
/// and save. Each run snapshots the value once at start, so toggling never
/// changes the protocol of a turn already in flight; it applies to new turns.
enum AgentDiffViewSetting {
    static let defaultsKey = "agentDiffViewEnabled"
    static let explanation = "May use additional AI tokens to recover missing file changes."

    /// Missing key means enabled (historical behavior).
    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? true
    }

    static func store(_ enabled: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: defaultsKey)
    }

    /// Backend values of `diffViewEnabled` that are absent (older servers)
    /// keep the feature on; only an explicit `false` disables it.
    static func resolve(serverValue: Bool?) -> Bool { serverValue ?? true }

    /// Capability flags advertised on the initial agent frame.
    struct Capabilities: Equatable, Sendable {
        let gitDiff: Bool
        let gitTurnDiff: Bool
        let diffRecovery: Bool
    }

    static func capabilities(enabled: Bool) -> Capabilities {
        Capabilities(gitDiff: enabled, gitTurnDiff: enabled, diffRecovery: enabled)
    }
}
