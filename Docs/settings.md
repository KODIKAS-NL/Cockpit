# Settings, commands and shortcuts

## Settings reference

All under **Settings → Extensions → Cockpit for Claude Code** (prefix `cockpitDaemon.`):

| Key | Type | Default | Description |
|---|---|---|---|
| `claudePath` | string | `claude` | Path to the Claude Code CLI executable |
| `language` | enum | `auto` | UI: `auto` (follows VS Code) / `pt-BR` / `en` |
| `dateLocale` | string | `""` | Locale for dates and times, for example `nl-NL` or `en-GB`. Empty: the region of the machine VS Code runs on (on a Mac, System Settings, Region), or, in a browser, the browser's own locale. Applies when a view is next opened |
| `model` | enum | `default` | Default model for new sessions; reflected in the panel dropdown |
| `effort` | enum | `default` | Default effort (`low`…`max`); `default` uses the CLI's `effortLevel` |
| `autoResumeLastSession` | boolean | `true` | On opening the folder, resume the most recent session for that directory |
| `permissionMode` | enum | `default` | Permission mode forwarded to the CLI (always sent, `default` included); reflected in the dropdown |
| `notifyOnComplete` | boolean | `true` | Notify when the agent finishes and the panel is not visible |
| `notifyOnPermission` | boolean | `true` | When Claude asks for permission and the chat is not visible, also show a notification with Allow and Deny. Answering in either place closes the other |
| `showThinking` | boolean | `false` | Expand *thinking* blocks by default |
| `verbosity` | enum | `verbose` | Timeline display level — `verbose` / `necessary` / `dialogo` / `quiet` (display only; see [Timeline verbosity](features.md#timeline-verbosity)) |
| `expandToolCards` | boolean | `false` | Expand tool cards by default in the timeline |
| `scrollOnSend` | boolean | `true` | Scroll the conversation to the end when you send a message |
| `spellCheck` | boolean | `false` | Inline PT-BR + EN spell-checker in the composer — **marks only, never auto-corrects**; click an underlined word for suggestions |
| `userName` | string | `""` | Name shown on your messages; empty = OS user |
| `internalModel` | enum | `claude-haiku-4-5` | Model for the Cockpit's internal AI calls (dictation correction, slash-command research) — clean, isolated calls; Haiku is fastest/cheapest |
| `voiceCorrect` | boolean | `false` | After stopping dictation, run a spelling/grammar pass with the internal model (clean one-shot). Opt-in |
| `voiceLanguage` | string | `""` | Dictation language (speech-to-text); empty follows the UI language |
| `ffmpegPath` | string | `""` | Path to ffmpeg used for voice capture; empty = `ffmpeg` from PATH |
| `systemPrompt.quiet` | string | quiet directive | Injected at the start of the system prompt: no narration during execution, no closing report. Empty = injects nothing |
| `systemPrompt.enabled` | boolean | `false` | Append your text to the CLI's system prompt on every start — see [Custom system prompt](features.md#custom-system-prompt) |
| `systemPrompt.text` | string | shell directive | Multi-line text appended to the system prompt; supports placeholders resolved against this machine |

> The limit meters now read **real** account usage via the OAuth `/usage` API
> (same source as the CLI's `/usage`), so no manual budgets are needed. The context
> meter limit is auto-derived from the active model (1M for `[1m]` variants and the natively-1M

## Commands and keyboard shortcuts

Commands (palette, **Tootega** category):

| Command | ID | Shortcut |
|---|---|---|
| Open Cockpit | `cockpitDaemon.open` | **Ctrl+Alt+C** (mac: Cmd+Alt+C) · also ✦ in the editor toolbar |
| New session | `cockpitDaemon.newSession` | **Ctrl+Alt+N** (in the panel) |
| Interrupt agent | `cockpitDaemon.interrupt` | **Ctrl+Alt+.** |
| **Reopen closed session** | `cockpitDaemon.reopenClosed` | **Ctrl+Shift+T** (when the Cockpit is focused) |
| **Focus waiting prompt** | `cockpitDaemon.focusPrompt` | none by default; opens the chat with a waiting permission prompt or question and focuses it |
| **Reload view** (fix gray/blank panel) | `cockpitDaemon.reloadView` | ↻ in the editor title bar + status bar |
| Sessions | `cockpitDaemon.openSessions` | — |
| Settings | `cockpitDaemon.settings` | — |
| Open in editor (resizable) | `cockpitDaemon.openInEditor` | — |
| Sign in / Sign out to Claude (CLI) | `cockpitDaemon.login` / `cockpitDaemon.logout` | — |
| Toggle language (pt-BR / English) | `cockpitDaemon.toggleLanguage` | — |
| **Set / Remove Anthropic API key** (model discovery, stored in the OS keychain) | `cockpitDaemon.setApiKey` / `cockpitDaemon.clearApiKey` | — |
| Enable / Disable real usage tracking | `cockpitDaemon.enableUsageTracking` / `...disableUsageTracking` | — |
| **Fix accents in PowerShell output** (install / remove the UTF-8 hook, Windows) | `cockpitDaemon.enableUtf8Fix` / `cockpitDaemon.disableUtf8Fix` | — |

### Accented characters in PowerShell output (Windows)

The Cockpit runs the CLI headless (stdio over pipes, **no console attached**). Without a
console, .NET falls back to the system **OEM code page** (e.g. 437) instead of UTF-8, so
`powershell` / `cmd` write their output in a legacy encoding — the CLI reads it as UTF-8 and
you get mojibake. Characters outside that code page (`ã` in CP 437) are *lost at write time*,
so no decoding fix on our side can recover them. In a terminal the problem is invisible
because the console is already at `chcp 65001`.

`Cockpit Daemon: Fix accents in PowerShell output` installs a `PreToolUse` hook in
`~/.claude/settings.json` (script at `~/.claude/.tootega/utf8-hook.ps1`) that prefixes every
**PowerShell** tool command with the UTF-8 encoding setup. It is idempotent, never blocks or
denies a command (any failure is a silent no-op), and is removed by the *Remove* command. No
system setting is changed and no reboot is needed. The **Bash** tool (Git Bash) is already
UTF-8 and is left untouched.

In the composer: **Enter** sends · **Shift+Enter** new line · **Ctrl+F** finds in the
conversation · **@** opens the file autocomplete · the **/** button opens the slash-command
menu · the **▾** button opens options · **drag files** onto it to attach.

On a session card in the dashboard, a small icon tab holds: **details** (always visible on the
active session), **remote control** (phone icon), **reload**, **rename** and **delete**. The others
show when you point at the card.

URI handler: `vscode://KODIKAS.cockpit-claude-code-daemon/open` opens the Cockpit.

## Slash commands

Slash commands are surfaced from the CLI (which exposes only their **names** via
`sessionInit`); the Cockpit adds curated categories and descriptions
([`webview/src/slashCatalog.ts`](../webview/src/slashCatalog.ts)). Commands **outside** the
curated catalog are auto-researched by the internal AI helper
([`SlashCommandResearch`](../src/cli/SlashCommandResearch.ts)) — category, short hint, and
detail in the UI language, cached globally in `~/.claude/tootega/` so each one is researched
only once. Third-party plugin commands group under **Plugin**; anything still unresolved
falls under **Other**.

| Category | Commands |
|---|---|
| Session | `resume` |
| Context | `clear`, `compact`, `context`, `memory` |
| Config | `model`, `config`, `permissions` |
| Tools | `review`, `init`, `mcp`, `agents`, `hooks` |
| Account | `login`, `logout` |
| Info | `cost`, `usage`, `status`, `help`, `doctor` |
| Plugin | third-party plugin commands (auto-grouped) |
| Other | anything still unresolved after auto-research |
