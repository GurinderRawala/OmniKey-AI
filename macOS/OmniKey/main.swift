@preconcurrency import AppKit
import ServiceManagement

extension Notification.Name {
    static let omniKeyShowSubscriptionPaywall = Notification.Name("OmniKeyShowSubscriptionPaywall")
}

enum LaunchAtLoginManager {
    static var isEnabled: Bool {
        if #available(macOS 13.0, *) {
            return SMAppService.mainApp.status == .enabled
        } else {
            return false
        }
    }

    static func setEnabled(_ enabled: Bool) {
        guard #available(macOS 13.0, *) else { return }

        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("LaunchAtLoginManager error: %@", error.localizedDescription)
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var statusItem: NSStatusItem?
    private var taskInstructionsWindowController: TaskInstructionsWindowController?
    private var subscriptionWindowController: SubscriptionWindowController?
    private var launchAtLoginMenuItem: NSMenuItem?
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Present OmniKey as a regular app so users can easily
        // find and relaunch it from the Dock / Applications.
        NSApp.setActivationPolicy(.regular)

        setupMenuBar()
        KeyboardMonitor.shared.startMonitoring()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(showSubscriptionWindow),
            name: .omniKeyShowSubscriptionPaywall,
            object: nil
        )

        Task {
            let subscribed = await SubscriptionManager.shared.checkExistingSubscription()
            if !subscribed {
                await MainActor.run {
                    self.showSubscriptionWindow()
                }
            }
        }
    }

    // setupMainMenu removed; we keep OmniKey as an accessory app
    // without a full menubar so that our HUD alerts continue to
    // behave like a lightweight utility across displays.
    
    private func setupMenuBar() {
        // Create a status bar item
        let statusBar = NSStatusBar.system
        statusItem = statusBar.statusItem(withLength: NSStatusItem.squareLength)
        
        if let button = statusItem?.button {
            button.title = "OK"
            button.font = NSFont.systemFont(ofSize: 12)
        }
        
        // Create menu
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Fix Prompt (Cmd+E)...", action: nil, keyEquivalent: "e"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Fix Grammar (Cmd+G)...", action: nil, keyEquivalent: "g"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "My Custom task (Cmd+T)...", action: nil, keyEquivalent: "t"))
        menu.addItem(NSMenuItem.separator())

        let instructionsItem = NSMenuItem(title: "Task Instructions…", action: #selector(showTaskInstructionsWindowFromMenu), keyEquivalent: "")
        instructionsItem.target = self
        menu.addItem(instructionsItem)

        let subscriptionItem = NSMenuItem(title: "Subscription & Billing…", action: #selector(showSubscriptionWindowFromMenu), keyEquivalent: "")
        subscriptionItem.target = self
        menu.addItem(subscriptionItem)

        let launchAtLoginItem = NSMenuItem(title: "Launch OmniKey at Login", action: #selector(toggleLaunchAtLogin(_:)), keyEquivalent: "")
        launchAtLoginItem.target = self
        launchAtLoginItem.state = LaunchAtLoginManager.isEnabled ? .on : .off
        menu.addItem(launchAtLoginItem)
        self.launchAtLoginMenuItem = launchAtLoginItem

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        
        statusItem?.menu = menu
    }

    @objc private func showTaskInstructionsWindowFromMenu() {
        showTaskInstructionsWindow()
    }

    private func showTaskInstructionsWindow() {
        if taskInstructionsWindowController == nil {
            taskInstructionsWindowController = TaskInstructionsWindowController()
        }

        NSApp.activate(ignoringOtherApps: true)
        taskInstructionsWindowController?.showWindow(nil)
    }

    @objc private func showSubscriptionWindowFromMenu() {
        showSubscriptionWindow()
    }

    @objc private func showSubscriptionWindow() {
        if subscriptionWindowController == nil {
            subscriptionWindowController = SubscriptionWindowController()
        }

        NSApp.activate(ignoringOtherApps: true)
        subscriptionWindowController?.showWindow(nil)
    }

    @objc private func toggleLaunchAtLogin(_ sender: NSMenuItem) {
        let newValue = (sender.state == .off)
        LaunchAtLoginManager.setEnabled(newValue)
        sender.state = newValue ? .on : .off
        launchAtLoginMenuItem?.state = sender.state
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
