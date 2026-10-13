import AppKit
import SwiftUI

/// The menu under the menu bar icon.
struct MenuContent: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text("Daemon: \(supervisor.state.label)")
        if !supervisor.sessions.isEmpty {
            Text(sessionSummary)
        }
        Divider()

        Button("Start") { supervisor.start() }
            .disabled(!canStart)
        Button("Stop") {
            if case .external = supervisor.state { supervisor.stopExternal() } else { supervisor.stop() }
        }
        .disabled(!canStop)
        Button("Restart") { supervisor.restart() }
            .disabled(!canRestart)

        Divider()
        Button("Open Window…") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: WindowID.main)
        }
        .keyboardShortcut("o")
        Button("Settings…") {
            NSApp.activate(ignoringOtherApps: true)
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        }
        .keyboardShortcut(",")
        Divider()
        Button("Quit (stops the daemon)") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var sessionSummary: String {
        let busy = supervisor.sessions.filter { $0.state == "busy" }.count
        let live = supervisor.sessions.filter { $0.state != "idle" }.count
        return "\(live) live session\(live == 1 ? "" : "s"), \(busy) working"
    }

    private var canStart: Bool {
        switch supervisor.state {
        case .stopped, .failed: return true
        default: return false
        }
    }

    private var canStop: Bool {
        switch supervisor.state {
        case .running, .external: return true
        default: return false
        }
    }

    private var canRestart: Bool {
        switch supervisor.state {
        case .running, .stopped, .failed: return true
        default: return false
        }
    }
}
