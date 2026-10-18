# Features

What the extension does, section by section. For a comparison with the official extension see
[comparison.md](comparison.md); for settings and commands see [settings.md](settings.md).

## Feature tables

Legend: ✓ implemented · partial · planned. The full requirements and priority catalog is in
[`CLAUDE.md`](../CLAUDE.md) and [`Docs/`](.).

### Conversation and agent core

| Feature | Status | How to use | Limitations |
|---|---|---|---|
| Token-by-token streaming chat | ✓ | Type and send; the answer appears incrementally | — |
| *Thinking* blocks with toggle | ✓ | Expand in the chat; default controlled by `cockpitDaemon.showThinking` | Only appears if the model/effort emits thinking |
| Tool-call timeline (expandable cards) | ✓ | Click a card for input/output; default via `cockpitDaemon.expandToolCards` | Inline diff in the editor not yet (rendered in the webview) |
| **Sandbox denials on the Bash card** | ✓ | An access the sandbox refused shows in an amber band above the output — the cause of the failure, not just its effect | The CLI only annotates the result with them from 2.1.224; recognised by shape, so a line we don't recognise stays in the output where it always was |
| Interrupt the agent (Stop) | ✓ | **Stop** button or **Ctrl+Alt+.** | Stops by ending the CLI process; it respawns on the next send |
| Session history: list, resume, rename | ✓ | The **Sessions** list in the dashboard; click to resume. The icons on a card open its details, start remote control, reload the view, rename and delete it | Advanced search partial |
| **Rewind** from a prompt | ✓ | Rewind button on a prompt — truncates the transcript at that point and re-arms `--resume` | Restores the conversation, not the files on disk (Git checkpoints still planned) |
| **Elapsed time** per turn | ✓ | Shown live on the gauge and again at the end of the turn | — |
| Subagents (parallel threads) | partial | Rendered when the CLI emits them | A dedicated parallel view is planned |
| Message queue (follow-ups) | ✓ | Send while a turn is running: the CLI queues it and the prompt shows as queued until it is picked up | — |

An expanded Edit card in the timeline:

