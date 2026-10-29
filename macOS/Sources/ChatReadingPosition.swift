import AppKit
import SwiftUI

struct ChatReadingPosition: Codable, Equatable {
    let anchorID: String
    let offset: Double
    var fallbackAnchorID: String? = nil
    var fallbackOffset: Double? = nil

    func origin(anchorTop: CGFloat, documentHeight: CGFloat, viewportHeight: CGFloat) -> CGFloat {
        min(max(0, anchorTop + offset), max(0, documentHeight - viewportHeight))
    }
}

struct ChatDraft: Codable, Equatable {
    var text = ""
    var location = 0
    var length = 0

    var selection: NSRange {
        let count = (text as NSString).length
        let start = min(max(0, location), count)
        return NSRange(location: start, length: min(max(0, length), count - start))
    }
}

@MainActor
final class ChatReadingStore {
    static let shared = ChatReadingStore()
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func position(for session: String) -> ChatReadingPosition? {
        decode(ChatReadingPosition.self, key: "chatReadingPosition.\(session)")
    }

    func save(_ position: ChatReadingPosition, for session: String) {
        guard self.position(for: session) != position else { return }
        defaults.set(try? JSONEncoder().encode(position), forKey: "chatReadingPosition.\(session)")
    }

    func draft(for session: String) -> ChatDraft {
        decode(ChatDraft.self, key: "chatDraft.\(session)") ?? ChatDraft()
    }

    func save(_ draft: ChatDraft, for session: String) {
        defaults.set(try? JSONEncoder().encode(draft), forKey: "chatDraft.\(session)")
    }

    private func decode<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

/// An AppKit marker avoids publishing geometry into SwiftUI during layout.
struct ChatReadingAnchor: NSViewRepresentable {
    let id: String
    func makeNSView(context: Context) -> ChatReadingAnchorView { ChatReadingAnchorView() }
    func updateNSView(_ view: ChatReadingAnchorView, context: Context) { view.anchorID = id }
}

final class ChatReadingAnchorView: NSView {
    var anchorID = ""
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Scrolls only for explicit navigation or to compensate for geometry changes
/// above the reading anchor. Never starts a SwiftUI scroll transaction.
@MainActor
struct ChatReadingViewport: NSViewRepresentable {
    let session: String
    let ready: Bool
    var revision: Int = 0
    let jumpRequest: Int
    let store: ChatReadingStore
    var onPosition: (Bool) -> Void
    var onMissingAnchor: () -> Bool

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        let coordinator = context.coordinator
        coordinator.configuration = self
        DispatchQueue.main.async { [weak view] in
            guard let view else { return }
            coordinator.attach(from: view)
        }
    }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.detach() }

    @MainActor
    final class Coordinator: NSObject {
        var configuration: ChatReadingViewport?
        private weak var scroll: NSScrollView?
        private var session: String?
        private var position: ChatReadingPosition?
        private var jumpRequest = 0
        private var restoring = false
        private var scheduled = false
        private var needsRestore = true
        private var observers: [NSObjectProtocol] = []

        func detach() {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers.removeAll()
            scroll = nil
            configuration = nil
        }

        func attach(from view: NSView) {
            var ancestor = view.superview
            while let candidate = ancestor, !(candidate is NSScrollView) { ancestor = candidate.superview }
            guard configuration != nil, let candidate = ancestor as? NSScrollView else { return }
            attach(to: candidate)
        }

