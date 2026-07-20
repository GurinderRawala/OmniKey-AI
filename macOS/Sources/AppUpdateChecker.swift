import Combine
import Foundation

/// Observes whether a newer app version is available on the Sparkle
/// appcast feed, without altering Sparkle's own update cycle.
///
/// Why not just rely on Sparkle?
///
/// Sparkle already runs a scheduled background check and, when it
/// finds a valid update, presents its standard update prompt. That
/// prompt is easy to miss (users dismiss it, or it fires while the
/// app is not focused). This checker layers a passive, always-visible
/// affordance on top:
///
///   * It fetches the same appcast that Sparkle uses (`SUFeedURL`
///     from `Info.plist`) — no separate endpoint contract to keep in
///     sync.
///   * It parses the most recent `<item>`'s `sparkle:shortVersionString`
///     and `sparkle:version` and compares them to the running bundle's
///     `CFBundleShortVersionString` / `CFBundleVersion`.
///   * When newer, it publishes `isUpdateAvailable = true` and
///     `latestShortVersion`, which the chat sidebar reads to show an
///     "Update available" button.
///
/// Tapping that button hands control back to Sparkle
/// (`AppDelegate.checkForUpdates()`), so the actual download +
/// installation path is unchanged — this class only drives the
/// discovery signal in the UI.
///
/// The class does NOT poll aggressively: it fetches once shortly after
/// launch and then every `refreshInterval` seconds while the app is
/// running (default: 6 hours). It also exposes `refreshNow()` so the
/// sidebar can force a check when the user opens the chat window.
@MainActor
final class AppUpdateChecker: ObservableObject {
    static let shared = AppUpdateChecker()

    /// True when the latest appcast entry has a version greater than
    /// the running app. Consumed by SwiftUI to show the sidebar
    /// "Update" button.
    @Published private(set) var isUpdateAvailable: Bool = false

    /// The `sparkle:shortVersionString` from the latest appcast item.
    /// Nil until the first successful fetch. Useful for tooltips /
    /// accessibility labels.
    @Published private(set) var latestShortVersion: String? = nil

    /// True while a fetch is in flight. Not currently surfaced in the
    /// UI but kept `@Published` in case a future revision wants a
    /// spinner next to the update button.
    @Published private(set) var isChecking: Bool = false

    /// Time between background checks. 6 hours is deliberately longer
    /// than a chat session and short enough that a released hotfix
    /// still surfaces within the same working day.
    private let refreshInterval: TimeInterval = 6 * 60 * 60

    /// The Sparkle feed URL, read once from `Info.plist`. `nil` means
    /// the app was built without a feed (dev builds) — the checker
    /// silently becomes a no-op in that case.
    private let feedURL: URL?

    private let session: URLSession
    private var timer: Timer?
    private var lastFetchAt: Date?

    private init() {
        let info = Bundle.main.infoDictionary ?? [:]
        if let raw = info["SUFeedURL"] as? String, let url = URL(string: raw) {
            self.feedURL = url
        } else {
            self.feedURL = nil
        }

        // Short timeout so a slow network never blocks the app; the
        // "Update" button simply stays hidden until a later check
        // succeeds.
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 12
        self.session = URLSession(configuration: config)
    }

