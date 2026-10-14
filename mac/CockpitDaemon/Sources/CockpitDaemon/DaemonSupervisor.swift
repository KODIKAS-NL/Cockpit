import Foundation
import Darwin

/// One line of the daemon's output (or of this app's own notes).
struct LogLine: Identifiable, Equatable {
    let id: Int
    let text: String
    let source: Source
    enum Source { case stdout, stderr, app }
}

/// What the app knows about the daemon.
enum DaemonState: Equatable {
    case stopped
    case starting
    case running(pid: Int32, since: Date)
    case stopping
    /// Exited on its own. The message says why (exit code, last error line).
    case failed(String)
    /// A daemon this app did not start owns the socket (the extension's launchd agent, a
    /// copy started by hand, or one orphaned by a crash of this app).
    case external(pid: Int32)

    var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    var label: String {
        switch self {
        case .stopped: return "Stopped"
        case .starting: return "Starting…"
        case .running: return "Running"
        case .stopping: return "Stopping…"
        case .failed: return "Stopped unexpectedly"
        case .external: return "Running outside this app"
        }
    }
}

/// Runs `node daemon.js` as a child process and keeps it running: streams its output to the
/// window and to ~/.cockpit/daemon.log, restarts it if it dies, and polls its sessions.
@MainActor
final class DaemonSupervisor: ObservableObject {
    @Published private(set) var state: DaemonState = .stopped
    @Published private(set) var lines: [LogLine] = []
    @Published private(set) var sessions: [DaemonSessionInfo] = []
    @Published private(set) var launchAgentInstalled = false
    @Published private(set) var scriptPath: String?
    @Published private(set) var nodePath: String?

    private var process: Process?
    private var userStopped = false
    private var restartAfterExit = false
    private var crashTimes: [Date] = []
    private var lineSeq = 0
    private var logFile: FileHandle?
    private var pollTimer: Timer?
    private var shellEnv: ShellEnvironment?
    private var stopCompletions: [() -> Void] = []

    private static let maxLines = 5000
    private static let maxCrashesPerMinute = 5

    init() {
        AppSettings.registerDefaults()
        refreshLaunchAgent()
    }

    var socketPath: String { AppSettings.socketPath }

    // MARK: - Controls

    func start() {
        guard process == nil else { return }
        switch state {
        case .starting, .stopping: return
        default: break
        }
        userStopped = false
        state = .starting
        let socket = socketPath
        Task.detached { [weak self] in
            // Off the main thread: the login shell and the socket probe can take a moment.
            let env = ShellEnvironment.load()
            let existing = try? DaemonSocket.hello(socketPath: socket)
            await self?.launch(env: env, existingPid: existing)
        }
    }

    func stop(completion: (() -> Void)? = nil) {
        userStopped = true
        restartAfterExit = false
        if let completion { stopCompletions.append(completion) }
        guard let process, process.isRunning else {
            if case .external = state {} else { state = .stopped }
            finishStop()
            return
        }
        state = .stopping
        note("Stopping the daemon (its Claude processes end with it)…")
        // SIGTERM: the daemon ends every CLI and removes its socket, then exits.
        process.terminate()
        let pid = process.processIdentifier
        after(8) { [weak self] in
            guard let self, let p = self.process, p.processIdentifier == pid, p.isRunning else { return }
            self.note("The daemon did not exit in time: killing it.")
            kill(pid, SIGKILL)
        }
    }

    func restart() {
        if process?.isRunning == true {
            stop()
            restartAfterExit = true
        } else {
            start()
        }
    }

    /// Stops a daemon this app did not start (asks it to exit, like launchd would).
    func stopExternal() {
        guard case .external(let pid) = state, pid > 0 else { return }
        note("Asking the daemon with pid \(pid) to exit…")
        kill(pid, SIGTERM)
        after(2) { [weak self] in
            self?.probeExternal()
        }
    }

