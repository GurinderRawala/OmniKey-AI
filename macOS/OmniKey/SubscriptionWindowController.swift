import AppKit
import SwiftUI

final class SubscriptionWindowController: NSWindowController {

    private let manager = SubscriptionManager.shared

    convenience init() {
        let rootView = SubscriptionPaywallView(manager: SubscriptionManager.shared) {
            return
        }
        let hosting = NSHostingController(rootView: rootView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 360),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey – Subscription"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentViewController = hosting

        self.init(window: window)
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)

        guard let window = self.window else { return }
        NSApp.activate(ignoringOtherApps: true)
        window.level = .normal
        window.makeKeyAndOrderFront(nil)
    }

    private func dismissIfNeeded() {
        if let window = self.window {
            window.performClose(nil)
        }
    }
}
