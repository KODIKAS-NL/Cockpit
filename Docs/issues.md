# Open issues

Local issue log (no GitHub issue yet). Newest first.

## Remote Control state appears reset after respawn or reconnect

- **Reported:** by the maintainer; the chat reports Remote Control as reset after a process respawn (auto-compact change, model change, stop and send) or a window reconnect to the daemon.
- **Expected:** the daemon re-enables the bridge after init (`resyncRemote`), and every window shows it as on.
- **To check:**
  - Does `resyncRemote` in `src/daemon/DaemonSession.ts` run on every respawn, and is `remote_state` broadcast afterwards?
  - Does a reconnecting window read `DaemonSessionInfo.remote` from the snapshot and apply it in `Session.onSnapshot`, or default to off?
  - The pairing link may change when the bridge is re-enabled; that must not read as off.
- **Findings:** the daemon log had no remote-control lines at all, and `sessions.json` held no `remoteOn` for the active conversation, so the intent had been dropped. The real CLI answers `remote_control` right after init fine (probed, fresh and resumed), so the cause is not confirmed. One path clears the intent for good: a single failed re-enable after a respawn.
- **Change:** the daemon now logs every remote-control request/answer, and retries a failed re-enable up to 4 times (2s, 4s, 6s) before showing it as off. Needs the daemon app rebuilt.
- **Repro lead:** installing a new `.vsix` (extension host reload) while Remote Control is on made it look closed. The daemon log shows no process exit or respawn then, and `sessions.json` kept `remoteOn` true, so the daemon's state was right; suspect the reloaded window's own state/indicator. Two window-sent `off` requests (16:32:31, 16:35:10 on 2026-10-17) are not explained yet.
- **Also seen:** a prompt typed on the phone was not drawn in the window's timeline (only a notice that Remote Control went off). Fixed in `Session.showPhonePrompt`. The unexplained `off` at 16:39:43 came from the only open window (iPad, browser); which action sent it is still unknown.
- **Status:** open. If it recurs, `~/.cockpit/daemon.log` now says why (`remote control on (resync): failed (...)`).
