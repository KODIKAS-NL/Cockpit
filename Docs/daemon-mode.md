# Daemon mode: architecture and operations

Daemon mode lets a Claude Code conversation outlive the VS Code window that started it. The
Claude process runs inside **cockpit-daemon**, a small background service, instead of as a
child of the window's extension host. Windows attach to it, follow it, and let go of it; the
conversation keeps running in between.

The typical setup this was built for: a Mac mini that is always on and holds the code, reached
from a MacBook over Remote-SSH and from an iPad over code-server. Start a task from the
MacBook, close the lid, and pick it up an hour later from either device.

## Contents

- [The pieces](#the-pieces)
- [What the daemon does (and doesn't)](#what-the-daemon-does-and-doesnt)
- [How the main flows work](#how-the-main-flows-work)
- [Starting and managing the daemon](#starting-and-managing-the-daemon)
- [Files on disk](#files-on-disk)
- [Wire protocol](#wire-protocol)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Code map](#code-map)

## The pieces

```
 MacBook ── Remote-SSH ──┐                     Mac mini
                         │   ┌──────────────────────────────────────────────────────┐
                         ├──▶│ VS Code server ─ extension host ─ Cockpit (window 1) │──┐
 iPad ── code-server ────┤   │ code-server    ─ extension host ─ Cockpit (window 2) │──┤
                         │   └──────────────────────────────────────────────────────┘  │
                         │                                                              │ Unix socket
                         │                                         ~/.cockpit/daemon.sock
                         │                                                              │
                         │   ┌──────────────────────────────────────────────────────┐  │
                         │   │ cockpit-daemon (launchd agent, plain Node)           │◀─┘
                         │   │   session A ── claude -p --input-format stream-json  │──▶ ~/.claude/projects/…/A.jsonl
                         │   │   session B ── claude -p …                           │──▶ ~/.claude/projects/…/B.jsonl
                         │   └──────────────────────────────────────────────────────┘
```

Everything runs on the same machine. The extension always runs where the code is (it is a
workspace extension), so under Remote-SSH and code-server it runs on the Mac mini, next to
the daemon. Only the editor UI runs on the MacBook or iPad.

There are three layers, each with one job:

| Layer | Runs as | Job |
|---|---|---|
| **Claude Code CLI** | one `claude -p` process per conversation | The agent: model calls, tools, permissions, transcript. Unchanged. |
| **cockpit-daemon** | one background process per user | Owns the CLI processes and relays their JSON lines to whichever windows are attached. |
| **Cockpit extension** | one per VS Code window | The UI. Renders the stream, collects your input and answers prompts. |

The conversation history is never stored by the daemon. The CLI writes it to its transcript
(`~/.claude/projects/<folder>/<session-id>.jsonl`) as it always has, and a window opening a
conversation paints the history from there. The daemon only keeps the little that is not on
disk yet.

## What the daemon does (and doesn't)

It does:

- **Start and own CLI processes.** Each in its own process group, so stopping one also ends
  its subagents and tools.
- **Relay the stream.** Every JSON line the CLI prints goes to every window attached to that
  conversation, unchanged. Every line a window sends goes to the CLI's stdin.
- **Run one handshake per process.** The CLI's `initialize` request (which returns the slash
  commands) is made once by the daemon; every window's own `initialize` is answered from that.
- **Hold prompts until answered.** Permission requests and questions (`control_request`) are
  kept until one window answers. The first answer is passed to the CLI; later answers are
  dropped and the other windows are told to close the card.
- **Refuse overlapping turns.** While a turn is running, a new user message is not queued: the
  window that sent it gets a refusal, and the text goes back to its input box.
- **Help late windows catch up.** A window attaching mid-turn gets a snapshot: the deltas of
  the message being written right now and the prompts still waiting.
- **Remember its sessions.** Across a restart or reboot, sessions are listed as idle and are
  resumed with `--resume` on the next message.
- **Tidy up.** A session that never received a message is dropped when no window holds it.
  Optionally, an idle process with nobody attached is stopped after a set number of hours.

It doesn't:

- Interpret the conversation, store history, or talk to the network. It never sees your
  API credentials: the CLI reads those itself, as usual.
- Decide anything for you. Settings (model, effort, permission mode, system prompt) are chosen
  in the window, which builds the CLI's argument list and hands it to the daemon.
- Work across machines. The socket is local to the machine.

## How the main flows work

### Opening a conversation

1. A window needs a process for a tab (you sent a message, opened a conversation, or the
   panel just opened). Cockpit builds the same argument list it would use locally and sends
   `open` with the workspace folder and, when known, the CLI session id.
2. The daemon looks for a session with that id **in that exact folder** (real path, so
   symlinks and trailing slashes don't matter; a parent or child folder is a different
   project). Found and running: it attaches. Found but stopped: it restarts it with
   `--resume` and the window's current arguments. Not found: it starts a new one.
3. The daemon answers with a snapshot. The window has already painted the history from the
   transcript; it now replays the snapshot (message in progress, waiting prompts) without
   repeating side effects such as writing the plan file again.
4. From then on, the window receives the session's events live.

When a window opens, its first tab attaches to the most recently active running
conversation in the folder. Other running conversations show as **live** in the session list;
opening one attaches to it.

### Prompts with several windows open

```
CLI ── control_request #42 ──▶ daemon ──▶ window 1 (card)   window 2 (card)
window 2 answers ─────────────▶ daemon ──▶ CLI
                                daemon ──▶ window 1: control_settled #42 (card closes)
window 1 answers late ────────▶ daemon: dropped
```

### Sending while a turn runs elsewhere

The daemon refuses the message (`rejected: busy`); the window removes the bubble, puts the
text back in the input box and shows a notice. The window already shows the other device's
turn as running, because the other device's message was echoed to it (`remote_user`).

### Closing, switching and stopping

| You do | Effect on the process |
|---|---|
| Close a tab or the window, or the connection drops | Keeps running. The window detaches. |
| Open another conversation in the same tab | The previous one keeps running. |
| Change model, effort, permission mode or agents | Process ends; on the next message it restarts with the new flags, same conversation (`--resume`). |
| **Tootega: Stop this session's process in the daemon** | Process ends; the conversation stays on disk and resumes on the next message. |
| **Tootega: Restart daemon** | Every process ends; running turns are lost; conversations resume on the next message. |

## Starting and managing the daemon

There are two ways to run the daemon on a Mac. Pick one: only one daemon can own the socket.

| | Cockpit Daemon app | launchd agent |
|---|---|---|
| What | A menu bar app that runs the daemon as its child | A background service, no UI |
| Starts at login | Yes (login item) | Yes |
| Restarted if it dies | Yes (with back-off) | Yes |
| Live log, sessions list, Start/Stop/Restart | Yes | Log file and `launchctl` only |
| Set up with | `mac/CockpitDaemon/scripts/build-app.sh --install` | **Tootega: Install daemon** |
| Quitting it | Stops the daemon and its Claude processes | Not applicable |

The app is described in [mac/CockpitDaemon/README.md](../mac/CockpitDaemon/README.md). The
rest of this section covers the launchd agent. With the app running, **Tootega: Install
daemon** detects it, switches daemon mode on and installs nothing.

### Install the launchd agent

On the machine that holds the code (the Mac mini):

1. Install the Cockpit `.vsix` in every VS Code server that should use daemon mode. The
   Remote-SSH server and code-server keep separate extension folders.
2. Open any window there and run **Tootega: Install daemon** from the command palette.

What the install command does:

- Copies the bundled daemon (`dist/daemon.js`) to `~/.cockpit/daemon.js`, a stable path that
  survives extension updates.
- Finds `node` and your `PATH` by asking your login shell, because launchd starts services
  with an almost empty `PATH`. `~/.local/bin` (where Claude's native installer puts `claude`)
  is added if missing.
- Writes a launchd agent, `~/Library/LaunchAgents/local.cockpit.daemon.plist`, with
  `RunAtLoad` (starts at login) and `KeepAlive` (restarted if it dies).
- Loads it (`launchctl bootout` of any previous version, then `launchctl bootstrap`).
- Turns on `tootega.daemon.enabled`.

Re-run it after updating the extension (to copy the new daemon), after moving `node` or
`claude`, or after changing `tootega.daemon.idleStopHours`.

On Linux the command starts the daemon as a detached background process instead. That lasts
until reboot; use a systemd user unit for anything permanent (see [Run it by hand](#run-it-by-hand)).

### Check that it runs

```sh
launchctl print gui/$(id -u)/local.cockpit.daemon | head -20   # state, pid, last exit
ls -l ~/.cockpit/daemon.sock                                   # srw------- = listening
tail -f ~/.cockpit/daemon.log                                  # or: Tootega: Show daemon log
```

A healthy log starts with `listening on …/daemon.sock (N sessions known)` and has one
`spawn …` line per CLI process started.

### Stop, restart, uninstall

```sh
launchctl kickstart -k gui/$(id -u)/local.cockpit.daemon   # restart (= Tootega: Restart daemon)
launchctl bootout gui/$(id -u)/local.cockpit.daemon        # stop until next login
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.cockpit.daemon.plist   # start again
```

To uninstall: `bootout` as above, delete the plist and `~/.cockpit/`, and turn off
`tootega.daemon.enabled`.

### Run it by hand

Useful for debugging; stop the launchd agent first (only one daemon can own the socket).

```sh
node ~/.cockpit/daemon.js [--socket <path>] [--state <file>] [--idle-stop-hours <n>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--socket` | `~/.cockpit/daemon.sock` | Where to listen. Must match `tootega.daemon.socketPath`. |
| `--state` | `~/.cockpit/sessions.json` | Where sessions are remembered. |
| `--idle-stop-hours` | `0` (never) | Stop a process idle this long with no window and no prompt waiting. |

It logs to stdout and stops every CLI cleanly on Ctrl+C or SIGTERM. If a stale socket file is
left from a crash, it is removed at start; if another daemon is listening, it refuses to start.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `tootega.daemon.enabled` | `false` | Run Claude in the daemon instead of in the window. |
| `tootega.daemon.socketPath` | `~/.cockpit/daemon.sock` | The daemon's socket. |
| `tootega.daemon.idleStopHours` | `0` | Passed to the daemon on install. |

If daemon mode is on but the socket is missing, the window warns once (with an **Install
daemon** button) and runs that tab locally, as without daemon mode.

## Files on disk

| Path | Written by | Contents |
|---|---|---|
| `~/.cockpit/daemon.sock` | daemon | The socket (owner-only). |
| `~/.cockpit/sessions.json` | daemon | Known sessions: folder, CLI session id, title, last arguments. Owner-only, since arguments can include your custom system prompt. |
| `~/.cockpit/daemon.js` | install command | The daemon itself. |
| `~/.cockpit/daemon.log` | daemon (via launchd) | Its log. |
| `~/Library/LaunchAgents/local.cockpit.daemon.plist` | install command | The launchd agent. |
| `$TMPDIR/cockpit-daemon-*/` | daemon | Per-process files the CLI reads (`--settings`, appended system prompt). Removed when the process exits. |
| `~/.claude/projects/…/*.jsonl` | Claude CLI | The transcripts, as always. |

## Wire protocol

Newline-delimited JSON over the Unix socket. Types: `shared/daemon.ts`.

Window → daemon (`op`):

| op | Purpose |
|---|---|
| `hello` | First message. Its `clientId` prefixes the window's own control request ids, so answers to them come back to that window only. |
| `list` | Sessions, optionally for one folder. |
| `open` | Attach to (or start, or create) the session for a folder + CLI session id. Answered with `snapshot`. |
| `send` | One JSON line for the CLI's stdin. |
| `detach` | Stop following a session; it keeps running. |
| `stop` | End the process; the session stays listed (idle). |
| `forget` | End the process and drop the session. |

Daemon → window (`type`): `hello_ok`, `sessions`, `snapshot`, `event` (one CLI line,
unchanged), `control_settled`, `remote_user`, `rejected`, `exit`, `stderr`, `error`.

The CLI's arguments travel in `open` as a list built by the window. Files the CLI must read
are sent as contents: an argument `@file:<name>` is replaced by the path of a temporary file
the daemon writes. The daemon removes any `--resume` from the list and adds its own once it
knows the session id, so a restart always continues the same transcript.

## Security

- The socket and state file are readable by your user only. Anyone who can use the socket
  can make the daemon start `claude` with arbitrary arguments, so it must stay owner-only.
  The daemon, the VS Code server and code-server all need to run as the same user.
- Nothing listens on the network. Remote access goes through your existing Remote-SSH or
  code-server setup (behind Tailscale, in the setup this was built for).
- The daemon runs the CLI with the environment it was started with (from launchd) plus the
  few variables the window asks for. It never sees or stores credentials.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Warning "cockpit-daemon is not running" | Not installed, or not started yet. Run **Install daemon**, or check `launchctl print` above. |
| Daemon starts, but every session fails at once | It cannot find `claude` or `node`. Check the `spawn` lines and errors in the log; re-run **Install daemon** from a shell where `which claude` works. |
| A conversation does not show as live in another window | The windows have different workspace folders (exact folder, not parent/child), or the conversation has not received its first message yet (it has no session id until then). |
| "This session is busy…" | A turn started on another device is still running. Wait for it, or interrupt it (interrupt always goes through). |
| After a daemon restart the first message takes a while | The CLI is being restarted with `--resume`; this is a normal cold start. |
| Two windows show slightly different usage numbers | Each window counts usage for the turns it saw; the transcript remains the source of truth. |

## Code map

| File | Role |
|---|---|
| `src/daemon/main.ts` | Daemon entry point (bundled to `dist/daemon.js`): flags, signals. |
| `src/daemon/Daemon.ts` | Socket server, session registry, folder matching, persistence, idle stop. |
| `src/daemon/DaemonSession.ts` | One CLI process: handshake cache, prompt arbitration, busy refusal, catch-up snapshot, `@file:` arguments. |
| `src/daemon/DaemonClient.ts` | The window's connection (one per extension host, shared by all tabs). |
| `src/daemon/paths.ts` | Socket location and folder normalization, shared by both sides. |
| `src/daemon/service.ts` | launchd install/restart, detached start on other platforms, probe for a running daemon. |
| `mac/CockpitDaemon/` | The macOS menu bar app that can run the daemon instead of launchd. |
| `src/cli/CliProcess.ts` | The interface `Session` uses for either kind of process. |
| `src/cli/RemoteCliProcess.ts` | `CliProcess` relayed through the daemon. |
| `src/cli/CliProcessManager.ts` | The local process (unchanged behaviour); exports the argument builder both share. |
| `src/session/Session.ts` | Snapshot replay, prompts settled elsewhere, other windows' messages, refusals. |
| `src/panel/ChatViewProvider.ts` | Auto-attach on open, live badges, detach on close, one plan file per plan. |
| `shared/daemon.ts` | Protocol types. |
| `test/Daemon.test.ts`, `test/DaemonSessions.test.ts` | Daemon behaviour and two-window flows, against `test/fixtures/fake-claude.mjs`. |
