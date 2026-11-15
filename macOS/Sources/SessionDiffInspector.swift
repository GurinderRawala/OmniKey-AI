import AppKit
import SwiftUI
import WebKit

// MARK: - Fetch

enum SessionDiffTheme: String, CaseIterable, Sendable {
    case dark
    case light

    init(_ scheme: ColorScheme) { self = scheme == .dark ? .dark : .light }
}

enum SessionDiffLayout: String, CaseIterable, Sendable {
    case unified
    case split

    var label: String { self == .unified ? "Unified" : "Side-by-side" }
}

struct SessionDiffHTMLResponse: Decodable, Equatable, Sendable {
    let id: String
    let html: String
    var additions: Int? = nil
    var deletions: Int? = nil
}

enum SessionDiffFetchError: LocalizedError, Equatable {
    case notSignedIn
    case invalidIdentifier
    case notFound
    case incomplete
    case server(Int)
    case malformed
    case mismatchedSnapshot

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in to view saved changes."
        case .invalidIdentifier: return "This snapshot can't be opened."
        case .notFound: return "This snapshot is no longer available."
        case .incomplete: return "This snapshot is incomplete and cannot be displayed."
        case let .server(code): return "Couldn't load the snapshot (HTTP \(code))."
        case .malformed, .mismatchedSnapshot: return "The server returned an invalid snapshot."
        }
    }
}

protocol SessionDiffPreviewFetching: Sendable {
    func preview(sessionId: String, diff: LiveTurnDiff, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse
}

protocol SessionDiffFetching: Sendable {
    func fetch(sessionId: String, diffId: String, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse
}

private final class SessionDiffNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Fetches the server-rendered HTML with the bearer token in a header only.
/// The web view never sees the API URL or the token.
struct SessionDiffHTTPFetcher: SessionDiffFetching, SessionDiffPreviewFetching {
    var authSnapshot: @Sendable () -> SubscriptionAuthSnapshot = { SubscriptionManager.shared.authSnapshot() }
    var session: URLSession = .shared

    static func requestURL(baseURL: URL, sessionId: String, diffId: String, theme: SessionDiffTheme, layout: SessionDiffLayout = .unified) -> URL? {
        var components = URLComponents(
            url: baseURL
                .appendingPathComponent("api/agent/sessions")
                .appendingPathComponent(sessionId)
                .appendingPathComponent("diffs")
                .appendingPathComponent(diffId),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "theme", value: theme.rawValue),
                                  URLQueryItem(name: "layout", value: layout.rawValue)]
        return components?.url
    }

    func fetch(sessionId: String, diffId: String, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse {
        let auth = authSnapshot()
        guard let token = auth.token, !token.isEmpty else { throw SessionDiffFetchError.notSignedIn }
        guard SavedSessionDiff(id: diffId, fileCount: 0, repositoryCount: 1, createdAt: "").hasSafeID,
              !sessionId.isEmpty, !sessionId.contains("/"),
              let url = Self.requestURL(baseURL: auth.baseURL, sessionId: sessionId, diffId: diffId, theme: theme, layout: layout)
        else { throw SessionDiffFetchError.invalidIdentifier }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 25
        return try await perform(request, expectedID: diffId)
    }

    func preview(sessionId: String, diff: LiveTurnDiff, theme: SessionDiffTheme, layout: SessionDiffLayout) async throws -> SessionDiffHTMLResponse {
        let auth = authSnapshot()
        guard let token = auth.token, !token.isEmpty else { throw SessionDiffFetchError.notSignedIn }
        guard !sessionId.isEmpty, !sessionId.contains("/"),
              let url = Self.requestURL(baseURL: auth.baseURL, sessionId: sessionId, diffId: "preview", theme: theme, layout: layout)
        else { throw SessionDiffFetchError.invalidIdentifier }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.omnikey.diff+json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "theme": theme.rawValue, "layout": layout.rawValue,
            "repositories": diff.repositories.map { ["root": $0.root, "patch": $0.patch] },
            "coverage": diff.coverage.prefix(8).map { ["root": $0.root, "status": $0.status, "reason": $0.reason, "suggestedFix": $0.suggestedFix] },
        ])
        return try await perform(request, expectedID: nil)
    }

