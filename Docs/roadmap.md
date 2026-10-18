# Roadmap

What is next for this fork, in rough priority order. It is a direction, not a promise: items move
as use shows what matters. What exists today is in [features.md](features.md), open problems are in
[issues.md](issues.md), and the original requirement catalog is in [../CLAUDE.md](../CLAUDE.md).

## Now: make the daemon flow solid

- **Verify Remote Control after a restart or reconnect.** The window-side cause is fixed; the daemon
  state after a process restart or a window reconnect is still unverified (see issues.md).
- **Linux and Windows.** The daemon, the install command and the extension have only been used on
  macOS. Test, and fix what breaks.
- **Second-Mac check** of the signed and notarized menu bar app.

## Next: fill the gaps in the core

- **File checkpoints** (Git): an automatic checkpoint before large changes, and restore modes
  (files, files only, files and task). Today rewind restores the conversation only.
- **Accept or reject per file and per hunk** before a write.
- **Context breakdown** from `/context` (system prompt, tools, MCP, messages, files).
- **Subagents view**: a dedicated panel for parallel threads instead of inline cards.

## Later

- Consumption history and charts over time (session and daily).
- Custom subagents: list and select.
- `CLAUDE.md` and settings editor with validation.
- Configurable UI density (compact or comfortable).
- Phone plan approval that keeps the chosen mode, if the Claude app adds a mode choice (see issues.md).
- Voice dictation without `ffmpeg` on the host.

## Ideas to shape

Not yet scoped.

- **An MCP endpoint (and bot connectors) on the daemon.** Let other AI clients, such as a Grok bot or
  any MCP-capable assistant, list and control conversations on the user's behalf: list sessions,
  read the output, send input, and answer or relay permission prompts. An MCP server is the general
  form and would cover a bot connector too. Open questions: authentication and a local-only default,
  and which actions need a human approval so a connected AI cannot bypass the permission model.
