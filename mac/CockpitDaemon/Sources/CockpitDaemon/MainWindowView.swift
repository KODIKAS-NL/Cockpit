import AppKit
import SwiftUI

struct MainWindowView: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor

    var body: some View {
        VStack(spacing: 0) {
            StatusHeader()
                .padding(16)
            Banners()
            Divider()
            VSplitView {
                SessionsPanel()
                    .frame(minHeight: 110, idealHeight: 180)
                LogPanel()
                    .frame(minHeight: 200)
            }
        }
    }
}

// MARK: - Status and controls

private struct StatusHeader: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            Circle()
                .fill(color)
                .frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(supervisor.state.label).font(.title3.weight(.semibold))
                    detail
                }
                Text(supervisor.socketPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
            Controls()
        }
    }

    @ViewBuilder private var detail: some View {
        switch supervisor.state {
        case .running(let pid, let since):
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text("pid \(pid) · up \(Self.duration(context.date.timeIntervalSince(since)))")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        case .external(let pid):
            Text("pid \(pid)").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
        case .failed(let why):
            Text(why).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
        default:
            EmptyView()
        }
    }

    private var color: Color {
        switch supervisor.state {
        case .running, .external: return .green
        case .starting, .stopping: return .yellow
        case .failed: return .red
        case .stopped: return .gray
        }
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        if s < 86400 { return "\(s / 3600)h \((s % 3600) / 60)m" }
        return "\(s / 86400)d \((s % 86400) / 3600)h"
    }
}

/// Start / Stop / Restart. A daemon this app didn't start can only be asked to stop.
struct Controls: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor

    var body: some View {
        HStack(spacing: 8) {
            Button {
                supervisor.start()
            } label: {
                Label("Start", systemImage: "play.fill")
            }
            .disabled(!canStart)

            Button {
                if case .external = supervisor.state {
                    supervisor.stopExternal()
                } else {
                    supervisor.stop()
                }
            } label: {
                Label("Stop", systemImage: "stop.fill")
            }
            .disabled(!canStop)

            Button {
                supervisor.restart()
            } label: {
                Label("Restart", systemImage: "arrow.clockwise")
            }
            .disabled(!canRestart)
        }
        .controlSize(.large)
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

// MARK: - Warnings

private struct Banners: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor

    var body: some View {
        VStack(spacing: 8) {
            if supervisor.launchAgentInstalled {
                Banner(
                    icon: "exclamationmark.triangle.fill",
                    text: "The extension's launchd agent is installed (\(Paths.launchAgentLabel)). Only one daemon can own the socket, and it starts at login before this app. Remove it to let this app run the daemon.",
                    action: "Remove launchd agent"
                ) {
                    supervisor.removeLaunchAgent()
                }
            }
            if case .external(let pid) = supervisor.state {
                Banner(
                    icon: "info.circle.fill",
                    text: "Another daemon (pid \(pid)) owns the socket, so this app is only watching it. Stop it, then press Start to run the daemon from here.",
                    action: "Stop it"
                ) {
                    supervisor.stopExternal()
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, supervisor.launchAgentInstalled || isExternal ? 12 : 0)
    }

    private var isExternal: Bool {
        if case .external = supervisor.state { return true }
        return false
    }
}

private struct Banner: View {
    let icon: String
    let text: String
    let action: String
    let perform: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(.orange)
            Text(text).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button(action, action: perform)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.12)))
    }
}

// MARK: - Sessions

private struct SessionsPanel: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Sessions").font(.headline)
                Text("\(supervisor.sessions.count)").foregroundStyle(.secondary)
                Spacer()
                Button {
                    supervisor.pollSessions()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
            }
            if supervisor.sessions.isEmpty {
                Text(supervisor.state.isRunning || isExternal
                     ? "No sessions yet. They appear here when a VS Code window starts or opens a conversation."
                     : "The daemon is not running.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                List(supervisor.sessions) { session in
                    SessionRow(session: session)
                }
                .listStyle(.inset)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var isExternal: Bool {
        if case .external = supervisor.state { return true }
        return false
    }
}

private struct SessionRow: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor
    let session: DaemonSessionInfo

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(stateColor).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title ?? "Untitled").lineLimit(1)
                Text(session.cwd)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(stateText).font(.caption.weight(.medium))
                Text(session.lastActivity, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(width: 140, alignment: .trailing)
            Button("Stop") {
                supervisor.stopSession(session)
            }
            .disabled(session.state == "idle")
            .help("End this conversation's Claude process. It stays on disk and resumes on the next message.")
        }
        .padding(.vertical, 2)
    }

    private var stateText: String {
        var parts: [String] = [session.state]
        if session.clients > 0 { parts.append(session.clients == 1 ? "1 window" : "\(session.clients) windows") }
        if session.pendingPrompts > 0 { parts.append("\(session.pendingPrompts) waiting") }
        return parts.joined(separator: " · ")
    }

    private var stateColor: Color {
        switch session.state {
        case "busy": return .orange
        case "running": return .green
        default: return .gray
        }
    }
}

// MARK: - Log

private struct LogPanel: View {
    @EnvironmentObject private var supervisor: DaemonSupervisor
    @State private var filter = ""
    @State private var follow = true
    /// Long lines (the CLI's arguments) wrap instead of scrolling sideways; remembered.
    @AppStorage("logWrap") private var wrap = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("Log").font(.headline)
                TextField("Filter", text: $filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
                Toggle("Follow", isOn: $follow)
                    .toggleStyle(.checkbox)
                Toggle("Wrap text", isOn: $wrap)
                    .toggleStyle(.checkbox)
                Spacer()
                Button("Copy") { copy() }
                Button("Clear") { supervisor.clearLog() }
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([Paths.logFile])
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            ScrollViewReader { proxy in
                ScrollView(wrap ? [.vertical] : [.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(visible) { line in
                            Text(line.text)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(color(for: line))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: !wrap, vertical: wrap)
                                .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                }
                .background(Color(nsColor: .textBackgroundColor))
                .onChange(of: supervisor.lines.last?.id) { lastId in
                    guard follow, let lastId, visible.last?.id == lastId else { return }
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
                .onAppear {
                    if let last = visible.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var visible: [LogLine] {
        let f = filter.trimmingCharacters(in: .whitespaces)
        guard !f.isEmpty else { return supervisor.lines }
        return supervisor.lines.filter { $0.text.localizedCaseInsensitiveContains(f) }
    }

    private func color(for line: LogLine) -> Color {
        switch line.source {
        case .stderr: return .red
        case .app: return .accentColor
        case .stdout:
            let t = line.text
            if t.contains("failed") || t.contains("error") { return .orange }
            return .primary
        }
    }

    private func copy() {
        let text = visible.map(\.text).joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
