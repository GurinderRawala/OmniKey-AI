import AppKit
import SwiftUI

final class AgentThinkingWindowController: NSWindowController {
    convenience init() {
        let rootView = AgentThinkingView(model: AgentThinkingModel.shared)
        let hostingController = NSHostingController(rootView: rootView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey – OmniAgent Session"
        window.minSize = NSSize(width: 800, height: 620)
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
