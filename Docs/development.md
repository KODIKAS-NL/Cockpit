# Development

Architecture, building, running from source, the event protocol and how to contribute.

## Architecture

```
┌────────────────────────────┐        stream-json (stdout)         ┌──────────────────────────────┐
│   Claude Code CLI          │ ──────────────────────────────────▶ │  VS Code extension           │
│   (engine)                 │                                      │  ┌────────────────────────┐  │
│   - agent loop             │ ◀────────────────────────────────── │  │ Webview (React + Vite) │  │
│   - tools, subagents       │     input + responses (stdin)        │  │ chat · timeline · stats│  │
│   - todos, context, cache  │                                      │  └────────────────────────┘  │
│   - permissions, MCP, hooks│                                      │  ┌────────────────────────┐  │
└────────────────────────────┘                                      │  │ Extension host (TS)    │  │
                                                                    │  │ spawn · NDJSON parser  │  │
                                                                    │  └────────────────────────┘  │
                                                                    └──────────────────────────────┘
```

Primary channel with the engine — `claude` in headless/streaming mode. The actual command
the host spawns (see [`src/cli/CliProcessManager.ts`](../src/cli/CliProcessManager.ts)):

```bash
claude -p \
  --output-format stream-json \
  --input-format stream-json \
  --include-partial-messages \
  --permission-prompt-tool stdio \
  --verbose \
  --permission-mode <mode> [--model <id>] [--effort <level>] [--resume <session_id>]
```

- `--output-format stream-json`: the CLI emits **one JSON object per line** (messages,
  `tool_use`, `tool_result`, `usage`, `control_request`, etc.).
- `--input-format stream-json`: lets the host send messages and control responses via
  stdin during the session.
- `--include-partial-messages`: enables token-by-token streaming (`stream_event`).
- `--permission-prompt-tool stdio`: routes permission decisions through the control
  protocol; without it, headless mode silently denies tools. This is also how
  **AskUserQuestion** reaches the UI.
- `--permission-mode` is **always** sent, `default` included: since CLI 2.1.285 a `-p`

The stream parser ([`src/cli/StreamParser.ts`](../src/cli/StreamParser.ts)) is
**version-tolerant**: unknown events are ignored without breaking the UI.

> **Architecture decision:** the channel is the **CLI**, not the Anthropic API / Agent SDK
> directly. This keeps automatic parity with the official engine (auth, billing,
> subscription limits, new features) without reimplementing anything.

## Prerequisites

| Requirement | Version | Note |
|---|---|---|
| VS Code | ≥ 1.90 | `engines.vscode` in the manifest |
| Node.js | ≥ 20 | Needed only for build/dev |
| Claude Code CLI | recent | `claude` on the `PATH`, **authenticated** |
| Git | any | Recommended for checkpoints (planned) |

