# Cockpit Daemon (macOS app)

A menu bar app that runs cockpit-daemon for you: starts it when you log in, shows its output
live, and gives you Start / Stop / Restart buttons and a list of the conversations it is
running. It replaces the launchd agent that **Tootega: Install daemon** creates; use one or
the other. See [Docs/daemon-mode.md](../../Docs/daemon-mode.md) for what the daemon does.

## Build and install

On the Mac that runs the daemon (Xcode or the Command Line Tools, plus Node.js):

```sh
cd Cockpit                         # the repo, with daemon mode applied
npm ci                             # once, so the extension (and dist/daemon.js) can be built
mac/CockpitDaemon/scripts/build-app.sh --install
open "/Applications/Cockpit Daemon.app"
```

The script builds `dist/daemon.js` if it is missing, compiles the app, bundles the daemon into
it, signs it ad hoc and copies it to /Applications. Rebuild after updating the extension, so
the bundled daemon matches the extension's protocol (`rm dist/daemon.js` first, or run
`npm run build`).

### Signing

The script signs the app **ad hoc** by default. That is all you need to run it on the Mac that
built it: macOS only checks downloaded (quarantined) apps against Gatekeeper, and a locally
built app is not quarantined.

Sign it with your Apple Developer certificate when:

- **You copy the app to another Mac** (AirDrop, download, a shared folder). It arrives
  quarantined, and Gatekeeper refuses an ad-hoc signed app. Sign with a *Developer ID
  Application* certificate and notarize it.
- **Your projects live in a protected folder** (Desktop, Documents, Downloads, iCloud Drive).
  macOS asks for access on behalf of the app that started the Claude processes, and remembers
  the answer per code signature. An ad-hoc signature changes with every build, so the question
  comes back after each rebuild; a certificate signature keeps it. Projects in a folder like
  `~/Projects` are not affected.
- You want the login item to show your name rather than an unidentified developer.

```sh
security find-identity -v -p codesigning          # find the exact certificate name
xcrun notarytool store-credentials cockpit        # once: Apple ID, team, app-specific password

SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE=cockpit \
  mac/CockpitDaemon/scripts/build-app.sh --install
```

No *Developer ID Application* certificate yet? Create it in Xcode › Settings › Accounts ›
Manage Certificates (it needs the paid program; the account holder has to create it). For use
on your own Macs only, an *Apple Development* certificate also works for `SIGN_IDENTITY`;
leave out `NOTARY_PROFILE` then, since only Developer ID can be notarized.

Then, once:

1. If you used **Tootega: Install daemon** before, the app shows a banner: press **Remove
   launchd agent**. Only one daemon can own the socket.
2. In the app's Settings, turn on **Open at login** (approve it in System Settings › General ›
   Login Items if macOS asks).
3. In VS Code nothing needs switching on: the dashboard header shows **Daemon: connected**.
   (**Tootega: Install daemon** detects the running app and installs nothing.)

## What you get

- **Menu bar icon** with the daemon's state, Start / Stop / Restart, the window, Settings and
  Quit. The icon is filled while the daemon runs and shows a warning when it stopped on its own.
- **Window**: status (pid, uptime, socket), the controls, the sessions the daemon holds
  (folder, title, busy / running / idle, windows attached, prompts waiting, last activity,
  and a Stop button per session), and the daemon's log, streaming, with filter, follow, wrap text, copy
  and clear.
- **Supervision**: if the daemon exits on its own it is restarted (1, 2, 4… s back-off; it
  gives up after 5 exits within a minute, so a broken setup doesn't loop).
- **Log file**: everything shown is also appended to `~/.cockpit/daemon.log` (rotated at
  5 MB), the same file the extension's **Show daemon log** opens.

Closing the window keeps the app and the daemon running in the menu bar. **Quitting the app
stops the daemon** and every Claude process it runs (conversations stay on disk and resume on
the next message).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Open at login | off | Registers the app as a login item. |
| Start the daemon when the app opens | on | Off = start it by hand. |
| Restart the daemon if it exits on its own | on | The supervision above. |
| Stop idle Claude processes | never | The daemon's `--idle-stop-hours`. |
| Node.js | from your login shell | The `node` that runs the daemon. |
| daemon.js | bundled in the app | Falls back to `~/.cockpit/daemon.js`. |
| Socket | `~/.cockpit/daemon.sock` | Must match `tootega.daemon.socketPath`. |

The app runs the daemon with the `PATH` of your login shell (plus `~/.local/bin` and the
Homebrew prefixes), so the daemon finds `claude` the way your terminal does. Apps started from
Finder or at login otherwise get a bare `PATH`.

## When something else owns the socket

If a daemon is already listening when the app starts (the extension's launchd agent, one you
started by hand, or one left behind if the app crashed), the app does not start a second one.
It shows that daemon's pid and its sessions, and offers **Stop it** (and **Remove launchd
agent** when that is the reason); then press **Start**. A daemon run by the launchd agent is restarted by
launchd as soon as it stops, so in that case use **Remove launchd agent**.

## Code

| File | Role |
|---|---|
| `CockpitDaemonApp.swift` | App, window, menu bar extra, settings scene; stops the daemon on quit. |
| `DaemonSupervisor.swift` | Runs `node daemon.js`, streams and tees its output, restarts it, polls sessions. |
| `DaemonSocket.swift` | Tiny client of the daemon's socket protocol (`hello`, `list`, `stop`). |
| `ShellEnvironment.swift` | `node` and `PATH` from the login shell. |
| `LoginItem.swift` | Open at login (`SMAppService`). |
| `MainWindowView.swift`, `MenuContent.swift`, `SettingsView.swift` | The UI. |
| `scripts/build-app.sh` | Builds, bundles, signs and installs the app. |

Requires macOS 13 (Ventura) or later.

## First build

This app was written without access to a Mac, so it has not been compiled yet. If
`build-app.sh` reports Swift errors, a Claude Code session on the Mac (`claude` in the repo)
can fix them quickly: paste the error and point it at `mac/CockpitDaemon`. The daemon it runs
is the same tested `dist/daemon.js` the extension uses.
