import AppKit
import SwiftUI

/// A thin NSWindowController wrapper that hosts the SwiftUI task instructions UI.
final class TaskInstructionsWindowController: NSWindowController {

    convenience init() {
        let rootView = TaskInstructionsView()
        let hostingController = NSHostingController(rootView: rootView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
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