        func attach(to candidate: NSScrollView) {
            guard let configuration, let document = candidate.documentView else { return }
            if scroll !== candidate {
                detach()
                self.configuration = configuration
                scroll = candidate
                candidate.contentView.postsBoundsChangedNotifications = true
                document.postsFrameChangedNotifications = true
                observe(NSView.boundsDidChangeNotification, object: candidate.contentView, layout: false)
                observe(NSView.frameDidChangeNotification, object: document, layout: true)
                observers.append(NotificationCenter.default.addObserver(
                    forName: NSScrollView.didLiveScrollNotification, object: candidate, queue: .main
                ) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, self.session == self.configuration?.session else { return }
                        // User intent wins even if a streaming layout reconciliation is queued.
                        self.needsRestore = false
                        self.capture()
                    }
                })
            }
            if session != configuration.session {
                session = configuration.session
                position = configuration.store.position(for: configuration.session)
                jumpRequest = configuration.jumpRequest
                needsRestore = true
            }
            if jumpRequest != configuration.jumpRequest {
                jumpRequest = configuration.jumpRequest
                position = nil
                needsRestore = false
                move(to: max(0, document.bounds.height - candidate.contentView.bounds.height))
                capture()
            } else {
                schedule()
            }
        }

        private func observe(_ name: Notification.Name, object: AnyObject, layout: Bool) {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) {
                [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, !self.restoring,
                          self.session == self.configuration?.session else { return }
                    if layout { self.schedule() }
                    else if !self.scheduled && !self.needsRestore { self.capture() }
                }
            })
        }

        private func schedule() {
            guard !scheduled else { return }
            scheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scheduled = false
                self.reconcile()
            }
        }

        private func anchors(in view: NSView) -> [(String, CGFloat)] {
            let own: [(String, CGFloat)]
            if let marker = view as? ChatReadingAnchorView, let document = scroll?.documentView {
                own = [(marker.anchorID, marker.convert(marker.bounds, to: document).minY)]
            } else { own = [] }
            return own + view.subviews.flatMap { anchors(in: $0) }
        }

        private func reconcile() {
            guard let configuration, configuration.ready, let scroll, let document = scroll.documentView else { return }
            if let position {
                if let anchor = anchors(in: document).first(where: { $0.0 == position.anchorID }) {
                    move(to: position.origin(anchorTop: anchor.1, documentHeight: document.bounds.height,
                                             viewportHeight: scroll.contentView.bounds.height))
                } else if let fallbackID = position.fallbackAnchorID,
                          let fallback = anchors(in: document).first(where: { $0.0 == fallbackID }) {
                    let saved = ChatReadingPosition(anchorID: fallbackID, offset: position.fallbackOffset ?? 0)
                    move(to: saved.origin(anchorTop: fallback.1, documentHeight: document.bounds.height,
                                          viewportHeight: scroll.contentView.bounds.height))
                } else if needsRestore {
                    // The saved anchor may be in an older history page. Keep it
                    // until hydration/pagination installs it rather than overwriting it.
                    if configuration.onMissingAnchor() { return }
                    // Deleted/expired anchors fall back to the available transcript.
                    self.position = nil
                }
            }
            if needsRestore && position == nil { move(to: 0) }
            needsRestore = false
            capture()
        }

        private func move(to y: CGFloat) {
            guard let scroll, abs(scroll.contentView.bounds.minY - y) > 0.5 else { return }
            restoring = true
            scroll.contentView.scroll(to: NSPoint(x: scroll.contentView.bounds.minX, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
            restoring = false
        }

        private func capture() {
            guard let configuration, configuration.ready, let scroll, let document = scroll.documentView else { return }
            let top = scroll.contentView.bounds.minY
            let markers = anchors(in: document).sorted { $0.1 < $1.1 }
            if let anchor = markers.last(where: { $0.1 <= top + 1 }) ?? markers.first {
                let message = markers.last(where: {
                    !$0.0.hasPrefix("step-") && !$0.0.hasPrefix("activity-") && $0.1 <= top + 1
                })
                position = ChatReadingPosition(anchorID: anchor.0, offset: top - anchor.1,
                                               fallbackAnchorID: message?.0,
                                               fallbackOffset: message.map { top - $0.1 })
                if let position { configuration.store.save(position, for: configuration.session) }
            }
            let below = document.bounds.maxY - scroll.contentView.bounds.maxY > 2
            // Leave the AppKit notification/layout stack before publishing UI state.
            DispatchQueue.main.async { [weak self] in
                guard self?.session == configuration.session else { return }
                configuration.onPosition(below)
            }
        }
    }
}

/// Restores selection without focusing the editor or scrolling its caret into view.
@MainActor
final class ChatDraftSelectionTracker: ObservableObject {
    private weak var textView: NSTextView?
    private var session: String?
    private var observers: [NSObjectProtocol] = []
    private var restoring = false

    func attach(_ textView: NSTextView, session: String) {
        guard self.textView !== textView || self.session != session else { return }
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        self.textView = textView
        self.session = session
        let draft = ChatReadingStore.shared.draft(for: session)
        DispatchQueue.main.async { [weak self, weak textView] in
            guard let self, let textView, self.session == session, textView.string == draft.text else { return }
            self.restoring = true
            textView.setSelectedRange(draft.selection)
            self.restoring = false
        }
        observers.append(NotificationCenter.default.addObserver(
            forName: NSTextView.didChangeSelectionNotification, object: textView, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.restoring, let view = self.textView,
                      view.window?.firstResponder === view, let session = self.session,
                      view.string == ChatReadingStore.shared.draft(for: session).text else { return }
                let range = view.selectedRange()
                ChatReadingStore.shared.save(
                    ChatDraft(text: view.string, location: range.location, length: range.length), for: session)
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: NSText.didBeginEditingNotification, object: textView, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let view = self.textView, let session = self.session else { return }
                let draft = ChatReadingStore.shared.draft(for: session)
                guard view.string == draft.text else { return }
                self.restoring = true
                view.setSelectedRange(draft.selection)
                self.restoring = false
            }
        })
    }

    func detach() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        textView = nil
        session = nil
    }
}
