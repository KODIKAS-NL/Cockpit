import AppKit
import SwiftUI

@main
struct CockpitDaemonApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Cockpit Daemon", id: WindowID.main) {
            MainWindowView()
                .environmentObject(appDelegate.supervisor)
                .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 920, height: 640)

        MenuBarExtra {
            MenuContent()
                .environmentObject(appDelegate.supervisor)
        } label: {
            MenuBarLabel(supervisor: appDelegate.supervisor)
        }

        Settings {
            SettingsView()
                .environmentObject(appDelegate.supervisor)
        }
    }
}

enum WindowID {
    static let main = "main"
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    // Registers the setting defaults in its init, before anything reads them.
    let supervisor = DaemonSupervisor()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if AppSettings.startOnLaunch {
            supervisor.start()
        }
    }

    /// The daemon is our child: quitting the app ends it (and every Claude process it runs),
    /// so it gets the chance to stop them cleanly first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        switch supervisor.state {
        case .running, .starting, .stopping:
            supervisor.stop {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
            return .terminateLater
        default:
            return .terminateNow
        }
    }

    /// Closing the window keeps the app (and the daemon) running in the menu bar.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

/// The menu bar icon reflects the daemon's state.
struct MenuBarLabel: View {
    @ObservedObject var supervisor: DaemonSupervisor

    var body: some View {
        Image(systemName: symbol)
            .accessibilityLabel("Cockpit Daemon: \(supervisor.state.label)")
    }

    private var symbol: String {
        switch supervisor.state {
        case .running, .external: return "terminal.fill"
        case .starting, .stopping: return "ellipsis.circle"
        case .failed: return "exclamationmark.triangle"
        case .stopped: return "terminal"
        }
    }
}
