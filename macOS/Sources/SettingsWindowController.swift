import AppKit
import SwiftUI

/// Forwards Command-key shortcuts to first-responder NSTextViews so SwiftUI
/// text fields handle paste/copy/select-all even when the app does not show
/// a full menubar.
final class SettingsWindow: NSWindow {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.command),
               let chars = event.charactersIgnoringModifiers,
               let textView = firstResponder as? NSTextView {
                switch chars {
                case "v": textView.paste(nil);      return
                case "c": textView.copy(nil);       return
                case "x": textView.cut(nil);        return
                case "a": textView.selectAll(nil);  return
                case "z": textView.undoManager?.undo(); return
                case "Z": textView.undoManager?.redo(); return
                default: break
                }
            }
        }
        super.sendEvent(event)
    }
}

final class SettingsWindowController: NSWindowController {
    convenience init() {
        let rootView = SettingsView()
        let hostingController = NSHostingController(rootView: rootView)

        let window = SettingsWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey AI · Settings"
        window.minSize = NSSize(width: 920, height: 600)
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
