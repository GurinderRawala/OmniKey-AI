import AppKit

/// Builds the application's top menu bar — the "File / Edit / View / Window /
/// Help" strip that appears next to the Apple logo whenever the app is the
/// frontmost (regular) application.
///
/// OmniKey originally launched as a pure menu-bar utility (`LSUIElement`
/// + `.accessory` activation policy), which on macOS means *no application
/// menu*. That had a real, user-visible cost: when the chat window entered
/// native full-screen via the green traffic-light, macOS hides the title bar
/// and reveals it on cursor-to-top — but only if the active app owns the
/// menu bar. With no menu bar there's nothing to reveal, so the close /
/// minimise / zoom buttons became unreachable and the only way out was
/// Escape.
///
/// Installing a real `NSApp.mainMenu` solves three problems at once:
///   1. Full-screen reveal works (cursor against the top of the screen
///      slides the menu bar + title bar down with traffic lights).
///   2. Standard keyboard shortcuts (Cmd-W close, Cmd-M minimise, Cmd-Q
///      quit, plus Edit-menu Cmd-Z / Cmd-X / Cmd-C / Cmd-V / Cmd-A) are
///      delivered to the responder chain for free, so we can drop the
///      ad-hoc `sendEvent` forwarding pattern in `ChatWindow` /
///      `SettingsWindow` over time.
///   3. The app finally has an "OmniKey AI" / "File" / "Edit" / "View" /
///      "Window" / "Help" strip, matching every other macOS app.
///
/// The menu only renders when the app is `.regular` and frontmost; in
/// `.accessory` (menu-bar-only) mode macOS hides the strip anyway, so this
/// is safe to install unconditionally at launch.
enum AppMainMenu {
    static func install(appName: String = "OmniKey AI") {
        let mainMenu = NSMenu()

        mainMenu.addItem(makeAppMenuItem(appName: appName))
        mainMenu.addItem(makeFileMenuItem())
        mainMenu.addItem(makeEditMenuItem())
        mainMenu.addItem(makeViewMenuItem())
        mainMenu.addItem(makeWindowMenuItem())
        mainMenu.addItem(makeHelpMenuItem())

        NSApp.mainMenu = mainMenu

        // Tell AppKit which submenus are the canonical "Window" and "Help"
        // menus so it can wire up standard items (e.g. the list of open
        // windows on the Window menu, Help search field).
        if let windowMenu = mainMenu.item(withTitle: "Window")?.submenu {
            NSApp.windowsMenu = windowMenu
        }
        if let helpMenu = mainMenu.item(withTitle: "Help")?.submenu {
            NSApp.helpMenu = helpMenu
        }
    }

    // MARK: - Submenus

    private static func makeAppMenuItem(appName: String) -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: appName)

        menu.addItem(NSMenuItem(
            title: "About \(appName)",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        ))
        menu.addItem(.separator())

        let settingsItem = NSMenuItem(
            title: "Settings…",
            action: #selector(AppDelegate.showSettingsWindowFromMainMenu),
            keyEquivalent: ","
        )
        menu.addItem(settingsItem)

        let updatesItem = NSMenuItem(
            title: "Check for Updates…",
            action: #selector(AppDelegate.checkForUpdatesFromMainMenu),
            keyEquivalent: ""
        )
        menu.addItem(updatesItem)
        menu.addItem(.separator())

        // System "Services" submenu.
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        servicesItem.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        menu.addItem(servicesItem)
        menu.addItem(.separator())

        menu.addItem(NSMenuItem(
            title: "Hide \(appName)",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        ))

        let hideOthers = NSMenuItem(
            title: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(hideOthers)

        menu.addItem(NSMenuItem(
            title: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        ))
        menu.addItem(.separator())

        menu.addItem(NSMenuItem(
            title: "Quit \(appName)",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        ))

        item.submenu = menu
        return item
    }

    private static func makeFileMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "File")

        let newChat = NSMenuItem(
            title: "New Chat",
            action: #selector(AppDelegate.newChatFromMainMenu),
            keyEquivalent: "n"
        )
        menu.addItem(newChat)
        menu.addItem(.separator())

        menu.addItem(NSMenuItem(
            title: "Close Window",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        ))

        item.submenu = menu
        return item
    }

    private static func makeEditMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Edit")

        menu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(redo)
        menu.addItem(.separator())

        menu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        menu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        menu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(.separator())

        // "Find" is wired through the responder chain so text views get it
        // for free; the menu item just provides the standard keystroke.
        let findItem = NSMenuItem(title: "Find", action: nil, keyEquivalent: "")
        let findSubmenu = NSMenu(title: "Find")
        let find = NSMenuItem(title: "Find…", action: Selector(("performFindPanelAction:")), keyEquivalent: "f")
        find.tag = NSTextFinder.Action.showFindInterface.rawValue
        findSubmenu.addItem(find)
        let findNext = NSMenuItem(title: "Find Next", action: Selector(("performFindPanelAction:")), keyEquivalent: "g")
        findNext.tag = NSTextFinder.Action.nextMatch.rawValue
        findSubmenu.addItem(findNext)
        let findPrev = NSMenuItem(title: "Find Previous", action: Selector(("performFindPanelAction:")), keyEquivalent: "g")
        findPrev.keyEquivalentModifierMask = [.command, .shift]
        findPrev.tag = NSTextFinder.Action.previousMatch.rawValue
        findSubmenu.addItem(findPrev)
        findItem.submenu = findSubmenu
        menu.addItem(findItem)

        item.submenu = menu
        return item
    }

    private static func makeViewMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "View")

        // `toggleFullScreen(_:)` is recognised by AppKit and forwarded to
        // the key window. Putting it in the View menu also gives macOS the
        // hook it needs to wire the Ctrl-Cmd-F shortcut for full-screen
        // and to draw the standard green-button menu treatment.
        let fullScreen = NSMenuItem(
            title: "Enter Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        fullScreen.keyEquivalentModifierMask = [.control, .command]
        menu.addItem(fullScreen)

        item.submenu = menu
        return item
    }

    private static func makeWindowMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Window")

        menu.addItem(NSMenuItem(
            title: "Minimize",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        ))
        menu.addItem(NSMenuItem(
            title: "Zoom",
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        ))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(
            title: "Bring All to Front",
            action: #selector(NSApplication.arrangeInFront(_:)),
            keyEquivalent: ""
        ))

        item.submenu = menu
        return item
    }

    private static func makeHelpMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Help")

        menu.addItem(NSMenuItem(
            title: "OmniKey AI Help",
            action: #selector(AppDelegate.openHelpFromMainMenu),
            keyEquivalent: "?"
        ))

        item.submenu = menu
        return item
    }
}
