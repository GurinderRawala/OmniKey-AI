import AppKit
@preconcurrency import ApplicationServices
import Carbon
import Foundation

// MARK: - Keyboard Monitor

@MainActor
final class KeyboardMonitor {
    static let shared = KeyboardMonitor()

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private let apiClient = APIClient()
    private var inProgressAlertTimer: Timer?
    private let inProgressAlertInterval: TimeInterval = 10.0
    private var elapsedTimer: Timer?
    private let logPrefix = "[omnikeyai]"

    // Remember the original app and selection so we can paste
    // the result back into the correct place even if the user
    // switches windows while the request is in flight.
    private var originalApp: NSRunningApplication?
    private var originalAXElement: AXUIElement?
    private var originalSelectedTextRange: CFTypeRef?

    // "HERK"
    private let hotKeySignature: OSType = .init(UInt32(bigEndian: 0x4845_524B))
    private let hotKeyID: UInt32 = 1

    private let grammarFixHotKeySignature: OSType = .init(UInt32(bigEndian: 0x4752_5846)) // "GRXF"
    private let grammarFixHotKeyID: UInt32 = 2

    private let customTaskHotKeySignature: OSType = .init(UInt32(bigEndian: 0x4354_534B)) // "CTSK"
    private let customTaskHotKeyID: UInt32 = 3

    private var originalSelectedText = ""

    private var persistentResultWindow: NSWindow?
    private var agentCommandStartTime: Date?
    private let agentAutoPassthroughThreshold: TimeInterval = 10.0

    private init() {}

