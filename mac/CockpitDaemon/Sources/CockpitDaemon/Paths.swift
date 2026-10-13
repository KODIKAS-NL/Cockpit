import Foundation

/// Locations shared with the Cockpit extension (see src/daemon/paths.ts and service.ts).
enum Paths {
    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    /// ~/.cockpit: socket, state, log and the installed daemon script.
    static var cockpitDir: URL { home.appendingPathComponent(".cockpit", isDirectory: true) }

    static var defaultSocket: String { cockpitDir.appendingPathComponent("daemon.sock").path }

    /// The extension's "Show daemon log" command reads this file, so the app writes it too.
    static var logFile: URL { cockpitDir.appendingPathComponent("daemon.log") }

    /// Where the extension's "Install daemon" command copies the daemon.
    static var installedScript: URL { cockpitDir.appendingPathComponent("daemon.js") }

    /// The launchd agent the extension's install command writes. Only one daemon can own the
    /// socket: when this app runs the daemon, that agent must go.
    static let launchAgentLabel = "local.cockpit.daemon"
    static var launchAgentPlist: URL {
        home.appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist")
    }

    /// `~/…` → absolute path (settings are typed by hand).
    static func expand(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }

    static func ensureCockpitDir() {
        try? FileManager.default.createDirectory(
            at: cockpitDir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }
}
