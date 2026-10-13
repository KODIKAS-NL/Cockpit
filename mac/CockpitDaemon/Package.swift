// swift-tools-version:5.9
// Cockpit Daemon: a menu bar app that runs and watches cockpit-daemon (dist/daemon.js).
// Build the .app with scripts/build-app.sh; `swift build` alone produces a bare binary.
import PackageDescription

let package = Package(
    name: "CockpitDaemon",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CockpitDaemon",
            path: "Sources/CockpitDaemon"
        ),
    ]
)
