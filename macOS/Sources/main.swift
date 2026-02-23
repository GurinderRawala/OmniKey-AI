import AppKit

extension Notification.Name {
    static let omniKeyShowSubscriptionPaywall = Notification.Name("OmniKeyShowSubscriptionPaywall")
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var statusItem: NSStatusItem?
    private var taskInstructionsWindowController: TaskInstructionsWindowController?
    private var subscriptionWindowController: SubscriptionWindowController?
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Keep the app as a menu-bar style utility while still
        // allowing us to present windows when needed.
        NSApp.setActivationPolicy(.accessory)

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

    @objc private func showSubscriptionWindow() {
        if subscriptionWindowController == nil {
            subscriptionWindowController = SubscriptionWindowController()
        }

        NSApp.activate(ignoringOtherApps: true)
        subscriptionWindowController?.showWindow(nil)
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
