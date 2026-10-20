# Cockpit in JetBrains Rider

Cockpit also runs in Rider (and, by design, other IntelliJ Platform IDEs). It is the same product:
the chat, the Hub, the scratchpad and the daemon are the ones the VS Code extension uses. Only the
shell around them is different.

Menu names and download pages change between releases, so check them against what you see.
The versions below are the ones this was built and tested with: **Rider 2026.2 (build 262)**,
macOS, Node 20+.

## How it works

```
┌─────────────────────────┐   RPC (the IDE's own   ┌──────────────────────────────┐
│ Frontend (your screen)  │ ◀──── connection) ───▶ │ Backend (holds the code)     │
│ - Cockpit tool window   │                        │ - Node sidecar (sidecar.js)  │
│ - JCEF browser tabs     │   HTTP + WebSocket     │   = the editor-neutral core  │
│   Chat, Hub, scratchpad │ ◀── direct, or SSH ──▶ │ - editor handlers: open file,│
│ - IDE theme             │       tunnel           │   diff, terminal, settings   │
└─────────────────────────┘                        └──────────────┬───────────────┘
                                                                  │ Unix socket
                                                      cockpit-daemon ─▶ claude CLI
```

- The plugin is **split** into three modules (`jetbrains/shared`, `frontend`, `backend`), which is
  what JetBrains Remote Development requires: UI code runs in the client, everything that touches
  the code runs on the machine that holds it.
- The **backend** starts the Node sidecar (`src/sidecar/`, the editor-neutral core in
  `src/core/`), which serves the React pages and talks to `cockpit-daemon`.
- The **frontend** shows those pages in a JCEF browser. The two sides talk over a small RPC
  interface (`CockpitRpcApi` in `jetbrains/shared`): start the sidecar, send commands, push the IDE
  theme, report whether the tool window is visible, and open scratchpad tabs.
- The page itself talks to the sidecar over HTTP and a WebSocket. When the IDE runs on one machine
  (local mode) that is `127.0.0.1`. When the backend is remote, the frontend sees that the port is
  not open locally and opens an **SSH tunnel** to it by itself.
- The Claude process still lives in `cockpit-daemon` (see [daemon-mode.md](daemon-mode.md)), so a
  conversation outlives the IDE window, exactly as in VS Code.

## Two ways to use it

| Mode | Setup | When |
|------|-------|------|
| **Local** | Rider on the machine that holds the code and the daemon | You sit at that machine |
| **Remote Development** | Rider backend on that machine, JetBrains Client on your laptop | Code and daemon on an always-on Mac mini or server, you work from a laptop |

Both use the same plugin build.

## Requirements

On the machine that holds the code (the **backend**, for example a Mac mini):

- Rider 2026.2 (a full install: the JCEF browser is not in the Gradle-downloaded copy).
- **Node.js 20+**, found on `PATH`, in `/opt/homebrew/bin`, `/usr/local/bin` or `/usr/bin`.
  Set `COCKPIT_NODE` to the full path of `node` to override.
- The Claude Code CLI, signed in, and `cockpit-daemon` running (see [daemon-mode.md](daemon-mode.md)).

On the laptop (the **client**, remote mode only):

- JetBrains Toolbox App, which installs the matching JetBrains Client.
- Key-based SSH to the backend that works without a prompt: `ssh <host>` must log in by itself.
  The tunnel runs `ssh` with `BatchMode=yes`, so it cannot ask for a password.

## Install the plugin

### 1. Get the zip

