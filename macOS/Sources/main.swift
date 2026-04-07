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
    private var monitoringStarted = false
    private var isAuthorized = false

    private var updaterController: SPUStandardUpdaterController?

    private let manualShownUserDefaultsKey = "OmniKeyManualShown"

    weak static var shared: AppDelegate?

    func applicationDidFinishLaunching(_: Notification) {
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
        let manualItem = NSMenuItem(title: "Manual", action: #selector(showManualWindowFromMenu), keyEquivalent: "")
        manualItem.target = self
        menu.addItem(manualItem)
        manualMenuItem = manualItem
        let licenseItem = NSMenuItem(title: "Subscription", action: #selector(showLicenseWindowFromMenu), keyEquivalent: "")
        licenseItem.target = self
        // Hide the subscription menu item if self-hosted
        if APIClient.isSelfHosted {
            licenseItem.isHidden = true
        }
        menu.addItem(licenseItem)
        licenseMenuItem = licenseItem
        let updateItem = NSMenuItem(title: "Check Updates", action: #selector(checkForUpdatesFromMenu), keyEquivalent: "")
        updateItem.target = self
        menu.addItem(updateItem)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))

        // Attach the menu to the status bar item so clicking the
        // menu bar icon shows this menu.
        statusItem?.menu = menu
    }

    @objc private func checkForUpdatesFromMenu() {
        updaterController?.checkForUpdates(nil)
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
}

// Top-level entry point for the executable target
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
