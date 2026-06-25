import AppKit
import Sparkle

class AppDelegate: NSObject, NSApplicationDelegate, SPUUpdaterDelegate {
    var window: NSWindow?
    var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var taskInstructionsMenuItem: NSMenuItem?
    private var agentSessionMenuItem: NSMenuItem?
    private var manualMenuItem: NSMenuItem?
    private var licenseMenuItem: NSMenuItem?
    private var taskInstructionsWindowController: TaskInstructionsWindowController?
    private var agentThinkingWindowController: AgentThinkingWindowController?
    private var licenseWindowController: LicenseWindowController?
    private var manualWindowController: ManualWindowController?
    private var scheduledJobsWindowController: ScheduledJobsWindowController?
    private var scheduledJobsMenuItem: NSMenuItem?
    private var mcpServersWindowController: MCPServersWindowController?
    private var mcpServersMenuItem: NSMenuItem?
    private var settingsWindowController: SettingsWindowController?
    private var settingsMenuItem: NSMenuItem?
    private var chatWindowController: ChatWindowController?
    private var chatMenuItem: NSMenuItem?
    private var monitoringStarted = false
    private var dockUpdateScheduled = false
    private var isAuthorized = false

    private var updaterController: SPUStandardUpdaterController?

    private let manualShownUserDefaultsKey = "OmniKeyManualShown"

    weak static var shared: AppDelegate?

    func applicationDidFinishLaunching(_: Notification) {
        // Install the standard top-of-screen menu bar before *anything*
        // else. macOS only displays the strip when the app is `.regular`
        // and active, but installing it now means it's ready the moment
        // the user opens a window — including for native full-screen,
        // which depends on the app owning the menu bar to reveal the
        // title-bar (and traffic lights) on cursor-to-top.
        AppMainMenu.install()
        NSApp.setActivationPolicy(.accessory)
        setupMenuBar()

        // Set up Sparkle auto-updater; this will automatically
        // check the SUFeedURL specified in Info.plist.
        updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: nil
        )

        AppDelegate.shared = self

