import AppKit
import Carbon
import Foundation
import ApplicationServices

// MARK: - Keyboard Monitor
final class KeyboardMonitor {
    static let shared = KeyboardMonitor()

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private let apiClient = APIClient()

    // "HERK"
    private let hotKeySignature: OSType = OSType(UInt32(bigEndian: 0x4845524B))
    private let hotKeyID: UInt32 = 1

    private let grammarFixHotKeySignature: OSType = OSType(UInt32(bigEndian: 0x47525846)) // "GRXF"
    private let grammarFixHotKeyID: UInt32 = 2

    private let customTaskHotKeySignature: OSType = OSType(UInt32(bigEndian: 0x4354534B)) // "CTSK"
    private let customTaskHotKeyID: UInt32 = 3

    private init() {}

    // Call this once at app startup (e.g. AppDelegate applicationDidFinishLaunching)
    func startMonitoring() {
        requestAccessibilityPermissions()

        installHotKeyHandler()
        registerHotKeys()

        print("🎧 Keyboard monitoring started (Carbon global hotkey Cmd+E, Cmd+G, and Cmd+T).")
    }

    func stopMonitoring() {
        if let hk = hotKeyRef {
            UnregisterEventHotKey(hk)
            hotKeyRef = nil
        }
        if let eh = eventHandlerRef {
            RemoveEventHandler(eh)
            eventHandlerRef = nil
        }
    }

    // MARK: - Carbon Hotkey Setup

    private func installHotKeyHandler() {
        // Listen for kEventHotKeyPressed
        var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                     eventKind: UInt32(kEventHotKeyPressed))

