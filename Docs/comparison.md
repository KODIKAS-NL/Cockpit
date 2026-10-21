# Cockpit compared with the official Claude Code extension

A side-by-side comparison with the official *Claude Code for VS Code* extension by Anthropic. The
official column was checked against its documentation and Marketplace listing (see
[Sources](#sources)) in June 2026. Anthropic ships quickly, so check before quoting.

Legend: ✓ yes · partial · – no · n/a not applicable · planned.

### Conversation & rendering

| Feature | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Token-by-token streaming chat | ✓ | ✓ | partial-messages + fallback |
| Thinking blocks (toggle / expand-all) | ✓ | ✓ | official adds `Ctrl+O` expand-all |
| Tool-call timeline (per-tool cards) | ✓ | ✓ | Cockpit: emoji per tool, Bash split, Read gutter |
| Markdown + syntax highlight | ✓ | ✓ | highlight.js + line-number gutter |
| Find in conversation (Ctrl+F) | ✓ | – | scope **Timeline** vs **Prompts only**, 250 ms debounce, highlight + jump |
| Export conversation | ✓ | – | self-contained HTML snapshot with expandable tool cards, or AI-polished Markdown |
| Timeline verbosity filter (verbose→quiet) | ✓ | – | display-only, doesn't change the agent |
| Scratchpad: annotate screenshots, sketch, attach to the prompt | ✓ | – | Excalidraw board per conversation, saved with it and shared across windows |
| Scroll-marker rail (one per prompt) | ✓ | partial | Cockpit minimap rail with numbered hover |
| Inline code references (paste copied code as an `@file#L10-12` pill) | ✓ | – | Backspace or ✕ removes it whole; chips in the timeline open the file |
| Question and plan cards docked above the prompt box | ✓ | – | the explanation stays readable; collapsible |
| Plan feedback and question notes with references and pasted images | ✓ | – | images are saved to `Planing/.attachment-temp/` and deleted when the turn ends |
| Conversations outlive the window (daemon), attach from any window | ✓ | – | see [daemon mode](daemon-mode.md) |
| Chat in the side bar, model/effort/mode live in the prompt box | ✓ | – |  |
| Model and effort pinned per permission mode | ✓ | – | switched live on mode change |
| Auto-compact limit per conversation | ✓ | – | kept by the daemon |

### Editing & human control

| Feature | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Permission approval (Allow / Always / Deny) | ✓ | ✓ | per-tool preview; `Ctrl+Enter`/`Esc` |
| Permission modes (plan/acceptEdits/auto/…) | ✓ | ✓ | dropdown; official cycles via the mode indicator |
| Model and effort pinned per permission mode | partial | ✓ | official: the CLI's `opusplan` alias (Opus to plan, Sonnet to build); Cockpit: any model and effort per mode (`modePins`), switched live |
| Plan mode (review, edit & approve) | ✓ | ✓ | Cockpit: Edit/Preview toggle; "Keep planning (send my notes)" feeds edits back to the agent |
| Composed questions (AskUserQuestion) | ✓ | ✓ | tabs, multi-select, "Other" |
| Questions asked in your language | ✓ | – | steers AskUserQuestion to the configured voice/UI language |
| Side-by-side diff | ✓ | ✓ | in-webview diff **plus** "Open diff in editor" → VS Code native `vscode.diff`; official also lets you edit in the diff before accepting |
| @-mention files/folders | partial | ✓ | Cockpit: fuzzy file autocomplete (`@` menu, host `findFiles`); no `Alt+K` shortcut |
| Share active selection (`@file#a-b`) | ✓ | ✓ | composer chip with an eye toggle to include/exclude the editor selection |
| Checkpoints / rewind (restore files) | partial | ✓ | official: fork / rewind-code / both. Cockpit rewinds the **transcript** only (file restore via Git planned) |

### Spell-checker & dictation

| Feature | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Inline spell-checker PT-BR + EN | ✓ | – | Hunspell (WASM) in the host; only flags words wrong in **both** languages. **Marks only — never auto-corrects** |
| Spell suggestions dropdown | ✓ | – | grouped per language; click the underlined word → fixes |
| Voice dictation (speech-to-text) | ✓ | – | Claude STT WebSocket; live partials |
| Post-dictation AI correction | ✓ | – | **opt-in** (`cockpitDaemon.voiceCorrect`, default off); clean isolated one-shot |
| Editable dictionaries modal (tabs) | ✓ | – | dictation terms/replacements + spell words; per-machine in `~/.claude/tootega` |

### Statistics, context & consumption

| Feature | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Context-window meter (used/limit, 200K·1M) | ✓ | ✓ | limit auto-derived from the active model |
| Cache panel (hit-rate, read, write, savings) | ✓ | – | per-turn + cumulative; last-turn hit rate |
| Local cost estimate (per turn/session) | ✓ | partial | official shows plan-usage; Cockpit adds a price-table estimate labelled "estimated" |
| Session / weekly subscription limits (% + reset) | ✓ | ✓ | Cockpit reads the real OAuth `/usage`, including the per-model weekly window labelled by the server |
| Usage attribution (long context / subagents / cache / MCP) | ✓ | ✓ | Cockpit estimates it from local transcripts; official reads it from the CLI `/usage` dialog |
| Cache keep-alive (1h TTL): meter *and* refresh | ✓ | – | not just a countdown — opt-in **Keep cache alive** re-arms the TTL before it lapses, so an idle session doesn't pay a full cache re-write |
| Estimated cache savings (USD) | ✓ | – | prices the cache-read tokens against the full input rate |
| Turn timing by (model, effort, type) | ✓ | – | atomic cross-process merge |
| Session activity: duration, turns, peak context | ✓ | – | high-water mark of context with its cache figure |
| Context injected per tool (calls + tokens) | ✓ | partial | ranks Bash/Read/Edit/MCP by the context each pushed in; MCP servers grouped |
| 7-day spend breakdown by model | ✓ | partial | from this machine's transcripts, as equivalent API price |
| All-time global token counter ([`DailyTokens`](../src/stats/DailyTokens.ts)) | ✓ | – | sent / received / total across **every project on the machine**, plus a per-day history — read from `~/.claude/projects/**/*.jsonl` with an incremental rollup, not just the open session |
| Context breakdown via `/context` | planned | ✓ | Cockpit UI ready, data source pending |

### Sessions, panels & recovery

| Feature | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| History: list / resume / rename / delete | ✓ | ✓ | both: AI-ish titles, search; official browses by time |
| Search/filter sessions | ✓ | ✓ | — |
| History grouped by time | ✓ | ✓ | Today / Yesterday / Last 7 days / Older |
| Multiple parallel conversations | ✓ | ✓ | per-tab CLI/stats/streaming; status dot idle/busy/error |
| Per-session spinner in the session list | ✓ | partial | a spinner on every running session |
| Close the webview without stopping the run | ✓ | partial | Cockpit keeps the CLI/session alive in the host; reopening replays the full timeline. Official tab-close behavior is not documented |
| Manual reload (fix gray/dead webview) | ✓ | n/a | status-bar ↻ + per-session-card ↻ + auto render-watchdog |
| Reopen closed session | ✓ | ✓ | `Ctrl+Shift+T` + command palette |
| Remote control (follow from phone) | ✓ | ✓ | phone icon on the session card (and in the composer) runs inside the daemon's process, the phone joins the live conversation — see [Remote Control](features.md#remote-control) |
| Resume cloud / remote sessions (claude.ai) | – | ✓ | official Remote tab |
| Reposition panel (sidebar / editor / window) | ✓ | ✓ | chat in the secondary side bar or an editor tab; dashboard in the Activity Bar |

### Extensibility

| Feature | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Slash commands with autocomplete | ✓ | ✓ | Cockpit curates descriptions; official `/` menu |
| Plugins manager + marketplaces | ✓ | ✓ | browse/install/enable/disable/update |
| MCP servers manage (`/mcp`) | partial | ✓ | both forward to the CLI |
| Built-in IDE MCP server (getDiagnostics, Jupyter execute) | – | ✓ | official runs a local `ide` MCP |
| Skills: cost per skill + what is loaded | ✓ | – | Cockpit reads `get_context_usage` (no turn, no tokens); see [Skills](features.md#skills) |
| Hooks / subagents UI | partial | ✓ | Cockpit forwards `/hooks` etc.; no dedicated UI |
| UTF-8 fix for PowerShell output (Windows) | ✓ | – | one-click `PreToolUse` hook; see [Accented characters in PowerShell output](settings.md#accented-characters-in-powershell-output-windows) |
| Chrome browser automation (`@browser`) | – | ✓ | official only |
| Git worktrees (parallel branches) | – | ✓ | official `--worktree` |
| Dynamic workflows / Artifacts (preview) | – | ✓ | official research preview |

### Platform, input & presentation

| Feature | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Theme synced with VS Code | ✓ | ✓ | `var(--vscode-*)` |
| Bilingual i18n (pt-BR + EN), runtime switch | ✓ | – | host + webview, no reload |
| Image paste / screenshot | ✓ | ✓ | Cockpit also pastes **file paths** (Unicode-safe on Windows) |
| Drag-to-attach files | ✓ | ✓ | drop files on the composer (reuses the path resolver); files with no path on the host (another device, a browser) are uploaded to `.cockpit/uploads/` and shown as a pill |
| Status-bar entry + spinner | ✓ | ✓ | Cockpit: idle/busy dot + model chip |
| Editor-toolbar entry point | ✓ | ✓ | ✦ icon opens the Cockpit from the editor title bar |
| Auto-save before read/write | ✓ | ✓ | flushes a dirty buffer before the agent touches the file (`cockpitDaemon.autosave`) |
| Keyboard shortcuts | ✓ | ✓ | open / new / interrupt / **Ctrl+F** |
| URI handler (`vscode://…/open`) | ✓ | ✓ | both |
| Release-notes link for the active CLI | ✓ | – | clicking the CLI version opens GitHub releases |
| Live model discovery (`/v1/models`) | ✓ | partial | Cockpit lists discovered models + grouped picker |
| Tolerant stream-json parser | ✓ | n/a | unknown events ignored, survives CLI upgrades |
| Sign-in | ✓ | ✓ | via the CLI auth |
| Terminal mode (`useTerminal`) | n/a | ✓ | Cockpit is GUI-only by design |
| Third-party providers (Bedrock/Vertex) | partial | ✓ | via shared `~/.claude/settings.json` |

### Visual design

| Aspect | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Native VS Code look (theme tokens) | ✓ | ✓ | light / dark / high-contrast |
| Per-tool cards with emoji + rich render | ✓ | partial | Bash split, Read line-gutter, Write/Edit highlight |
| Color-banded meters (context / limits) | ✓ | partial | green→amber→red bands |
| Big centered "Cockpit" loader while loading | ✓ | – | orange ring instead of a gray/blank panel |
| Orange accent + spinners (busy/running) | ✓ | partial | per-tab + per-session-card spinners |
| Scroll-marker minimap rail | ✓ | – | one numbered marker per prompt |
| Wavy underline for misspellings | ✓ | – | from the inline spell-checker |
| Configurable UI density | planned | — | planned |

### Information on screen

| Information | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Context used / remaining / limit | ✓ | ✓ | live, color-banded |
| Cache hit-rate + read/write + savings | ✓ | – | per-turn **and** cumulative |
| Cost per turn / per session (estimate) | ✓ | partial | labelled "estimated" |
| Tokens in / out / cache-create / cache-read | ✓ | partial | dedicated block |
| Session / weekly limits with reset time | ✓ | ✓ | includes the per-model weekly window |
| Cache TTL countdown (keep-alive) | ✓ | – | time-to-expiry of the 1h cache |
| Turn timing by model/effort/type | ✓ | – | sample counts |
| Active model / effort / permission mode | ✓ | ✓ | dropdowns + status bar |
| Session details (created, updated, messages, tools, size) | ✓ | partial | under the (i) icon on each session |
| CLI version + update indicator | ✓ | partial | + release-notes link |
| Per-turn vs cumulative cache hit in logs | ✓ | – | `hit=95% (last 100%)` |

### Usability

| Aspect | Cockpit | Official GUI | Notes |
|---|:--:|:--:|---|
| Draft anti-loss (survives reload/crash) | ✓ | partial | mirrored in host + webview state |
| Reopen → full timeline replay | ✓ | partial | even if the run continued in the background |
| Manual render recovery (no restart) | ✓ | n/a | status-bar ↻ + card ↻ + auto-watchdog |
| Find + jump + highlight (Ctrl+F) | ✓ | – | scope Timeline / Prompts |
| Inline spell-checker + suggestions dropdown | ✓ | – | marks only; click to fix (no auto-correct) |
| Voice dictation with live partials | ✓ | – | + opt-in post-dictation AI cleanup |
| Slash autocomplete + curated hints | ✓ | ✓ | ↑/↓/Enter/Esc |
| @-mention file autocomplete | ✓ | ✓ | `@` menu over workspace files (fuzzy) |
| Editable plan mode | ✓ | ✓ | Edit/Preview + send notes back |
| Open diff in native editor | ✓ | ✓ | button on the edit-permission modal |
| Auto-save before read/write | ✓ | ✓ | flush dirty buffer first |
| Reopen closed session | ✓ | ✓ | `Ctrl+Shift+T` |
| Remote control from phone | ✓ | ✓ | phone icon on the session card |
| One-click export (HTML snapshot / Markdown) | ✓ | – | tool cards reopen in the browser, or AI-polished |
| Elegant confirm dialogs (delete/effort) | ✓ | partial | Esc/overlay, danger styling |
| Scroll-to-bottom + at-bottom autoscroll | ✓ | ✓ | floating button when scrolled up |
| Keyboard-first (send/stop/new/find) | ✓ | ✓ | — |

## Where each one is ahead

Cockpit is ahead on the numbers: the cache panel with its savings estimate and a keep-alive that
re-arms the one-hour cache lifetime, session activity (duration, turns, peak context), context
injected per tool, and an all-time token counter across every project on the machine. It also has
runtime language switching (pt-BR and English), find in the conversation, an inline spell-checker,
voice dictation, export to HTML or Markdown, and render recovery. Its sessions also survive closing
the window or the laptop, see [daemon mode](daemon-mode.md).

The official extension is ahead on native-editor diffs with edit-before-accept, @-mentions with
line ranges, file-restoring checkpoints, the built-in IDE MCP server (diagnostics, Jupyter),
Chrome automation, git worktrees, cloud-session resume, and dynamic workflows and Artifacts.

## Still open

Items the official extension has and Cockpit does not:

| Gap | Status | Why |
|---|---|---|
| Context breakdown via `/context` | blocked | No clean source in stream-json. Only running `/context` yields a text block, which pollutes the transcript and costs a turn. The UI is ready and waits for a stable data source. |
| File-restoring checkpoints | planned | Rewind restores the conversation, not the files; Git-based restore is not built. |

Official-only and out of scope: the built-in IDE MCP server, Chrome automation, git worktrees,
cloud-session resume, dynamic workflows and Artifacts, terminal mode.

## Sources

- Official extension docs: <https://code.claude.com/docs/en/vs-code>
- Marketplace listing: <https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code>
- Checkpointing: <https://code.claude.com/docs/en/checkpointing>
