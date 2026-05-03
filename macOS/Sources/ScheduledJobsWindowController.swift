import AppKit
import SwiftUI

/// Custom window that forwards common Command-key shortcuts to the
/// first responder so that SwiftUI text inputs (backed by NSTextView)
/// correctly handle paste/undo/select-all even without a full menubar.
final class ScheduledJobsWindow: NSWindow {
    private func firstTextView(in view: NSView) -> NSTextView? {
        if let tv = view as? NSTextView { return tv }
        for sub in view.subviews {
            if let tv = firstTextView(in: sub) { return tv }
        }
        return nil
    }

    override func sendEvent(_ event: NSEvent) {
        // Intercept Command-key shortcuts at the window level so they
        // still work when SwiftUI hosting views are first responder.
        if event.type == .keyDown {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.command), let chars = event.charactersIgnoringModifiers {
                let targetTextView: NSTextView?
                if let tv = firstResponder as? NSTextView {
                    targetTextView = tv
                } else if let contentView = contentView {
                    targetTextView = firstTextView(in: contentView)
                } else {
                    targetTextView = nil
                }

                if let textView = targetTextView {
                    switch chars {
                    case "v":
                        textView.paste(nil)
                        return
                    case "c":
                        textView.copy(nil)
                        return
                    case "x":
                        textView.cut(nil)
                        return
                    case "a":
                        textView.selectAll(nil)
                        return
                    case "z":
                        textView.undoManager?.undo()
                        return
                    case "Z":
                        textView.undoManager?.redo()
                        return
                    default:
                        break
                    }
                }
            }
        }

        super.sendEvent(event)
    }
}

final class ScheduledJobsWindowController: NSWindowController {
    convenience init() {
        let rootView = ScheduledJobsView()
        let hostingController = NSHostingController(rootView: rootView)

        let window = ScheduledJobsWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 738),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey – Scheduled Jobs"
        window.minSize = NSSize(width: 1080, height: 738)
        window.center()
        window.isReleasedWhenClosed = false
        window.contentViewController = hostingController

        self.init(window: window)
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)

        guard let window = window else { return }
        NSApp.activate(ignoringOtherApps: true)
        window.level = .normal
        window.makeKeyAndOrderFront(nil)
    }
}
