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
}

enum SessionDiffFetchError: LocalizedError, Equatable {
    case notSignedIn
    case invalidIdentifier
    case notFound
    case server(Int)
    case malformed
    case mismatchedSnapshot

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in to view saved changes."
        case .invalidIdentifier: return "This snapshot can't be opened."
        case .notFound: return "This snapshot is no longer available."
        case let .server(code): return "Couldn't load the snapshot (HTTP \(code))."
        case .malformed, .mismatchedSnapshot: return "The server returned an invalid snapshot."
        }
    }
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
struct SessionDiffHTTPFetcher: SessionDiffFetching {
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
        guard 200..<300 ~= http.statusCode else { throw SessionDiffFetchError.server(http.statusCode) }
        guard let body = try? JSONDecoder().decode(SessionDiffHTMLResponse.self, from: data) else {
            throw SessionDiffFetchError.malformed
        }
        guard body.id == diffId else { throw SessionDiffFetchError.mismatchedSnapshot }
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
            result.insert(contentsOf: metaTag, at: close.upperBound)
            return result
        }
        if let htmlTag = html.range(of: "<html", options: .caseInsensitive),
           let close = html.range(of: ">", range: htmlTag.upperBound..<html.endIndex)
        {
            var result = html
            result.insert(contentsOf: "<head>\(metaTag)</head>", at: close.upperBound)
            return result
        }
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">\(metaTag)</head><body>\(html)</body></html>"
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

    private let fetcher: any SessionDiffFetching
    private var task: Task<Void, Never>?
    private var generation = 0

    init(fetcher: any SessionDiffFetching = SessionDiffHTTPFetcher()) {
        self.fetcher = fetcher
    }

    static func key(_ selection: SessionDiffSelection, theme: SessionDiffTheme, layout: SessionDiffLayout = .unified) -> String {
        "\(selection.sessionId)\u{0}\(selection.diff.id)\u{0}\(theme.rawValue)\u{0}\(layout.rawValue)"
    }

    /// Loads exactly `selection.diff.id`. Any earlier in-flight fetch is
    /// cancelled and its late result discarded (stale identity guard).
    func load(_ selection: SessionDiffSelection, theme: SessionDiffTheme, layout: SessionDiffLayout = .unified, force: Bool = false) {
        let key = Self.key(selection, theme: theme, layout: layout)
        if !force, key == loadedKey, phase != .idle { return }
        task?.cancel()
        generation += 1
        let current = generation
        loadedKey = key
        phase = .loading
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
            self.phase = outcome
        }
    }

    func reset() {
        task?.cancel()
        task = nil
        generation += 1
        loadedKey = nil
        phase = .idle
    }
}

// MARK: - Web view

/// Non-persistent, script-free web view that only ever displays the string
/// it was given. Every navigation other than that initial load, every
/// popup and every external resource is refused.
struct SessionDiffWebView: NSViewRepresentable {
    let html: String

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
        context.coordinator.load(html, into: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.load(html, into: webView)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var loadedHTML: String?

        func load(_ html: String, into webView: WKWebView) {
            guard html != loadedHTML else { return }
            loadedHTML = html
            webView.loadHTMLString(html, baseURL: nil)
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

struct SessionDiffInspectorView: View {
    @ObservedObject var model: ChatModel
    let selection: SessionDiffSelection
    @StateObject private var inspector = SessionDiffInspectorModel()
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("sessionDiffInspectorLayout") private var layout: SessionDiffLayout = .unified

    // Always use the same effective system appearance as the rest of the app.
    private var theme: SessionDiffTheme { SessionDiffTheme(colorScheme) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(NordTheme.border(colorScheme)).frame(height: 1)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(NordTheme.editorBackground(colorScheme))
        .onAppear { inspector.load(selection, theme: theme, layout: layout) }
        .onChange(of: selection) { _, next in inspector.load(next, theme: theme, layout: layout) }
        .onChange(of: theme) { _, next in inspector.load(selection, theme: next, layout: layout) }
        .onChange(of: layout) { _, next in inspector.load(selection, theme: theme, layout: next) }
        .onDisappear { inspector.reset() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: selection.diff.scope == .commit || selection.diff.scope == .turn ? "point.3.connected.trianglepath.dotted" : "doc.text.magnifyingglass")
                .foregroundColor(NordTheme.accent(colorScheme))
            VStack(alignment: .leading, spacing: 1) {
                Text(selection.diff.headerTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Text(selection.diff.detailText)
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(selection.diff.detailText)
            }
            Spacer(minLength: 4)
            Picker("Diff layout", selection: $layout) {
                ForEach(SessionDiffLayout.allCases, id: \.self) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
            .help("Choose unified or side-by-side changes")
            .accessibilityLabel("Diff layout")
            Button {
                model.closeSessionDiff()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundColor(NordTheme.secondaryText(colorScheme))
            .help("Close changes")
            .accessibilityLabel("Close changes")
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
    }

    @ViewBuilder
    private var content: some View {
        switch inspector.phase {
        case .idle, .loading:
            ProgressView("Loading changes…")
                .controlSize(.small)
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        case let .loaded(html):
            SessionDiffWebView(html: html)
        case let .failed(message):
            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 20))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Text(message)
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .multilineTextAlignment(.center)
                Button("Retry") { inspector.load(selection, theme: theme, layout: layout, force: true) }
                    .controlSize(.small)
            }
            .padding(24)
        }
    }
}

// MARK: - Card shown before its final answer

struct SessionDiffCardView: View {
    let diff: SavedSessionDiff
    @ObservedObject private var model = ChatModel.shared
    @Environment(\.colorScheme) private var colorScheme

    private var isSelected: Bool { model.inspectedSessionDiff?.diff.id == diff.id }

    var body: some View {
        Button {
            model.toggleSessionDiff(diff)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: diff.scope == .commit || diff.scope == .turn ? "point.3.connected.trianglepath.dotted" : "plusminus.circle")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(NordTheme.accent(colorScheme))
                VStack(alignment: .leading, spacing: 2) {
                    Text(diff.buttonTitle)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Text(diff.detailText)
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: isSelected ? "sidebar.right" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(NordTheme.border(colorScheme).opacity(isSelected ? 0.55 : 0.25))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(isSelected ? NordTheme.accent(colorScheme).opacity(0.7) : NordTheme.border(colorScheme), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(diff.helpText)
        .accessibilityLabel("\(diff.buttonTitle). \(diff.detailText)")
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
            guard block.kind == .sessionDiff, let diff = block.sessionDiff, diff.hasSafeID else { return false }
            return seen.insert(diff.id).inserted
        }
    }
}