    /// Kick off the first check and schedule periodic re-checks.
    /// Safe to call multiple times — subsequent calls are no-ops.
    func start() {
        guard timer == nil else { return }
        // Delay the first fetch slightly so we don't compete with the
        // initial burst of network activity at launch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.refreshNow()
        }
        let t = Timer.scheduledTimer(withTimeInterval: refreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshNow() }
        }
        t.tolerance = 60
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// Force a check now. Debounced to at most once every 30 seconds
    /// so a jittery UI (e.g. rapidly reopening the chat window) does
    /// not hammer the feed.
    func refreshNow() {
        guard let feedURL else { return }
        if isChecking { return }
        if let last = lastFetchAt, Date().timeIntervalSince(last) < 30 { return }

        isChecking = true
        lastFetchAt = Date()

        var request = URLRequest(url: feedURL)
        request.setValue("application/rss+xml, application/xml;q=0.9, */*;q=0.5", forHTTPHeaderField: "Accept")

        session.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let ok = (response as? HTTPURLResponse)?.statusCode ?? 0
            let parsed: LatestAppcastVersion? = {
                guard ok >= 200, ok < 300, let data else { return nil }
                return AppcastLatestVersionParser.parse(data)
            }()
            Task { @MainActor in
                self.isChecking = false
                guard let parsed else { return }
                self.apply(parsed)
            }
        }.resume()
    }

    /// Compare `latest` against the running bundle and publish.
    private func apply(_ latest: LatestAppcastVersion) {
        self.latestShortVersion = latest.shortVersion

        let info = Bundle.main.infoDictionary ?? [:]
        let currentShort = (info["CFBundleShortVersionString"] as? String) ?? ""
        let currentBuild = (info["CFBundleVersion"] as? String) ?? ""

        // Prefer `sparkle:version` (CFBundleVersion) for the ordering
        // comparison — it is guaranteed to be a monotonically
        // increasing integer for every release, which matches how
        // Sparkle itself decides "is this newer?". Fall back to the
        // human-readable short version when the build number is
        // missing on either side.
        let newer: Bool
        if let latestBuildInt = Int(latest.build), let currentBuildInt = Int(currentBuild) {
            newer = latestBuildInt > currentBuildInt
        } else {
            newer = AppUpdateChecker.compareShortVersions(latest.shortVersion, currentShort) == .orderedDescending
        }

        self.isUpdateAvailable = newer
    }

    /// Semver-ish comparison for dotted-integer short versions
    /// (e.g. `1.1.1` vs `1.1.10`). Non-numeric segments compare
    /// lexicographically, which is enough for our release scheme.
    static func compareShortVersions(_ a: String, _ b: String) -> ComparisonResult {
        let ap = a.split(separator: ".")
        let bp = b.split(separator: ".")
        let n = max(ap.count, bp.count)
        for i in 0..<n {
            let av = i < ap.count ? String(ap[i]) : "0"
            let bv = i < bp.count ? String(bp[i]) : "0"
            if let ai = Int(av), let bi = Int(bv) {
                if ai != bi { return ai < bi ? .orderedAscending : .orderedDescending }
            } else {
                let cmp = av.compare(bv)
                if cmp != .orderedSame { return cmp }
            }
        }
        return .orderedSame
    }
}

/// Extracted appcast metadata: the values we need for a version check.
struct LatestAppcastVersion: Equatable {
    let shortVersion: String
    let build: String
}

/// Minimal XMLParser wrapper that pulls the first `<enclosure>` element
/// out of a Sparkle appcast and reads its `sparkle:shortVersionString`
/// + `sparkle:version` attributes. Only the *first* item is inspected —
/// Sparkle appcasts are ordered newest-first.
final class AppcastLatestVersionParser: NSObject, XMLParserDelegate {
    static func parse(_ data: Data) -> LatestAppcastVersion? {
        let inst = AppcastLatestVersionParser()
        let parser = XMLParser(data: data)
        parser.delegate = inst
        parser.shouldProcessNamespaces = false
        parser.parse()
        return inst.result
    }

    private var result: LatestAppcastVersion?

    func parser(_ parser: XMLParser,
                didStartElement elementName: String,
                namespaceURI _: String?,
                qualifiedName _: String?,
                attributes attributeDict: [String: String]) {
        guard result == nil else { return }
        guard elementName == "enclosure" else { return }
        let short = attributeDict["sparkle:shortVersionString"] ?? ""
        let build = attributeDict["sparkle:version"] ?? ""
        guard !short.isEmpty || !build.isEmpty else { return }
        result = LatestAppcastVersion(shortVersion: short, build: build)
        parser.abortParsing()
    }
}
