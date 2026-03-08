import AppKit
import SwiftUI

/// NSWindowController hosting the ManualView that explains how to use OmniKey.
final class ManualWindowController: NSWindowController {
    convenience init() {
        let rootView = ManualView()
        let hostingController = NSHostingController(rootView: rootView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 620),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey – Manual"
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
