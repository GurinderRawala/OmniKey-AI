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

final class SkillsWindowController: NSWindowController {
    private var model: SkillsViewModel?

    convenience init() {
        let model = SkillsViewModel()
        let hostingController = NSHostingController(rootView: SkillsView(model: model))

        let window = SkillsWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey AI · Skills"
        window.minSize = NSSize(width: 860, height: 600)
        window.center()
        window.isReleasedWhenClosed = false
        window.contentViewController = hostingController

        self.init(window: window)
        self.model = model
    }

    override func showWindow(_ sender: Any?) {
        let wasVisible = window?.isVisible == true
        super.showWindow(sender)
        guard let window else { return }
        // Re-fetch on every (re)open so CLI or other-client edits show up;
        // never while an edit is in progress, so drafts are kept.
        if !wasVisible, let model, model.listState != .idle, model.editor == nil {
            model.refresh()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.level = .normal
        window.makeKeyAndOrderFront(nil)
    }
}
