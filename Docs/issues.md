# Open issues

Local issue log (no GitHub issue yet). Fixed items are removed; see the git history.

## Remote Control: respawn/reconnect still unverified

The window-side cause is fixed (1.0.293: sending no longer turns Remote Control off) and verified on the iPad. What is still unverified is the daemon state after a process restart or a window reconnect. If it recurs, `~/.cockpit/daemon.log` says why (`remote control on (resync): failed (...)`). Two window-sent `off` requests on 2026-10-17 (16:32:31, 16:35:10) were never explained.

## Known limitation: approving a plan on the phone always continues in default mode

The Remote Control card in the Claude app (iPhone, claude.ai/code) offers only "approve" for a plan, with no mode choice: the CLI then continues in default mode and every step asks for permission. Cockpit's remembered plan-approval choice (auto / accept edits) is not applied there. Applying it from a window after a phone approval (seen as a `control_cancel_request` for `ExitPlanMode`) was considered and rejected: with two Cockpit windows open on the same conversation, both would react and could conflict. Workaround: switch the mode in a Cockpit window (or with `/permissions` on the phone) after approving. Nothing to do on our side unless the app adds a mode choice.
