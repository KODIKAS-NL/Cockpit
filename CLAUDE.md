# CLAUDE.md — Project Directives

> Directives file read by Claude Code (and any agent) when working in this repository.
> Defines scope, architecture principles, conventions, and the feature catalog.

---

## 1. Product identity

| Field | Value |
|-------|-------|
| **Name** | Cockpit for Claude Code |
| **Authorship / Maintainer** | **Tootega Pesquisa e Inovação** (original author); this fork is maintained by **Jeroen Versteege (KODIKAS)**; Marketplace / Open VSX publisher `KODIKAS-NL`, repository `KODIKAS-NL/Cockpit` |
| **Type** | **Visual Studio Code** extension (GUI) plus **cockpit-daemon**, the background service that runs Claude (and, on a Mac, a menu bar app that runs the daemon). Works in VS Code, code-server and Remote-SSH |
| **License** | **MIT** (open source) |
| **Nature** | Interface and process keeper that operates **through the Claude Code CLI** — it does not reimplement the agent. The daemon only keeps the CLI process alive and shared between windows and devices |
| **Audience** | Developers who keep their code, and Claude Code, on one always-on machine (a Mac mini, a home server) and reach it from several devices (Remote-SSH, code-server, a phone through Remote Control), and want conversations that outlive the window. Also: a rich GUI with consumption transparency and fine-grained control |
| **Languages** | **Bilingual, mandatory**: pt-BR and **international English** (neutral, no US/UK regionalisms) |

### Founding principle

This UI is **only a presentation and control layer**. All orchestration — the agent loop, tool execution, subagents, todos, context management, compaction, permissions, MCP, hooks, skills — **lives in the Claude Code CLI**. The extension:

1. **Renders** the event stream the CLI emits.
2. **Captures** user input and implements the client side of the interactive protocols (permission approval, plan mode, answering questions).
3. **Never** reimplements the engine logic. If something about orchestration needs to change, that is the CLI's problem, not ours.

---

## 2. Architecture (summary)

```
┌───────────────────┐   stream-json   ┌───────────────────────┐   Unix socket   ┌───────────────────────┐
│ Claude Code CLI   │ ◀── stdin ───── │ cockpit-daemon        │ ◀── NDJSON ───▶ │ VS Code extension     │
│ (engine)          │ ─── stdout ───▶ │ (Node, on the machine │                 │ (one per window)      │
│ - agent loop      │                 │  that holds the code) │                 │ - Webview (React)     │
│ - tools, subagents│                 │ - spawns the CLI      │                 │   chat, Hub, stats,   │
│ - todos, context  │                 │ - keeps it alive and  │                 │   limits, diffs       │
│ - permissions,    │                 │   restarts it         │                 │ - Host (TypeScript)   │
│   MCP, hooks      │                 │ - Remote Control      │                 │   Session, parser,    │
└───────────────────┘                 └───────────────────────┘                 │   VS Code APIs        │
                                        ▲ other windows, and the phone          └───────────────────────┘
                                        │ (Remote Control), attach the same way
```

### The daemon (Claude runs in it, not in the window)

The Claude process is **not** a child of the extension host. It lives in **`cockpit-daemon`**, a
small background service on the machine that holds the code (launchd agent, or the Cockpit Daemon
menu bar app on a Mac). The extension talks to it over a Unix socket (NDJSON, `shared/daemon.ts`),
through `RemoteCliProcess`. The daemon spawns `claude` with the stream-json flags below, keeps it
alive across windows, devices and sleep, restarts it itself (keep-alive, auto-compact), and runs
Remote Control for the phone. Any window can attach to a running conversation. The founding
principle holds: the daemon only keeps the process alive and relays its events; orchestration is
still the CLI's. Every window attaches through `Session` → `RemoteCliProcess` → `DaemonClient`; the
host never spawns Claude itself. Details: `Docs/daemon-mode.md`.

### Two engines, one protocol