    private func perform(_ request: URLRequest, expectedID: String?) async throws -> SessionDiffHTMLResponse {
        let (bytes, response) = try await session.bytes(for: request, delegate: SessionDiffNoRedirect())
        let maximumBytes = 20 * 1024 * 1024
        guard response.expectedContentLength <= maximumBytes else { throw SessionDiffFetchError.malformed }
        var data = Data()
        for try await byte in bytes {
            guard data.count < maximumBytes else { throw SessionDiffFetchError.malformed }
            data.append(byte)
        }
        guard let http = response as? HTTPURLResponse else { throw SessionDiffFetchError.malformed }
        if http.statusCode == 404 { throw SessionDiffFetchError.notFound }
        if http.statusCode == 409 { throw SessionDiffFetchError.incomplete }
        guard 200..<300 ~= http.statusCode else { throw SessionDiffFetchError.server(http.statusCode) }
        guard let body = try? JSONDecoder().decode(SessionDiffHTMLResponse.self, from: data) else {
            throw SessionDiffFetchError.malformed
        }
        guard expectedID.map({ body.id == $0 }) ?? body.id.hasPrefix("preview_") else { throw SessionDiffFetchError.mismatchedSnapshot }
        return body
    }
}

// MARK: - HTML hardening

enum SessionDiffHTMLDocument {
    /// Client-side policy layered on top of the server's: no network, no
    /// scripts, no frames, no forms. Policies intersect, so this can only
    /// tighten whatever the server sent.
    static let contentSecurityPolicy =
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; "
        + "script-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; "
        + "connect-src 'none'; media-src 'none'; object-src 'none'"

    static let nativeStyle = "<style>header.snapshot{display:none}[hidden]{display:none!important}</style>"

    static var metaTag: String {
        "<meta http-equiv=\"Content-Security-Policy\" content=\"\(contentSecurityPolicy)\">"
    }

    /// Inserts the CSP as the first element of `<head>` so it applies before
    /// any server markup; wraps fragments in a minimal document.
    static func prepare(_ html: String) -> String {
        if let head = html.range(of: "<head", options: .caseInsensitive),
           let close = html.range(of: ">", range: head.upperBound..<html.endIndex)
        {
            var result = html
            result.insert(contentsOf: metaTag + nativeStyle, at: close.upperBound)
            return result
        }
        if let htmlTag = html.range(of: "<html", options: .caseInsensitive),
           let close = html.range(of: ">", range: htmlTag.upperBound..<html.endIndex)
        {
            var result = html
            result.insert(contentsOf: "<head>\(metaTag)\(nativeStyle)</head>", at: close.upperBound)
            return result
        }
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">\(metaTag)\(nativeStyle)</head><body>\(html)</body></html>"
    }
}

// MARK: - Inspector state

struct SessionDiffSelection: Equatable {
    let sessionId: String
    let diff: SavedSessionDiff
}

