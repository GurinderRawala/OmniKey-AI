import AppKit
import SwiftUI

/// Custom window that forwards common Command-key shortcuts to the
/// first responder so that SwiftUI's TextEditor (backed by NSTextView)
/// correctly handles paste/undo/select-all even without a full menubar.
final class TaskInstructionsWindow: NSWindow {

    private func firstTextView(in view: NSView) -> NSTextView? {
        if let tv = view as? NSTextView { return tv }
        for sub in view.subviews {
            if let tv = firstTextView(in: sub) { return tv }
        }
        return nil
    }

    override func sendEvent(_ event: NSEvent) {
        // Intercept Command-key shortcuts at the window level so they
        // work even when SwiftUI's hosting view is first responder.
        if event.type == .keyDown {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.command), let chars = event.charactersIgnoringModifiers {

                // Prefer the first responder if it's a text view, otherwise
                // search our view hierarchy for any NSTextView (the SwiftUI
                // TextEditor backing view).
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

/// A thin NSWindowController wrapper that hosts the SwiftUI task instructions UI.
final class TaskInstructionsWindowController: NSWindowController {

    convenience init() {
        let rootView = TaskInstructionsView()
        let hostingController = NSHostingController(rootView: rootView)

        let window = TaskInstructionsWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 560),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey – Task Instructions"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentViewController = hostingController

        self.init(window: window)
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)

        guard let window = self.window else { return }
        NSApp.activate(ignoringOtherApps: true)
        window.level = .normal
        window.makeKeyAndOrderFront(nil)
    }
}