**`cockpitDaemon.tootegaEnabled` is the master switch** (off by default). Off, the local engine does
not exist for the installation: nothing spawns `agent.exe`, `cockpitDaemon.engine` is ignored and the
Engine picker hides itself (the host offers a single engine, and the UI renders the combo only
when there is a choice). On, `cockpitDaemon.engine` chooses the default binary and the per-tab
override comes back. `availableEngines()` / `tootegaEnabled()` in `src/cli/Engine.ts` are the
single source for both — do not read the setting directly elsewhere.

| engine | binary | what it brings |
|--------|--------|----------------|
| `claude` (default) | Claude Code CLI | account, subscription limits, plugins, skills, MCP |
| `tootega` | Tootega Code CLI (`tools/agent.exe` of TootegaEngine) | local model, no account, no cost, nothing leaves the machine |

They speak the **same process contract** — stream-json over stdin/stdout, the
shapes in `shared/events.ts` — so the founding principle holds for both: the UI
still does not reimplement orchestration, it just spawns a different engine.

What differs is only what exists *around* the conversation. `src/cli/Engine.ts`
holds that in one place (`engineCaps`): the local engine has no account, no
extensions and no cost, so those panels stay empty instead of failing. Cost
showing zero is not a gap — running locally costs nothing.

The Tootega engine needs its server up (`serve.cmd` in the TootegaEngine repo);
`cockpitDaemon.tootegaServer` says where it is.

**Primary channel with the engine:** `claude` in headless/streaming mode. The daemon builds the
argument list it is given by the window (`buildClaudeArgs` in `src/cli/CliProcessManager.ts`); the
core of it is:

```
claude -p --output-format stream-json --input-format stream-json --include-partial-messages \
       --permission-prompt-tool stdio --verbose --replay-user-messages
```

- `--output-format stream-json`: the CLI emits one JSON event per line (messages, tool_use, tool_result, usage, etc.).
- `--input-format stream-json`: allows sending messages and responses via stdin during the session.
- `--permission-prompt-tool stdio`: permission requests arrive as `control_request` events and are answered on stdin (the client side of the approval protocol).
- `--replay-user-messages`: the CLI echoes each prompt it takes in, which is how queued and other windows' messages are tracked.
- Resumable sessions via `--resume <session_id>` (the daemon adds it on every restart).
- Model, effort and permission mode switch **live** through control requests (`set_model`, `apply_flag_settings`, `set_permission_mode`), without ending the process.

**Complementary data sources** (statistics/account), described in the execution plan:
- **Statusline** hook (JSON with `model`, `context_window`, `cost`, `rate_limits` — current format: `limits[]` with `kind` = `session` | `weekly_all` | `weekly_scoped` and `scope.model.display_name`; legacy `five_hour`/`seven_day`/`seven_day_<model>` still parsed as a fallback).
- `/usage`, `/context`, `/cost` commands (or their programmatic equivalents).
- Session/transcript files in `~/.claude/`.

> **Recorded architecture decision:** the channel is the **CLI**, not the Anthropic API/Agent SDK directly. This keeps automatic parity with the official engine (auth, billing, subscription limits, new features) without reimplementing anything.

---

## 3. Technical stack

| Layer | Technology |
|--------|-----------|
| Extension (host) | TypeScript, VS Code Extension API |
| UI (webview) | React 18, bundled with esbuild, CSS with VSCode theme tokens (`var(--vscode-*)`) |
| Daemon | Node.js (`src/daemon/`, bundled to `dist/daemon.js`), no `vscode` dependency; Unix socket with NDJSON (`shared/daemon.ts`) |
| macOS app | Swift menu bar app that runs the daemon (`mac/CockpitDaemon/`), signed with a Developer ID and notarized |
| Webview ↔ host communication | `postMessage` / `acquireVsCodeApi()` |
| Host ↔ engine communication | Unix socket to `cockpit-daemon`, which spawns `claude` (`child_process`); NDJSON parser. The Tootega engine is spawned directly by the host |
| Diffs | Native VSCode diff API + custom webview rendering when needed |
| Testing | Vitest (unit and daemon integration, with a fake `claude` in `test/fixtures/`) |
| Packaging | `vsce` (Visual Studio Marketplace) and `ovsx` (Open VSX, for code-server); see `Docs/releasing.md` |