@MainActor
final class SessionDiffInspectorModel: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded(String)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var loadedKey: String?

    @Published private(set) var isUpdating = false
    @Published private(set) var updateError: String?
    private var sourceID: String?
    private var previewStyle: String?
    private var queuedPreview: (String, LiveTurnDiff, SessionDiffTheme, SessionDiffLayout)?
    private let previewFetcher: any SessionDiffPreviewFetching
    private let fetcher: any SessionDiffFetching
    private var task: Task<Void, Never>?
    private var generation = 0

    init(fetcher: any SessionDiffFetching = SessionDiffHTTPFetcher(), previewFetcher: any SessionDiffPreviewFetching = SessionDiffHTTPFetcher()) {
        self.fetcher = fetcher
        self.previewFetcher = previewFetcher
    }

    static func key(_ selection: SessionDiffSelection, theme: SessionDiffTheme, layout: SessionDiffLayout = .unified) -> String {
        "\(selection.sessionId)\u{0}\(selection.diff.id)\u{0}\(theme.rawValue)\u{0}\(layout.rawValue)"
    }

    /// Loads exactly `selection.diff.id`. Any earlier in-flight fetch is
    /// cancelled and its late result discarded (stale identity guard).
    func load(_ selection: SessionDiffSelection, theme: SessionDiffTheme, layout: SessionDiffLayout = .unified, force: Bool = false, preserveContent: Bool = false) {
        guard selection.diff.isEligibleForViewer else {
            task?.cancel()
            generation += 1
            loadedKey = nil
            phase = .failed("The changes snapshot is incomplete and cannot be displayed.")
            return
        }
        let key = Self.key(selection, theme: theme, layout: layout)
        if !force, key == loadedKey, phase != .idle { return }
        task?.cancel()
        queuedPreview = nil
        previewStyle = nil
        generation += 1
        let current = generation
        loadedKey = key
        let identity = selection.sessionId + ":" + selection.diff.id
        if case .loaded = phase {
            if sourceID != identity && !preserveContent { phase = .loading }
        } else { phase = .loading }
        sourceID = identity
        isUpdating = true
        updateError = nil
        let fetcher = self.fetcher
        task = Task { [weak self] in
            let outcome: Phase
            do {
                let body = try await fetcher.fetch(
                    sessionId: selection.sessionId, diffId: selection.diff.id, theme: theme, layout: layout
                )
                outcome = body.id == selection.diff.id
                    ? .loaded(SessionDiffHTMLDocument.prepare(body.html))
                    : .failed(SessionDiffFetchError.mismatchedSnapshot.localizedDescription)
            } catch is CancellationError {
                return
            } catch let error as URLError where error.code == .cancelled {
                return
            } catch {
                outcome = .failed(error.localizedDescription)
            }
            guard let self, !Task.isCancelled, self.generation == current else { return }
            self.isUpdating = false
            if case .failed(let message) = outcome, case .loaded = self.phase { self.updateError = message }
            else { self.phase = outcome }
        }
    }

    func loadPreview(sessionId: String, diff: LiveTurnDiff, theme: SessionDiffTheme, layout: SessionDiffLayout, force: Bool = false) {
        let key = "\(sessionId):\(diff.turnID):\(diff.revision):\(theme):\(layout)"
        guard force || key != loadedKey else { return }
        let identity = sessionId + ":" + diff.turnID
        let style = "\(theme):\(layout)"
        if sourceID == identity, previewStyle == style, isUpdating {
            // Finish the current render, then consume only the newest queued
            // revision. Continuous edits cannot starve the first useful frame.
            queuedPreview = (sessionId, diff, theme, layout)
            return
        }
        task?.cancel()
        queuedPreview = nil
        previewStyle = style
        generation += 1
        let current = generation
        loadedKey = key
        if case .loaded = phase {
            if identity != sourceID { phase = .loading }
        } else { phase = .loading }
        sourceID = identity
        updateError = nil
        isUpdating = true
        let fetcher = previewFetcher
        task = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(200))
                let body = try await fetcher.preview(sessionId: sessionId, diff: diff, theme: theme, layout: layout)
                guard let self, !Task.isCancelled, self.generation == current else { return }
                self.phase = .loaded(SessionDiffHTMLDocument.prepare(body.html))
                self.isUpdating = false
                self.drainPreviewQueue()
            } catch {
                guard let self, !Task.isCancelled, self.generation == current else { return }
                self.isUpdating = false
                if case .loaded = self.phase { self.updateError = "Couldn't update changes." }
                else { self.phase = .failed(error.localizedDescription) }
                self.drainPreviewQueue()
            }
        }
    }

    private func drainPreviewQueue() {
        previewStyle = nil
        guard let next = queuedPreview else { return }
        queuedPreview = nil
        loadPreview(sessionId: next.0, diff: next.1, theme: next.2, layout: next.3)
    }

    func reset() {
        task?.cancel()
        task = nil
        queuedPreview = nil
        previewStyle = nil
        generation += 1
        loadedKey = nil
        sourceID = nil
        isUpdating = false
        updateError = nil
        phase = .idle
    }
}

// MARK: - Web view

/// Non-persistent view with page scripts, external navigation and resources
/// disabled. Fixed app-owned scripts in an isolated world manage reading state;
/// no source text from the diff is ever evaluated.
struct SessionDiffWebView: NSViewRepresentable {
    let html: String
    var identity: String = ""
    var disclosureCommand: Int = 0
    var filter: String = ""

