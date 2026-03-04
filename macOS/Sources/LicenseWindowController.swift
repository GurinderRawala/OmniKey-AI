import AppKit
import SwiftUI

/// Custom window that forwards common Command-key shortcuts to the
/// first responder so that SwiftUI text fields can handle paste/copy
/// even without a full menubar.
final class LicenseWindow: NSWindow {
    private func firstTextResponder(in view: NSView) -> NSResponder? {
        if view is NSTextField || view is NSTextView { return view }
        for sub in view.subviews {
            if let r = firstTextResponder(in: sub) { return r }
        }
        return nil
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.command), let chars = event.charactersIgnoringModifiers {
                let target: NSResponder?
                if let first = firstResponder, first is NSTextField || first is NSTextView {
                    target = first
                } else if let contentView = contentView {
                    target = firstTextResponder(in: contentView)
                } else {
                    target = nil
                }

                if let textField = target as? NSTextField {
                    let editor = textField.currentEditor()
                    switch chars {
                    case "v":
                        editor?.paste(nil)
                        return
                    case "c":
                        editor?.copy(nil)
                        return
                    case "x":
                        editor?.cut(nil)
                        return
                    case "a":
                        editor?.selectAll(nil)
                        return
                    default:
                        break
                    }
                } else if let textView = target as? NSTextView {
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

/// NSWindowController hosting the LicenseView used to enter and
/// activate the subscription key.
final class LicenseWindowController: NSWindowController {
    convenience init() {
        let rootView = LicenseView()
        let hostingController = NSHostingController(rootView: rootView)

        let window = LicenseWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 240),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OmniKey – Activation"
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
