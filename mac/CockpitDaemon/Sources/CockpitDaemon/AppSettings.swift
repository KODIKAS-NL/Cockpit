import Foundation

/// User settings (UserDefaults). Empty strings mean "automatic".
enum SettingKey {
    static let nodePath = "nodePath"
    static let scriptPath = "scriptPath"
    static let socketPath = "socketPath"
    static let idleStopHours = "idleStopHours"
    static let startOnLaunch = "startOnLaunch"
    static let autoRestart = "autoRestart"
}

enum AppSettings {
    private static var defaults: UserDefaults { .standard }

    static func registerDefaults() {
        defaults.register(defaults: [
            SettingKey.nodePath: "",
            SettingKey.scriptPath: "",
            SettingKey.socketPath: "",
            SettingKey.idleStopHours: 0,
            SettingKey.startOnLaunch: true,
            SettingKey.autoRestart: true,
        ])
    }

    static var nodePath: String { defaults.string(forKey: SettingKey.nodePath) ?? "" }
    static var scriptPath: String { defaults.string(forKey: SettingKey.scriptPath) ?? "" }
    static var idleStopHours: Int { defaults.integer(forKey: SettingKey.idleStopHours) }
    static var startOnLaunch: Bool { defaults.bool(forKey: SettingKey.startOnLaunch) }
    static var autoRestart: Bool { defaults.bool(forKey: SettingKey.autoRestart) }

    /// Must match the extension's `tootega.daemon.socketPath` (both default to ~/.cockpit/daemon.sock).
    static var socketPath: String {
        let configured = (defaults.string(forKey: SettingKey.socketPath) ?? "")
            .trimmingCharacters(in: .whitespaces)
        return configured.isEmpty ? Paths.defaultSocket : Paths.expand(configured)
    }

    /// The daemon script to run: the setting, else the copy bundled in the app, else the one
    /// the extension's install command left in ~/.cockpit.
    static func resolvedScript() -> URL? {
        let configured = scriptPath.trimmingCharacters(in: .whitespaces)
        if !configured.isEmpty {
            let url = URL(fileURLWithPath: Paths.expand(configured))
            return FileManager.default.fileExists(atPath: url.path) ? url : nil
        }
        if let bundled = Bundle.main.url(forResource: "daemon", withExtension: "js") {
            return bundled
        }
        let installed = Paths.installedScript
        return FileManager.default.fileExists(atPath: installed.path) ? installed : nil
    }
}
