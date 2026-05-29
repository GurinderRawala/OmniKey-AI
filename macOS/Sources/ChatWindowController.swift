import AppKit
import SwiftUI

/// Custom NSWindow subclass that forwards common Cmd-key shortcuts to the
/// active NSTextView — mirrors the pattern used by `MCPServersWindow` so that
/// paste/undo/copy work correctly inside the chat input even without a full
/// menu bar.
final class ChatWindow: NSWindow {
    private func firstTextView(in view: NSView) -> NSTextView? {
        if let tv = view as? NSTextView { return tv }
        for subview in view.subviews {
            if let tv = firstTextView(in: subview) { return tv }
        }
        return nil
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.command), let chars = event.charactersIgnoringModifiers {
                let targetTextView: NSTextView?
                if let tv = firstResponder as? NSTextView {
                    targetTextView = tv
                } else if let contentView {
                    targetTextView = firstTextView(in: contentView)
                } else {
                    targetTextView = nil
                }

                if let tv = targetTextView {
                    switch chars {
                    case "v": tv.paste(nil); return
                    case "c": tv.copy(nil); return
                    case "x": tv.cut(nil); return
                    case "a": tv.selectAll(nil); return
                    case "z": tv.undoManager?.undo(); return
                    case "Z": tv.undoManager?.redo(); return
                    default: break
                    }
                }
            }
        }
        super.sendEvent(event)
    }
}

final class ChatWindowController: NSWindowController {
    /// Strong reference to the chat model so we can re-fetch sessions whenever
    /// the chat window is shown or becomes key. `ChatView.onAppear` only fires
    /// the first time the SwiftUI hierarchy is mounted — subsequent reopens
    /// (window closed then shown again, or backgrounded then refocused) keep
    /// the same hosting controller alive, so we drive the refresh from AppKit.
    private let model: ChatModel

    convenience init() {
        self.init(model: ChatModel.shared)
    }

    init(model: ChatModel) {
        self.model = model
        let rootView = ChatView(model: model)
        let hostingController = NSHostingController(rootView: rootView)

        // ~20% larger than original 1100×740
        let window = ChatWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 888),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey AI · Chat"
        window.minSize = NSSize(width: 960, height: 660)
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.center()
        window.isReleasedWhenClosed = false
        window.contentViewController = hostingController

        super.init(window: window)

        // Keep the sidebar in sync whenever focus returns to the chat window
        // (e.g. user Cmd-Tabs back, or clicks the window after working
        // elsewhere). Cheap GET that no-ops when unauthenticated.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowDidBecomeKey(_:)),
            name: NSWindow.didBecomeKeyNotification,
            object: window
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        guard let window else { return }
        NSApp.activate(ignoringOtherApps: true)
        window.level = .normal
        window.makeKeyAndOrderFront(nil)

        // Refresh sidebar data every time the chat window is opened — this
        // covers the case where the window was closed (or hidden) and then
        // re-shown via the menu bar item, which does NOT re-trigger
        // SwiftUI's `.onAppear` on the cached hosting view.
        refreshChatData()
    }

    @objc private func windowDidBecomeKey(_ notification: Notification) {
        refreshChatData()
    }

    private func refreshChatData() {
        model.refreshSessions()
        model.fetchGroups()
    }
}
