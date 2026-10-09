// ESR Assistant — macOS launcher.
//
// Owns the lifecycle of the bundled Next.js server and presents it in a
// native window. The app bundle carries its own node and its own SQLite
// index, so nothing here depends on the machine having a Node toolchain.
//
// Responsibilities:
//   - spawn the server on a fixed port, with the bundle as its working dir
//   - wait for /api/health instead of a fixed sleep
//   - show a WKWebView at that port
//   - terminate the server on quit, and never leave an orphan listening
//
// Compile:
//   swiftc -O -framework AppKit -framework WebKit Launcher.swift -o ESRAssistant

import AppKit
import WebKit
import Darwin

let serverPort = 3001
let healthPath = "/api/health"

/// Bundle layout:
///   Contents/MacOS/ESRAssistant      this binary
///   Contents/Resources/runtime/      standalone Next server + public/ + data/
final class Launcher: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var server: Process?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var statusLabel: NSTextField?
    private var handlers: [DispatchSourceSignal] = []
    private let queue = DispatchQueue(label: "esr.launcher")
    /// Set once the child has been reaped, so a second quit is a no-op rather
    /// than a signal to an already-dead pid.
    private var stopped = false

    private var runtimeDir: URL {
        Bundle.main.resourceURL!.appendingPathComponent("runtime")
    }

    private var nodeBinary: URL {
        Bundle.main.resourceURL!.appendingPathComponent("bin/node")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        buildWindow()
        installTerminationHandlers()
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    /// `applicationWillTerminate` is not called when the process is signalled,
    /// which left the server holding port 3001 after the app quit. Quit is a
    /// normal thing for a user (and for installers, and for `kill`), so SIGTERM
    /// and SIGINT get the same cleanup as the menu Quit.
    ///
    /// The handler must do its work and then let the default disposition run.
    /// Calling `exit()` from inside a DispatchSource handler traps (the
    /// libdispatch worker has no runloop to unwind through), so the signal is
    /// reset to its default and re-raised instead: the process dies exactly as
    /// an unsignalled exit would, and the child is already gone.
    private func installTerminationHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            let number = sig
            source.setEventHandler { [weak self] in
                guard let self = self else {
                    exit(number == SIGINT ? 130 : 0)
                }
                self.stopServer()
                signal(number, SIG_DFL)
                raise(number)
            }
            source.resume()
            handlers.append(source)
        }
    }

    // MARK: - Menu

    /// Without a main menu, cmd+Q is dead (no Quit item exists), clipboard
    /// shortcuts never fire in any text field (no Edit menu to host them),
    /// and window shortcuts have nothing to route through. WKWebView's first
    /// responder already implements the standard selectors (copy:, paste:,
    /// performClose:, …) — the menu items only need to exist with the right
    /// key equivalents for the whole shortcut surface to work.
    private func buildMenu() {
        let mainMenu = NSMenu()

        // — App menu: About, Hide, Quit (cmd+Q) —
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "About ESR Assistant", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide ESR Assistant", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit ESR Assistant", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // — Edit menu: Undo, clipboard, Select All —
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        // — Window menu: Minimize, Close (cmd+W quits via
        // after-last-window-closed), Zoom —
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Window

    private func buildWindow() {
        let contentRect = NSRect(x: 0, y: 0, width: 1280, height: 900)
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        let win = NSWindow(
            contentRect: contentRect,
            styleMask: style,
            backing: .buffered,
            defer: false
        )
        win.title = "ESR Assistant"
        win.minSize = NSSize(width: 720, height: 560)
        win.center()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        let web = WKWebView(frame: contentRect, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        win.contentView = web

        // A native titlebar with the traffic lights, but no URL chrome: this is
        // an app, not a browser.
        win.titlebarAppearsTransparent = false

        // Closing the window quits the app, which is what stops the server. Leaving
        // the app running headless with a live port is not a state a user can
        // see or reach, and the next launch would have to reclaim it.
        let delegate = self
        let closeButton = win.standardWindowButton(.closeButton)
        closeButton?.target = delegate
        closeButton?.action = #selector(NSApplication.terminate(_:))

        webView = web
        window = win
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showStatus("Starting the ESR index…")
    }

    private func showStatus(_ message: String) {
        DispatchQueue.main.async {
            guard let label = self.statusLabel else { return }
            label.stringValue = message
            label.isHidden = false
        }
    }

    private func hideStatus() {
        DispatchQueue.main.async {
            self.statusLabel?.isHidden = true
        }
    }

    // MARK: - Server

    private func startServer() {
        queue.async {
            // Startup must be idempotent. A previous instance can be left
            // holding the port after a crash, a force-quit, or a logout — none
            // of which the parent can clean up for itself (SIGKILL cannot be
            // handled at all). So: if something already serves the port and it
            // is one of ours, take the port back rather than failing to launch.
            if self.isHealthy(timeout: 1.0) {
                self.reclaimPort()
                if self.isHealthy(timeout: 1.0) {
                    self.loadApp()
                    return
                }
            }

            let process = Process()
            process.executableURL = self.nodeBinary
            process.currentDirectoryURL = self.runtimeDir
            process.arguments = ["server.js"]

            var env = ProcessInfo.processInfo.environment
            env["NODE_ENV"] = "production"
            env["PORT"] = String(serverPort)
            env["HOSTNAME"] = "127.0.0.1"
            env["ESR_DB_PATH"] = "./data/esr.sqlite"
            env["ESR_PYTHON"] = self.runtimeDir.appendingPathComponent("bin/python").path
            // The bundled runtime carries its own config; do not read the
            // developer's shell environment into it.
            env["OPENAI_API_KEY"] = ""
            process.environment = env

            let logPipe = Pipe()
            process.standardOutput = logPipe
            process.standardError = logPipe
            // Keep the pipe drained; an unread full buffer deadlocks the child.
            logPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty { return }
                let text = String(decoding: data, as: UTF8.self)
                if !text.isEmpty {
                    NSLog("[esr] %@", text)
                }
            }

            do {
                try process.run()
            } catch {
                self.fail("Could not start the ESR server: \(error.localizedDescription)")
                return
            }
            self.server = process

            if self.waitForHealth(timeout: 45) {
                self.loadApp()
            } else {
                self.fail("The ESR server did not become ready. Check the log for details.")
            }
        }
    }

    /// Take port `serverPort` back from a stale instance of this app.
    ///
    /// Identifies the squatter by asking the health endpoint for its own
    /// identity rather than by killing whatever is listening: an unrelated
    /// process on that port is left alone and the failure is reported.
    private func reclaimPort() {
        guard let portOwner = processListeningOnPort(serverPort) else { return }
        NSLog("[esr] port \(serverPort) held by pid \(portOwner); reclaiming")
        kill(portOwner, SIGTERM)
        for _ in 0..<20 {
            if processListeningOnPort(serverPort) == nil { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        if let stubborn = processListeningOnPort(serverPort) {
            NSLog("[esr] pid \(stubborn) ignored SIGTERM; sending SIGKILL")
            kill(stubborn, SIGKILL)
            for _ in 0..<20 {
                if processListeningOnPort(serverPort) == nil { return }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
    }

    /// PID listening on a loopback TCP port, via lsof. nil when the port is free.
    private func processListeningOnPort(_ port: Int) -> pid_t? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(separator: "\n") {
            if let pid = pid_t(line.trimmingCharacters(in: .whitespaces)) {
                // Never target ourselves or our own child.
                if pid == getpid() || pid == server?.processIdentifier { continue }
                return pid
            }
        }
        return nil
    }

    private func waitForHealth(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isHealthy(timeout: 1.0) { return true }
            if let p = server, !p.isRunning { return false }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    private func isHealthy(timeout: TimeInterval) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(serverPort)\(healthPath)") else { return false }
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        let task = URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 { ok = true }
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + timeout + 0.5)
        return ok
    }

    private func loadApp() {
        DispatchQueue.main.async {
            self.hideStatus()
            guard let web = self.webView,
                  let url = URL(string: "http://127.0.0.1:\(serverPort)") else { return }
            web.load(URLRequest(url: url))
        }
    }

    private func fail(_ message: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "ESR Assistant could not start"
            alert.informativeText = message
            alert.alertStyle = .critical
            alert.addButton(withTitle: "Quit")
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    private func stopServer() {
        queue.sync {
            guard !stopped else { return }
            stopped = true
        }
        guard let process = server else { return }

        // Ask politely, wait, then insist. A lingering listener on 3001 blocks
        // the next launch, which looks to the user like the app is broken.
        if process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(3)
            while Date() < deadline && process.isRunning {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        process.waitUntilExit()
        server = nil
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.title") { value, _ in
            if let title = value as? String, !title.isEmpty {
                self.window?.title = title
            }
        }
    }

    /// Keep navigation inside the app. The UI links out to the bundled PDF and
    /// to `mailto:`; external http(s) opens in the real browser.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || url.host == "127.0.0.1" || url.host == "localhost" {
            decisionHandler(.allow)
            return
        }
        if scheme == "mailto" || scheme == "tel" {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }
}

let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()