---

## 4. Feature catalog

**Origin** legend: `Claude GUI` = official Claude Code extension · `CLI` = engine capability to surface in the UI · `Cline` / `Roo·Kilo` / `Windsurf·Cascade` = feature seen in other agents that is worth incorporating · `Cockpit` = our own differentiator.
**Prio** legend: `P0` MVP · `P1` essential post-MVP · `P2` differentiator.
**Status** is not tracked here: what is implemented, partial or planned lives in [Docs/features.md](Docs/features.md). This catalog is the requirement list and its priorities.

### 4.1. Conversation and agent core

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| C1 | Chat with token-by-token streaming | Claude GUI | P0 |
| C2 | Render thinking blocks with toggle | CLI | P1 |
| C3 | Tool-call timeline (cards per tool, collapsible input/output) | Claude GUI | P0 |
| C4 | @-mention of files, folders, symbols | Claude GUI | P0 |
| C5 | Attach images / paste screenshot into the prompt | Claude GUI | P1 |
| C6 | Interrupt the agent at any time (stop) | CLI | P0 |
| C7 | Message queue (send follow-ups without waiting for a response) | Cline | P1 |
| C8 | Session history: list, resume, search, rename | CLI | P0 |
| C9 | Sort/filter sessions by date, **cost**, **tokens** | Cline | P2 |
| C10 | Subagents: view parallel threads and their progress | CLI | P1 |

### 4.2. Editing, diff, and human control

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| E1 | Side-by-side inline diff before writing | Claude GUI | P0 |
| E2 | Accept/reject change per file and per hunk | Roo·Kilo | P1 |
| E3 | Permission approval (Allow/Deny + Allow-always) | CLI | P0 |
| E4 | HITL mode vs. Agent-first mode (configurable auto-approve) | Roo·Kilo | P1 |
| E5 | Tool and command allowlist/denylist per session/project | Roo·Kilo / CLI | P1 |
| E6 | Plan mode: view, **edit**, and approve the plan before executing | Claude GUI | P0 |
| E7 | Plan preview with numbered steps and per-step approval | Windsurf·Cascade | P2 |
| E8 | Agent Todos panel (live list, status per item) | CLI | P1 |

### 4.3. Checkpoints and recovery

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| K1 | Automatic checkpoint before large changes | Claude GUI / Cline | P0 |
| K2 | Rewind from any message | Claude GUI | P1 |
| K3 | Restore modes: **Restore Files** · **Restore Files Only** · **Restore Files & Task** | Cline | P1 |
| K4 | Snapshot view (what changed in the checkpoint) | Cline | P2 |

### 4.4. Statistics, context, cache, and consumption *(a core part of the product)*

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| S1 | **Context window** meter: used / remaining / limit (200K · 1M) | CLI | P0 |
| S2 | **Context breakdown**: system prompt, tools, MCP, messages, files, todos, thinking | CLI (`/context`) | P1 |
| S3 | **Cache**: write tokens, read tokens, hit-rate, and estimated savings | CLI / API usage | P1 |
| S4 | **Cost**: per request, per session, and cumulative (tokens + $) | Cline / CLI (`/cost`) | P0 |
| S5 | Tokens per category: input, output, cache-create, cache-read | CLI | P1 |
| S6 | **Subscription limits**: 5h and 7d windows, % used, and reset time | CLI (`rate_limits`) | P0 |
| S7 | **Pacing** indicator (consumption rate vs. limit) | Statusline / Cockpit | P2 |
| S8 | Active model, effort, mode (plan/normal), workspace | CLI (statusline) | P0 |
| S9 | Alerts: context near the limit, imminent compaction, plan limit | Cockpit | P1 |
| S10 | Consumption history/charts over time (session and daily) | Cline / Cockpit | P2 |
| S11 | Visible **compaction** event (how much was condensed) | CLI | P2 |

