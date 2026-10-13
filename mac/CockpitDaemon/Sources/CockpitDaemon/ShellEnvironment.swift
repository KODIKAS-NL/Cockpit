import Foundation

/// `node` and PATH as the user's login shell sees them.
///
/// Apps started from Finder or at login get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
/// so neither `node` nor `claude` (often in ~/.local/bin or a Homebrew prefix) would be found.
/// Asking the login shell once gives the PATH a terminal would have.
struct ShellEnvironment {
    var node: String?
    var path: String?

    static func load() -> ShellEnvironment {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-lc", "command -v node; printf '%s' \"$PATH\""]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return ShellEnvironment(node: nil, path: nil)
        }
        // A login shell that hangs (a prompt in .zprofile, say) must not hang the app.
        let deadline = Date().addingTimeInterval(10)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            return ShellEnvironment(node: nil, path: nil)
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let text = String(decoding: data, as: UTF8.self)
        var lines = text.components(separatedBy: "\n")
        let pathLine = lines.popLast() ?? ""
        let node = lines
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first(where: { $0.hasPrefix("/") })
        return ShellEnvironment(node: node, path: pathLine.isEmpty ? nil : pathLine)
    }

    /// PATH for the daemon: the login shell's, with ~/.local/bin (Claude's native installer)
    /// and the Homebrew prefixes added when missing.
    func daemonPath() -> String {
        var parts = (path ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        let extras = [
            Paths.home.appendingPathComponent(".local/bin").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]
        for extra in extras.reversed() where !parts.contains(extra) {
            parts.insert(extra, at: 0)
        }
        return parts.joined(separator: ":")
    }
}
