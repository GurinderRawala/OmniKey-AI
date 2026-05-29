import AppKit
import SwiftUI

/// Custom window that forwards common Command-key shortcuts to the
/// first responder so that SwiftUI text inputs (backed by NSTextView)
/// correctly handle paste/undo/select-all even without a full menubar.
/// Shortcuts are only forwarded when an NSTextView is the active first
/// responder — no fallback scan is performed to avoid accidentally
/// routing to unrelated fields.
final class MCPServersWindow: NSWindow {
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

final class MCPServersWindowController: NSWindowController {
    convenience init() {
        let rootView = MCPServersView()
        let hostingController = NSHostingController(rootView: rootView)

        let window = MCPServersWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 738),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey AI · MCP Servers"
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