    static func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.isFraudulentWebsiteWarningEnabled = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.suppressesIncrementalRendering = true
        return configuration
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: Self.makeConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.load(html, identity: identity, into: webView)
        context.coordinator.disclose(disclosureCommand, in: webView)
        context.coordinator.filter(filter, in: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.load(html, identity: identity, into: webView)
        context.coordinator.disclose(disclosureCommand, in: webView)
        context.coordinator.filter(filter, in: webView)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var loadedHTML: String?
        private var identity = ""
        private var generation = 0
        private var state: [String: Any] = [:]
        private var disclosureCommand = 0
        private var pendingDisclosure = false
        private var filterQuery = ""

        // Page JavaScript stays disabled. Only these fixed application-owned
        // scripts run in an isolated content world, with data passed as arguments.
        static let captureState = """
        return { x: window.scrollX, y: window.scrollY, files: Array.from(document.querySelectorAll('details.file')).map(d => ({ key: d.dataset.fileKey || d.querySelector('summary')?.textContent, open: d.open, scroll: Array.from(d.querySelectorAll('.diffs-host')).flatMap(h => Array.from(h.shadowRoot?.querySelectorAll('pre,[data-code]') || []).map(p => p.scrollLeft)) })) };
        """
        static let restoreState = """
        const files = new Map((state.files || []).map(f => [f.key, f]));
        document.querySelectorAll('details.file').forEach(d => {
            const key = d.dataset.fileKey || d.querySelector('summary')?.textContent;
            const saved = files.get(key);
            if (!saved) return;
            d.open = saved.open;
            const ports = Array.from(d.querySelectorAll('.diffs-host')).flatMap(h => Array.from(h.shadowRoot?.querySelectorAll('pre,[data-code]') || []));
            ports.forEach((p, i) => p.scrollLeft = saved.scroll?.[i] || 0);
        });
        window.scrollTo(state.x || 0, state.y || 0);
        """

        func load(_ html: String, identity nextIdentity: String = "", into webView: WKWebView) {
            guard html != loadedHTML || identity != nextIdentity else { return }
            let preserve = loadedHTML != nil && identity == nextIdentity
            loadedHTML = html
            identity = nextIdentity
            generation += 1
            let token = generation
            if !preserve {
                state = [:]
                webView.loadHTMLString(html, baseURL: nil)
                return
            }
            webView.callAsyncJavaScript(Self.captureState, arguments: [:], in: nil, in: .defaultClient) { [weak self, weak webView] result in
                guard let self, let webView, self.generation == token else { return }
                if case .success(let value) = result, let value = value as? [String: Any] { self.state = value }
                webView.loadHTMLString(html, baseURL: nil)
            }
        }

        func disclose(_ command: Int, in webView: WKWebView) {
            guard command != disclosureCommand else { return }
            disclosureCommand = command
            pendingDisclosure = command != 0
            if !webView.isLoading { applyDisclosure(in: webView) }
        }

        private func applyDisclosure(in webView: WKWebView) {
            guard pendingDisclosure else { return }
            pendingDisclosure = false
            webView.callAsyncJavaScript("document.querySelectorAll('details.file').forEach(d => d.open = expand);", arguments: ["expand": disclosureCommand > 0], in: nil, in: .defaultClient, completionHandler: nil)
        }

        func filter(_ query: String, in webView: WKWebView) {
            guard query != filterQuery else { return }
            filterQuery = query
            applyFilter(in: webView)
        }

        private func applyFilter(in webView: WKWebView) {
            webView.callAsyncJavaScript("""
            let matches = 0;
            const queryText = query.trim().toLocaleLowerCase();
            document.querySelectorAll('details.file').forEach(d => {
                d.hidden = !(d.querySelector('.file-path')?.textContent || d.querySelector('summary')?.textContent || '').toLocaleLowerCase().includes(queryText);
                if (!d.hidden) matches++;
            });
            document.querySelectorAll('section.repo').forEach(s => s.hidden = !Array.from(s.querySelectorAll('details.file')).some(d => !d.hidden));
            let empty = document.getElementById('native-filter-empty');
            if (!empty) { empty = document.createElement('p'); empty.id = 'native-filter-empty'; empty.className = 'note'; empty.textContent = 'No matching files'; document.body.appendChild(empty); }
            empty.hidden = !queryText || matches > 0;
            """, arguments: ["query": filterQuery], in: nil, in: .defaultClient, completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            applyFilter(in: webView)
            webView.callAsyncJavaScript(Self.restoreState, arguments: ["state": state], in: nil, in: .defaultClient) { [weak self, weak webView] _ in
                guard let self, let webView else { return }
                self.applyDisclosure(in: webView)
            }
        }

        static func allows(_ url: URL?, navigationType: WKNavigationType, isMainFrame: Bool) -> Bool {
            // Only the initial `loadHTMLString` (about:blank) and in-page
            // fragment jumps are permitted. Links never open externally.
            guard isMainFrame, let url else { return false }
            if url.scheme == "about" { return navigationType == .other || navigationType == .linkActivated && url.fragment != nil }
            return false
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            let allowed = Self.allows(
                navigationAction.request.url,
                navigationType: navigationAction.navigationType,
                isMainFrame: navigationAction.targetFrame?.isMainFrame ?? false
            )
            decisionHandler(allowed ? .allow : .cancel)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? { nil }

        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}

// MARK: - Inspector panel

enum ChangesInspectorSource: Equatable {
    case saved(SessionDiffSelection)
    case preview(sessionID: String, diff: LiveTurnDiff)

    var identity: String {
        switch self {
        case .saved(let selection): return selection.sessionId + ":" + selection.diff.id
        case .preview(let session, let diff): return session + ":" + diff.turnID
        }
    }
    var counts: (files: Int, additions: Int?, deletions: Int?) {
        switch self {
        case .saved(let selection): return (selection.diff.fileCount, selection.diff.additions, selection.diff.deletions)
        case .preview(_, let diff):
            let counts = DiffLineCounts(patches: diff.repositories.map(\.patch))
            return (counts.files, counts.additions, counts.deletions)
        }
    }
}

extension ChatModel {
    var changesInspectorSource: ChangesInspectorSource? {
        if let diff = inspectedCapturedDiff, let session = activeSessionId {
            return .preview(sessionID: session, diff: diff)
        }
        if showsLiveChanges, let diff = currentLiveDiff, let session = activeSessionId {
            return .preview(sessionID: session, diff: diff)
        }
        return inspectedSessionDiff.map(ChangesInspectorSource.saved)
    }
}

struct SessionDiffInspectorView: View {
    @ObservedObject var model: ChatModel
    let selection: SessionDiffSelection
    var body: some View { ChangesInspectorView(model: model, source: .saved(selection)) }
}

/// One stable native inspector for both updating and saved turn changes.
struct ChangesInspectorView: View {
    @ObservedObject var model: ChatModel
    let source: ChangesInspectorSource
    @StateObject private var inspector = SessionDiffInspectorModel()
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("sessionDiffInspectorLayout") private var layout: SessionDiffLayout = .unified
    @State private var disclosureCommand = 0
    @State private var documentIdentity = ""
    @State private var filter = ""
    private var theme: SessionDiffTheme { SessionDiffTheme(colorScheme) }

    var body: some View {
        VStack(spacing: 0) {
            ChangesDrawerHeader(files: source.counts.files, additions: source.counts.additions,
                deletions: source.counts.deletions, isUpdating: inspector.isUpdating,
                layout: $layout, filter: $filter, expand: { disclosureCommand = abs(disclosureCommand) + 1 },
                collapse: { disclosureCommand = -(abs(disclosureCommand) + 1) }, close: model.closeSessionDiff)
            Divider()
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            if let error = inspector.updateError {
                HStack {
                    Text(error).foregroundStyle(.secondary)
                    Spacer()
                    Button("Retry") { load(force: true) }.buttonStyle(.link)
                }.font(.caption).padding(10)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .onAppear { documentIdentity = source.identity; load() }
        .onChange(of: source) { old, next in
            // Completion changes the source but not what the reader was viewing.
            let completing: Bool
            if case .preview = old, case .saved(let selection) = next, model.currentChangeBlock?.sessionDiff?.id == selection.diff.id { completing = true } else { completing = false }
            if !completing, old.identity != next.identity { documentIdentity = next.identity; disclosureCommand = 0; filter = "" }
            load(preserveContent: completing)
        }
        .onChange(of: theme) { _, _ in load() }
        .onChange(of: layout) { _, _ in load() }
        .onDisappear { inspector.reset() }
    }

    private func load(force: Bool = false, preserveContent: Bool = false) {
        switch source {
        case .saved(let selection): inspector.load(selection, theme: theme, layout: layout, force: force, preserveContent: preserveContent)
        case .preview(let session, let diff): inspector.loadPreview(sessionId: session, diff: diff, theme: theme, layout: layout, force: force)
        }
    }

    @ViewBuilder private var content: some View {
        switch inspector.phase {
        case .idle, .loading:
            VStack(spacing: 12) { ProgressView().controlSize(.small); Text("Loading changes…").font(.callout).foregroundStyle(.secondary) }
        case .loaded(let html):
            SessionDiffWebView(html: html, identity: documentIdentity, disclosureCommand: disclosureCommand, filter: filter)
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load changes", systemImage: "doc.text.magnifyingglass")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { load(force: true) }.controlSize(.regular)
            }
        }
    }
}

struct ChangesDrawerHeader: View {
    let files: Int
    let additions: Int?
    let deletions: Int?
    let isUpdating: Bool
    @Binding var layout: SessionDiffLayout
    @Binding var filter: String
    let expand: () -> Void
    let collapse: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "doc.text")
                    .font(.system(size: 16)).foregroundStyle(Color.accentColor)
                    .frame(width: 30, height: 30)
                    .background(Color.accentColor.opacity(0.09), in: RoundedRectangle(cornerRadius: 7))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Changes").font(.system(size: 13, weight: .semibold))
                    ChangeCountsLabel(files: files, additions: additions, deletions: deletions)
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                if isUpdating { ProgressView().controlSize(.mini).help("Updating changes") }
                Button(action: close) { Image(systemName: "xmark").frame(width: 18, height: 18) }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
                    .help("Close changes (Esc)").accessibilityLabel("Close changes").keyboardShortcut(.cancelAction)
            }
            HStack(spacing: 8) {
                Picker("Diff layout", selection: $layout) {
                    Text("Unified").tag(SessionDiffLayout.unified)
                    Text("Side by Side").tag(SessionDiffLayout.split)
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 230)
                Spacer(minLength: 0)
                Menu {
                    Button("Expand All Files", systemImage: "arrow.up.and.down.text.horizontal", action: expand)
                    Button("Collapse All Files", systemImage: "list.bullet", action: collapse)
                } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help("File display options").accessibilityLabel("File display options")
            }
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.tertiary)
                TextField("Filter files", text: $filter).textFieldStyle(.plain)
                    .accessibilityLabel("Filter changed files")
                if !filter.isEmpty {
                    Button { filter = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                        .buttonStyle(.plain).help("Clear filter").accessibilityLabel("Clear file filter")
                }
            }.font(.system(size: 12)).padding(.horizontal, 8).padding(.vertical, 6)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
        }.padding(14)
        .background(.bar)
    }
}

