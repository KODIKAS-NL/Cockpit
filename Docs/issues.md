# Open issues

Local issue log (no GitHub issue yet). Newest first.

## Remote Control state appears reset after respawn or reconnect

- **Reported:** by the maintainer; the chat reports Remote Control as reset after a process respawn (auto-compact change, model change, stop and send) or a window reconnect to the daemon.
- **Expected:** the daemon re-enables the bridge after init (`resyncRemote`), and every window shows it as on.
- **To check:**
  - Does `resyncRemote` in `src/daemon/DaemonSession.ts` run on every respawn, and is `remote_state` broadcast afterwards?
  - Does a reconnecting window read `DaemonSessionInfo.remote` from the snapshot and apply it in `Session.onSnapshot`, or default to off?
  - The pairing link may change when the bridge is re-enabled; that must not read as off.
- **Status:** not reproduced or verified yet.