    /// Unloads and deletes the extension's launchd agent, so this app is the only owner.
    func removeLaunchAgent() {
        let label = "gui/\(getuid())/\(Paths.launchAgentLabel)"
        let result = Self.run("/bin/launchctl", ["bootout", label])
        if result.status != 0 && !result.output.isEmpty {
            note("launchctl bootout: \(result.output.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        do {
            try FileManager.default.removeItem(at: Paths.launchAgentPlist)
            note("Removed the launchd agent (\(Paths.launchAgentPlist.path)).")
        } catch {
            note("Could not remove \(Paths.launchAgentPlist.path): \(error.localizedDescription)")
        }
        refreshLaunchAgent()
        after(1) { [weak self] in
            self?.probeExternal()
        }
    }

    func stopSession(_ session: DaemonSessionInfo) {
        let socket = socketPath
        note("Stopping the Claude process of “\(session.title ?? session.folderName)”.")
        Task.detached { [weak self] in
            do {
                try DaemonSocket.stopSession(socketPath: socket, id: session.id)
            } catch {
                await self?.note("Could not stop the session: \(error.localizedDescription)")
            }
            await self?.pollSessions()
        }
    }

    func clearLog() {
        lines.removeAll()
    }

    func refreshLaunchAgent() {
        launchAgentInstalled = FileManager.default.fileExists(atPath: Paths.launchAgentPlist.path)
    }

    // MARK: - Launch

    private func launch(env: ShellEnvironment, existingPid: Int32?) {
        shellEnv = env
        if userStopped { state = .stopped; return }
        if let pid = existingPid {
            state = .external(pid: pid)
            note("A daemon is already listening on \(socketPath) (pid \(pid)); it was not started by this app.")
            startPolling()
            return
        }
        guard let script = AppSettings.resolvedScript() else {
            state = .failed("daemon.js not found")
            note("No daemon script: set one in Settings, or run “Cockpit Daemon: Install daemon” once in VS Code to create \(Paths.installedScript.path).")
            return
        }
        let configuredNode = AppSettings.nodePath.trimmingCharacters(in: .whitespaces)
        guard let node = configuredNode.isEmpty ? env.node : Paths.expand(configuredNode) else {
            state = .failed("node not found")
            note("Node.js was not found in your login shell's PATH. Install it, or set its path in Settings.")
            return
        }
        scriptPath = script.path
        nodePath = node

        Paths.ensureCockpitDir()
        openLogFile()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        var args = [script.path, "--socket", socketPath]
        if AppSettings.idleStopHours > 0 { args += ["--idle-stop-hours", String(AppSettings.idleStopHours)] }
        p.arguments = args
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = env.daemonPath()
        p.environment = environment
        p.currentDirectoryURL = Paths.home
        p.standardInput = FileHandle.nullDevice

        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        attach(out, source: .stdout)
        attach(err, source: .stderr)

        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            let reason = proc.terminationReason
            Task { @MainActor in self?.didExit(status: status, reason: reason) }
        }

        do {
            try p.run()
        } catch {
            state = .failed(error.localizedDescription)
            note("Could not start \(node): \(error.localizedDescription)")
            return
        }
        process = p
        state = .running(pid: p.processIdentifier, since: Date())
        note("Started the daemon (pid \(p.processIdentifier)): \(node) \(args.joined(separator: " "))")
        startPolling()
    }