        // Install handler on the application event target
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, eventRef, _) -> OSStatus in
                guard let eventRef else { return OSStatus(eventNotHandledErr) }

                var hotKeyID = EventHotKeyID()
                let err = GetEventParameter(
                    eventRef,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotKeyID
                )

                guard err == noErr else { return err }

                // Route only our hotkey
                if hotKeyID.signature == KeyboardMonitor.shared.hotKeySignature &&
                    hotKeyID.id == KeyboardMonitor.shared.hotKeyID {

                    DispatchQueue.main.async {
                        KeyboardMonitor.shared.handleCommandE()
                    }
                    return noErr
                }

                if hotKeyID.signature == KeyboardMonitor.shared.grammarFixHotKeySignature &&
                    hotKeyID.id == KeyboardMonitor.shared.grammarFixHotKeyID {

                    DispatchQueue.main.async {
                        KeyboardMonitor.shared.handleCommandG()
                    }
                    return noErr
                }

                if hotKeyID.signature == KeyboardMonitor.shared.customTaskHotKeySignature &&
                    hotKeyID.id == KeyboardMonitor.shared.customTaskHotKeyID {

                    DispatchQueue.main.async {
                        KeyboardMonitor.shared.handleCommandT()
                    }
                    return noErr
                }

                return OSStatus(eventNotHandledErr)
            },
            1,
            &eventSpec,
            nil,
            &eventHandlerRef
        )

        if status != noErr {
            print("❌ Failed to install hotkey handler: \(status)")
        } else {
            print("✅ Hotkey handler installed")
        }
    }

    private func registerHotKeys() {
        // Cmd modifier
        let modifiers: UInt32 = UInt32(cmdKey)

        // Carbon virtual keycode for "E" is 14 on US keyboard layouts
        let enhancerKeyCode: UInt32 = 14

        var hkRef: EventHotKeyRef?
        let hkID = EventHotKeyID(signature: hotKeySignature, id: hotKeyID)

        let enhancePromptKeyStatus = RegisterEventHotKey(
            enhancerKeyCode,
            modifiers,
            hkID,
            GetApplicationEventTarget(),
            0,
            &hkRef
        )

        if enhancePromptKeyStatus == noErr {
            hotKeyRef = hkRef
            print("✅ Cmd+E hotkey registered")
        } else {
            print("❌ Failed to register Cmd+E hotkey: \(enhancePromptKeyStatus)")
        }

         // Carbon virtual keycode for "G" is 5 on US keyboard layouts
        // will be used to fix grammar only.
        let grammarFixKeyCode: UInt32 = 5

        var grammarFixHKRef: EventHotKeyRef?
        let grammarFixHkID = EventHotKeyID(signature: grammarFixHotKeySignature, id: grammarFixHotKeyID)

        let grammarFixKeyStatus = RegisterEventHotKey(
            grammarFixKeyCode,
            modifiers,
            grammarFixHkID,
            GetApplicationEventTarget(),
            0,
            &grammarFixHKRef
        )

        if grammarFixKeyStatus == noErr {
            hotKeyRef = grammarFixHKRef
            print("✅ Cmd+G hotkey registered for grammar fix")
        } else {
            print("❌ Failed to register Cmd+G hotkey: \(grammarFixKeyStatus)")
        }
        // Carbon virtual keycode for "T" is 17 on US keyboard layouts
        // will be used for the custom task.
        let customTaskKeyCode: UInt32 = 17

        var customTaskHKRef: EventHotKeyRef?
        let customTaskHkID = EventHotKeyID(signature: customTaskHotKeySignature, id: customTaskHotKeyID)

        let customTaskKeyStatus = RegisterEventHotKey(
            customTaskKeyCode,
            modifiers,
            customTaskHkID,
            GetApplicationEventTarget(),
            0,
            &customTaskHKRef
        )

        if customTaskKeyStatus == noErr {
            hotKeyRef = customTaskHKRef
            print("✅ Cmd+T hotkey registered for custom task")
        } else {
            print("❌ Failed to register Cmd+T hotkey: \(customTaskKeyStatus)")
        }
    }

    private func execute(cmd: String) {
         // Make sure our app can show UI
        NSApp.activate(ignoringOtherApps: true)

        // First try Accessibility API to read globally selected text
        if let rawText = getGloballySelectedText() {
            let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                print("[PromptEnhancer] AX captured text (length: \(trimmed.count)):\n\(trimmed)")
                proceedWithSelectedText(trimmed, cmd: cmd)
                return
            } else {
                print("[PromptEnhancer] AX selected text is empty; falling back to clipboard.")
            }
        } else {
            print("[PromptEnhancer] AX selected text is nil; falling back to clipboard.")
        }

        // Fallback: use Cmd+C + pasteboard change detection
        copySelectedTextUsingPasteboardFallback(cmd: cmd)
    }

    private func handleCommandG() {
        execute(cmd: "G")
    }

    // MARK: - Hotkey Action

    private func handleCommandE() {
        execute(cmd: "E")
    }

    private func handleCommandT() {
        execute(cmd: "T")
    }

    /// Common flow once we have a non-empty selected text.
    private func proceedWithSelectedText(_ text: String, cmd: String) {
        if cmd == "E" {
        showAlert(
            title: "Enhancing Prompt",
            message: "Enhancing your selected text..."
        )
        } else if cmd == "G" {
            showAlert(
                title: "Fixing Grammar",
                message: "Fixing grammar of your selected text..."
            )
        } else if cmd == "T" {
            showAlert(
                title: "Performing Custom Task",
                message: "Processing your selected text..."
            )
        }

        sendToAPI(text: text, cmd: cmd)
    }

    /// Fallback approach: simulate Cmd+C in the frontmost app and read
    /// the updated pasteboard contents only if the changeCount changed.
    private func copySelectedTextUsingPasteboardFallback(cmd: String) {
        let pasteboard = NSPasteboard.general
        let initialChangeCount = pasteboard.changeCount

        // Copy selected text: Cmd+C in the frontmost app
        simulateKeyCombination(carbonKeyCode: CGKeyCode(8), flags: .maskCommand) // "C" is 8

        // Wait briefly for pasteboard to update
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }

            let currentPasteboard = NSPasteboard.general
            let newChangeCount = currentPasteboard.changeCount
            print("[PromptEnhancer] Pasteboard changeCount: initial=\(initialChangeCount), current=\(newChangeCount)")

            // If the pasteboard did not change, no new copy happened
            if newChangeCount == initialChangeCount {
                self.showAlert(
                    title: "No Text Selected",
                    message: "There is no text selected. Please select some text and try again."
                )
                print("[PromptEnhancer] Cmd+\(cmd) pressed but pasteboard did not change (no copy).")
                return
            }

            let selectedText = PasteboardManager.shared.getSelectedTextFromPasteboard() ?? ""
            let trimmed = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                self.showAlert(
                    title: "No Text Selected",
                    message: "There is no text selected. Please select some text and try again."
                )
                print("[PromptEnhancer] Cmd+\(cmd) pressed but copied text is empty.")
                return
            }

            print("[PromptEnhancer] Clipboard captured text (length: \(trimmed.count)):\n\(trimmed)")
            self.proceedWithSelectedText(trimmed, cmd: cmd)
        }
    }

    /// Use the Accessibility API to retrieve the currently selected text
    /// from the focused UI element in the active application.
    private func getGloballySelectedText() -> String? {
        let systemWideElement = AXUIElementCreateSystemWide()

        var focusedValue: CFTypeRef?
        let focusedError = AXUIElementCopyAttributeValue(
            systemWideElement,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        )

        guard focusedError == .success, let focusedValue else {
            print("[PromptEnhancer] Failed to get focused AX element: \(focusedError.rawValue)")
            return nil
        }

        let focusedElement = focusedValue as! AXUIElement

        var selectedValue: AnyObject?
        let selectedError = AXUIElementCopyAttributeValue(
            focusedElement,
            kAXSelectedTextAttribute as CFString,
            &selectedValue
        )

        guard selectedError == .success, let selectedText = selectedValue as? String else {
            print("[PromptEnhancer] Failed to get selected text: \(selectedError.rawValue)")
            return nil
        }

        return selectedText
    }

    private func sendToAPI(text: String, cmd: String) {
        let original = normalizeOriginalText(text)
        print("[PromptEnhancer] Normalized text to send (length: \(original.count)).")

        apiClient.enhance(original, cmd: cmd) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }

                switch result {
                case .success(let enhancedText):
                    self.showAlert(title: "Success", message: "Text enhanced!")
                    self.replaceSelectedText(with: enhancedText)

                case .failure(let error):
                    self.showAlert(title: "Error", message: "Failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// send the underlying original text to the backend.
    private func normalizeOriginalText(_ text: String) -> String {
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func replaceSelectedText(with text: String) {
        // Put enhanced text onto pasteboard
        PasteboardManager.shared.setPasteboardText(text)

        // Paste: Cmd+V
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.simulateKeyCombination(carbonKeyCode: CGKeyCode(9), flags: .maskCommand) // "V" is 9
        }
    }

    // MARK: - UI

    private func showAlert(title: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)

        guard let screen = NSScreen.main else { return }

        let width: CGFloat = 360
        let height: CGFloat = 90
        let x = (screen.visibleFrame.midX - width / 2)
        let y = screen.visibleFrame.maxY - height - 60
        let frame = NSRect(x: x, y: y, width: width, height: height)

        let window = NSWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )

        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .statusBar
        window.ignoresMouseEvents = true
        window.hasShadow = true

        let contentView = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        contentView.wantsLayer = true
        contentView.layer?.cornerRadius = 12
        contentView.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.85).cgColor

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .boldSystemFont(ofSize: 15)
        titleLabel.textColor = .white
        titleLabel.alignment = .center
        titleLabel.frame = NSRect(x: 16, y: height - 32, width: width - 32, height: 20)

        let messageLabel = NSTextField(labelWithString: message)
        messageLabel.font = .systemFont(ofSize: 13)
        messageLabel.textColor = .white
        messageLabel.alignment = .center
        messageLabel.lineBreakMode = .byWordWrapping
        messageLabel.maximumNumberOfLines = 2
        messageLabel.frame = NSRect(x: 16, y: 16, width: width - 32, height: 36)

        contentView.addSubview(titleLabel)
        contentView.addSubview(messageLabel)

        window.contentView = contentView
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            window.animator().alphaValue = 1
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.7) {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.25
                window.animator().alphaValue = 0
            }, completionHandler: {
                window.orderOut(nil)
            })
        }
    }

    // MARK: - Key Simulation (requires Accessibility permission)

    private func simulateKeyCombination(carbonKeyCode: CGKeyCode, flags: CGEventFlags) {
        let trusted = AXIsProcessTrusted()
        print("ℹ️ AXIsProcessTrusted() = \(trusted)")

        guard let source = CGEventSource(stateID: .hidSystemState) else {
            print("[PromptEnhancer] Failed to create CGEventSource.")
            return
        }

        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: carbonKeyCode, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: carbonKeyCode, keyDown: false) else {
            print("[PromptEnhancer] Failed to create CGEvent for key down/up.")
            return
        }

        keyDown.flags = flags
        keyUp.flags = flags

        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }

    // MARK: - Accessibility Permissions

    private func requestAccessibilityPermissions() {
        let exePath = CommandLine.arguments.first ?? "<unknown>"
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)

        print("ℹ️ Executable path: \(exePath)")

        if trusted {
            print("✅ Accessibility permissions granted")
        } else {
            print("⚠️ Accessibility permissions NOT granted yet. Enable it in System Settings → Privacy & Security → Accessibility.")
        }
    }
}