Tested against Claude CLI **2.1.x** (aligned with `2.1.223`; screenshots show `2.1.177`). The
parser is version-tolerant — unknown stream events are ignored gracefully — but the event
contract can vary between versions, see [Known limitations](../README.md#known-limitations).

On **Windows**, `claude` is typically a `.cmd` shim. Node 22+ refuses to execute it
without a shell (CVE-2024-27980 mitigation), so the host spawns it with `shell: true`.
If the CLI was installed by the **native installer** into `~/.local/bin` (which is not
always on the `PATH` on Windows), the host probes that location automatically and uses the
first `claude` that answers `--version`.

## Run in development (without installing)

Opens VS Code in an **Extension Development Host**, loading the extension straight from
source — nothing is installed permanently.

**Windows (PowerShell):**

```powershell
./run-dev.ps1
./run-dev.ps1 -OpenPath "C:\path\to\project"   # open pointing at a project
./run-dev.ps1 -Watch                           # recompile on save
```

**Windows (cmd):**

```bat
run-dev.cmd
run-dev.cmd C:\path\to\project
```

**macOS / Linux (bash):**

```bash
./run-dev.sh                       # test window without a folder
./run-dev.sh /path/to/project      # open pointing at a project
./run-dev.sh --watch               # recompile on save
./run-dev.sh --code code-insiders  # use VS Code Insiders
```

**Via VS Code:** open this folder and press `F5` (the *Run extension (dev)* configuration
in [`.vscode/launch.json`](../.vscode/launch.json)).

In the test window, open the Cockpit with **Ctrl+Alt+C**, the **Cockpit** item in the
status bar, or the palette (`Ctrl+Shift+P` → *"Cockpit Daemon: Open Cockpit"*).

## Build and packaging (.vsix)

```bash
npm install
npm run build        # compiles host + webview into dist/ (esbuild)
npm run typecheck    # type-checks both tsconfigs (host + webview)
npm test             # unit tests (Vitest)
npm run package      # bump patch + build + produce the .vsix (requires @vscode/vsce)
```

Available scripts ([`package.json`](../package.json)):

| Script | Does |
|---|---|
| `build` | `node esbuild.mjs` — bundles `extension.js`, `daemon.js`, `webview/main.js`, `scratchpad/main.js` + CSS, and copies the scratchpad fonts |
| `watch` | build in watch mode |
| `typecheck` | `tsc --noEmit` over both tsconfigs (host and webview) |
| `test` / `test:watch` | Vitest |
| `vscode:prepublish` | production build (`esbuild.mjs --production`) |
| `package` | `npm version patch` → build → `vsce package` |
| `vsix` | typecheck → bump → build → `vsce package` |

On Windows there are also `package-vsix.ps1` / `package-vsix.cmd` as shortcuts; on
macOS/Linux use `./package-vsix.sh [out.vsix]`. For the dev host, `./run-dev.sh` mirrors
`run-dev.ps1`.
Build output lands in `dist/` (`extension.js`, `daemon.js`, `webview/main.js`, `webview/main.css`, and the scratchpad bundle in `scratchpad/`).
Packaging boundaries are controlled by [`.vscodeignore`](../.vscodeignore) — only `dist/`,
`l10n/`, `media/`, `package.nls*.json`, `LICENSE`, and `README.md` ship in the `.vsix`.

## Project structure

```
src/                  Extension host (TypeScript)
  extension.ts        Activation, commands, config listeners, URI handler, status bar
  cli/                Spawn, stream-json parser, model discovery, statusline, settings
  panel/              ChatViewProvider (host ↔ webview bridge; editor panel + hub view)
  session/            Session (one conversation's runtime in a window), session store, usage aggregation
  daemon/             cockpit-daemon (Node, no vscode): server, per-conversation sessions, client
  scratchpad/         Scratchpad panels (host side): store in ~/.cockpit/scratchpads, messages, live reload
  stats/              Context/cache/cost/tokens aggregator
  i18n/               Host i18n
  util/               Logger
webview/              UI in React (bundled with esbuild)
  scratchpad/         The scratchpad page (Excalidraw), its own bundle, loaded on demand
  src/components/     Composer, Timeline, DiffView, modals, Todos, etc.
  src/i18n/           en / pt-BR catalogs
  src/store.ts        Webview state
  src/slashCatalog.ts Curated slash-command metadata
shared/               Event contract and host ↔ webview protocol
l10n/                 Runtime strings (vscode.l10n)
media/                Icons
mac/CockpitDaemon/    The macOS menu bar app that runs the daemon
package.nls*.json     Manifest strings
test/                 Vitest unit tests (StreamParser)
Docs/                 Planning, comparison with the official GUI, status
images/               Screenshots used in the README and the docs
```

Communication:
- **Webview ↔ host:** `postMessage` / `acquireVsCodeApi()` (protocol in
  [`shared/protocol.ts`](../shared/protocol.ts)).
- **Host ↔ engine:** `child_process` (spawning `claude`) + NDJSON parser
  ([`shared/events.ts`](../shared/events.ts)).

## Event stream and control protocol (developer deep-dive)

The host spawns `claude` once per session and speaks **stream-json** over stdin/stdout. The
parser ([`src/cli/StreamParser.ts`](../src/cli/StreamParser.ts)) splits NDJSON and tolerates
noise; unknown event types are dropped rather than crashing the UI.

**Outbound (host → CLI)**, written one JSON object per line:

- Right after spawn, a control handshake enables interactive routing and returns the slash
  command list:
  ```json
  {"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}
  ```
- A user turn:
  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
  ```
  Pasted images add `{"type":"image","source":{"type":"base64","media_type":"…","data":"…"}}`
  blocks to `content`.
- A permission decision (reply to `can_use_tool`):
  ```json
  {"type":"control_response","response":{"subtype":"success","request_id":"…","response":{…}}}
  ```
  `allow` requires `updatedInput` (the CLI validates with Zod — replying just
  `{behavior:"allow"}` fails the union). "Always allow" returns `updatedPermissions` from
  the CLI's `permission_suggestions`. Deny sends `{behavior:"deny", message}`.

**Inbound (CLI → host)** event types the UI consumes: `system` (incl. `init` with the
active model), `assistant` / `user` messages, `result`, `stream_event` (partial tokens),
and `control_request` (`can_use_tool`, which carries both tool-permission prompts and
**AskUserQuestion**).

**Interrupt** ends the CLI process and **kills the whole tree** so no orphaned child
(e.g. a `node` subagent) keeps running: on Windows (`shell: true`) via `taskkill /T`; on
macOS/Linux the CLI is spawned `detached` (its own process group) and killed with
`process.kill(-pid)` (SIGTERM, then SIGKILL after a grace period). The process respawns on
the next send. **Resume** re-arms `--resume <session_id>` and
replays the transcript read from `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (the cwd is
encoded by mapping `:` `\` `/` → `-`).

## Non-goals

- Do not compete with the official extension at 1:1 parity — the differentiator is
  **consumption transparency and fine-grained control**.
- Do not talk to the Anthropic API directly **for the agent loop** — that channel is the
  **CLI**. The only exception is a few **clean, isolated** utility calls with the local OAuth
  token (real usage, voice STT, dictation correction); see
  [Cockpit-exclusive features](features.md#cockpit-exclusive-features) and [`CLAUDE.md`](../CLAUDE.md) §6.
- Do not implement our own billing — the account and limits are the user's subscription.
- Do not store user data off their machine.

## Contributing

- **English only** in the repository: identifiers, code, comments, documentation and commit messages. The product itself stays bilingual (pt-BR and English).
- Follow the neighboring file's pattern (naming, comment density, language).
- **Do not reimplement the engine.** If you are tempted to replicate orchestration, stop
  and surface what the CLI already does.
- Every visible string goes through i18n.
- Before a PR: `npm run typecheck && npm test && npm run build`.

Related documents: [`CLAUDE.md`](../CLAUDE.md) ·
[`Docs/FAQ.md`](FAQ.md) ·
[`Docs/execution-plan.md`](execution-plan.md) ·
[`Docs/implementation-status.md`](implementation-status.md).