    private func attach(_ pipe: Pipe, source: LogLine.Source) {
        let splitter = LineSplitter()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                let rest = splitter.flush()
                if !rest.isEmpty { Task { @MainActor in self?.append(rest, source: source) } }
                return
            }
            let complete = splitter.push(data)
            if !complete.isEmpty { Task { @MainActor in self?.append(complete, source: source) } }
        }
    }

    private func didExit(status: Int32, reason: Process.TerminationReason) {
        process = nil
        let how = reason == .uncaughtSignal ? "signal \(status)" : "exit code \(status)"
        if userStopped {
            note("The daemon stopped (\(how)).")
            state = .stopped
            sessions = []
            stopPolling()
            finishStop()
            if restartAfterExit {
                restartAfterExit = false
                start()
            }
            return
        }
        let lastError = lines.last(where: { $0.source == .stderr })?.text ?? lines.last?.text ?? ""
        state = .failed("\(how)\(lastError.isEmpty ? "" : " — \(lastError)")")
        sessions = []
        note("The daemon exited on its own (\(how)).")

        guard AppSettings.autoRestart else { stopPolling(); return }
        let now = Date()
        crashTimes = crashTimes.filter { now.timeIntervalSince($0) < 60 } + [now]
        if crashTimes.count > Self.maxCrashesPerMinute {
            note("It exited \(crashTimes.count) times within a minute: not restarting. Check the log, then press Start.")
            stopPolling()
            return
        }
        let delay = Double(min(30, 1 << (crashTimes.count - 1)))
        note("Restarting in \(Int(delay)) s…")
        after(delay) { [weak self] in
            guard let self, !self.userStopped, self.process == nil else { return }
            self.start()
        }
    }

    private func finishStop() {
        let completions = stopCompletions
        stopCompletions = []
        for c in completions { c() }
    }

    /// Re-checks a daemon this app did not start: gone → stopped; still there → keep showing it.
    private func probeExternal() {
        let socket = socketPath
        Task.detached { [weak self] in
            let pid = try? DaemonSocket.hello(socketPath: socket)
            await self?.applyProbe(pid)
        }
    }

    private func applyProbe(_ pid: Int32?) {
        guard process == nil else { return }
        if let pid {
            state = .external(pid: pid)
        } else if case .external = state {
            state = .stopped
            sessions = []
            note("The other daemon is gone. Press Start to run it from this app.")
        }
    }

    // MARK: - Sessions

    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollSessions() }
        }
        // First poll once the daemon had a moment to open its socket.
        after(0.7) { [weak self] in self?.pollSessions() }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func pollSessions() {
        let socket = socketPath
        Task.detached { [weak self] in
            let list = try? DaemonSocket.list(socketPath: socket)
            await self?.applySessions(list)
        }
    }

    private func applySessions(_ list: [DaemonSessionInfo]?) {
        if let list {
            sessions = list
        } else if case .external = state {
            probeExternal()
        }
    }

    // MARK: - Log

    func note(_ text: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        append(["[\(stamp)] [app] \(text)"], source: .app)
    }

    private func append(_ texts: [String], source: LogLine.Source) {
        var added: [LogLine] = []
        for t in texts {
            lineSeq += 1
            added.append(LogLine(id: lineSeq, text: t, source: source))
        }
        lines.append(contentsOf: added)
        if lines.count > Self.maxLines {
            lines.removeFirst(lines.count - Self.maxLines)
        }
        writeToLogFile(texts)
    }

    private func openLogFile() {
        guard logFile == nil else { return }
        let url = Paths.logFile
        let fm = FileManager.default
        // Keep one previous log, so the file never grows without bound.
        if let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue,
           size > 5 * 1024 * 1024 {
            let old = url.appendingPathExtension("1")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: url, to: old)
        }
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        logFile = try? FileHandle(forWritingTo: url)
        _ = try? logFile?.seekToEnd()
    }

    private func writeToLogFile(_ texts: [String]) {
        guard let logFile else { return }
        let data = Data((texts.joined(separator: "\n") + "\n").utf8)
        try? logFile.write(contentsOf: data)
    }

    // MARK: - Helpers

    /// Runs `body` on the main actor after `seconds`.
    private func after(_ seconds: Double, _ body: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            body()
        }
    }

    @discardableResult
    nonisolated static func run(_ tool: String, _ args: [String]) -> (status: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}

/// Splits a byte stream into lines. Used from one pipe's handler queue at a time.
final class LineSplitter: @unchecked Sendable {
    private var buffer = Data()
    private let lock = NSLock()

    func push(_ data: Data) -> [String] {
        lock.lock(); defer { lock.unlock() }
        buffer.append(data)
        var out: [String] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            out.append(String(decoding: line, as: UTF8.self))
        }
        return out
    }

    func flush() -> [String] {
        lock.lock(); defer { lock.unlock() }
        guard !buffer.isEmpty else { return [] }
        let rest = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll()
        return [rest]
    }
}
