import AppKit
import SwiftUI

/// NSWindowController hosting the first-launch Terms & Conditions
/// acceptance screen. Blocks the rest of the launch flow (subscription
/// activation, manual, hotkey monitoring) until the user accepts. The
/// window's close button also terminates the app because using OmniKey
/// without accepting the terms is not a supported state.
final class TermsWindowController: NSWindowController, NSWindowDelegate {
    /// Invoked on the main queue once the user clicks "I Accept" — the
    /// controller has already persisted acceptance via
    /// `TermsAcceptance.recordAcceptance()` and closed the window.
    private let onAccept: () -> Void

    init(onAccept: @escaping () -> Void) {
        self.onAccept = onAccept

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 560),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey AI · Terms & Conditions"
        window.center()
        window.isReleasedWhenClosed = false
        window.level = .modalPanel

        super.init(window: window)

        let hosting = NSHostingController(rootView: TermsView { [weak self] in
            guard let self, let window = self.window else { return }
            window.orderOut(nil)
            self.onAccept()
        })
        window.contentViewController = hosting
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("TermsWindowController is not decodable from a coder")
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    // MARK: - NSWindowDelegate

    /// Closing the terms window without accepting is treated as "decline"
    /// — quit the app so it never runs in an unaccepted state.
    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === self.window else { return }
        if !TermsAcceptance.hasAcceptedCurrent {
            // Deferred so AppKit can finish tearing down the window before
            // the process exits.
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}
