import AppKit
import SwiftUI

/// Forwards common Command-key editing shortcuts to a focused NSTextView so
/// the SwiftUI text inputs work without a full menu bar (same approach as
/// the MCP Servers window).
final class SkillsWindow: NSWindow {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.command),
               let chars = event.charactersIgnoringModifiers,
               let textView = firstResponder as? NSTextView {
                switch chars {
                case "v": textView.paste(nil); return
                case "c": textView.copy(nil); return
                case "x": textView.cut(nil); return
                case "a": textView.selectAll(nil); return
                case "z": textView.undoManager?.undo(); return
                case "Z": textView.undoManager?.redo(); return
                default: break
                }
            }
        }
        super.sendEvent(event)
    }
}

final class SkillsWindowController: NSWindowController, NSWindowDelegate {
    private var model: SkillsViewModel?
    private var isFittingWindow = false
    /// The backend + subscription this window's list, drafts and pending
    /// requests belong to. The app replaces the controller when it changes.
    private(set) var identity: SubscriptionIdentity?

    /// Whether a controller bound to `bound` may keep serving `current`.
    /// JWT refreshes keep the identity; key/backend changes or sign-out don't.
    static func canReuse(boundTo bound: SubscriptionIdentity?, for current: SubscriptionIdentity?) -> Bool {
        bound != nil && bound == current
    }

    convenience init(identity: SubscriptionIdentity?) {
        self.init(identity: identity, model: SkillsViewModel(service: APIClient.skills(for: identity)),
                  visibleFrame: NSScreen.main?.visibleFrame)
    }

    /// Injectable model/screen for offline layout tests; production uses the active display.
    convenience init(identity: SubscriptionIdentity?, model: SkillsViewModel, visibleFrame: NSRect?) {
        let hostingController = NSHostingController(rootView: SkillsView(model: model))
        // AppKit owns window size. SwiftUI content must not grow the window to
        // its intrinsic preferred size as lists, instructions or editors load.
        hostingController.sizingOptions = []

        let window = SkillsWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey AI · Skills"
        window.isReleasedWhenClosed = false
        window.contentViewController = hostingController
        // Attaching a hosting controller can replace the initial content size.
        window.setContentSize(NSSize(width: 960, height: 640))

        self.init(window: window)
        self.model = model
        self.identity = identity
        window.delegate = self
        if let visibleFrame {
            fitWindow(to: visibleFrame, center: true)
        } else {
            window.minSize = SkillsWindowSizing.preferredMinimumFrameSize
            window.center()
        }
    }

    /// The identity changed: stop the model before the window goes away.
    @MainActor
    func retire() {
        model?.retire()
    }

    override func showWindow(_ sender: Any?) {
        let wasVisible = window?.isVisible == true
        // A cached window may have been opened on a larger/disconnected display.
        fitWindowToCurrentScreen()
        super.showWindow(sender)
        guard let window else { return }
        fitWindowToCurrentScreen()
        // Re-fetch on every (re)open so CLI or other-client edits show up;
        // never while an edit is in progress, so drafts are kept.
        if !wasVisible, let model, model.listState != .idle, model.editor == nil {
            model.refresh()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.level = .normal
        window.makeKeyAndOrderFront(nil)
    }

    func windowDidChangeScreen(_ notification: Notification) {
        fitWindowToCurrentScreen(duringScreenChange: true)
    }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        fitWindowToCurrentScreen(duringScreenChange: true)
    }

    private func fitWindowToCurrentScreen(duringScreenChange: Bool = false) {
        guard let window else { return }
        // Ordered-out windows may not have a screen. Preserve their monitor
        // based on frame intersection instead of moving them to the main display.
        let screens = NSScreen.screens
        let index = SkillsWindowSizing.bestScreenIndex(for: window.frame, frames: screens.map(\.visibleFrame))
        guard let screen = index.map({ screens[$0] }) ?? window.screen ?? NSScreen.main else { return }
        fitWindow(to: screen.visibleFrame, duringScreenChange: duringScreenChange)
    }

    /// Clamp the outer frame, not just content: the title bar must fit too.
    func fitWindow(to visibleFrame: NSRect, center: Bool = false, duringScreenChange: Bool = false) {
        guard let window, !isFittingWindow, !window.styleMask.contains(.fullScreen) else { return }
        isFittingWindow = true
        defer { isFittingWindow = false }
        let available = center ? SkillsWindowSizing.availableFrame(in: visibleFrame) : visibleFrame
        window.minSize = NSSize(
            width: min(SkillsWindowSizing.preferredMinimumFrameSize.width, available.width),
            height: min(SkillsWindowSizing.preferredMinimumFrameSize.height, available.height)
        )
        let frame = SkillsWindowSizing.fittedFrame(window.frame, in: visibleFrame, center: center, duringScreenChange: duringScreenChange)
        if frame != window.frame { window.setFrame(frame, display: false, animate: false) }
    }
}

/// Pure frame geometry so scaled laptop and multi-monitor layouts are testable
/// without moving or opening the running application's windows.
enum SkillsWindowSizing {
    static let preferredMinimumFrameSize = NSSize(width: 720, height: 480)

    static func availableFrame(in visible: NSRect) -> NSRect {
        // visibleFrame already excludes the Dock/menu bar. Keep a small extra
        // margin without imposing a minimum larger than an unusually small screen.
        let margin = min(16, max(0, min(visible.width, visible.height) / 10))
        return visible.insetBy(dx: margin, dy: margin)
    }

    static func bestScreenIndex(for frame: NSRect, frames: [NSRect]) -> Int? {
        frames.indices.filter { frame.intersects(frames[$0]) }.max {
            let left = frame.intersection(frames[$0])
            let right = frame.intersection(frames[$1])
            return left.width * left.height < right.width * right.height
        }
    }

    static func fittedFrame(_ frame: NSRect, in visible: NSRect, center: Bool = false,
                            duringScreenChange: Bool = false) -> NSRect {
        let available = center ? availableFrame(in: visible) : visible
        // Do not snap a normally-sized window mid-drag or prevent straddling.
        if duringScreenChange && frame.width <= available.width && frame.height <= available.height {
            return frame
        }
        let size = NSSize(width: min(frame.width, available.width), height: min(frame.height, available.height))
        let origin = center
            ? NSPoint(x: available.midX - size.width / 2, y: available.midY - size.height / 2)
            : NSPoint(x: min(max(frame.minX, available.minX), available.maxX - size.width),
                      y: min(max(frame.minY, available.minY), available.maxY - size.height))
        return NSRect(origin: origin, size: size)
    }
}