// MARK: - Card shown before its final answer

struct SessionDiffCardView: View {
    let diff: SavedSessionDiff
    @ObservedObject private var model = ChatModel.shared
    var body: some View {
        TurnChangesCard(files: diff.fileCount, additions: diff.additions, deletions: diff.deletions,
            selected: model.inspectedSessionDiff?.diff.id == diff.id) { model.toggleSessionDiff(diff) }
    }
}

struct CapturedChangesCardView: View {
    let diff: LiveTurnDiff
    @ObservedObject private var model = ChatModel.shared
    private var counts: DiffLineCounts { DiffLineCounts(patches: diff.repositories.map(\.patch)) }
    var body: some View {
        TurnChangesCard(files: counts.files, additions: counts.additions, deletions: counts.deletions,
            selected: model.inspectedCapturedDiff?.turnID == diff.turnID) { model.inspectCapturedChanges(diff) }
    }
}

struct TurnChangesCard: View {
    let files: Int
    let additions: Int?
    let deletions: Int?
    let selected: Bool
    let action: () -> Void
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.system(size: 15, weight: .medium)).foregroundStyle(Color.accentColor)
                    .frame(width: 34, height: 34)
                    .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 5) {
                    Text("Changes").font(.system(size: 13, weight: .semibold))
                    ChangeCountsLabel(files: files, additions: additions, deletions: deletions)
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: selected ? "sidebar.right" : "chevron.right")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .padding(13).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor).opacity(hovered ? 1 : 0.65), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? Color.accentColor.opacity(0.6) : Color(nsColor: .separatorColor).opacity(0.5)))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain).onHover { hovered = $0 }
        .help("View changes from this turn")
        .accessibilityLabel("Changes from this turn, \(files) files")
    }
}

// MARK: - Placement

enum ChatSessionDiffPlacement {
    /// Cards that belong to the first final answer: those positioned before
    /// it, each keeping its own saved ID (never a "latest" substitute).
    static func cards(beforeFinalIn blocks: [ChatBlock]) -> [ChatBlock] {
        guard let finalIndex = blocks.firstIndex(where: { $0.kind == .finalAnswer }) else { return [] }
        var seen = Set<String>()
        return blocks[..<finalIndex].filter { block in
            guard block.kind == .sessionDiff, let diff = block.sessionDiff, diff.isEligibleForViewer, diff.fileCount > 0 else { return false }
            return seen.insert(diff.id).inserted
        }
    }
}
