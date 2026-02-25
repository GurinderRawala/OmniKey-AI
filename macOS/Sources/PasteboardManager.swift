import Foundation
import AppKit

final class PasteboardManager {
    static let shared = PasteboardManager()

    // Primary helpers used by KeyboardMonitor
    func getSelectedTextFromPasteboard() -> String? {
        let pasteboard = NSPasteboard.general
        return pasteboard.string(forType: .string)
    }

    func setPasteboardText(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    // Backwards-compatible helpers (if you still use old names anywhere)
    func getSelectedText() -> String? {
        getSelectedTextFromPasteboard()
    }

    func setSelectedText(_ text: String) {
        setPasteboardText(text)
    }
}