### 4.5. Extensibility (surface what the CLI allows)

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| X1 | Slash commands (built-in + project/user custom) with autocomplete | CLI | P0 |
| X2 | Skills: list, describe, trigger | CLI | P1 |
| X3 | Custom subagents: list and select | CLI | P1 |
| X4 | MCP servers: status, exposed tools, connect/disconnect | CLI | P1 |
| X5 | Hooks: view configured ones and their triggers | CLI | P2 |
| X6 | `CLAUDE.md` / settings editor with validation | CLI | P1 |
| X7 | Persisted permission management (settings.json) | CLI | P1 |
| X8 | Plugins manager: browse, install, remove, enable, update, marketplaces | CLI | P1 |

### 4.6. Modes and productivity

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| M1 | Role-based modes (Code, Architect, Ask, Debug, Test) as presets | Roo·Kilo | P2 |
| M2 | Model and effort selector per session | CLI | P1 |
| M3 | Workspace awareness: open files, selection, terminal | Windsurf·Cascade | P2 |
| M4 | Project memory (persistent notes the agent consults) | Windsurf·Cascade | P2 |
| M5 | Multiple simultaneous sessions/tabs | Cockpit | P2 |
| M6 | Git worktrees integration (session per branch) | Cockpit | P2 |
| M7 | Voice dictation into the composer (speech-to-text, optional correction) | Cockpit | P2 |

### 4.7. Presentation and accessibility

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| P1 | Theme synced with VSCode (light/dark/high-contrast) | Claude GUI | P0 |
| P2 | Rich Markdown + syntax highlighting in code blocks | Claude GUI | P0 |
| P3 | Keyboard shortcuts and full keyboard navigation | Claude GUI | P1 |
| P4 | **Bilingual i18n: pt-BR + international English**, runtime switching, follows the VSCode locale | Cockpit | **P0** |
| P5 | Configurable UI density (compact/comfortable) | Cockpit | P2 |

### 4.8. Daemon and multi-device *(the reason this fork exists)*

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| D1 | Conversations run in `cockpit-daemon` and **outlive the window** (close the lid, drop the connection, reload) | Cockpit | **P0** |
| D2 | Any window on the machine **attaches** to a running conversation; the first answer to a prompt wins and closes it everywhere | Cockpit | **P0** |
| D3 | The daemon keeps the process alive and restarts it by itself (keep-alive, auto-compact limit, changed spec) without cutting a running turn | Cockpit | P1 |
| D4 | **Remote Control**: the phone or claude.ai/code joins the live conversation as one more client | CLI / Cockpit | P1 |
| D5 | Model, effort and permission mode **switch live**, with no restart | CLI | P1 |
| D6 | Side bar chat next to the code, and a Hub with live badges of running conversations | Cockpit | P1 |
| D7 | macOS menu bar app that runs the daemon (start at login, live log, signed and notarized) | Cockpit | P2 |

---

## 5. Code conventions

- **Language:** **English only** in the repository — identifiers, code, comments, documentation and commit messages. This is about the *source*; it does not affect the product, whose UI stays bilingual (see the i18n rule below).
- **Style:** follow the neighboring file's pattern (naming, comment density, language).
- **Do not reimplement the engine.** If you are tempted to replicate orchestration logic, stop — surface what the CLI already does.
- **Stream parsing:** version-tolerant — unknown events are ignored gracefully and never break the UI.
- **Security:** never log credential content; respect the CLI's permission model; do not bypass approval prompts.

- **Daemon protocol:** `shared/daemon.ts` is the contract between the extension and the daemon; the two ship separately (the `.vsix` and the Cockpit Daemon app), so a change that adds a message type or field must stay compatible with the other side, and the daemon app has to be rebuilt and reinstalled for daemon-side changes.
- **Sessions are not windows:** state that belongs to the conversation (auto-compact limit, spawn spec, Remote Control) lives in the daemon; state that belongs to a window (tab, scroll, drafts) lives in the extension.

### Repository layout