        // Observe every OmniKey window so we can show / hide the Dock
        // icon based on whether any user-facing window is on screen.
        // `nil` `object:` means "for any window in this process".
        // `NSWindow.didBecomeKey` fires reliably the first time any
        // OmniKey window comes on screen via `makeKeyAndOrderFront`,
        // and `NSWindow.willClose` fires when one goes away. Together
        // they cover every show/hide transition for the windows we
        // create. We also observe `NSWindow.didMiniaturize` and
        // `NSWindow.didDeminiaturize` so windows tucked into the Dock
        // don't keep the icon up — the Dock presence should reflect
        // *actually visible* windows, not just allocated ones.
        // We only need *two* signals to maintain Dock visibility:
        //   - `didBecomeKey` fires the first time any user-facing window
        //     comes on screen via `makeKeyAndOrderFront`.
        //   - `willClose` fires when one goes away.
        //
        // Notifications like `didMiniaturize` / `didBecomeMain` MUST NOT be
        // observed here: changing the activation policy while a zoom or
        // miniaturise animation is in flight tears the Dock tile out from
        // under AppKit's animator and the green / orange traffic-light
        // buttons stop responding ("once maximised I can no longer
        // minimise the chat window"). Letting miniaturised windows keep
        // the Dock icon present is also the standard macOS behaviour —
        // the user can still click the Dock tile to bring them back.
        let windowEvents: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification,
            NSWindow.willCloseNotification,
        ]
        for name in windowEvents {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(scheduleDockVisibilityUpdate),
                name: name,
                object: nil
            )
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSubscriptionUnauthorizedNotification),
            name: .subscriptionUnauthorized,
            object: nil
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSubscriptionExpiredNotification),
            name: .subscriptionExpired,
            object: nil
        )

        // Self-hosted: call /activate with an empty key to obtain a JWT
        // (the backend issues one without requiring a subscription key).
        // We still need the token for the agent WebSocket, so we cannot skip this.
        if APIClient.isSelfHosted {
            SubscriptionManager.shared.activateStoredKey { [weak self] _ in
                // Proceed regardless of outcome — the agent will retry on first use.
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.isAuthorized = true
                    self.updateAuthStatusUI()
                    self.startMonitoringIfNeeded()
                    self.showManualIfFirstTime()
                }
            }
        } else {
            // If we already have a stored subscription key, try to
            // activate it and start monitoring only when authorized.
            if SubscriptionManager.shared.hasStoredKey {
                SubscriptionManager.shared.activateStoredKey { [weak self] success in
                    DispatchQueue.main.async {
                        guard let self else { return }

                        if success {
                            self.isAuthorized = true
                            self.updateAuthStatusUI()
                            self.startMonitoringIfNeeded()
                            self.showManualIfFirstTime()
                        } else {
                            self.isAuthorized = false
                            self.updateAuthStatusUI()
                            self.showLicenseWindow()
                        }
                    }
                }
            } else {
                // No key stored yet: prompt the user immediately.
                isAuthorized = false
                updateAuthStatusUI()
                showLicenseWindow()
            }
        }
    }

    private func setupMenuBar() {
        // Create a status bar item
        let statusBar = NSStatusBar.system
        statusItem = statusBar.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem?.button {
            if let statusImage = NSImage(named: "StatusBarIcon") {
                statusImage.isTemplate = false
                button.image = statusImage
                button.imageScaling = .scaleProportionallyDown
                button.imagePosition = .imageOnly
            } else {
                button.title = "OK"
                button.font = NSFont.systemFont(ofSize: 12)
            }
        }

        // Create menu
        let menu = NSMenu()

        let statusMenuItem = NSMenuItem(title: "Status: Checking…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(NSMenuItem.separator())

        let chatItem = NSMenuItem(title: "Agent Chat", action: #selector(showChatWindowFromMenu), keyEquivalent: "")
        chatItem.target = self
        chatItem.isEnabled = true
        menu.addItem(chatItem)
        chatMenuItem = chatItem

        self.statusMenuItem = statusMenuItem
        let instructionsItem = NSMenuItem(title: "Task Instructions", action: #selector(showTaskInstructionsWindowFromMenu), keyEquivalent: "")
        instructionsItem.target = self
        instructionsItem.isEnabled = false
        menu.addItem(instructionsItem)
        taskInstructionsMenuItem = instructionsItem
        let agentItem = NSMenuItem(title: "OmniAgent Session", action: #selector(showAgentThinkingWindowFromMenu), keyEquivalent: "")
        agentItem.target = self
        agentItem.isEnabled = true
        menu.addItem(agentItem)
        agentSessionMenuItem = agentItem
        let scheduledJobsItem = NSMenuItem(title: "Scheduled Jobs", action: #selector(showScheduledJobsWindowFromMenu), keyEquivalent: "")
        scheduledJobsItem.target = self
        scheduledJobsItem.isEnabled = false
        menu.addItem(scheduledJobsItem)
        scheduledJobsMenuItem = scheduledJobsItem
        let mcpServersItem = NSMenuItem(title: "MCP Servers", action: #selector(showMCPServersWindowFromMenu), keyEquivalent: "")
        mcpServersItem.target = self
        mcpServersItem.isEnabled = false
        menu.addItem(mcpServersItem)
        mcpServersMenuItem = mcpServersItem
        let settingsItem = NSMenuItem(title: "Settings", action: #selector(showSettingsWindowFromMenu), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.isEnabled = true
        menu.addItem(settingsItem)
        settingsMenuItem = settingsItem
        let licenseItem = NSMenuItem(title: "Subscription", action: #selector(showLicenseWindowFromMenu), keyEquivalent: "")
        licenseItem.target = self
        // Hide the subscription menu item if self-hosted
        if APIClient.isSelfHosted {
            licenseItem.isHidden = true
        }
        menu.addItem(licenseItem)
        licenseMenuItem = licenseItem
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))

        // Attach the menu to the status bar item so clicking the
        // menu bar icon shows this menu.
        statusItem?.menu = menu
    }

    @objc private func checkForUpdatesFromMenu() {
        updaterController?.checkForUpdates(nil)
    }
    @objc func checkForUpdatesFromMainMenu() {
        updaterController?.checkForUpdates(nil)
    }

    @objc func showSettingsWindowFromMainMenu() {
        showSettingsWindow()
    }

    @objc func newChatFromMainMenu() {
        // The chat window owns the actual "start new chat" action via
        // ChatModel; opening (or focusing) the chat window first is the
        // safest cross-state entry point.
        showChatWindow()
        ChatModel.shared.startNewChat()
    }

    @objc func openHelpFromMainMenu() {
        // Reuse the existing manual window — it's what users get the
        // first time they launch and is the closest thing OmniKey has
        // to a help center today.
        if manualWindowController == nil {
            manualWindowController = ManualWindowController()
        }
        NSApp.activate(ignoringOtherApps: true)
        manualWindowController?.showWindow(nil)
    }


    /// Public hook so SwiftUI views (e.g. SettingsView) can trigger Sparkle.
    func checkForUpdates() {
        updaterController?.checkForUpdates(nil)
    }

    /// Returns true if a Sparkle updater session can currently be initiated.
    /// Sparkle returns false while an update is already in progress.
    func canCheckForUpdates() -> Bool {
        return updaterController?.updater.canCheckForUpdates ?? false
    }

    @objc private func showChatWindowFromMenu() {
        showChatWindow()
    }

    func showChatWindow() {
        if chatWindowController == nil {
            chatWindowController = ChatWindowController()
        }
        NSApp.activate(ignoringOtherApps: true)
        chatWindowController?.showWindow(nil)
    }

    @objc private func showTaskInstructionsWindowFromMenu() {
        showTaskInstructionsWindow()
    }

    func showTaskInstructionsWindow() {
        guard isAuthorized else {
            showLicenseWindow()
            return
        }

        if taskInstructionsWindowController == nil {
            taskInstructionsWindowController = TaskInstructionsWindowController()
        }

        NSApp.activate(ignoringOtherApps: true)
        taskInstructionsWindowController?.showWindow(nil)
    }

    @objc private func showScheduledJobsWindowFromMenu() {
        showScheduledJobsWindow()
    }

    func showScheduledJobsWindow() {
        guard isAuthorized else { showLicenseWindow(); return }
        if scheduledJobsWindowController == nil {
            scheduledJobsWindowController = ScheduledJobsWindowController()
        }
        NSApp.activate(ignoringOtherApps: true)
        scheduledJobsWindowController?.showWindow(nil)
    }

    @objc private func showMCPServersWindowFromMenu() {
        showMCPServersWindow()
    }

    func showMCPServersWindow() {
        guard isAuthorized else { showLicenseWindow(); return }
        if mcpServersWindowController == nil {
            mcpServersWindowController = MCPServersWindowController()
        }
        NSApp.activate(ignoringOtherApps: true)
        mcpServersWindowController?.showWindow(nil)
    }

    @objc private func showSettingsWindowFromMenu() {
        showSettingsWindow()
    }

    func showSettingsWindow() {
        if settingsWindowController == nil {
            settingsWindowController = SettingsWindowController()
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindowController?.showWindow(nil)
    }

    @objc private func showAgentThinkingWindowFromMenu() {
        showAgentThinkingWindow()
    }

    func showAgentThinkingWindow() {
        if agentThinkingWindowController == nil {
            agentThinkingWindowController = AgentThinkingWindowController()
        }

        NSApp.activate(ignoringOtherApps: true)
        agentThinkingWindowController?.showWindow(nil)
    }

    @objc private func showManualWindowFromMenu() {
        showManualWindow()
    }

    private func showManualWindow() {
        if manualWindowController == nil {
            manualWindowController = ManualWindowController()
        }

        NSApp.activate(ignoringOtherApps: true)
        manualWindowController?.showWindow(nil)
    }

    @objc private func showLicenseWindowFromMenu() {
        showLicenseWindow()
    }

    private func showLicenseWindow() {
        if licenseWindowController == nil {
            licenseWindowController = LicenseWindowController()
        }

        NSApp.activate(ignoringOtherApps: true)
        licenseWindowController?.showWindow(nil)
    }

    /// Called when the user successfully activates a subscription key
    /// from the license window.
    func handleSuccessfulAuthorization() {
        isAuthorized = true
        updateAuthStatusUI()
        startMonitoringIfNeeded()
        licenseWindowController?.close()
        showManualIfFirstTime()
    }

    private func startMonitoringIfNeeded() {
        guard !monitoringStarted else { return }
        monitoringStarted = true
        KeyboardMonitor.shared.startMonitoring()
    }

    private func showManualIfFirstTime() {
        let defaults = UserDefaults.standard
        if !defaults.bool(forKey: manualShownUserDefaultsKey) {
            defaults.set(true, forKey: manualShownUserDefaultsKey)
            defaults.synchronize()
            showManualWindow()
        }
    }

    private func updateAuthStatusUI() {
        let title: String
        if isAuthorized {
            title = "🟢 Active"
        } else if SubscriptionManager.shared.hasStoredKey {
            title = "🔴 Key Expired"
        } else {
            title = "🔴 Not Activated"
        }

        statusMenuItem?.title = title
        taskInstructionsMenuItem?.isEnabled = isAuthorized
        scheduledJobsMenuItem?.isEnabled = isAuthorized
        mcpServersMenuItem?.isEnabled = isAuthorized
    }

    /// Called when an @omniAgent session starts — shows the thinking window.
    func agentSessionDidStart() {
        showAgentThinkingWindow()
    }

    /// Called when an @omniAgent session ends. The OmniAgent Session menu item
    /// is always visible so the user can open it and pick a session at any time.
    func agentSessionDidEnd() {
        // Nothing to do — window and menu item remain available.
    }

    @objc private func handleSubscriptionUnauthorizedNotification() {
        isAuthorized = false
        updateAuthStatusUI()
        showLicenseWindow()
    }

    @objc private func handleSubscriptionExpiredNotification() {
        isAuthorized = false
        SubscriptionManager.shared.clearSubscription()
        updateAuthStatusUI()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            let alert = NSAlert()
            alert.messageText = "Subscription expired"
            alert.informativeText = "Your OmniKey subscription has expired. Please purchase a new subscription to continue using OmniKey."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Buy Subscription")
            alert.addButton(withTitle: "Cancel")

            let response = alert.runModal()
            if response == .alertFirstButtonReturn {
                if let url = URL(string: "https://omnikey.ai") {
                    NSWorkspace.shared.open(url)
                }
            }

            self.showLicenseWindow()
        }
    }

    @objc func quit() {
        NSApplication.shared.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        return false // Keep app running in menu bar
    }

    // MARK: - Dock visibility

    /// Coalesces dock-visibility recomputes onto the next runloop tick.
    /// Reacting *synchronously* to AppKit window notifications was
    /// dangerous: when the user hit the green traffic-light button, the
    /// `didBecomeMain` notification fired mid-zoom-animation, we flipped
    /// the activation policy, and AppKit got confused enough that the
    /// traffic-light buttons (specifically minimise) stopped responding
    /// until the window was closed and re-opened. Bouncing through a
    /// `DispatchQueue.main.async` lets every in-flight window animation
    /// finish before we touch `NSApp.activationPolicy`, and naturally
    /// debounces bursts of notifications (e.g. didResignKey +
    /// didBecomeKey when switching between OmniKey windows).
    @objc private func scheduleDockVisibilityUpdate() {
        guard !dockUpdateScheduled else { return }
        dockUpdateScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.dockUpdateScheduled = false
            self.applyDockVisibility()
        }
    }

    /// Recomputes the app's activation policy from the set of currently
    /// visible user windows. The app starts as `.accessory` (menu-bar
    /// only); the moment any user-facing OmniKey window appears we
    /// promote to `.regular` so the Dock icon shows up, and the moment
    /// the last one closes we drop back to `.accessory`.
    ///
    /// Critically this method:
    ///   - does **not** call `NSApp.activate(...)`. Re-activating mid-
    ///     session yanks key focus away from whatever the user is doing
    ///     and was the root cause of the "after maximise I can't
    ///     minimise" bug — the spurious activation interrupted the zoom
    ///     animation and left the traffic-light buttons stuck.
    ///   - **counts miniaturised windows as still present** so tucking
    ///     a window into the Dock keeps the OmniKey icon there for the
    ///     user to click it back out.
    private func applyDockVisibility() {
        let hasUserWindow = NSApp.windows.contains { Self.isUserFacingWindow($0) }
        let desired: NSApplication.ActivationPolicy = hasUserWindow ? .regular : .accessory
        guard NSApp.activationPolicy() != desired else { return }
        NSApp.setActivationPolicy(desired)
    }

    /// Filter for "real" user-facing windows. Excludes status-bar panels,
    /// menu host windows, popovers, and anything that isn't currently
    /// visible on screen — otherwise the Dock icon would never go away
    /// because AppKit keeps several invisible bookkeeping windows around.
    /// Miniaturised windows *do* count: their owning user-facing window
    /// is still present (just docked), so the Dock icon should remain.
    private static func isUserFacingWindow(_ window: NSWindow) -> Bool {
        // `isVisible` reports `true` for both on-screen *and* miniaturised
        // windows, which is exactly what we want.
        guard window.isVisible else { return false }
        if window is NSPanel { return false }
        guard window.canBecomeMain else { return false }
        guard window.styleMask.contains(.titled) else { return false }
        return true
    }

    /// Re-open the chat window when the user clicks the Dock icon while no
    /// windows are visible — standard macOS app behaviour.
    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showChatWindow()
        }
        return true
    }
}

// Top-level entry point for the executable target
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
