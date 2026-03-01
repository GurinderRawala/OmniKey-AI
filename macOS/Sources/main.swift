import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var taskInstructionsMenuItem: NSMenuItem?
    private var taskInstructionsWindowController: TaskInstructionsWindowController?
    private var licenseWindowController: LicenseWindowController?
    private var monitoringStarted = false
    private var isAuthorized = false

    static weak var shared: AppDelegate?
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupMenuBar()

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
    
    private func setupMenuBar() {
        // Create a status bar item
        let statusBar = NSStatusBar.system
        statusItem = statusBar.statusItem(withLength: NSStatusItem.squareLength)
        
        if let button = statusItem?.button {
            if
                let url = Bundle.main.url(forResource: "MenuBarIcon", withExtension: "png"),
                let image = NSImage(contentsOf: url)
            {
                image.isTemplate = true
                button.image = image
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
        self.taskInstructionsMenuItem = instructionsItem
        let licenseItem = NSMenuItem(title: "Subscription", action: #selector(showLicenseWindowFromMenu), keyEquivalent: "")
        licenseItem.target = self
        menu.addItem(licenseItem)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        
        // Attach the menu to the status bar item so clicking the
        // menu bar icon shows this menu.
        self.statusItem?.menu = menu
    }

    @objc private func showTaskInstructionsWindowFromMenu() {
        showTaskInstructionsWindow()
    }

    private func showTaskInstructionsWindow() {
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
    }

    private func startMonitoringIfNeeded() {
        guard !monitoringStarted else { return }
        monitoringStarted = true
        KeyboardMonitor.shared.startMonitoring()
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
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false // Keep app running in menu bar
    }
}
// Top-level entry point for the executable target
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
