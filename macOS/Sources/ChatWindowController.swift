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

final class ChatWindowController: NSWindowController, NSWindowDelegate {
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
        // Decouple the SwiftUI content's intrinsic size from the AppKit window
        // size. Without this, SwiftUI keeps republishing a "preferred" content
        // size on every layout pass while the user drags the window between
        // displays (or from a large monitor to a smaller one). AppKit then
        // tries to honour both the window's minSize and the SwiftUI preferred
        // size, which on macOS 13/14/15 can spin the layout loop and hang the
        // UI until the window finally settles. The window owns its size; the
        // SwiftUI tree just fills whatever it's given.
        hostingController.sizingOptions = []

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

        window.delegate = self

        // Keep the sidebar in sync whenever focus returns to the chat window
        // (e.g. user Cmd-Tabs back, or clicks the window after working
        // elsewhere). Cheap GET that no-ops when unauthenticated.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWindowDidBecomeKey(_:)),
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
        // Dock-icon visibility is handled centrally in `AppDelegate` via
        // the global `NSWindow.didBecomeVisible` / `willClose` notifications,
        // so every OmniKey window — not just chat — adds the Dock icon
        // while it's on screen.
        NSApp.activate(ignoringOtherApps: true)
        window.level = .normal
        window.makeKeyAndOrderFront(nil)

        // Refresh sidebar data every time the chat window is opened — this
        // covers the case where the window was closed (or hidden) and then
        // re-shown via the menu bar item, which does NOT re-trigger
        // SwiftUI's `.onAppear` on the cached hosting view.
        refreshChatData()
    }

    @objc private func handleWindowDidBecomeKey(_: Notification) {
        refreshChatData()
    }

    // MARK: - NSWindowDelegate

    /// Snap the window back inside the new screen's visible frame whenever
    /// the user moves it between displays. Without this, dragging a 1320×888
    /// window from a large external monitor onto a 1280×800 built-in display
    /// (or unplugging the external entirely) can leave the window larger than
    /// the target screen — at which point AppKit's automatic clamp + SwiftUI's
    /// own preferred-size feedback fight each other and the app appears to
    /// hang for several seconds. Doing the clamp ourselves (synchronously,
    /// once) cuts that loop short.
    func windowDidChangeScreen(_: Notification) {
        clampWindowToScreen()
    }

    func windowDidChangeBackingProperties(_: Notification) {
        clampWindowToScreen()
    }

    private func clampWindowToScreen() {
        guard let window, let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        var frame = window.frame

        // Honour the window's minSize while clamping; if the screen is
        // narrower than minSize we still respect the screen edge so the
        // titlebar stays reachable.
        let maxWidth = max(window.minSize.width, visible.width)
        let maxHeight = max(window.minSize.height, visible.height)
        frame.size.width = min(frame.size.width, maxWidth)
        frame.size.height = min(frame.size.height, maxHeight)

        if frame.maxX > visible.maxX { frame.origin.x = visible.maxX - frame.size.width }
        if frame.minX < visible.minX { frame.origin.x = visible.minX }
        if frame.maxY > visible.maxY { frame.origin.y = visible.maxY - frame.size.height }
        if frame.minY < visible.minY { frame.origin.y = visible.minY }

        if frame != window.frame {
            window.setFrame(frame, display: true, animate: false)
        }
    }

    private func refreshChatData() {
        model.refreshSessions()
        model.fetchGroups()
    }
}
