import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor

    @AppStorage(SettingKey.startOnLaunch) private var startOnLaunch = true
    @AppStorage(SettingKey.autoRestart) private var autoRestart = true
    @AppStorage(SettingKey.idleStopHours) private var idleStopHours = 0
    @AppStorage(SettingKey.nodePath) private var nodePath = ""
    @AppStorage(SettingKey.scriptPath) private var scriptPath = ""
    @AppStorage(SettingKey.socketPath) private var socketPath = ""

    // Waiting for approval counts as on: turning the toggle off here would cancel the request.
    @State private var openAtLogin = LoginItem.isEnabled || LoginItem.needsApproval
    @State private var loginError: String?

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Open at login", isOn: $openAtLogin)
                    .onChange(of: openAtLogin) { enabled in
                        do {
                            try LoginItem.setEnabled(enabled)
                            loginError = LoginItem.needsApproval
                                ? "Allow it in System Settings › General › Login Items."
                                : nil
                        } catch {
                            loginError = error.localizedDescription
                            openAtLogin = LoginItem.isEnabled || LoginItem.needsApproval
                        }
                    }
                if let loginError {
                    HStack {
                        Text(loginError).font(.caption).foregroundStyle(.secondary)
                        Button("Open Login Items") { LoginItem.openSystemSettings() }
                            .controlSize(.small)
                    }
                }
                Toggle("Start the daemon when the app opens", isOn: $startOnLaunch)
                Toggle("Restart the daemon if it exits on its own", isOn: $autoRestart)
            }

            Section("Daemon") {
                Stepper(value: $idleStopHours, in: 0...168) {
                    Text(idleStopHours == 0
                         ? "Stop idle Claude processes: never"
                         : "Stop idle Claude processes after \(idleStopHours) h")
                }
                Text("Only processes with no window attached and no prompt waiting; they resume on the next message.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Paths (empty = automatic)") {
                TextField("Node.js", text: $nodePath, prompt: Text(supervisor.nodePath ?? "from your login shell"))
                TextField("daemon.js", text: $scriptPath, prompt: Text(supervisor.scriptPath ?? "bundled in the app"))
                TextField("Socket", text: $socketPath, prompt: Text(Paths.defaultSocket))
                Text("The socket must match the extension's tootega.daemon.socketPath setting.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                HStack {
                    Text("Changes to the daemon and paths apply when it restarts.")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Restart now") { supervisor.restart() }
                        .disabled(!supervisor.state.isRunning)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
    }
}