    /// Call this once at app startup (e.g. AppDelegate applicationDidFinishLaunching)
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
            { _, eventRef, _ -> OSStatus in
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
                if hotKeyID.signature == KeyboardMonitor.shared.hotKeySignature,
                   hotKeyID.id == KeyboardMonitor.shared.hotKeyID
                {
                    DispatchQueue.main.async {
                        KeyboardMonitor.shared.handleCommandE()
                    }
                    return noErr
                }

                if hotKeyID.signature == KeyboardMonitor.shared.grammarFixHotKeySignature,
                   hotKeyID.id == KeyboardMonitor.shared.grammarFixHotKeyID
                {
                    DispatchQueue.main.async {
                        KeyboardMonitor.shared.handleCommandG()
                    }
                    return noErr
                }

                if hotKeyID.signature == KeyboardMonitor.shared.customTaskHotKeySignature,
                   hotKeyID.id == KeyboardMonitor.shared.customTaskHotKeyID
                {
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
        let modifiers = UInt32(cmdKey)

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

    @MainActor private func execute(cmd: String) {
        // Capture the current frontmost app and its focused
        // text selection before we start any work, so we can
        // restore focus and paste the result back there later.
        captureOriginalContext()

        // First try Accessibility API to read globally selected text
        if let rawText = getGloballySelectedText() {
            let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                print("\(logPrefix) AX captured text (length: \(trimmed.count)):\n\(trimmed)")
                proceedWithSelectedText(trimmed, cmd: cmd)
                return
            } else {
                print("\(logPrefix) AX selected text is empty; falling back to clipboard.")
            }
        } else {
            print("\(logPrefix) AX selected text is nil; falling back to clipboard.")
        }

        // Fallback: use Cmd+C + pasteboard change detection
        copySelectedTextUsingPasteboardFallback(cmd: cmd)
    }

    @MainActor private func handleCommandG() {
        execute(cmd: "G")
    }

    // MARK: - Hotkey Action

    @MainActor private func handleCommandE() {
        execute(cmd: "E")
    }

    @MainActor private func handleCommandT() {
        execute(cmd: "T")
    }

    private func handleInProgressAlert(cmd: String) {
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
    }

    /// Common flow once we have a non-empty selected text.
    private func proceedWithSelectedText(_ text: String, cmd: String) {
        originalSelectedText = text

        // For Cmd+T with an @omniAgent directive, route through the
        // agent without showing the "Performing Custom Task" alerts.
        if cmd == "T", AgentRunner.shared.containsAgentDirective(text) {
            sendToAgent(text: text)
            return
        }

        // For all other flows, show periodic in-progress alerts.
        startInProgressAlerts(for: cmd)
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
            print("\(logPrefix) Pasteboard changeCount: initial=\(initialChangeCount), current=\(newChangeCount)")

            // If the pasteboard did not change, no new copy happened
            if newChangeCount == initialChangeCount {
                self.showAlert(
                    title: "No Text Selected",
                    message: "There is no text selected. Please select some text and try again."
                )
                print("\(logPrefix) Cmd+\(cmd) pressed but pasteboard did not change (no copy).")
                return
            }

            let selectedText = PasteboardManager.shared.getSelectedTextFromPasteboard() ?? ""
            let trimmed = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                self.showAlert(
                    title: "No Text Selected",
                    message: "There is no text selected. Please select some text and try again."
                )
                print("\(logPrefix) Cmd+\(cmd) pressed but copied text is empty.")
                return
            }

            print("\(logPrefix) Clipboard captured text (length: \(trimmed.count)):\n\(trimmed)")
            self.proceedWithSelectedText(trimmed, cmd: cmd)
        }
    }

    /// Use the Accessibility API to retrieve the currently selected text
    /// from the focused UI element in the active application.
    private func getGloballySelectedText() -> String? {
        // If OmniKey itself is active and the key window has a text view
        // as first responder (e.g. the Task Instructions TextEditor),
        // read the selection directly from that NSTextView.
        if NSApp.isActive, let textView = NSApp.keyWindow?.firstResponder as? NSTextView {
            let range = textView.selectedRange()
            if range.length > 0 {
                let full = textView.string as NSString
                let selectedText = full.substring(with: range)
                print("\(logPrefix) Local NSTextView selected text (length: \(selectedText.count))")
                return selectedText
            }
        }

        // Finally, fall back to the system-wide focused element.
        let systemWideElement = AXUIElementCreateSystemWide()

        var focusedValue: CFTypeRef?
        let focusedError = AXUIElementCopyAttributeValue(
            systemWideElement,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        )

        guard focusedError == .success, let focusedValue else {
            print("\(logPrefix) Failed to get focused AX element: \(focusedError.rawValue)")
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
            print("\(logPrefix) Failed to get selected text: \(selectedError.rawValue)")
            return nil
        }

        return selectedText
    }

    private func sendToAPI(text: String, cmd: String) {
        let original = normalizeOriginalText(text)
        print("\(logPrefix) Normalized text to send (length: \(original.count)).")

        apiClient.enhance(original, cmd: cmd) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }

                self.stopInProgressAlerts()

                switch result {
                case let .success(enhancedText):
                    self.showAlert(title: "Success", message: "Text enhanced!")
                    let finalText = self.extractImprovedText(from: enhancedText)
                    self.replaceSelectedText(with: finalText)

                case let .failure(error):
                    let nsError = error as NSError

                    if cmd == "T",
                       nsError.domain == "APIClient",
                       nsError.code == 404
                    {
                        self.showAlert(
                            title: "No Task Template",
                            message: "No default task template is configured. Opening Task Instructions…"
                        )

                        AppDelegate.shared?.showTaskInstructionsWindow()
                    } else {
                        self.showAlert(title: "Error", message: "Failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    /// Route an @agent request through the websocket AgentService.
    private func sendToAgent(text: String) {
        let original = normalizeOriginalText(text)
        print("\(logPrefix) Normalized @agent text to send (length: \(original.count)).")

        // Open the thinking window so the session picker sheet (if needed)
        // has a surface to present from, and the user can watch progress.
        AppDelegate.shared?.agentSessionDidStart()

        // Reset and start the shared thinking model so the window is ready
        // to stream updates from the agent.
        AgentThinkingModel.shared.reset(with: "Request:\n\(original)")
        AgentThinkingModel.shared.isRunning = true
        agentCommandStartTime = Date()

        elapsedTimer?.invalidate()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            DispatchQueue.main.async {
                AgentThinkingModel.shared.elapsedSeconds += 1
            }
        }

        AgentRunner.shared.runAgentSession(
            originalText: original,
            completion: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }

                    self.elapsedTimer?.invalidate()
                    self.elapsedTimer = nil
                    AgentThinkingModel.shared.isRunning = false
                    AppDelegate.shared?.agentSessionDidEnd()
                    self.stopInProgressAlerts()

                    switch result {
                    case let .success(finalText):
                        let elapsed = self.agentCommandStartTime.map { Date().timeIntervalSince($0) } ?? 0
                        self.agentCommandStartTime = nil

                        if elapsed >= self.agentAutoPassthroughThreshold {
                            // Agent ran long enough that the user has likely moved on;
                            // copy the result and show a persistent alert instead of
                            // auto-pasting back into whatever is now focused.
                            PasteboardManager.shared.setPasteboardText(finalText)
                            self.showPersistentResultReadyAlert()
                        } else {
                            self.showAlert(title: "Agent Complete", message: "Command finished.")
                            self.replaceSelectedText(with: finalText)
                        }

                    case let .failure(error):
                        let nsError = error as NSError
                        if nsError.domain == "AgentRunner", nsError.code == -9999 {
                            // User cancelled the agent run; do not show an error.
                            return
                        }

                        self.showAlert(title: "Agent Error", message: error.localizedDescription)
                    }
                }
            }
        )
    }

    /// send the underlying original text to the backend.
    private func normalizeOriginalText(_ text: String) -> String {
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func replaceSelectedText(with text: String) {
        // If OmniKey's own window (e.g. Task Instructions) is active and
        // the first responder is a text view, replace the selection
        // directly instead of going through the pasteboard.
        if NSApp.isActive, let textView = NSApp.keyWindow?.firstResponder as? NSTextView {
            let range = textView.selectedRange()
            let full = textView.string as NSString
            let replacement = text

            if let undoManager = textView.undoManager {
                let oldString = textView.string
                undoManager.registerUndo(withTarget: textView) { target in
                    target.string = oldString
                }
                undoManager.setActionName("OmniKey Enhancement")
            }

            let newString = full.replacingCharacters(in: range, with: replacement)
            textView.string = newString
            // Move the insertion point to the end of the inserted text.
            let insertionLocation = range.location + (replacement as NSString).length
            textView.setSelectedRange(NSRange(location: insertionLocation, length: 0))
            return
        }

        // Otherwise, we are operating on another app. Try to
        // reactivate the original app and restore its selection
        // before pasting there. If that fails, fall back to just
        // copying the text to the clipboard and asking the user
        // to paste manually.
        pasteResultBackToOriginalContext(text)
    }

    // MARK: - Streaming helpers

    /// Starts periodic in-progress alerts while the enhancement
    /// request is running, and shows the first alert immediately.
    private func startInProgressAlerts(for cmd: String) {
        stopInProgressAlerts()

        // Show the initial in‑progress alert right away.
        handleInProgressAlert(cmd: cmd)

        let timer = Timer.scheduledTimer(withTimeInterval: inProgressAlertInterval, repeats: true) {
            [weak self] _ in
            self?.handleInProgressAlert(cmd: cmd)
        }

        inProgressAlertTimer = timer
    }

    /// Stops any ongoing in-progress alerts.
    private func stopInProgressAlerts() {
        inProgressAlertTimer?.invalidate()
        inProgressAlertTimer = nil
    }

    /// Extracts the improved text from the model response by
    /// removing optional <improved_text> wrapper tags, falling
    /// back to the raw response if no tags are present.
    private func extractImprovedText(from response: String) -> String {
        let trimmed = response.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let startRange = trimmed.range(of: "<improved_text>") else {
            return trimmed
        }

        guard let endRange = trimmed.range(of: "</improved_text>", range: startRange.upperBound ..< trimmed.endIndex) else {
            return trimmed
        }

        let inner = trimmed[startRange.upperBound ..< endRange.lowerBound]
        return inner.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - UI

    func showAlert(title: String, message: String) {
        // Choose the screen under the current mouse cursor so the
        // HUD appears on the display the user is working on.
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { screen in
            NSMouseInRect(mouseLocation, screen.frame, false)
        } ?? NSScreen.main

        guard let targetScreen = screen else { return }

        let width: CGFloat = 360
        let height: CGFloat = 90
        let x = (targetScreen.visibleFrame.midX - width / 2)
        let y = targetScreen.visibleFrame.maxY - height - 60
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
        window.collectionBehavior = [.canJoinAllSpaces, .transient]

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
        // We deliberately avoid making this window key so we don't
        // steal focus from the frontmost app.
        window.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.20
            window.animator().alphaValue = 1
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.7) {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                window.animator().alphaValue = 0
            } completionHandler: {
                window.orderOut(nil)
            }
        }
    }

    // MARK: - Key Simulation (requires Accessibility permission)

    private func simulateKeyCombination(carbonKeyCode: CGKeyCode, flags: CGEventFlags) {
        let trusted = AXIsProcessTrusted()
        print("ℹ️ AXIsProcessTrusted() = \(trusted)")

        guard let source = CGEventSource(stateID: .hidSystemState) else {
            print("\(logPrefix) Failed to create CGEventSource.")
            return
        }

        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: carbonKeyCode, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: carbonKeyCode, keyDown: false)
        else {
            print("\(logPrefix) Failed to create CGEvent for key down/up.")
            return
        }

        keyDown.flags = flags
        keyUp.flags = flags

        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }

    // MARK: - Accessibility Permissions

    @MainActor
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

    // MARK: - Original context capture & paste-back

    /// Capture the frontmost application's focused element and its
    /// selected text range so we can later restore focus and paste
    /// the enhanced text back into the same place.
    private func captureOriginalContext() {
        // Clear any previous context first.
        originalApp = nil
        originalAXElement = nil
        originalSelectedTextRange = nil

        // If OmniKey itself is active (e.g. user is in our Task
        // Instructions window), we handle replacement directly in
        // the NSTextView and do not need AX-based paste-back.
        if NSApp.isActive {
            return
        }

        guard let frontmost = NSWorkspace.shared.frontmostApplication else {
            print("\(logPrefix) Unable to resolve frontmost app for selection context.")
            return
        }

        let appElement = AXUIElementCreateApplication(frontmost.processIdentifier)

        var focusedValue: CFTypeRef?
        let focusedError = AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        )

        guard focusedError == .success, let focusedValue else {
            print("\(logPrefix) Could not capture AX focused element for app \(frontmost.localizedName ?? "?"): \(focusedError.rawValue)")
            // We at least remember the app so we can reactivate it.
            originalApp = frontmost
            return
        }

        let focusedElement = focusedValue as! AXUIElement

        var rangeValue: CFTypeRef?
        let rangeError = AXUIElementCopyAttributeValue(
            focusedElement,
            kAXSelectedTextRangeAttribute as CFString,
            &rangeValue
        )

        originalApp = frontmost
        originalAXElement = focusedElement

        if rangeError == .success, let rangeValue {
            originalSelectedTextRange = rangeValue
        } else {
            originalSelectedTextRange = nil
            print("\(logPrefix) Could not capture AX selected range: \(rangeError.rawValue)")
        }
    }

    /// Try to paste the enhanced text back into the original app
    /// and selection captured when the hotkey was pressed. If this
    /// is not possible (e.g. the window closed or AX is not fully
    /// available), we fall back to copying the text and showing a
    /// notification so the user can paste manually.
    private func pasteResultBackToOriginalContext(_ text: String) {
        // Always ensure the result is on the clipboard.
        PasteboardManager.shared.setPasteboardText(text)

        guard let originalApp else {
            // We don't know where the request originated from;
            // keep the text on the clipboard and instruct the
            // user to paste wherever they need it.
            showPersistentResultReadyAlert()
            return
        }

        // Try to bring the original app back to the front so
        // Cmd+V targets the same window/field as when the user
        // first invoked OmniKey, but only if it's not already
        // the frontmost application.
        let didActivate: Bool
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != originalApp.processIdentifier {
            originalApp.activate(options: [.activateIgnoringOtherApps])
            didActivate = true
        } else {
            didActivate = false
        }

        let performPasteBack: () -> Void = { [weak self, originalApp] in
            guard let self else { return }

            // Best-effort: if we captured a selection range,
            // try to restore it. Even if this fails, we still
            // go ahead and paste, because the original selection
            // is still active.
            if let range = self.originalSelectedTextRange {
                let element = self.originalAXElement ?? AXUIElementCreateApplication(originalApp.processIdentifier)
                let setResult = AXUIElementSetAttributeValue(
                    element,
                    kAXSelectedTextRangeAttribute as CFString,
                    range
                )

                if setResult != .success {
                    print("\(self.logPrefix) Failed to restore AX selected range: \(setResult.rawValue)")
                }
            }

            // With focus on the same element, simulated Cmd+V
            // should replace the existing selection or insert at
            // the current caret position.
            self.simulateKeyCombination(carbonKeyCode: CGKeyCode(9), flags: .maskCommand) // "V" is 9

            // Clear context after we've attempted paste-back.
            self.originalApp = nil
            self.originalAXElement = nil
            self.originalSelectedTextRange = nil
            self.originalSelectedText = ""
        }

        if didActivate {
            // Give macOS a brief moment to bring the original
            // app and its window back to the front before we
            // attempt to restore the selection and paste.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: performPasteBack)
        } else {
            // App is already frontmost; we can paste back
            // immediately without any delay.
            performPasteBack()
        }
    }

    /// Show a small persistent top-right notification that stays visible
    /// until the user explicitly closes it.
    private func showPersistentResultReadyAlert() {
        if let window = persistentResultWindow {
            window.orderFrontRegardless()
            return
        }

        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { candidate in
            NSMouseInRect(mouseLocation, candidate.frame, false)
        } ?? NSScreen.main ?? NSScreen.screens.first

        guard let screen else { return }

        let isDarkMode = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let palette = persistentAlertPalette(isDarkMode: isDarkMode)

        let width: CGFloat = 260
        let height: CGFloat = 68
        let radius: CGFloat = 14
        let margin: CGFloat = 16
        let x = screen.visibleFrame.maxX - width - margin
        let y = screen.visibleFrame.maxY - height - margin

        let window = NSWindow(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .statusBar
        window.ignoresMouseEvents = false
        window.hasShadow = true
        window.animationBehavior = .alertPanel
        window.collectionBehavior = [.canJoinAllSpaces, .transient]

        // behindWindow blending composites with actual screen content — fixes the
        // washed-out rendering in light mode that .withinWindow caused on a clear window.
        let root = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        root.material = isDarkMode ? .hudWindow : .popover
        root.blendingMode = .behindWindow
        root.state = .active
        root.wantsLayer = true
        root.layer?.cornerRadius = radius
        root.layer?.masksToBounds = true
        root.layer?.borderWidth = 1
        root.layer?.borderColor = palette.border.cgColor

        // Add an explicit base surface tint so text remains readable on bright
        // wallpapers and translucent content in both appearance modes.
        let surfaceLayer = CALayer()
        surfaceLayer.frame = CGRect(x: 0, y: 0, width: width, height: height)
        surfaceLayer.backgroundColor = palette.surface.cgColor
        root.layer?.insertSublayer(surfaceLayer, at: 0)

        // Subtle accent gradient wash bleeding from the left edge
        let gradientLayer = CAGradientLayer()
        gradientLayer.frame = CGRect(x: 0, y: 0, width: width * 0.60, height: height)
        gradientLayer.startPoint = CGPoint(x: 0, y: 0.5)
        gradientLayer.endPoint = CGPoint(x: 1, y: 0.5)
        gradientLayer.colors = [
            palette.accent.withAlphaComponent(isDarkMode ? 0.13 : 0.08).cgColor,
            palette.accent.withAlphaComponent(0).cgColor,
        ]
        root.layer?.addSublayer(gradientLayer)

        // Circular icon badge
        let iconSize: CGFloat = 34
        let iconX: CGFloat = 14
        let iconY: CGFloat = (height - iconSize) / 2
        let iconBg = NSView(frame: NSRect(x: iconX, y: iconY, width: iconSize, height: iconSize))
        iconBg.wantsLayer = true
        iconBg.layer?.cornerRadius = iconSize / 2
        iconBg.layer?.backgroundColor = palette.iconBackground.cgColor

        let checkView = NSImageView(frame: NSRect(x: 0, y: 0, width: iconSize, height: iconSize))
        if let img = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil) {
            checkView.image = img.withSymbolConfiguration(
                NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
            )
        }
        checkView.contentTintColor = palette.accent
        checkView.imageScaling = .scaleNone
        iconBg.addSubview(checkView)

        // Labels — vertically centred as a block inside the toast.
        // attributedStringValue forces the color at the attributed-string level,
        // which is immune to NSVisualEffectView appearance overrides.
        let textX: CGFloat = iconX + iconSize + 10
        let textW: CGFloat = width - textX - 24

        let titleLabel = NSTextField()
        titleLabel.isEditable = false
        titleLabel.isSelectable = false
        titleLabel.isBezeled = false
        titleLabel.drawsBackground = false
        titleLabel.attributedStringValue = NSAttributedString(
            string: "Result Ready",
            attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                         .foregroundColor: palette.titleText]
        )
        titleLabel.frame = NSRect(x: textX, y: 34, width: textW, height: 15)

        let subtitleLabel = NSTextField()
        subtitleLabel.isEditable = false
        subtitleLabel.isSelectable = false
        subtitleLabel.isBezeled = false
        subtitleLabel.drawsBackground = false
        subtitleLabel.lineBreakMode = .byTruncatingTail
        subtitleLabel.maximumNumberOfLines = 1
        subtitleLabel.attributedStringValue = NSAttributedString(
            string: "Task complete · paste with ⌘V",
            attributes: [.font: NSFont.systemFont(ofSize: 10.5),
                         .foregroundColor: palette.messageText]
        )
        subtitleLabel.frame = NSRect(x: textX, y: 19, width: textW, height: 13)

        // Close button — xmark.circle.fill SF Symbol, no bezel, intentionally small
        let closeBtn = NSButton(frame: NSRect(x: width - 21, y: height - 21, width: 13, height: 13))
        closeBtn.title = ""
        closeBtn.isBordered = false
        if let xImg = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Dismiss") {
            closeBtn.image = xImg.withSymbolConfiguration(
                NSImage.SymbolConfiguration(pointSize: 10, weight: .regular)
            )
        }
        closeBtn.contentTintColor = palette.closeIcon
        closeBtn.setButtonType(.momentaryPushIn)
        closeBtn.action = #selector(dismissPersistentResultReadyAlert)
        closeBtn.target = self

        root.addSubview(iconBg)
        root.addSubview(titleLabel)
        root.addSubview(subtitleLabel)
        root.addSubview(closeBtn)

        window.contentView = root
        window.alphaValue = 0
        window.setFrameOrigin(NSPoint(x: x, y: y + 12))
        window.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.25
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 1
            window.animator().setFrameOrigin(NSPoint(x: x, y: y))
        }

        persistentResultWindow = window
    }

    private func persistentAlertPalette(isDarkMode: Bool) -> (
        surface: NSColor,
        border: NSColor,
        titleText: NSColor,
        messageText: NSColor,
        accent: NSColor,
        iconBackground: NSColor,
        closeIcon: NSColor
    ) {
        if isDarkMode {
            let accent = NSColor(calibratedRed: 34 / 255, green: 211 / 255, blue: 238 / 255, alpha: 1)
            return (
                surface: NSColor(calibratedWhite: 0.10, alpha: 0.82),
                border: NSColor.white.withAlphaComponent(0.14),
                titleText: NSColor(white: 0.96, alpha: 1),
                messageText: NSColor(white: 0.78, alpha: 1),
                accent: accent,
                iconBackground: accent.withAlphaComponent(0.22),
                closeIcon: NSColor(white: 0.70, alpha: 1)
            )
        }

        let accent = NSColor(calibratedRed: 67 / 255, green: 56 / 255, blue: 202 / 255, alpha: 1)
        return (
            surface: NSColor(calibratedRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.90),
            border: NSColor.black.withAlphaComponent(0.12),
            titleText: NSColor(calibratedRed: 10 / 255, green: 15 / 255, blue: 31 / 255, alpha: 1),
            messageText: NSColor(calibratedRed: 30 / 255, green: 41 / 255, blue: 59 / 255, alpha: 0.96),
            accent: accent,
            iconBackground: accent.withAlphaComponent(0.14),
            closeIcon: NSColor(calibratedRed: 30 / 255, green: 41 / 255, blue: 59 / 255, alpha: 0.72)
        )
    }

    @objc private func dismissPersistentResultReadyAlert() {
        persistentResultWindow?.orderOut(nil)
        persistentResultWindow = nil
    }
}

// MARK: - Agent-specific UI helpers

extension KeyboardMonitor {
    /// Show a more detailed alert when an agent-triggered
    /// shell command fails.
    func showAgentCommandFailureAlert(command: String, output: String) {
        showAlert(
            title: "Command Failed",
            message: "The agent command failed. Check the output in your context and try again."
        )

        print("\(logPrefix) Agent command failed. Command:\n\(command)\nOutput:\n\(output)")
    }
}