![An Edit card with its diff, expanded in the timeline](https://raw.githubusercontent.com/KODIKAS-NL/Cockpit/master/images/tool-card.png)

### Editing, diff, and human control

| Feature | Status | How to use | Limitations |
|---|---|---|---|
| Permission approval (Allow / Always / Deny) | ✓ | Per-tool modal with preview (Bash, Write, WebFetch, JSON); **Ctrl+Enter** = allow, **Esc** = deny | — |
| **Invisible characters exposed in the command** | ✓ | Zero-width, bidi overrides, non-ASCII spaces, tab padding and C0 controls show as a marked glyph (hover gives `U+XXXX NAME`), with a warning above the command | Applies to the command preview; other previews show the raw text |
| Permission modes (HITL ↔ auto) | ✓ | **Permission** dropdown (`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`) | `bypassPermissions` disables approvals — use with care |
| **Plan mode** (view, **edit** and approve a plan) | ✓ | `ExitPlanMode` permission with **Edit/Preview** toggle and a **maximize** toggle for long plans; **Approve & run** or **Keep planning (send my notes)** feeds your edits back | — |
| Composed questions (AskUserQuestion) | ✓ | Modal with tabs per question, option cards, `multiSelect`, an **Other** option, and a **text box per question** that is added to that question's choices (**Enter** sends, **Shift+Enter** new line) | — |
| Side-by-side diff in the native editor | ✓ | **Open diff in editor** button on the edit-permission modal → VS Code `vscode.diff` | Editing inside the native diff to change the proposal is still in the webview path |
| **@-mention file autocomplete** | ✓ | Type `@` to pick a workspace file (fuzzy) | No `Alt+K` line-range shortcut |
| **Share editor selection** | ✓ | Composer chip (`@file#a-b`) with an eye toggle to include/exclude | — |
| **Auto-save before read/write** | ✓ | Flushes a dirty buffer before the agent reads/writes (`cockpitDaemon.autosave`) | — |
| Accept/reject per file and per hunk | planned | — | — |
| Agent Todos panel | partial | The **Tasks** tab shows the live task list | Depends on the CLI emitting todos |

A multiple-choice question from the agent:

![The question dialog](https://raw.githubusercontent.com/KODIKAS-NL/Cockpit/master/images/question.png)

### Checkpoints and recovery

| Feature | Status | Note |
|---|---|---|
| Automatic checkpoint before large changes | planned | Planned (Git) |
| Rewind from any message | partial | Truncates the transcript and re-arms `--resume` (conversation rewind); file restore via Git still planned |
| Restore Files / Files Only / Files & Task | planned | — |

### Statistics, context, cache, and consumption

| Feature | Status | How to use | Limitations |
|---|---|---|---|
| **Context window** meter (used / remaining / limit) | ✓ | Bar at the top of the dashboard, with color bands; 200K or 1M limit. `CLAUDE_CODE_DISABLE_1M_CONTEXT` (environment or the `env` block of user/project settings) caps it at 200K, where the CLI auto-compacts | Limit auto-derived from the active model when the engine doesn't report its own |
| **Engine warnings** (fast-mode credits, restricted subagent model) | ✓ | banner in the timeline, once per session | Recognised by shape from `system` events — a warning the CLI stops emitting simply stops appearing |
| **Cache**: hit-rate, read, write | ✓ | Cache section under the (i) of the active session | — |
| **Cache life** countdown + **keep-alive** ([`CacheKeeper`](../src/cli/CacheKeeper.ts)) | ✓ | Bar showing how much of the prompt cache's 1 h TTL is left (shown while keep-alive is off). Ticking **Keep cache alive** re-arms it before expiry with a headless one-shot, so a session you step away from doesn't pay a full cache re-write on the next turn | The refresh costs one minimal turn; the TTL is the CLI's, not ours |
| **Estimated cache savings** | ✓ | **Est. savings** in the cache section under the (i): what the cache-read tokens would have cost billed at the full input rate | Estimate, same caveat as Cost |
| **Cost** per turn and session | partial | Cost section under the (i) ("estimated" label) | Estimate, not the official invoice |
| Tokens in / out / cache-create / cache-read | ✓ / partial | Tokens section under the (i) | Full breakdown partial |
| **Subscription limits** (current session, weekly, per-model weekly) | ✓ | Meters in the panel, fed by the real OAuth `/usage` API (same source as `/usage`) | Statusline complements it during low usage — see [statusline](#real-account-usage-statusline) |
| **Usage attribution** (long context, subagents, cache hit-rate, context per tool/MCP) | ✓ | "Where your tokens went" section in the Usage dialog | Estimated from local transcripts; `tool_result` tokens approximated at ~4 chars/token |
| **Global token counter** (all-time + per day) | ✓ | **Tokens (global)** block in the Usage dialog: sent, received and total across every project on this machine, with a day-by-day bar history | Machine-local only (this device's transcripts); does not include other devices |
| **7-day spend by model** | ✓ | **Breakdown** in the Usage dialog, with new vs. cache-read tokens per model | Equivalent API price — on a subscription you are not charged this |
| **Turn timing** segmented by (model, effort, type) | ✓ | Sample counts per segment; debounced flush with a cross-process lock (atomic merge) | — |
| **Session duration**, **turn count**, **peak context** | ✓ | Session activity section under the (i): wall-clock duration, turns completed, and the high-water mark of context (with the cache figure at that moment) | — |
| Context-near-limit alert | ✓ | Automatic warning above ~85% | — |
| **Visible compaction** (S11) | ✓ | While it happens the indicator says *"Compacting the context…"* instead of looking stuck; the `compact_boundary` closes it with a blue band in the timeline: `before → after · −condensed · duration` | The sizes are the CLI's own (`compact_metadata`); a field it stops sending just disappears from the band |
| Context **breakdown** via `/context` | planned | — | UI ready, data source pending |
| Historical consumption charts | planned | — | — |
| Active model / effort / mode | ✓ | Dropdowns in the panel + status bar | — |

Session details (created, updated, messages, size, model, id, and for the active session its tokens, cache, cost and activity) are under the (i) icon on its card in the Sessions list.

#### The cache, the context and the token counters

The CLI knows most of this but does not show it. Four of these need work the CLI does not do for you:

**1. The prompt cache as a resource you manage, not just observe.**
Every GUI can show a cache hit rate after the fact. The Cockpit prices it — **Est. savings**
is what those cache-read tokens would have cost at the full input rate — and, more usefully,
lets you *keep* it: the **Cache life** bar counts down the 1 h TTL, and ticking **Keep cache
alive** re-arms it with a minimal headless turn before it lapses. Walking away from a large
session normally means the next prompt re-writes the whole cache; this is the difference
between paying cache-read and paying cache-write on a 500 K-token context.

**2. Where the context actually went.**
**Context injected per tool** ranks Bash, Read, Edit, Grep and MCP by the tokens each pushed
into the window, with call counts. When a session fills up faster than expected, this names
the culprit instead of leaving you to guess — usually one chatty tool. MCP servers are
grouped so a noisy server stands out as one row.

**3. A token counter that outlives the session.**
**Tokens (global)** is all-time and machine-wide: sent, received and total across *every*
project in `~/.claude/projects`, with a per-day history. The CLI's own `/usage` answers "how
much of my plan is left this week"; this answers "how much have I actually run through this
tool, ever, and on which days". It is built from an incremental rollup of the transcripts,
so it is cheap to recompute and survives every session you have ever run.

**4. Peak context, not just current context.**
A context meter that only shows *now* hides the spike that triggered compaction.
**Session activity** keeps the high-water mark — with the cache figure at that moment —
alongside duration and turn count.

> **Honest about the numbers:** the USD figures are the *equivalent API price*, computed
> locally from a price table — on a subscription you are not charged them, and they are
> labelled as estimates throughout. `tool_result` tokens are approximated at ~4 chars/token.
> Everything derived from transcripts covers **this machine only**. The one set of figures
> that is not an estimate is the subscription limits, which come from the same OAuth
> `/usage` API the CLI itself uses.

### Extensibility (surfacing what the CLI exposes)

| Feature | Status | Note |
|---|---|---|
| Slash commands (built-in + custom) with autocomplete | ✓ / partial | Curated catalog (context, session, config, tools, account, info); the CLI exposes only names via `sessionInit`, descriptions are curated |
| **Plugins manager** (browse / install / remove / enable / disable / update + marketplaces) | ✓ | **Plugins** in the Hub — see [Plugins](#plugins) |
| **Skills: listing cost, loaded state, per-skill listing control** | ✓ | **Skills** in the Hub — see [Skills](#skills) |
| Custom subagents: list / select | planned | — |
| **MCP servers: health / tools / pending approval** | ✓ | **MCP** in the Hub: a card per server with its live status and the tools it exposes; `Pending approval` (unapproved `.mcp.json`) is surfaced. Connecting/approving is still done in the CLI (`/mcp`) |
| Hooks: view configured ones | partial | `/hooks` forwarded to the CLI |
| `CLAUDE.md` / settings editor | planned | — |

### Presentation and accessibility

| Feature | Status |
|---|---|
| Theme synced with VS Code (light/dark/high-contrast via `var(--vscode-*)`) | ✓ |
| Rich Markdown + syntax highlighting (highlight.js) | ✓ |
| Keyboard shortcuts | ✓ |
| **Bilingual i18n** pt-BR + English, runtime switching | ✓ |
| Configurable UI density | planned |

### Prompt history

Browse previous prompts and the session stream directly in the panel.

### Delete session

Deleting a session removes the transcript from disk — an **irreversible action**, guarded
by a confirmation.

## Cockpit-exclusive features

Features that go beyond showing what the CLI does. Most rely on a deliberately narrow exception to the "CLI-only" rule: a handful of **clean,
isolated** calls authenticated with the local Claude.ai OAuth token
(`~/.claude/.credentials.json`). These are **not** the agent loop — they send only what the
task needs (instruction + text), with **no** agent system prompt, tools, MCP, or project
context, and **never** write or log credentials.

| Feature | What it does | Channel |
|---|---|---|
| **Scratchpad** (Excalidraw board per conversation) | Annotate screenshots and sketch, then attach the result to the prompt — see [Scratchpad](#scratchpad) | Local (no tokens until you send the image) |
| **Voice dictation** (speech-to-text) | Dictate straight into the composer — see [Voice dictation](#voice-dictation) | OAuth STT WebSocket (same service as the CLI's `/voice`); **no** token spend |
| **Dictation correction** | **Opt-in** (default off) spelling/grammar pass after you stop dictating; a clean one-shot (instruction + text only, ~1.7 s) | Anthropic Messages API with the internal model (`cockpitDaemon.internalModel`, default Haiku) |
| **Internal AI utility helper** ([`AiClient`](../src/cli/AiClient.ts)) | Shared, clean one-shot helper for the Cockpit's own utility calls (dictation correction, slash-command research). Avoids the CLI one-shot's ~5 s cold start + full system prompt/tools | Anthropic Messages API (OAuth), isolated |
| **Slash-command auto-research** ([`SlashCommandResearch`](../src/cli/SlashCommandResearch.ts)) | Categorizes/labels **unknown** slash commands (category, short hint, detail) in the UI language; results cached globally in `~/.claude/tootega/` so each command is researched only once | Internal AI helper |
| **Plugins manager** ([`PluginManager`](../src/cli/PluginManager.ts)) | Browse/install/remove/enable/disable/update plugins + marketplaces; canonical URL and kind badge per plugin resolved once by the internal helper and cached — see [Plugins](#plugins) | CLI (`claude plugin …`) + internal AI helper for URL/kind |
| **Timeline verbosity** | Display-only filter (verbose / necessary / dialogo / quiet) that collapses tool noise — see [Timeline verbosity](#timeline-verbosity) | Local |
| **Minimum-effort gate** ([`RepoDirectives`](../src/session/RepoDirectives.ts)) | A folder can pin a minimum reasoning effort via a `CLAUDE.md` tag (`<!-- **enffort=max** -->`); on send, if the selected effort is below the folder's floor the Cockpit asks to confirm | Local (reads `CLAUDE.md`) |
| **Prompt rewind** | Rewind to an earlier prompt: truncates the transcript and re-arms `--resume` | Local |
| **Rename context** | Rename a saved session from its card; updates the open webview title | Local |
| **Per-turn elapsed time** | Live on the gauge and again at the end of each turn | Local |
| **Prompt-cache keep-alive** ([`CacheKeeper`](../src/cli/CacheKeeper.ts)) | Opt-in per session: re-arms the cache's 1 h TTL before it lapses so an idle session doesn't pay a full cache re-write on the next prompt | Headless one-shot resume (minimal turn) |
| **All-time global token counter** ([`DailyTokens`](../src/stats/DailyTokens.ts)) | Sent / received / total across every project on this machine, with a per-day history; incremental rollup over `~/.claude/projects/**/*.jsonl` | Local (reads transcripts) |
| **Real account usage** | Session / weekly / per-model meters fed by the real OAuth `/usage` API (no manual budgets) | OAuth `/usage`; **no** token spend |
| **Statusline real-usage wrapper** | Reversible wrapper that caches `rate_limits` / `context_window` and re-invokes your original statusline — see [statusline](#real-account-usage-statusline) | Local (Windows) |

> **Why the exception is safe:** these calls are *clean and isolated* and sit outside agent
> orchestration. The agent loop, billing parity, and subscription limits stay 100% on the
> CLI. The OAuth token is **read-only**; `/usage` and STT spend **no** tokens, and the
> dictation correction spends only *minimal* subscription tokens (instruction + text). See
> [`CLAUDE.md`](../CLAUDE.md) §6 for the recorded decision.

## Scratchpad

A whiteboard tied to a conversation, for the things that are easier to show than to type.

- **Open it** from the pencil button in the prompt box, from **Annotate** in the image viewer (the
  image is placed on the board), or with **Cockpit Daemon: Open scratchpad**. It opens as its own
  editor tab, one per conversation.
- **Draw** with the full Excalidraw toolset: pen, shapes, arrows, text, images, eraser, zoom and undo.
  Mouse, trackpad and touch/Apple Pencil input work, including in code-server on the iPad. The canvas
  is always white, whatever the VS Code theme, because the board is exported as a PNG on white. The
  interface is in English or Portuguese.
- **Start from an image.** **From clipboard** places the image on the clipboard on the board, and
  **Latest chat image** places the newest image sent in the conversation. Nothing is inserted unless
  you press the button.
- **Send to chat** exports the board as a PNG and attaches it to the prompt box of the conversation.
  Nothing reaches Claude until you press send, and Claude only ever sees what you send, never the
  live board. **Save PNG** writes the image to disk. **New board** (click twice) clears it.
- **Saved with the conversation** in `~/.cockpit/scratchpads/<session id>.excalidraw.json`, so every
  VS Code server of that user on the machine (code-server and Remote-SSH alike) sees the same boards.
  A board open in two windows updates when the other saves; the last save wins. Deleting a
  conversation deletes its board. A board drawn before the conversation has a session id is kept
  under the tab and adopted when the id appears.
- **Not included:** Excalidraw's shape library is hidden (a library implies something permanent
  outside the conversation), and the CJK handwriting font is left out to keep the download small.
- The board is a separate bundle (`dist/scratchpad/`, about 4 MB packed) that loads only when a
  board is opened.

## Models, effort and sessions

- **Model** and **Effort** are *session overrides* (they do not change global settings);
  switching restarts the CLI session.
- **The model list is not hardcoded anywhere.** The CLI has no `models` subcommand, so the
  catalogue comes from **`/v1/models`** — id, `display_name` (the label shown),
  `max_input_tokens` (the context column, and what decides the `[1m]` suffix) and
  `created_at` (newest first). A model released to your account appears on its own, with no
  extension update.
  - The credential is the API key set via **Cockpit Daemon: Set Anthropic API key** (OS keychain),
    `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, or — on **subscription** accounts with no
    API key — the CLI's own OAuth token. `GET /v1/models` spends no tokens.
  - The last successful answer is cached (globalState) and is what the picker shows while
    offline or before discovery replies, instead of a list that goes stale.
  - `default` (no `--model` flag) and the **Custom…** field (any id, validated by the CLI on
    spawn) are the only entries the extension itself contributes.
- **Default (…)** in the picker is not ours either: it is `model` from
  `~/.claude/settings.json` (re-read on every session init, so a change made with the CLI's own
  `/config` shows up without reloading the window), or the default observed in the `init` of a
  session with no per-tab override.
- **Effort** is a fixed CLI enum: `low / medium / high / xhigh / max`.
- **Engine** — `cockpitDaemon.tootegaEnabled` is the master switch for the local **Tootega Code**
  engine, **off by default**. Off, the Cockpit runs on Claude Code alone: nothing spawns
  `agent.exe`, `cockpitDaemon.engine` is ignored and the Engine combo is not rendered (the host
  offers a single engine, and a one-option picker is noise). On, the combo returns and each tab
  can be pinned — N Claude tabs plus one Tootega tab, which needs the TootegaEngine server up
  (`serve.cmd`; `cockpitDaemon.tootegaServer` says where).

## Remote Control

Continue a Cockpit conversation from your phone or from `claude.ai/code`. The phone-icon button — on the
session card in the Hub and in the composer — starts it.

**Why it is a terminal, not a slash command.** `/remote-control` only exists in an *interactive*
session. The Cockpit's session is headless (`-p --input-format stream-json`, which is what gives
us the event stream), and there the CLI answers *"/remote-control isn't available in this
environment"* — the command isn't even in that session's `slash_commands` (measured on 2.1.223).
So the Cockpit hands the conversation over the way the CLI does support it.

What the button does:

1. **Stops the tab's headless process.** Two processes owning one session would duplicate the
   context on disk.
2. **Opens a visible terminal** with `claude --remote-control --resume <session-id>` — an
   interactive session that continues *this* conversation and prints the pairing URL/QR.
3. **Keeps the timeline following.** The interactive session writes to the same transcript, so
   the tab repaints from it while the remote session runs: local history and remote turns side
   by side.
4. **Steps the composer aside.** The button turns green; typing in the Cockpit is refused with an
   explanation and reveals the terminal instead of respawning a process over the conversation.
5. **Clicking again turns it off** (same toggle as the official extension): the terminal closes
   and the Cockpit drives the conversation again. Nothing is lost — the next message resumes it.
   Closing the terminal by hand does the same.

**The button says what is known, not what was hoped for.** Spawning the terminal is not proof
that the session came up, so the state is *confirmed*: the CLI registers every running process in
`~/.claude/sessions/<pid>.json`, and [`SessionRegistry`](../src/cli/SessionRegistry.ts) looks for
this conversation there (checking the pid is really alive — a hard kill leaves the file behind).
The button is **amber and pulsing** while connecting, **green** once the process is registered,
and **red** if it never appeared (45s) or disappeared after being up. A failure leaves the
terminal open — it holds the reason (login, network, a CLI error) — and the next click
reconnects instead of toggling off. Assuming success was the bug the official extension fixed in
2.1.224; the fix here is the same one, at the same place.

Requirements are the CLI's, not ours: Remote Control needs a **claude.ai login** (an
`ANTHROPIC_API_KEY` in the environment, or an `ANTHROPIC_BASE_URL` outside `api.anthropic.com`,
disables it), and the local process must stay alive while the remote session is connected.

## Plugins

A full **plugins manager** ([`src/cli/PluginManager.ts`](../src/cli/PluginManager.ts),
[`PluginsModal`](../webview/src/components/PluginsModal.tsx)), opened from the **Plugins**
entry in the Hub. Everything goes through the official CLI (`claude plugin …`) — the Cockpit
only surfaces it:

- **List** installed + available plugins (across configured marketplaces) and filter by
  **All / Installed / Available**; search by name; sort exposes install counts.
- **Actions:** install (with scope), uninstall, enable, disable, update.
- **Marketplaces:** add (URL, `owner/repo`, or local path) and remove.
- **Enrichment:** each plugin shows a **kind** badge (skills · agents · commands · MCP ·
  hooks · mixed) and a canonical **URL**. The kind of *installed* plugins is computed
  precisely from local components; URL + kind for the rest are resolved once by the internal
  AI helper (Haiku) and **cached** in `~/.claude/tootega/plugin-urls.json` (**Refresh** can
  force re-validation). Best-effort — failure keeps the derived values.

## Skills

Skills are cheap until they aren't: every skill the CLI knows keeps its **name + description**
in the context of every turn, and a skill that is actually *triggered* injects its whole
`SKILL.md` body. The **Skills** entry in the Hub
([`SkillsModal`](../webview/src/components/SkillsModal.tsx)) makes both visible.

The panel keeps **two axes side by side**: the dropdown *configures* what enters the listing,
and the label next to it *observes* what is actually in the context — `light`, `⚡ loaded`, or
`off · resident`. Header totals show `skills` · `metadata` · `loaded`, and rows are grouped
by origin (project · user · built-in) with filter chips.

Colour carries meaning rather than decorating: one hue per **origin**, shared by the chip, the
group header, the row's side rule and its badge, so a column reads at a glance. Each row has a
2px **weight bar** — its cost relative to the most expensive skill in the listing. A row you
switch off is dimmed (and brightens on hover, so its former cost stays readable); `off ·
resident` is never dimmed, because an alert that fades away is not an alert. Every colour comes
from VS Code theme tokens, so light, dark and high-contrast all work.

- **Where the numbers come from:** the control-protocol request `get_context_usage`
  ([`ContextUsage.ts`](../src/cli/ContextUsage.ts)). It is a **local** computation in the engine —
  it does **not** create a turn, spend tokens, or add a line to the transcript. It answers even
  before the first message. Per skill it returns the **origin** (`projectSettings` ·
  `userSettings` · `built-in`; anything new falls back to a `plugin` group instead of
  disappearing) and the **metadata tokens** — **measured by the engine, not estimated**. Only
  the loaded body is an estimate, and it is the only figure labelled `est.`.
- **Loaded vs. light:** the CLI emits no dedicated event when a skill is triggered. A skill
  called by the model shows up as a `Skill` tool call whose result is `Launching skill: <name>`,
  followed by a synthetic message carrying the body — the size estimate comes from **that
  message** (~4 chars/token), i.e. what actually entered the context, not from the file on
  disk. That message is taken **by position**, not by a header: a skill with its own directory
  opens with `Base directory for this skill: …`, a built-in ships the `SKILL.md` raw, and
  matching a header would leave the built-ins with no number. The other engine path,
  `Execute skill: <name>`, loads **nothing** into the context and is therefore not marked.
  A skill triggered by `/name` **from the Cockpit** is marked too (we sent it), but the engine
  reports no size, so no number is shown rather than a made-up one.
- **Loaded by a hook:** a hook (`SessionStart`, `UserPromptSubmit`, …) can dump a skill body
  straight into the context — no `Skill` tool call, no `/name`, so nothing would mark it. The
  stream does carry `system/hook_response` with the injected text, but not the skill's name
  (the hook command is usually a script of its own), so the only possible link is the
  **content**: [`SkillBodyIndex.ts`](../src/cli/SkillBodyIndex.ts) matches the injected text
  against the body of the `SKILL.md` files on disk (a 200-character normalised signature, past
  the frontmatter). On a match the skill is marked `⚡ loaded` and labelled *loaded by a hook*,
  because it is an inference. A built-in has no file on disk and therefore cannot be named.
- **Hook context:** matched or not, every `hook_response` is accounted for under **hook
  context** in the panel, grouped by hook with the injected size and how many times it fired.
  That text weighs in the prompt exactly like a skill body, so hiding it would be the same
  blind spot in a different place.
- **Visible in the timeline:** when a body enters the context, the `Skill` card gets a
  `⚡ <name> · +N tk loaded (est.)` seal — the cost appears at the moment it happens, not only
  in the panel. A hook injection has no card to seal, so it gets its own thin band in the
  timeline (a `SessionStart` hook fires before the first prompt and belongs to no turn); a hook
  that fires on every prompt is banded **once**, and the repetitions are counted in the panel.
- **Listing control (per skill):** `On (full)` · `Name only` · `Only /command` · `Off`. This maps
  to the CLI's `skillOverrides` and the saving is real — measured on a 14-skill setup, turning
  three of them down took the listing from **1928 → 1027 tokens**. Overrides are stored **per
  workspace** (`.claude/skills/` belongs to the project, so they must not leak into other
  folders), survive a VS Code restart, and are passed to the CLI when it starts; **your
  `~/.claude/settings.json` is never touched**, and the CLI outside the Cockpit is unaffected.
- **What the panel will not pretend:** there is **no way to unload a single skill** from a live
  context — the engine offers none. An already-loaded skill you switch off is shown as
  `off · resident`: it will not be listed or triggered again, but the body stays until a new
  session or `/clear`. Measured on the same session: listing dropped by exactly the skill's
  metadata tokens while `Messages` stayed unchanged.
- A skill triggered by `/name` typed **outside** the Cockpit (in the terminal, on a session we
  resumed) is invisible to us and is not shown.

Field notes with the raw captures: [`Docs/pesquisa/skills-transparencia.md`](pesquisa/skills-transparencia.md).

## Custom system prompt

**Quiet directive** (`systemPrompt.quiet`, a separate multi-line box): injected at the very
**start** of the appended payload, before the language rule and your own text — it tells the
agent to stop narrating the execution and to stop closing with a report or summary. It has no
on/off switch: **an empty box injects nothing**. It leads the payload because it is a rule about
the shape of every answer, and a rule of shape read after the content loses to the content.

**Settings → Cockpit for Claude Code → System Prompt**: a multi-line box (`systemPrompt.text`) plus an
on/off switch (`systemPrompt.enabled`, off by default). When on, the text is appended to the
CLI's system prompt.

- **Applied on every CLI start**, including the respawn that continues the same conversation
  (model/effort change, skill override). Injecting it only on a brand-new context would make
  the directive vanish mid-conversation without anyone noticing.
- **The text is a template, validated against your machine**
  ([`SystemPromptTemplate.ts`](../src/cli/SystemPromptTemplate.ts)):
  `${defaultShell}` · `${psVersion}` · `${winPathStyle}` · `${projectPathWin}` ·
  `${projectPathGitBash}` · `${projectPathWsl}` · `${wslRow}` · `${os}` · `${tempDir}`.
  A line whose placeholder points at something not installed here — no WSL, no Git Bash — is
  **dropped whole**: describing a shell the machine does not have is worse than saying nothing.
  An unknown `${name}` is kept verbatim rather than invented or blanked.
- The default content is a shell-discipline directive (which interpreter, which path style,
  where `/tmp` does and does not exist), which is exactly the class of mistake that costs a
  broken command.
- **Delivered by file, not by argument.** Measured on Windows: passed inline, a multi-line text
  containing `|`, `$` or backticks is mangled by `cmd.exe` under `shell:true` and reaches the
  model empty — an injected sentinel came back `MISSING`. Through
  `--append-system-prompt-file` it arrives intact. Also measured: repeating
  `--append-system-prompt` does not accumulate (the last one wins), so your text and the
  AskUserQuestion language rule are merged into one payload instead of one erasing the other.

## Timeline verbosity

`cockpitDaemon.verbosity` controls **how much of the timeline is shown — display only; it does not
change the agent or what the CLI does.** Modes:

| Mode | Shows |
|---|---|
| `verbose` (default) | Everything (as before) |
| `necessary` | Only edits and final explanations |
| `dialogo` | Only edits and what it's doing |
| `quiet` | Only final explanations |

In non-verbose modes the progress bar collapses several hidden tool calls into a single
turn/edit segment instead of one card per tool.

## Voice dictation

Dictate prompts straight into the composer. The **mic button** in the composer bar starts
and stops capture.

- **Transcription** runs over the OAuth **speech-to-text WebSocket**
  (`/api/ws/speech_to_text/voice_stream`) — the same service the CLI's `/voice` uses
  (`deepgram-nova3`, live interim results, endpointing). It spends **no** tokens.
- **Mic capture happens on the host** via **ffmpeg** (the webview blocks `getUserMedia`).
  Point `cockpitDaemon.ffmpegPath` at your ffmpeg binary, or leave it empty to use `ffmpeg` from
  the `PATH`.
- **Optional correction (opt-in, default off):** turn on `cockpitDaemon.voiceCorrect` and, when you
  stop, the text is sent to the **internal model** (`cockpitDaemon.internalModel`, default Haiku) for a
  quick spelling/grammar pass — a clean, isolated one-shot (instruction + text only, ~1.7 s).
- **Language:** `cockpitDaemon.voiceLanguage` sets the dictation language; empty follows the
  Cockpit UI language.
- **UX:** the input gets focus when dictation starts; on stop it goes read-only with a
  spinner while correcting; typing ends the dictation.

> Voice features use the OAuth exception (clean, isolated calls) — see
> [Cockpit-exclusive features](#cockpit-exclusive-features).

## Composer attachments

- **Paste image** (screenshot/bitmap without a path): attached as a base64 image block in
  the `user` message (`{type:'image',source:{type:'base64',media_type,data}}`); preview
  chips in the composer and thumbnails in the bubble.
- **Paste file** (with a path): inserts the **address** into the text — **relative** to the
  context cwd if inside it, otherwise **absolute** (resolved on the host with
  `path.relative`). The path comes from `File.path` (Electron) or `text/uri-list`
  (`file://…`); when the webview exposes neither, the host reads the OS clipboard
  (cross-platform: `Get-Clipboard` on Windows, AppleScript on macOS, `wl-paste`/`xclip`
  on Linux).

## Real account usage (statusline)

The limit meters need real `rate_limits` data. The automatic channel
(`rate_limit_event` in the stream) already works; the **statusline** complements it during
low usage.

Claude Code now reports these limits as a `limits[]` array — one entry per window, with
`kind` = `session` | `weekly_all` | `weekly_scoped` and the model name in
`scope.model.display_name`. The Cockpit reads that array and labels the per-model window
with whatever the server calls it (today, Fable). The older fixed fields
(`five_hour`, `seven_day`, `seven_day_<model>`) are still accepted as a fallback.

**Order of sources, and what happens when one fails.** The meters prefer the OAuth
`/usage` API (the account's actual percentage), then the statusline cache, and only then a
local USD estimate computed from this machine's transcripts. A failed API call no longer
drops straight to that estimate: transient causes (timeout, 429, 5xx, dropped connection)
are retried once, and if the call still fails the **last good reading is reused for up to
15 minutes** — a real percentage from a few minutes ago beats a table estimate. `401`
is not retried, since an expired token only comes back when the CLI refreshes it. When the
panel does fall back, the estimate note states the reason (e.g. `HTTP 401`), and the change
of source is written to the **Cockpit for Claude Code** output channel.

The **Enable real usage tracking** command installs a statusline *wrapper* that:

1. writes `rate_limits` and `context_window` to `~/.claude/.tootega-usage.json`;
2. **re-invokes your original statusline** (preserving, e.g., badges like the caveman one).

It is **reversible** (*Disable real usage tracking*). On first activation the extension
also offers it once via a notification. Today it is **Windows-only** (PowerShell). After
enabling, run an interactive `claude` session once to populate the cache.

> If editing `~/.claude/settings.json` fails (e.g. it contains comments), the extension
> warns you to edit it manually.

## Internationalization (i18n)

- **Every** visible string goes through i18n — no hardcoded text.
- Locales: **pt-BR** and **en** (international English, neutral).
- Default: follows `vscode.env.language`; falls back to `en` when the locale is not
  supported. Manual override in `cockpitDaemon.language`. **Runtime switching** (no extension
  reload).
- Catalogs:
  - **Manifest:** `package.nls.json` (en base) + `package.nls.pt-br.json`.
  - **Host (runtime):** `l10n/bundle.l10n.json` + `l10n/bundle.l10n.pt-br.json`
    (`vscode.l10n`).
  - **Webview:** `webview/src/i18n/en.ts` + `pt-br.ts`, with `{0}` interpolation.