Build it (see [Build from source](#build-from-source)) or take a release zip. It is named
`cockpit-<version>.zip`, for example `cockpit-1.0.353.zip`.

### 2. Local mode

1. In Rider: **Settings → Plugins → ⚙ → Install Plugin from Disk…**, pick the zip, restart Rider.
2. Open a project. The **Cockpit** tool window is on the right, and **Tools → Cockpit** has the
   actions (Open, New Conversation, Scratchpad, Interrupt, Conversations, Settings, Log In/Out,
   Restart/Show Daemon).

### 3. Remote Development, on the backend machine

Install the zip into the backend's plugin folder, replacing any older copy. For Rider 2026.2 on
macOS:

```
rm -rf ~/Library/Application\ Support/JetBrains/Rider2026.2/plugins/cockpit
unzip -q cockpit-1.0.353.zip -d ~/Library/Application\ Support/JetBrains/Rider2026.2/plugins/
ls ~/Library/Application\ Support/JetBrains/Rider2026.2/plugins/cockpit/lib/modules
```

The last command must list `cockpit.backend.jar`, `cockpit.frontend.jar` and `cockpit.shared.jar`.
If you installed an older build under another folder name (an early test build used
`cockpit-rider`), remove that folder too.

Then restart the backend: close the client and run `pkill -f remote-dev-server` on the backend
machine. There is nothing to start by hand; the next connection from Toolbox starts a fresh
backend that loads the plugin.

### 4. Remote Development, on the laptop

The JetBrains Client normally fetches the frontend part of the plugin from the backend when it
connects, so you usually install nothing here. If the Cockpit tool window does not show up, install
the same zip in the client: **Settings → Plugins → ⚙ → Install Plugin from Disk…**, then restart the
client. Client and backend must run the **same plugin version**.

## Connect from the laptop

JetBrains Gateway only supports Linux hosts, so for a macOS backend use the **Toolbox App**.

1. Install the JetBrains Toolbox App on the laptop and sign in.
2. In Toolbox, open the **Remote Development** (SSH) section and add the backend: its host name
   (for example `delphi.home.kodikas.nl`), your user and your SSH key.
3. Toolbox installs or finds Rider on the backend, and lists the projects. If it offers to select
   which settings to apply, choose **Backend** to keep the backend's settings.
4. Open the project folder. The JetBrains Client opens on the laptop.
5. Open the **Cockpit** tool window. The first time, it asks for the **SSH host**: enter the same
   name you use with `ssh` (for example `delphi.home.kodikas.nl`). It is remembered in the IDE's
   settings under the key `cockpit.sshHost`. To skip the prompt, set the environment variable
   `COCKPIT_SSH_HOST` for the client.

When the page loads, the tunnel is up. You will see an `ssh -N -L …` process on the laptop; it ends
with the client.

## Settings

- **Settings → Tools → Cockpit for Claude Code** is a form generated from the same manifest as the
  VS Code settings. It is saved to `~/.cockpit/jetbrains-settings.json` on the **backend**.
- The Hub's **Settings** button opens the form; **Tools → Cockpit → Open Settings File** opens the
  JSON file. Edits to the file are picked up live.
- Language follows the IDE; the theme (light/dark and the editor colours) follows the IDE live.

## What works

Chat with streaming, the tool timeline, permission, plan and question dialogs, diffs, file links
(`file:line`), **Copy as Reference** from the editor, the Hub (usage, plugins, MCP, skills, sessions),
the scratchpad as an editor tab, voice dictation, menu actions, and a live theme.
Remote mode has been verified with a MacBook client and a Mac mini backend.

## Known limits

- JCEF cursor changes (the pointer on buttons) may not show.
- The scratchpad editor tab, login/secret flows and the settings form have been tested locally;
  in remote mode check them on your setup and report anything off.
- The settings form (Settings → Tools) is registered on the backend; the Hub's Settings button and
  **Tools → Cockpit → Settings…** open it through the sidecar.
- Rider only. Other IntelliJ Platform IDEs need the module names of the target product checked.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| "Plugins were disabled: … counterparts are inconsistent" | Client and backend have different plugin versions, or only one side has it. Install the same zip on both, then enable Cockpit on Frontend and Backend in **Settings → Plugins**. |
| Tool window shows "Service not found: …CockpitRpcApi" | The backend has the plugin disabled or not loaded. Remove `nl.kodikas.cockpit` from `~/Library/Application Support/JetBrains/Rider2026.2/disabled_plugins.txt` on the backend, then `pkill -f remote-dev-server` and reconnect. Check `lib/modules` has the three jars. |
| Tool window shows "Cockpit could not start" with "Node.js was not found" | Install Node 20+ on the backend, or set `COCKPIT_NODE`. |
| Empty tabs, no page | The IDE has no JCEF. Use a full Rider install, not the Gradle-downloaded copy. |
| Rider opens a temporary project named like a number (for example `27199300`) instead of your folder | A stray `*.csproj` inside the folder (for example from a build cache) was picked up as the solution. Delete it. The plugin's own sandbox lives outside the repo for this reason. |
| Page does not load in remote mode | `ssh <host>` must work without a prompt from the laptop. Check the `[ssh]` lines in the client's `idea.log`. Clear the saved host by setting `cockpit.sshHost` again, or set `COCKPIT_SSH_HOST`. |
| Plugin error "Cannot resolve cockpit.shared.xml" | The Gradle root project is not named `cockpit`: module names (`cockpit.shared` …) must match the project name. |

Logs: `~/Library/Logs/JetBrains/Rider2026.2/idea.log` on the backend, and the client's own log on the
laptop. Sidecar output appears in the backend log with the `[sidecar]` prefix.

## Build from source

Needs the JBR that ships with Rider (JDK 25), a full Rider install for JCEF, and Node.

```
npm run build                      # produces dist/sidecar.js and the pages
cd jetbrains
export JAVA_HOME=$HOME/Applications/Rider.app/Contents/jbr/Contents/Home
./gradlew buildPlugin              # build/distributions/cockpit-<version>.zip
```

- The Gradle build uses the Rider found in `~/Applications/Rider.app` or `/Applications/Rider.app`
  (or `-PriderPath=<path>`), otherwise it downloads one.
- Kotlin is pinned to **2.4.0**: the RPC compiler plugin (`rpc` 2.4.0-RC-0.1) must match it.
- The plugin version follows the root `package.json`.

Try it in a sandbox IDE with the frontend and backend as separate processes:

```
./gradlew runIdeBackend runIdeFrontend --parallel
```

`./gradlew runIde` runs only one side. The sandbox is kept in `~/.cache/cockpit-rider-sandbox`,
outside the repo. Layout of `jetbrains/`:

| Path | What is there |
|------|---------------|
| `shared/` | `CockpitRpcApi` and its DTOs |
| `frontend/` | The tool window, the browser tabs, `ThemeCss`, the SSH tunnel (`CockpitFrontend`), actions, the scratchpad tab |
| `backend/` | `SidecarService` (starts the sidecar and answers its editor requests), `EditorEvents`, Copy as Reference, the settings form |
| `src/main/resources/META-INF/plugin.xml` | The plugin id (`nl.kodikas.cockpit`) and the module list |