| Path | What is there |
|------|---------------|
| `src/extension.ts`, `src/panel/` | Extension entry, the chat view provider (the host side of the UI) |
| `src/session/` | `Session` (one conversation's runtime in a window), `SessionStore` (transcripts) |
| `src/cli/` | Engine contract (`CliProcess`), the daemon client (`RemoteCliProcess`), the Tootega runner (`CliProcessManager`), usage, models, plugins, auth |
| `src/daemon/` | `cockpit-daemon`: server, per-conversation sessions, client, install helpers |
| `shared/` | Types used by host, webview and daemon: `events.ts`, `protocol.ts`, `daemon.ts` |
| `webview/src/` | The React UI (`App.tsx`, `store.ts`, `components/`, `i18n/`) |
| `mac/CockpitDaemon/` | The Swift menu bar app and `scripts/build-app.sh` (sign and notarize) |
| `test/` | Vitest suites; `test/fixtures/fake-claude.mjs` stands in for the CLI |
| `l10n/`, `package.nls*.json` | Host strings and the manifest strings (en, pt-BR) |
| `Docs/` | User and design documentation |

### Commands

```
npm run build        # extension, daemon and webview (esbuild)
npm run watch        # the same, rebuilding on change
npm run typecheck    # host and webview
npm test             # Vitest
npm run vsix         # typecheck, bump the patch version, package the .vsix
npm run publish:marketplace / publish:openvsx    # see Docs/releasing.md
mac/CockpitDaemon/scripts/build-app.sh [--install]   # the macOS app
```

### i18n (mandatory rule)

- **Every user-visible string goes through i18n.** No hardcoded text in the UI — use translation keys.
- **Supported locales:** `pt-BR` and `en` (**international** English, neutral — vocabulary and date/number formats without US/UK bias).
- **Default language:** follows `vscode.env.language`; falls back to `en` when the locale is not supported. Manual override available in settings.
- **Runtime switching** (no extension reload).
- Catalogs: `l10n/` (`bundle.l10n.pt-br.json`, with `bundle.l10n.json` as the English base) via `vscode.l10n` on the host; `webview/src/i18n/` (`en.ts`, `pt-br.ts`) on the webview; `package.nls.json` / `package.nls.pt-br.json` for the manifest. The override is the `cockpitDaemon.language` setting.
- Pluralization and interpolation are handled by the i18n layer, never by string concatenation.

---

## 6. Non-goals (out of scope)

- Do not replace or compete with the official extension at 1:1 parity — the differentiators are **conversations that outlive the window and follow you across devices** (the daemon), plus **consumption transparency and fine-grained control**.
- Do not talk to the Anthropic API directly for the **agent loop** (the channel is the CLI). **Exception:** isolated utility calls authenticated with the local Claude.ai OAuth token (`~/.claude/.credentials.json`) are allowed when they are *clean* (only what the task needs — no agent system prompt, no tools, no MCP, no project context) and not part of the agent orchestration. Examples: `GET /api/oauth/usage` (real usage, same as `/usage`, no token spend); the speech-to-text WebSocket (`/api/ws/speech_to_text/voice_stream`, no token spend); and dictation text correction via `POST /v1/messages` with Haiku (spends *minimal* subscription tokens, but sends only the instruction + text — far cleaner/faster than a CLI one-shot, which has ~5s cold start and loads the full system prompt + tools/MCP every call). Never write or log credentials.
- Do not implement our own billing/payment — the account and limits are those of the user's Claude subscription.
- Do not store user data outside their machine.

---

## 7. Related documents

- [README.md](README.md) — what the extension is and how to start.
- [Docs/daemon-mode.md](Docs/daemon-mode.md) — the daemon: pieces, flows, wire protocol, operations.
- [Docs/remote-setup.md](Docs/remote-setup.md) — Remote-SSH, code-server and phone setup.
- [Docs/features.md](Docs/features.md) — what is implemented, partial or planned.
- [Docs/settings.md](Docs/settings.md) — settings, commands, shortcuts, slash commands.
- [Docs/development.md](Docs/development.md) — building, running from source, the event protocol.
- [Docs/releasing.md](Docs/releasing.md) — publishing to the Marketplace, Open VSX and GitHub.
- [Docs/execution-plan.md](Docs/execution-plan.md) — the original roadmap and requirements (historical: written for the Tootega original).
- [Docs/issues.md](Docs/issues.md) — open issues and known limitations.
