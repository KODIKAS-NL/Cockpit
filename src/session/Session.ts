// A conversation runtime: it wraps a CLI process, its statistics and
// all the streaming state. It emits UI messages through a callback (the provider
// tags them with the tab id and forwards them to the webview). Several instances run
// in parallel — one per tab.
import { randomUUID } from 'node:crypto';
import type { DiscoveredModel } from '../cli/ModelDiscovery';
import { CliProcessManager, type CliOptions } from '../cli/CliProcessManager';
import type { CliProcess } from '../cli/CliProcess';
import { RemoteCliProcess } from '../cli/RemoteCliProcess';
import { foreignLive, liveSessionsSync } from '../cli/SessionRegistry';
import type { DaemonClient } from '../daemon/DaemonClient';
import { parseLocalCommand } from '../../shared/localCommand';
import type { SessionSnapshot } from '../../shared/daemon';
import type { EngineId } from '../cli/Engine';
import { StatsAggregator } from '../stats/StatsAggregator';
import { loadStats, saveStats } from '../stats/StatsStore';
import { log, dlog } from '../util/logger';
import type {
  ClaudeEvent,
  AssistantEvent,
  UserEvent,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../shared/events';
import { parseContextUsage } from '../cli/ContextUsage';
import { matchSkillBody, skillNamesOnDisk } from '../cli/SkillBodyIndex';
import { parseMcpErrors } from '../cli/McpInventory';
import type { HostToWebview, LimitWindow, SkillOverride } from '../../shared/protocol';

export interface SessionHooks {
  emit: (msg: HostToWebview) => void;
  onBusy: (busy: boolean) => void;
  onResult: () => void;
  onInteraction: () => void;
  /**
   * A permission card was just sent to the chat. The host may also raise it elsewhere (a native
   * notification, when the chat is not in view); `onPromptClosed` says it was answered or withdrawn.
   */
  onPermissionPrompt?: (p: { requestId: string; title: string; detail: string; canAlways: boolean }) => void;
  onPromptClosed?: (requestId: string) => void;
  /** The model and effort pinned to a permission mode, if any (setting cockpitDaemon.modePins). */
  modePin?: (mode: string) => { model?: string; effort?: string } | undefined;
  /** The CLI switched mode on its own (e.g. a plan was approved): the picks changed with it. */
  onModeChanged?: () => void;
  /** The picker followed a model chosen elsewhere: show it, but do not persist it as a choice. */
  onModelFollowed?: () => void;
  /** The conversation's auto-compact limit was changed by another window: the picks changed with it. */
  onCompactChanged?: () => void;
  onInit: (model?: string, slashCommands?: string[]) => void;
  /** The model list the CLI reports in its `initialize` reply (what the account can use). */
  onModels?: (models: DiscoveredModel[]) => void;
  onAuthRequired: () => void;
  // The turn ended abnormally: the host locates it and shows the warning in the tab.
  //  - 'aborted': the CLI process died mid-turn (no result).
  //  - 'error':   the CLI reported an error result (the CLI's own text).
  //  - 'transient': drop/stall (the CLI retries); soft warning.
  onTurnError?: (info: { kind: 'aborted' | 'error' | 'transient'; code?: number | null; text?: string }) => void;
  fileText: (tool: string, input: unknown) => string | undefined;
  // Each tool_use (before execution): enables autosaving read/write files.
  onToolUse?: (tool: string, input: unknown) => void;
  // Plan mode (ExitPlanMode): persist the proposed plan as a markdown file under Planing/ at the
  // repo root and open it in the editor. Returns the workspace-relative path written, or undefined
  // when nothing could be saved (no workspace, write error). The approval gate stays in the UI.
  savePlan?: (plan: string) => string | undefined;
  /** Executable for an engine. Without an argument: the window's default. */
  claudePath: (engine?: EngineId) => string;
  cwd: () => string;
  // Default engine of the window, when the tab has no override.
  engine?: () => EngineId;
  engineServer?: () => string | undefined;
  // Defaults coming from the settings (what 'default' resolves to when there is no override).
  settings: () => {
    model: string;
    effort: string;
    permission: string;
    allowAgents: boolean;
    autoCompact?: string;
    enableTodoTools?: boolean;
    // 'off' forces extended thinking off for every spawn; anything else leaves it to the
    // user's Claude Code configuration.
    thinking?: string;
  };
  // Language (short code: pt, en…) for the agent's questions (AskUserQuestion).
  askLanguage: () => string;
  // Texto do usuário para o system prompt, já expandido (vazio = não injeta).
  // Vale em TODO spawn (inclusive respawn com --resume): se saísse no respawn, a
  // diretiva sumiria no meio da conversa sem ninguém perceber.
  extraSystemPrompt: () => string | undefined;
  // Diretiva "quiet" (settings): vai no início do texto injetado. Vazio = não injeta.
  quietPrompt: () => string | undefined;
  // The Claude process lives in cockpit-daemon and outlives the window; this is its client.
  // (The Tootega engine is the exception: its process is a child of the extension host.)
  daemon: () => DaemonClient;
}

export class Session {
  cli?: CliProcess;
  stats: StatsAggregator;
  resumeId?: string;
  busy = false;
  private compacting = false; // the CLI is condensing the context right now (S11)
  slashCommands: string[] = [];
  sessionId?: string;
  // Latest `system/init` inventory (tools + MCP servers). The MCP panel's source:
  // it says which tools each server exposes — something `claude mcp list` doesn't report.
  lastTools?: string[];
  lastMcpServers?: { name: string; status: string }[];
  // Servers the CLI skipped at config validation (init `mcp_server_errors`, 2.1.219).
  lastMcpErrors?: import('../cli/McpInventory').McpServerError[];
  // Skills anunciadas pelo `system/init` (campo `skills`). Serve para reconhecer
  // um /nome digitado no composer como acionamento de skill.
  lastSkills?: string[];
  // Overrides de listing por skill desta aba. Vão para o CLI via --settings no spawn.
  skillOverrides: Record<string, SkillOverride> = {};
  // `/nome` enviados antes de o init dizer quais nomes são skills.
  private pendingSlashSkills: string[] = [];
  // Engine warnings already shown (the CLI may repeat the same one every turn).
  private noticesSeen = new Set<string>();

  // Background tasks still running (Workflow / tool with run_in_background).
  // The turn that launches them ends (`result` clears busy), but the work goes on;
  // we keep the "running" indicator alive while this map isn't empty.
  // Key = the engine's `task_id`; value = {tool, label} shown to the user.
  //
  // The source of truth is the stream's `system` events (`background_tasks_changed`,
  // `task_started`, `task_updated`, `task_notification`). It can NOT be deduced from the
  // `<task-notification>` text: when a task finishes with a turn in flight, the CLI queues
  // the notification and it never reaches stdout as a message — only the `system` event arrives.
  // `toolUseId`: the tool call that started it. While that call has no result yet it is the
  // tool card running in the turn (a foreground Bash the CLI also registers as a task), not
  // background work: it stays out of the list until its result arrives and the task goes on.
  private bgTasks = new Map<string, { tool: string; label: string; toolUseId?: string }>();
  private openToolCalls = new Set<string>();

  // tool_use id → tool name, to name the task when `task_started` arrives
  // (the event brings the tool_use id, not the name). It only keeps what can still become a task.
  private toolNames = new Map<string, string>();

  // PER-TAB overrides (in memory). Empty = uses the settings default.
  // Engine of THIS tab. Per tab and not global because N Claude tabs and one
  // Tootega tab side by side is the intended use: different processes, and the
  // Claude ones never touch the local server.
  engineOverride?: EngineId;
  /** Empty history already announced for this tab (Tootega engine only). */
  private historyAnnounced = false;
  modelOverride?: string;
  effortOverride?: string;
  permissionOverride?: string;
  // Allow agents (Task) and workflows (Workflow). undefined = uses the settings default.
  allowAgentsOverride?: boolean;
  // Auto-compact for this conversation: 'auto' | 'off' | window in tokens. undefined = the setting.
  autoCompactOverride?: string;

  // Streaming state
  private currentAssistantId?: string;
  private streamedText = new Set<string>();
  private blockKind = new Map<number, string>();
  private toolBuffers = new Map<number, { id: string; name: string; json: string }>();
  private emittedTools = new Set<string>();
  // Subagent parents whose text arrived via partial deltas — so the later full `assistant`
  // event isn't emitted a second time (same guard as `streamedText` for the main agent).
  private subagentStreamed = new Set<string>();
  private pendingPerm = new Map<string, { tool: string; input: unknown; suggestions?: unknown[] }>();
  // The card/question emitted for each pending prompt, to show it again after the webview
  // repaints its history (which clears prompts) or when another window catches up.
  private pendingPromptMsg = new Map<string, HostToWebview>();
  // Feeding a daemon snapshot through onCliEvent: the events already happened, so side
  // effects that must happen once (writing the plan file) are skipped.
  private replaying = false;
  // Our messages the CLI has not taken in yet (it queues what arrives mid-turn). Only
  // tracked when the CLI echoes them back (--replay-user-messages: the Claude engine).
  private unconsumed = new Set<string>();
  /** Prompts this window already has on screen (its own and other windows'), by uuid: their CLI echo must not draw them again. */
  private shownUser = new Set<string>();
  private replayEcho = false;
  // Settings changed while no process was attached (e.g. after a reload): the
  // daemon's process may already be running with the old ones. Applied live on attach.
  private dirtyLive = new Set<LiveSetting>();
  // We interrupted a turn that has messages waiting: its error result is expected, and the
  // CLI goes on with the queue.
  private interrupting = false;

  constructor(private hooks: SessionHooks) {
    this.stats = this.newStats();
  }

  /**
   * Agregador com o reconhecedor de skill por corpo já ligado: hooks injetam contexto sem
   * emitir `tool_use Skill`, e essa é a única forma de saber QUAL skill entrou por ali.
   * A lista do `system/init` é a fonte boa, mas o hook de SessionStart chega antes dele —
   * até lá vale o que existe em disco.
   */
  private newStats(): StatsAggregator {
    const stats = new StatsAggregator(0);
    stats.setSkillBodyResolver((text) => {
      const cwd = this.hooks.cwd();
      return matchSkillBody(text, this.lastSkills ?? skillNamesOnDisk(cwd), cwd);
    });
    return stats;
  }

  // ---- lifecycle ----

  // Effective values (tab override ?? settings default).
  engine(): EngineId {
    return this.engineOverride ?? this.hooks.engine?.() ?? 'claude';
  }
  /** Changing engine changes which program answers: the process has to go. */
  setEngine(v: EngineId): void {
    if (this.engine() === v) return;
    this.engineOverride = v;
    this.stop();
  }

  model(): string {
    if (this.modelOverride) return this.modelOverride;
    return this.hooks.settings().model;
  }
  effort(): string {
    return this.effortOverride ?? this.hooks.settings().effort;
  }
  permission(): string {
    return this.permissionOverride ?? this.hooks.settings().permission;
  }
  allowAgents(): boolean {
    return this.allowAgentsOverride ?? this.hooks.settings().allowAgents;
  }
  autoCompact(): string {
    return this.autoCompactOverride ?? this.hooks.settings().autoCompact ?? 'auto';
  }

  // Model, effort and permission mode switch in the running process: a restart would abort the
  // turn, and end the process every window and the phone share. None waits for a restart.
  setModel(m: string): void {
    this.modelOverride = m;
    this.applyLive(['model']);
  }
  setEffort(e: string): void {
    this.effortOverride = e;
    this.applyLive(['effort']);
  }
  setPermission(p: string): void {
    this.permissionOverride = p;
    const pinned = this.applyModePin(p, false);
    this.applyLive(pinned ? ['permission', 'model', 'effort'] : ['permission']);
  }

  /**
   * Puts back the model/effort/mode a tab had before its dropdowns were edited (the choice was
   * for a new tab): what was switched live in the running process is switched back.
   */
  restoreSettings(b: { model?: string; effort?: string; permission?: string; allowAgents?: boolean }): void {
    const kinds: LiveSetting[] = [];
    if (b.model !== this.modelOverride) kinds.push('model');
    if (b.effort !== this.effortOverride) kinds.push('effort');
    if (b.permission !== this.permissionOverride) kinds.push('permission');
    this.modelOverride = b.model;
    this.effortOverride = b.effort;
    this.permissionOverride = b.permission;
    this.allowAgentsOverride = b.allowAgents;
    if (kinds.length > 0) this.applyLive(kinds);
  }

  /** Brings the process in step with the settings in `kinds`, without restarting it. */
  private applyLive(kinds: LiveSetting[]): void {
    const cli = this.cli;
    if (!cli) {
      for (const k of kinds) this.dirtyLive.add(k);
      return;
    }
    cli.updateOptions?.(this.liveOptions());
    if (cli.isRunning()) {
      void this.sendLive(kinds);
    } else if (cli.persistent) {
      // Attaching, or attached to a session with no process: the spec covers a new process,
      // the snapshot tells whether one is already running with the old settings.
      for (const k of kinds) this.dirtyLive.add(k);
    } else {
      this.stop(); // a process that is not running: the next one starts from fresh options
    }
  }

  /** The control requests the mode pins use too. A refusal falls back to a restart. */
  private async sendLive(kinds: LiveSetting[]): Promise<void> {
    const cli = this.cli;
    if (!cli) return;
    const model = this.model();
    const effort = this.effort();
    const results = await Promise.all(
      kinds.map((k) => {
        if (k === 'model') return cli.requestControl('set_model', 5000, { model: model === 'default' ? null : model });
        if (k === 'effort') {
          return cli.requestControl('apply_flag_settings', 5000, { settings: { effortLevel: effort === 'default' ? null : effort } });
        }
        return cli.requestControl('set_permission_mode', 5000, { mode: this.permission() });
      }),
    );
    dlog('session', `live ${kinds.join('+')}: ${results.map((r) => (r === undefined ? 'failed' : 'ok')).join(', ')}`);
    if (results.some((r) => r === undefined) && this.cli === cli) {
      const failed = kinds.filter((_, i) => results[i] === undefined).join('+');
      cli.updateOptions?.(this.cliOptions());
      if (this.busy) {
        // A restart now would abort the turn (and, on the daemon, the process every window shares).
        log(`[session] live switch of ${failed} failed mid-turn: restarting after the turn`);
        this.restartAfterTurn = true;
      } else {
        log(`[session] live switch of ${failed} failed: restarting the process`);
        this.restartWithSettings();
      }
    }
  }
  /** A live switch failed while a turn ran: the process restarts when the turn ends. */
  private restartAfterTurn = false;

  /** The CLI changed a setting on its own: the daemon's spec follows, so a restart keeps it. */
  private syncSpec(): void {
    if (!this.replaying) this.cli?.updateOptions?.(this.liveOptions());
  }

  /** The settings a live switch changes, as process options (what a later restart must keep). */
  private liveOptions(): Partial<CliOptions> {
    const model = this.model();
    const effort = this.effort();
    return {
      model: model && model !== 'default' ? model : undefined,
      effort: effort && effort !== 'default' ? effort : undefined,
      permissionMode: this.permission(),
    };
  }

  /**
   * Settings the CLI only reads at start: stop, and the next message starts it with them. In
   * the daemon gets the new spec first (it restarts on its own under Remote Control).
   */
  private restartWithSettings(): void {
    this.cli?.updateOptions?.(this.cliOptions());
    this.stop();
  }

  /**
   * Takes the model/effort pinned to `mode`, if there is one. `live`: the process keeps running
   * (the CLI changed mode mid-turn), so it is switched in place, without a restart.
   */
  applyModePin(mode: string, live: boolean): boolean {
    const pin = this.hooks.modePin?.(mode);
    if (!pin || (!pin.model && !pin.effort)) return false;
    if (pin.model) this.modelOverride = pin.model;
    if (pin.effort) this.effortOverride = pin.effort;
    if (live && this.cli?.isRunning()) {
      // 'default' = back to what the CLI would use without a flag.
      if (pin.model) void this.cli.requestControl('set_model', 5000, { model: pin.model === 'default' ? null : pin.model });
      if (pin.effort) {
        void this.cli.requestControl('apply_flag_settings', 5000, {
          settings: { effortLevel: pin.effort === 'default' ? null : pin.effort },
        });
      }
    }
    dlog('session', `mode ${mode}: pinned model=${pin.model ?? '-'} effort=${pin.effort ?? '-'}${live ? ' (live)' : ''}`);
    return true;
  }
  setAllowAgents(v: boolean): void {
    this.allowAgentsOverride = v;
    this.restartWithSettings();
  }
  /** True when the change needs no restart from this window (Claude: the daemon restarts). */
  setAutoCompact(v: string): boolean {
    this.autoCompactOverride = v;
    // For Claude the limit belongs to the conversation: the daemon keeps it, so it survives a
    // restart and holds in every window (and under Remote Control). The process reads it at
    // start, so the daemon restarts it — after the turn, when one is running. With no process
    // yet, the choice only waits: the first start carries it.
    if (this.cli instanceof RemoteCliProcess) {
      this.cli.setAutoCompact(v);
      return true;
    }
    if (!this.cli && this.engine() === 'claude') {
      this.compactChosenDetached = true;
      return true;
    }
    this.stop();
    return false;
  }

  /** The user picked an auto-compact limit while no process was attached: the attach sends it. */
  private compactChosenDetached = false;

  /** Everything a new process starts with. */
  private cliOptions(): CliOptions {
    const model = this.model();
    const effort = this.effort();
    const engine = this.engine();
    return {
      claudePath: this.hooks.claudePath(engine),
      cwd: this.hooks.cwd(),
      engine,
      server: engine === 'tootega' ? this.hooks.engineServer?.() : undefined,
      model: model && model !== 'default' ? model : undefined,
      effort: effort && effort !== 'default' ? effort : undefined,
      autoCompact: this.autoCompact(),
      permissionMode: this.permission(),
      // Blocks subagents/workflows when off (token saving).
      disallowedTools: this.allowAgents() ? undefined : ['Task', 'Workflow'],
      // Com agentes liberados, encaminha o texto dos subagentes p/ mostrá-lo no card do Task.
      forwardSubagentText: this.allowAgents(),
      enableTodoTools: this.hooks.settings().enableTodoTools,
      // resumeId ?? sessionId: a defense against any path that knows the
      // sessionId but hasn't pinned the resumeId — avoids a spawn without --resume
      // (which would duplicate the context). clearConversation() clears both for a new conversation.
      resumeSessionId: this.resumeId ?? this.sessionId,
      askLanguage: this.hooks.askLanguage(),
      extraSystemPrompt: this.hooks.extraSystemPrompt(),
      quietPrompt: this.hooks.quietPrompt(),
      // 'on' é o default do CLI: mandar não muda nada e só suja o --settings.
      skillOverrides: Object.fromEntries(
        Object.entries(this.skillOverrides).filter(([, v]) => v !== 'on'),
      ),
      forceThinkingOff: this.hooks.settings().thinking === 'off',
    };
  }

  /** The other CLI process we warned about (pid), so a deliberate send after the warning goes through. */
  private foreignWarned?: number;

  /**
   * Another live Claude Code process (the official extension, a terminal) has this conversation
   * open: starting a second one would fork it. The first time, say so and start nothing; an
   * attach in the background stays out of the way, a message the user sends afterwards
   * continues here anyway.
   */
  private blockedByForeign(user: boolean): boolean {
    const id = this.resumeId ?? this.sessionId;
    if (!id) return false;
    const other = foreignLive(liveSessionsSync(), id);
    if (!other) return false;
    if (this.foreignWarned !== other.pid) {
      this.foreignWarned = other.pid;
      this.emit({
        kind: 'engineNotice',
        id: `elsewhere:${other.pid}`,
        text: `${other.entrypoint ?? '?'}|${other.status ?? '?'}`,
        topic: 'running_elsewhere',
      });
      log(`[session] ${id} is open in pid ${other.pid} (${other.entrypoint}, ${other.status}): not attaching`);
      return true;
    }
    return !user;
  }

  /** Starts (attaches) the CLI process. `user`: a message the user just sent asks for it. */
  ensureCli(user = false): void {
    if (this.cli) return;
    const opts = this.cliOptions();
    const engine = opts.engine ?? 'claude';
    if (engine === 'claude' && this.blockedByForeign(user)) return;
    // Claude runs in the daemon; the Tootega agent keeps its own lifecycle, as a child process.
    this.replayEcho = engine === 'claude'; // buildClaudeArgs passes --replay-user-messages
    if (engine === 'claude') {
      const remote = new RemoteCliProcess(opts, this.hooks.daemon());
      remote.on('snapshot', (snap: SessionSnapshot) => this.onSnapshot(snap));
      remote.on('settled', (requestId: string) => this.onPromptSettled(requestId));
      remote.on('remoteUser', (message: unknown, uuid?: string) => this.onRemoteUser(message, uuid));
      remote.on('autoCompact', (value: string) => this.adoptAutoCompact(value));
      remote.on('gone', () => {
        // Deleted elsewhere: the timeline stays, but the next message starts a new conversation.
        this.cli = undefined;
        this.sessionId = undefined;
        this.resumeId = undefined;
        this.seenModel = undefined;
        this.historyAnnounced = false;
        this.emit({ kind: 'engineNotice', id: `gone:${Date.now()}`, text: '', topic: 'session_gone' });
      });
      remote.on('remoteState', (on: boolean, url?: string) => this.onRemoteState(on, url));
      // A limit chosen before any process: it goes to the daemon right after attaching.
      if (this.compactChosenDetached && this.autoCompactOverride !== undefined) {
        remote.setAutoCompact(this.autoCompactOverride);
      }
      this.compactChosenDetached = false;
      this.cli = remote;
    } else {
      this.cli = new CliProcessManager(opts);
      this.dirtyLive.clear(); // a new process starts from these options
    }
    this.cli.on('event', (e: ClaudeEvent) => this.onCliEvent(e));
    this.cli.on('stderr', (t: string) => {
      log(`[cli stderr] ${t.trim()}`);
      if (isAuthError(t)) this.hooks.onAuthRequired();
    });
    this.cli.on('exit', (code: number | null, reason?: 'stopped' | 'daemon') => {
      log(`CLI exited (${code})`);
      // Its prompts died with it (the daemon drops them too): close the cards, or answering
      // one later would go nowhere.
      this.settleAllPrompts();
      // Death mid-turn (busy still on = it wasn't stop()/interrupt(),
      // which clear busy first): the process aborted without emitting `result`. Without a warning the
      // indicator disappears and the user thinks it is still running. Finish and warn.
      const abortedMidTurn = this.busy;
      this.clearQueue(); // the queue died with the process
      if (abortedMidTurn) {
        if (this.currentAssistantId) this.emit({ kind: 'assistantDone', id: this.currentAssistantId });
        this.stats.endTurn();
        this.persist();
        this.resetStreamingState();
      }
      this.setBusy(false);
      this.resetBgTasks(); // processo morto → nenhuma tarefa em background sobrevive
      if (abortedMidTurn) {
        if (reason) {
          // Not a crash: another window stopped it, or the daemon restarted. A notice, not an error.
          this.emit({
            kind: 'engineNotice',
            id: `exit:${randomUUID()}`,
            text: '',
            topic: reason === 'stopped' ? 'stopped_elsewhere' : 'daemon_restarted',
          });
        } else {
          this.hooks.onTurnError?.({ kind: 'aborted', code });
        }
        this.emit({ kind: 'stats', stats: this.stats.snapshot() });
      }
    });
    this.cli.start();
  }

  /**
   * Sends a message. Mid-turn the CLI queues it: it joins the running turn at its next step,
   * or runs as the next turn. `uuid` identifies it when the CLI echoes it back.
   */
  send(text: string, images?: { mediaType: string; data: string }[], uuid: string = randomUUID()): void {
    this.ensureCli(true);
    if (!this.cli) return; // another process has this conversation: warned, nothing started
    if (!this.busy) {
      this.setBusy(true);
      this.stats.beginTurn(); // stopwatch of the active execution time (excludes idleness)
    }
    // State BEFORE the turn: mainly the cache (age/life), to understand what
    // each prompt finds (warm vs. cold cache = re-paying the cacheWrite).
    const s = this.stats.snapshot();
    const cacheState =
      s.cacheExpiresInMs == null
        ? 'frio (sem turno anterior)'
        : s.cacheAlive
          ? `quente, expira em ${(s.cacheExpiresInMs / 60_000).toFixed(1)}m (idade ${((s.cacheAgeMs ?? 0) / 60_000).toFixed(1)}m)`
          : `VENCIDO há ${((-(s.cacheExpiresAt ?? 0) + Date.now()) / 60_000).toFixed(1)}m → re-cache neste turno`;
    log(
      `[session] send (${this.sessionId ?? this.resumeId ?? 'nova'}): ${text.length} chars, ${images?.length ?? 0} img | ` +
        `ctx=${s.contextUsed}/${s.contextLimit} | cache: ${cacheState} | ` +
        `hit=${(s.cacheHitRate * 100).toFixed(0)}%${s.lastTurnHitRate != null ? ` (últ. ${(s.lastTurnHitRate * 100).toFixed(0)}%)` : ''} read=${s.cacheReadTokens} write=${s.cacheCreateTokens} resets=${s.cacheResetCount ?? 0} | ` +
        `custo=$${s.sessionCostUsd.toFixed(4)}${s.costIsEstimate ? '~' : ''} turnos=${s.turnCount ?? 0}`,
    );
    this.noteSlashSkill(text);
    if (this.replayEcho) this.unconsumed.add(uuid);
    this.shownUser.add(uuid);
    this.cli!.sendUserMessage(text, images, uuid);
  }

  /**
   * "Send now": the message goes into the CLI's queue and the running turn is interrupted;
   * the CLI then runs the queue. Idle, it is a plain send.
   */
  sendNow(text: string, images?: { mediaType: string; data: string }[], uuid: string = randomUUID()): void {
    const running = this.busy;
    this.send(text, images, uuid);
    if (running) this.interrupt();
  }

  /**
   * `/nome` de uma skill conhecida = acionamento pelo USUÁRIO. Provado na Fase 1: esse
   * caminho NÃO emite nada no stream (nem tool_use, nem system) — o corpo é injetado em
   * silêncio. Como fomos nós que enviamos, marcamos aqui. Sem tokens: o engine não informa.
   */
  private noteSlashSkill(text: string): void {
    const m = /^\/([A-Za-z0-9_:-]+)/.exec(text.trim());
    if (!m) return;
    const name = m[1];
    // O init (que traz a lista de skills) só chega DEPOIS da primeira mensagem: numa aba
    // nova ainda não sabemos se `/foo` é skill. Guarda e confirma quando o init chegar —
    // sem isso, um /skill como primeira mensagem da aba nunca era marcado.
    if (!this.lastSkills) {
      this.pendingSlashSkills.push(name);
      return;
    }
    if (this.lastSkills.includes(name)) this.stats.markSkillActive(name, 'user');
  }

  /** Resolve os `/nome` enviados antes de o init revelar quais são skills. */
  private resolvePendingSlashSkills(): void {
    if (this.pendingSlashSkills.length === 0) return;
    const pending = this.pendingSlashSkills;
    this.pendingSlashSkills = [];
    for (const name of pending) {
      if (this.lastSkills?.includes(name)) this.stats.markSkillActive(name, 'user');
    }
  }

  interrupt(): void {
    if (this.unconsumed.size > 0 && this.cli) {
      // Queued messages survive an interrupt: the CLI ends this turn with an error result
      // and runs them next, so the turn ends there (see 'result'), not here.
      this.interrupting = true;
      this.cli.interrupt();
      dlog('session', `interrupt with ${this.unconsumed.size} queued (${this.sessionId ?? '?'})`);
      return;
    }
    this.cli?.interrupt();
    this.stats.endTurn();
    this.persist();
    this.setBusy(false);
    this.resetBgTasks(); // interromper mata o processo → tarefas em background morrem
    dlog('session', `interrupt (${this.sessionId ?? '?'})`);
  }

  /** Stops the process; keeps the statistics. The next message respawns it. */
  stop(): void {
    // Close the message in flight, or the timeline keeps its caret blinking.
    if (this.currentAssistantId) this.emit({ kind: 'assistantDone', id: this.currentAssistantId });
    this.restartAfterTurn = false;
    this.resetStreamingState();
    this.settleAllPrompts();
    this.clearQueue();
    this.stats.endTurn(); // closes the turn in flight (idle time after it isn't counted)
    this.persist();
    if (this.cli) dlog('session', `stop (${this.sessionId ?? this.resumeId ?? '?'})`);
    this.cli?.stop();
    this.cli = undefined;
    this.setBusy(false);
    this.resetBgTasks();
  }

  /**
   * The window is done with this tab, but the Claude conversation goes on without it (in the
   * daemon): lets go of the process instead of ending it. The Tootega process just stops.
   */
  detach(): void {
    if (!this.cli?.persistent) {
      this.stop();
      return;
    }
    this.resetStreamingState();
    this.pendingPerm.clear();
    this.pendingPromptMsg.clear();
    this.clearQueue();
    this.stats.endTurn();
    this.persist();
    dlog('session', `detach (${this.sessionId ?? this.resumeId ?? '?'})`);
    this.cli.detach();
    this.cli = undefined;
    this.setBusy(false);
    this.resetBgTasks();
  }

  /** True when the process outlives this window (the daemon's). */
  isPersistent(): boolean {
    return !!this.cli?.persistent;
  }

  /** Shows the pending prompts again (the webview clears them when it repaints history). */
  reemitPrompts(): void {
    for (const msg of this.pendingPromptMsg.values()) this.emit(msg);
    // A remounted webview starts with an empty background list, and the next
    // `background_tasks_changed` may be hours away (or never, if nothing changes again).
    this.emitBackground();
  }

  // ---- the daemon: staying in step with other windows ----

  /**
   * Attached to a daemon session: catch up. History comes from the transcript (the host
   * already painted it); the snapshot adds the message being written right now and the
   * prompts still waiting for an answer.
   */
  private onSnapshot(snap: SessionSnapshot): void {
    // A choice this window just made is on its way to the daemon: don't take the old value back.
    const ownCompact = this.cli instanceof RemoteCliProcess && this.cli.hasPendingCompact();
    if (snap.session.autoCompact && !ownCompact) this.adoptAutoCompact(snap.session.autoCompact);
    const cliId = snap.session.cliSessionId;
    if (cliId && !this.resumeId) this.resumeId = cliId;
    if (snap.session.state === 'busy' && !this.busy) {
      this.setBusy(true);
      this.stats.beginTurn();
    }
    // Reconnected after the turn ended while this window was cut off: the `result` never arrived, so
    // the chat would show "in progress" for ever. The daemon is the truth: it is not busy.
    if (snap.session.state !== 'busy' && this.busy && this.unconsumed.size === 0 && !this.interrupting) {
      dlog('session', 'daemon attach: turn already finished, clearing the busy state');
      this.stats.endTurn();
      this.emit({ kind: 'stats', stats: this.stats.snapshot() });
      this.setBusy(false);
      this.hooks.onResult();
      this.resetStreamingState();
    }
    // Background tasks: the daemon's list is the truth. The CLI only emits
    // `background_tasks_changed` on a change, so one that finished while this window was cut off
    // would stay in the indicator for ever (and one that started would never show up).
    if (Array.isArray(snap.backgroundTasks)) this.syncBgTasks(snap.backgroundTasks);
    if (snap.session.remote?.on) this.onRemoteState(true, snap.session.remote.url);
    this.replaying = true;
    try {
      for (const ev of [...snap.partial, ...snap.pendingControl]) this.onCliEvent(ev as ClaudeEvent);
    } finally {
      this.replaying = false;
    }
    if (this.dirtyLive.size > 0) {
      // Changed while detached: a process already running still has the old settings, and
      // kept its own spec (the one this window opened with was not used).
      const kinds = [...this.dirtyLive];
      this.dirtyLive.clear();
      this.cli?.updateOptions?.(this.liveOptions());
      if (snap.started || snap.session.state !== 'idle') void this.sendLive(kinds);
    }
    dlog(
      'session',
      `daemon attach ${snap.session.id} (${cliId ?? 'new'}): ${snap.session.state}, ` +
        `${snap.partial.length} partial, ${snap.pendingControl.length} prompts`,
    );
  }

  /** The process is gone: every prompt it was waiting on is closed. */
  private settleAllPrompts(): void {
    const ids = new Set([...this.pendingPerm.keys(), ...this.pendingPromptMsg.keys()]);
    for (const id of ids) this.onPromptSettled(id);
  }

  /** Another window answered this prompt: close it here. */
  private onPromptSettled(requestId: string): void {
    this.pendingPerm.delete(requestId);
    this.pendingPromptMsg.delete(requestId);
    this.emit({ kind: 'promptSettled', requestId });
    this.hooks.onPromptClosed?.(requestId);
  }

  /** Is a permission request or a question waiting for an answer? */
  hasPendingPrompt(): boolean {
    return this.pendingPromptMsg.size > 0;
  }

  /** Is this permission request still waiting for an answer? */
  hasPendingPermission(requestId: string): boolean {
    return this.pendingPerm.has(requestId);
  }

  /** Answer a permission request from the host (a native notification) and close its chat card. */
  decideFromHost(requestId: string, decision: 'allow' | 'deny' | 'allow_always'): void {
    this.decide(requestId, decision);
    this.emit({ kind: 'promptSettled', requestId });
  }

  /** Another window sent a prompt: show it, and follow the turn it started. */
  private adoptAutoCompact(value: string): void {
    if (this.autoCompact() === value) return;
    this.autoCompactOverride = value;
    this.hooks.onCompactChanged?.();
  }

  /** Remote Control in the daemon's process: true when this session can offer it. */
  canRemote(): boolean {
    return this.cli instanceof RemoteCliProcess;
  }

  /** Resolves once the daemon attach in progress (if any) is done. */
  async whenAttached(): Promise<void> {
    if (this.cli instanceof RemoteCliProcess) await this.cli.whenAttached();
  }

  /** Turns Remote Control on or off; the state itself comes back through `onRemoteState`. */
  async setRemote(on: boolean): Promise<{ ok: boolean; url?: string; error?: string }> {
    this.ensureCli();
    if (!this.cli) return { ok: false, error: 'this conversation is running in another Claude Code process' };
    if (!(this.cli instanceof RemoteCliProcess)) return { ok: false, error: 'not available for this engine' };
    return this.cli.setRemote(on);
  }

  remoteActive = false;

  private onRemoteState(on: boolean, url?: string): void {
    this.remoteActive = on;
    this.emit({ kind: 'remoteState', active: on, phase: on ? (url ? 'active' : 'connecting') : undefined, url });
  }

  private onRemoteUser(message: unknown, uuid?: string): void {
    if (uuid) this.shownUser.add(uuid);
    const content = (message as { content?: unknown })?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('');
    }
    // Mid-turn it waits in the CLI's queue, like ours (cleared by the echo, see onUser).
    const queued = this.busy;
    if (!this.busy) {
      this.setBusy(true);
      this.stats.beginTurn();
    }
    this.emit({ kind: 'remoteUser', text, id: uuid, queued: queued && this.replayEcho && !!uuid });
  }

  /** Clears the conversation entirely (new/resume): also resets the statistics. */
  clearConversation(end = false): void {
    // The conversation this tab leaves keeps running in the daemon (another window, or this
    // one later, can pick it up); detach() is stop() for the Tootega process. `end`: the
    // conversation is being deleted, so it must not keep running.
    if (end) this.stop();
    else this.detach();
    this.sessionId = undefined;
    this.foreignWarned = undefined;
    this.seenModel = undefined;
    // Also clears the resumeId: a REALLY new conversation. Without this, after "clear
    // context" on a resumed session the next send() would respawn with --resume of the
    // old session (it wouldn't clear) — and the init pinning would keep that id glued on.
    this.resumeId = undefined;
    this.stats = this.newStats();
    // A new conversation gets a new session id, and the webview goes back to
    // waiting for history — so it has to be announced again.
    this.historyAnnounced = false;
  }

  resume(sessionId: string): void {
    this.clearConversation();
    this.resumeId = sessionId;
    // Hydrates the persisted accumulators: the session KEEPS being coherent (the CLI doesn't
    // re-emit the usage of old turns on --resume).
    const persisted = loadStats(sessionId);
    if (persisted) this.stats.hydrate(persisted);
    this.stats.markReopen(); // contador de reaberturas do contexto
    const snap = this.stats.snapshot();
    dlog(
      'session',
      `resume ${sessionId}: ${persisted ? 'hidratado' : 'sem stats salvos'}, reopen=${snap.reopenCount}, ctx=${snap.contextUsed}, turnos=${snap.turnCount}, cacheAlive=${snap.cacheAlive ?? false}`,
    );
    this.emit({ kind: 'stats', stats: this.stats.snapshot() }); // restaura a barra de imediato
    this.emitTimeline();
  }

  /** Persists this session's statistics (debounced/atomic). Requires a sessionId. */
  private persist(): void {
    const id = this.sessionId ?? this.resumeId;
    if (id) saveStats(this.stats.serialize(id, this.hooks.cwd()));
  }

  /**
   * Keep-alive ping through this session's LIVE CLI (not through a parallel --resume, which
   * would conflict with the open process). It reuses the normal turn flow: the
   * `result` stops the stopwatch and persists lastTurnTs → restarting the cache life.
   * Returns false when busy (a turn in progress already keeps the cache warm).
   */
  keepAlivePing(): boolean {
    if (this.busy) return false;
    this.ensureCli();
    if (!this.cli) return false;
    this.setBusy(true);
    this.stats.beginTurn();
    dlog('session', `keep-alive ping (${this.sessionId ?? this.resumeId ?? '?'})`);
    this.cli!.sendUserMessage('keep-alive: answer only "ok". Do not use tools and do not change files.');
    return true;
  }

  /** Turns this context's cache keep-alive on/off and persists the state. */
  setKeepCacheAlive(value: boolean): void {
    this.stats.setKeepCacheAlive(value);
    this.persist();
    this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    dlog('session', `keepCacheAlive=${value} (${this.sessionId ?? this.resumeId ?? '?'})`);
  }

  /** Sends the timeline/compactions (heavy) — per turn, not per token. */
  private emitTimeline(): void {
    const { timeline, compactions } = this.stats.timelineSnapshot();
    this.emit({ kind: 'statsTimeline', timeline, compactions });
  }

  applyLimits(limits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow }, source: 'real' | 'estimate'): void {
    this.stats.setLimits(limits, source);
  }

  snapshot() {
    return this.stats.snapshot();
  }

  // ---- Skills ----

  /**
   * Relê os metadados de skills via `get_context_usage` (control_request). É cálculo
   * local do engine: NÃO cria turno, não gasta token e não entra no transcript. Sem CLI
   * vivo não faz nada — spawnar só para ler inflaria a conta com um processo à toa.
   */
  async refreshSkills(): Promise<void> {
    if (!this.cli?.isRunning()) return;
    const info = parseContextUsage(await this.cli.requestControl('get_context_usage'));
    if (!info) return; // CLI sem o subtype / payload em formato novo: mantém o que já havia
    this.stats.applyContextUsage(info);
    this.emit({ kind: 'stats', stats: this.stats.snapshot() });
  }

  /**
   * Define o override de listing de uma skill. O efeito é real (o listing encolhe), mas
   * só vale a partir do próximo spawn: para o CLI, isso é settings de inicialização.
   * O stop() faz o respawn silencioso com --resume no próximo send — o mesmo caminho
   * usado na troca de modelo/effort. O contexto já carregado é preservado: um corpo de
   * skill que já entrou NÃO sai daqui.
   */
  setSkillOverride(name: string, value: SkillOverride): void {
    if (value === 'on') delete this.skillOverrides[name];
    else this.skillOverrides[name] = value;
    this.stats.setSkillOverrides(this.skillOverrides);
    this.restartWithSettings();
    this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    dlog('session', `skillOverride ${name}=${value}`);
  }

  /** Re-sends this session's timeline/compactions (when switching/opening the tab). */
  sendTimeline(): void {
    this.emitTimeline();
  }

  // ---- control protocol (permission / AskUserQuestion) ----

  /** Name of the tool a pending permission prompt is for. */
  pendingTool(requestId: string): string | undefined {
    return this.pendingPerm.get(requestId)?.tool;
  }

  decide(requestId: string, decision: 'allow' | 'deny' | 'allow_always', message?: string, mode?: string): void {
    const pend = this.pendingPerm.get(requestId);
    this.pendingPerm.delete(requestId);
    this.pendingPromptMsg.delete(requestId);
    this.hooks.onPromptClosed?.(requestId);
    if (pend?.tool) {
      // On denials, records the reason (the user's feedback) in the denial log.
      this.stats.recordDecision(pend.tool, decision, decision === 'deny' ? message : undefined);
      this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    }
    if (decision === 'deny') {
      // `message` = the user's feedback (e.g. notes in editable plan mode).
      this.cli?.sendControlResponse(requestId, {
        behavior: 'deny',
        message: message?.trim() || 'Denied by user',
      });
      return;
    }
    const resp: Record<string, unknown> = { behavior: 'allow', updatedInput: pend?.input ?? {} };
    const updates: unknown[] = [];
    if (decision === 'allow_always' && pend?.suggestions?.length) updates.push(...pend.suggestions);
    // Plan approval in a chosen mode: the CLI reports the new mode, which applies its pin.
    if (mode && KNOWN_MODES.has(mode)) updates.push({ type: 'setMode', mode, destination: 'session' });
    if (updates.length) resp.updatedPermissions = updates;
    this.cli?.sendControlResponse(requestId, resp);
  }

  answer(requestId: string, answers: Record<string, string>): void {
    const pend = this.pendingPerm.get(requestId);
    this.pendingPerm.delete(requestId);
    this.pendingPromptMsg.delete(requestId);
    const base = (pend?.input as Record<string, unknown>) ?? {};
    this.cli?.sendControlResponse(requestId, {
      behavior: 'allow',
      updatedInput: { ...base, answers },
    });
  }

  // ---- internals ----

  private setBusy(b: boolean): void {
    this.busy = b;
    // A turn that ends without a boundary (interrupted, or an error while compacting) must not
    // leave the indicator lit — nothing is being condensed after the turn is over.
    if (!b) this.setCompacting(false);
    this.hooks.onBusy(b);
  }

  /** Announces (once) that the CLI is condensing the context — the `compacting` status repeats. */
  private setCompacting(active: boolean): void {
    if (this.compacting === active) return;
    this.compacting = active;
    this.emit({ kind: 'compaction', active });
  }

  /**
   * Seals the compaction with what the CLI measured: `compact_metadata` gives the trigger, the
   * size before and (when it knows it) after. Shape-tolerant — a version that stops sending a
   * field just makes that number disappear from the banner.
   */
  private emitCompactBoundary(meta: any): void {
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    this.emit({
      kind: 'compaction',
      active: false,
      pre: num(meta?.pre_tokens ?? meta?.preTokens),
      post: num(meta?.post_tokens ?? meta?.postTokens),
      trigger: typeof meta?.trigger === 'string' ? meta.trigger : undefined,
      durationMs: num(meta?.duration_ms ?? meta?.durationMs),
    });
  }

  /** Inserts or refines it (`task_started` arrives later and knows the real tool). */
  private addBgTask(id: string, tool: string, label: string, toolUseId?: string): void {
    const cur = this.bgTasks.get(id);
    if (cur && cur.tool === tool && cur.label === label && (cur.toolUseId || !toolUseId)) return;
    this.bgTasks.set(id, { tool, label, toolUseId: toolUseId ?? cur?.toolUseId });
    this.emitBackground();
  }

  private clearBgTask(id: string): void {
    if (!this.bgTasks.delete(id)) return;
    this.emitBackground();
  }

  /**
   * `background_tasks_changed` brings the COMPLETE list of what is running now — it is the source of
   * truth. Reconcile against it: whatever died disappears (including tasks killed by the
   * agent, which emit no notification) and whatever the UI didn't see being born appears (e.g. a session
   * resumed with a task already in progress).
   */
  private syncBgTasks(tasks: any[]): void {
    const live = new Map<string, any>();
    for (const t of tasks) if (t?.task_id != null) live.set(String(t.task_id), t);
    let changed = false;
    for (const id of [...this.bgTasks.keys()]) {
      if (!live.has(id)) {
        this.bgTasks.delete(id);
        changed = true;
      }
    }
    for (const [id, t] of live) {
      if (this.bgTasks.has(id)) continue;
      this.bgTasks.set(id, {
        tool: taskTool(t.task_type),
        label: String(t.description ?? id),
        toolUseId: typeof t.tool_use_id === 'string' ? t.tool_use_id : undefined,
      });
      changed = true;
    }
    if (changed) this.emitBackground();
  }

  /** Clears the background state (session stop/cleanup). */
  private resetBgTasks(): void {
    this.toolNames.clear();
    this.openToolCalls.clear();
    if (this.bgTasks.size === 0) return;
    this.bgTasks.clear();
    this.emitBackground();
  }

  private emitBackground(): void {
    const tasks = [...this.bgTasks.entries()]
      .filter(([, v]) => !v.toolUseId || !this.openToolCalls.has(v.toolUseId))
      .map(([id, v]) => ({ id, tool: v.tool, label: v.label }));
    this.emit({ kind: 'background', tasks });
  }

  private emit(msg: HostToWebview): void {
    this.hooks.emit(msg);
  }

  private onCliEvent(ev: ClaudeEvent): void {
    // Subagent event (--forward-subagent-text): tagged with parent_tool_use_id. Route its
    // text to the launching Task card and stop here — it must NOT reach the main bubble nor
    // stats (subagent cost stays sourced from the authoritative result total / 7d breakdown,
    // so the live counters don't change from what they were without forwarding).
    const parentId = (ev as any).parent_tool_use_id;
    if (typeof parentId === 'string' && parentId && ev.type !== 'control_request') {
      // A subagent's permission prompt (`control_request`) MUST still reach the normal
      // handler — only its narration (assistant/stream/user/result) is diverted here.
      this.onSubagentEvent(parentId, ev);
      return;
    }
    const snap = this.stats.ingest(ev);
    this.emit({ kind: 'stats', stats: snap });
    // Corpo de skill que acabou de entrar no contexto: vira selo no card do Skill.
    for (const load of this.stats.takeSkillLoads()) {
      this.emit({ kind: 'skillLoaded', toolUseId: load.toolUseId, name: load.name, tokens: load.tokens });
    }
    // Contexto injetado por hook: não tem card para selar, então é item próprio.
    for (const h of this.stats.takeHookLoads()) {
      this.emit({ kind: 'hookInjected', hook: h.hook, event: h.event, skill: h.skill, tokens: h.tokens });
    }

    switch (ev.type) {
      case 'system': {
        const s = ev as any;
        if (s.subtype === 'background_tasks_changed') {
          this.syncBgTasks(Array.isArray(s.tasks) ? s.tasks : []);
          break;
        }
        if (s.subtype === 'task_started') {
          const tool = this.toolNames.get(s.tool_use_id) ?? taskTool(s.task_type);
          this.toolNames.delete(s.tool_use_id);
          this.addBgTask(String(s.task_id), tool, String(s.description ?? s.task_id), s.tool_use_id);
          break;
        }
        if (s.subtype === 'task_notification' || s.subtype === 'task_updated') {
          // Any state other than `running` = the task is gone (finished,
          // failed, killed by the agent). `background_tasks_changed` covers this too,
          // but closing here avoids depending on the order between the two events.
          const status = String(s.status ?? s.patch?.status ?? '');
          if (status && status !== 'running') this.clearBgTask(String(s.task_id));
          // Task finished with the session idle: the CLI opens a turn on its own
          // to react to the notification. Without marking busy, that turn's `result` would fall into
          // the "stray/replay" discard and wouldn't be counted. A killed task (`stopped`/
          // `killed`) generates no turn — marking busy there would leave the spinner stuck.
          if (s.subtype === 'task_notification' && !this.busy && (status === 'completed' || status === 'failed')) {
            this.setBusy(true);
            this.stats.beginTurn();
          }
          break;
        }
        // Compaction stopped being a silent pause: the CLI reports it while it happens
        // (`status: compacting`, repeated every 30s) and seals it with `compact_boundary`
        // carrying how much context was condensed. 2.1.224 started showing both to its own
        // attached clients; here they are the S11 event and the reason the turn stalls.
        if (s.subtype === 'status') {
          // The CLI reports its mode here; a different one than ours means it switched on its
          // own (a plan approved). Follow it, with the model/effort pinned to the new mode.
          const mode = cliMode(s.permissionMode);
          if (mode && mode !== cliMode(this.permission())) {
            this.permissionOverride = mode;
            this.applyModePin(mode, !this.replaying);
            this.syncSpec();
            this.hooks.onModeChanged?.();
          }
          const status = String(s.status ?? '');
          if (status === 'compacting') this.setCompacting(true);
          else if (s.compact_result !== undefined || s.compact_error !== undefined) {
            this.setCompacting(false);
          }
          break;
        }
        if (s.subtype === 'compact_boundary') {
          this.setCompacting(false);
          this.emitCompactBoundary(s.compact_metadata ?? s.compactMetadata);
          break;
        }
        const notice = engineNotice(s);
        if (notice) {
          // Once per session per warning: the CLI may repeat it every turn.
          if (!this.noticesSeen.has(notice.id)) {
            this.noticesSeen.add(notice.id);
            this.emit({ kind: 'engineNotice', ...notice });
          }
          break;
        }
        if (s.subtype === 'init') {
          if (Array.isArray(s.slash_commands)) this.slashCommands = s.slash_commands;
          // Stores the init inventory: the MCP panel needs it at any moment,
          // not only at the instant the event goes by.
          this.lastTools = Array.isArray(s.tools) ? s.tools : undefined;
          this.lastMcpServers = Array.isArray(s.mcp_servers) ? s.mcp_servers : undefined;
          this.lastMcpErrors = parseMcpErrors(s.mcp_server_errors);
          // `skills` existe desde 2.1.x; ausente em versões antigas → segue sem o painel.
          this.lastSkills = Array.isArray(s.skills) ? s.skills.filter((x: unknown) => typeof x === 'string') : undefined;
          // Engine that knows its own window says so (the Tootega agent reads it
          // from the server it talks to). Without this the meter would show the
          // Claude default of 200K over a context that is really 16K, and the
          // bar would never leave 1%.
          if (typeof s.context_window === 'number' && s.context_window > 0) {
            this.stats.setContextLimit(s.context_window);
          }
          // The local engine keeps no transcript under ~/.claude: its
          // conversation IS the timeline. Saying "history loaded, and it is
          // empty" right here is what lets the view paint — the webview hides
          // everything while `sessionId` is set and history never arrived, and
          // `replayTab` cannot answer because the session is busy mid-turn.
          if (this.engine() === 'tootega' && !this.historyAnnounced) {
            this.historyAnnounced = true;
            this.emit({ kind: 'history', items: [] });
          }
          this.resolvePendingSlashSkills();
          this.sessionId = s.session_id;
          if (s.session_id) {
            this.cli?.setResumeId(s.session_id); // a silent respawn continues THIS session
            // Pins the resume id at SESSION LEVEL: a stop() (model/effort/permission
            // change) discards the CliProcessManager, and the next
            // send() respawns via ensureCli() reading `this.resumeId`. Without this, that
            // respawn would start WITHOUT --resume and the CLI would create a NEW .jsonl — a
            // DUPLICATED context in the Hub. With it, it always continues the same session.
            this.resumeId = s.session_id;
            this.persist(); // sessionId conhecido: cria/atualiza o arquivo de stats
            dlog('session', `init: sessionId=${s.session_id} model=${s.model ?? '?'} mode=${s.permissionMode ?? '?'}`);
          }

          this.emit({
            kind: 'sessionInit',
            sessionId: s.session_id,
            model: s.model,
            cwd: s.cwd,
            mode: s.permissionMode,
            tools: s.tools,
            mcpServers: s.mcp_servers,
            slashCommands: this.slashCommands,
          });
          this.hooks.onInit(typeof s.model === 'string' ? s.model : undefined, this.slashCommands);
        }
        break;
      }
      case 'stream_event':
        this.onRawStream((ev as any).event);
        break;
      case 'assistant':
        this.onAssistant(ev as AssistantEvent);
        break;
      case 'user':
        this.onUser(ev as UserEvent);
        break;
      case 'control_request': {
        const r = ev as any;
        if (r.request?.subtype === 'can_use_tool') {
          const reqId = r.request_id as string;
          const tool = (r.request.tool_name as string) ?? 'tool';
          const input = r.request.input;
          const suggestions = r.request.permission_suggestions as unknown[] | undefined;
          this.pendingPerm.set(reqId, { tool, input, suggestions });
          this.hooks.onInteraction();
          // Bypass means "stop asking", but some CLI checks reach the host anyway:
          // `blockReadsOutsideWorkingDirectories` (CLI 2.1.271+) prompts even under
          // --permission-mode bypassPermissions, and so does any Bash line the checker
          // cannot fully analyse (`find -exec`, wildcards, chained `cd`). Those arrive
          // here as a normal can_use_tool, so the dropdown only keeps its promise if we
          // answer them ourselves. AskUserQuestion is exempt: it rides the same request
          // but is a question to the user, and auto-answering it sends empty answers.
          if (this.permission() === 'bypassPermissions' && tool !== 'AskUserQuestion') {
            // ExitPlanMode still saves the plan before it is approved — the file in
            // Planing/ is the record, and losing it to the auto-allow would be a
            // silent regression.
            if (tool === 'ExitPlanMode' && !this.replaying) {
              const plan = typeof (input as any)?.plan === 'string' ? (input as any).plan : '';
              if (plan) this.hooks.savePlan?.(plan);
            }
            this.decide(reqId, 'allow');
            break;
          }
          if (tool === 'AskUserQuestion') {
            const questions = ((input as any)?.questions ?? []) as any[];
            const ask: HostToWebview = { kind: 'askRequest', requestId: reqId, questions };
            this.pendingPromptMsg.set(reqId, ask);
            this.emit(ask);
          } else {
            // Plan mode: persist the plan to Planing/ and open it in the editor. The file is the
            // primary surface now; the permission card keeps only the approval gate.
            let planFile: string | undefined;
            if (tool === 'ExitPlanMode' && !this.replaying) {
              const plan = typeof (input as any)?.plan === 'string' ? (input as any).plan : '';
              if (plan) planFile = this.hooks.savePlan?.(plan);
            }
            const card: HostToWebview = {
              kind: 'permissionRequest',
              requestId: reqId,
              tool,
              displayName: r.request.display_name,
              description: r.request.description,
              input,
              suggestions: suggestions as any,
              oldText: this.hooks.fileText(tool, input),
              planFile,
            };
            this.pendingPromptMsg.set(reqId, card);
            this.emit(card);
            if (!this.replaying) {
              this.hooks.onPermissionPrompt?.({
                requestId: reqId,
                title: r.request.display_name || tool,
                detail: promptDetail(input, r.request.description),
                canAlways: !!suggestions?.length,
              });
            }
          }
        }
        break;
      }
      case 'control_cancel_request': {
        // The CLI withdrew a prompt (its turn ended another way): close it.
        const id = String((ev as any).request_id ?? '');
        if (id && (this.pendingPerm.has(id) || this.pendingPromptMsg.has(id))) this.onPromptSettled(id);
        break;
      }
      case 'control_response': {
        // Response to the `initialize` handshake: it already brings the slash commands BEFORE the
        // first send. (The `system init` only arrives after the first message.)
        const r = ev as any;
        const resp = r.response;
        let models = extractModels(resp?.response);
        if (!models.length) models = extractModels(resp);
        if (models.length) this.hooks.onModels?.(models);
        const cmds = extractSlashCommands(resp?.response) || extractSlashCommands(resp);
        if (cmds.length && this.slashCommands.length === 0) {
          this.slashCommands = cmds;
          this.emit({ kind: 'slashCommands', commands: cmds });
          this.hooks.onInit(undefined, cmds); // dispara pesquisa IA + grade de contextos
        }
        break;
      }
      case 'result': {
        const r = ev as any;
        // Only counts what WE started: send()/keepAlivePing() set busy=true. A
        // `result` with busy=false is stray/replay (e.g. the CLI re-emits turns on
        // `--resume`) — processing it would inflate local turns/cost and pollute the UI.
        if (!this.busy) {
          dlog('session', `result ignored (busy=false): CLI stray/replay`);
          break;
        }
        const errText = String(r.result ?? r.error ?? '').trim();
        const interrupted = this.interrupting;
        this.interrupting = false;
        if (interrupted) {
          // The end of the turn we interrupted for "Send now" / Stop: not an error.
        } else if (r.is_error && isAuthError(errText)) {
          this.hooks.onAuthRequired();
        } else if (r.is_error) {
          // Error reported by the CLI at the end of the turn. A transient one (drop/stall, CLI
          // 2.1.179+ preserves the partial) gets a soft warning; the rest get an error warning
          // with the CLI's own text. Without this the turn "dies" with no explanation.
          const transient = isTransientError(errText, r.subtype);
          log(`[session] result ${transient ? 'transient' : 'error'} (${this.sessionId ?? '?'}): ${errText.slice(0, 160)}`);
          this.hooks.onTurnError?.({ kind: transient ? 'transient' : 'error', text: errText || undefined });
        }
        this.stats.endTurn(); // stops the prompt's stopwatch (real execution time)
        {
          const s = this.stats.snapshot();
          log(
            `[session] result (${this.sessionId ?? '?'}): turnos=${s.turnCount}, ctx=${s.contextUsed}/${s.contextLimit}, ` +
              `custo=$${s.sessionCostUsd.toFixed(4)}${s.costIsEstimate ? '~' : ''}, activeMs=${s.activeMs ?? 0}, ` +
              `hit=${(s.cacheHitRate * 100).toFixed(0)}%${s.lastTurnHitRate != null ? ` (últ. ${(s.lastTurnHitRate * 100).toFixed(0)}%)` : ''} read=${s.cacheReadTokens} write=${s.cacheCreateTokens} resets=${s.cacheResetCount ?? 0}`,
          );
        }
        this.emit({ kind: 'turnComplete', costUsd: r.total_cost_usd, usage: r.usage });
        this.emit({ kind: 'stats', stats: this.stats.snapshot() }); // activeMs consolidado
        this.emitTimeline(); // nova amostra de timeline (1x por turno)
        this.persist(); // saves the session state (stays coherent on reopen)
        this.setBusy(false);
        this.hooks.onResult();
        this.resetStreamingState();
        if (this.restartAfterTurn && this.unconsumed.size === 0 && !this.replaying) {
          this.restartAfterTurn = false;
          this.restartWithSettings();
          break;
        }
        // Messages still in the CLI's queue run as the next turn, right away.
        if (this.unconsumed.size > 0) {
          this.setBusy(true);
          this.stats.beginTurn();
        }
        break;
      }
      case 'rate_limit_event':
        this.onRateLimit((ev as any).rate_limit_info);
        break;
    }
  }

  /**
   * Account limit coming from the engine in the stream. Automatic channel (no statusline):
   * status + reset + window always; % (`utilization`) only close to the limit.
   */
  private onRateLimit(info: any): void {
    if (!info || typeof info !== 'object') return;
    const type = info.rateLimitType ?? info.rate_limit_type;
    const which = type === 'five_hour' ? 'fiveHour' : type === 'seven_day' ? 'sevenDay' : undefined;
    if (!which) return; // seven_day_opus/sonnet/overage: outside the 2 displayed windows
    let pct: number | undefined =
      typeof info.utilization === 'number' && Number.isFinite(info.utilization)
        ? info.utilization
        : undefined;
    if (pct != null && pct > 1.5) pct = pct / 100; // defensivo (caso venha 0..100)
    const resetRaw = info.resetsAt ?? info.resets_at;
    let resetsAt: string | undefined;
    if (typeof resetRaw === 'number' && Number.isFinite(resetRaw)) {
      const ms = resetRaw > 1e12 ? resetRaw : resetRaw * 1000;
      try {
        resetsAt = new Date(ms).toISOString();
      } catch {
        /* invalid epoch */
      }
    }
    const status =
      info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected'
        ? info.status
        : undefined;
    this.stats.setStreamLimit(which, { usedPct: pct, resetsAt, status });
    this.emit({ kind: 'stats', stats: this.stats.snapshot() });
  }

  private onRawStream(raw: any): void {
    if (!raw || typeof raw.type !== 'string') return;
    switch (raw.type) {
      case 'message_start': {
        const id = raw.message?.id ?? `m_${this.emittedTools.size}_${this.blockKind.size}`;
        this.currentAssistantId = id;
        this.blockKind.clear();
        this.toolBuffers.clear();
        this.emit({ kind: 'assistantStart', id });
        break;
      }
      case 'content_block_start': {
        const idx = raw.index ?? 0;
        const block: ContentBlock = raw.content_block;
        this.blockKind.set(idx, block?.type ?? 'text');
        if (block?.type === 'tool_use') {
          const b = block as ToolUseBlock;
          this.toolBuffers.set(idx, { id: b.id, name: b.name, json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = raw.index ?? 0;
        const delta = raw.delta ?? {};
        const id = this.currentAssistantId ?? 'm';
        if (delta.type === 'text_delta') {
          this.streamedText.add(id);
          this.emit({ kind: 'assistantText', id, delta: delta.text ?? '' });
        } else if (delta.type === 'thinking_delta') {
          this.emit({ kind: 'thinking', id, delta: delta.thinking ?? '' });
        } else if (delta.type === 'input_json_delta') {
          const buf = this.toolBuffers.get(idx);
          if (buf) buf.json += delta.partial_json ?? '';
        }
        break;
      }
      case 'content_block_stop': {
        const idx = raw.index ?? 0;
        const buf = this.toolBuffers.get(idx);
        if (buf && !this.emittedTools.has(buf.id)) {
          this.emittedTools.add(buf.id);
          const input = safeJson(buf.json);
          this.emit({ kind: 'toolUse', id: buf.id, name: buf.name, input });
          this.hooks.onToolUse?.(buf.name, input);
        }
        break;
      }
      case 'message_stop': {
        if (this.currentAssistantId) this.emit({ kind: 'assistantDone', id: this.currentAssistantId });
        break;
      }
    }
  }

  private onAssistant(ev: AssistantEvent): void {
    this.followModel((ev.message as { model?: unknown } | undefined)?.model);
    const id = ev.message?.id ?? this.currentAssistantId ?? `m_${this.emittedTools.size}`;
    const blocks = ev.message?.content ?? [];
    if (!this.streamedText.has(id)) {
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => (b as any).type === 'text')
        .map((b: any) => b.text)
        .join('');
      if (text) {
        this.emit({ kind: 'assistantStart', id });
        this.emit({ kind: 'assistantText', id, delta: text });
        this.emit({ kind: 'assistantDone', id });
      }
    }
    for (const b of blocks) {
      if ((b as any).type === 'tool_use') {
        const t = b as ToolUseBlock;
        if (!this.emittedTools.has(t.id)) {
          this.emittedTools.add(t.id);
          this.emit({ kind: 'toolUse', id: t.id, name: t.name, input: t.input });
          this.openToolCalls.add(t.id);
          this.hooks.onToolUse?.(t.name, t.input);
          // Background launch (Workflow, or a tool with run_in_background): stores the
          // name so the task can be named when the matching `task_started` arrives.
          if (t.name === 'Workflow' || (t.input as any)?.run_in_background === true) {
            this.toolNames.set(t.id, t.name);
          }
        }
      }
    }
  }

  // Subagent event forwarded by the CLI (parent_tool_use_id set). We surface only the
  // subagent's visible TEXT, attributed to the Task tool_use that launched it. Thinking,
  // tool calls and usage of the subagent are intentionally left out of the main timeline.
  private onSubagentEvent(parentId: string, ev: ClaudeEvent): void {
    let delta = '';
    if (ev.type === 'stream_event') {
      const d = (ev as any).event?.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') delta = d.text;
    } else if (ev.type === 'assistant') {
      // Full assistant message (no partials seen): concatenate its text blocks.
      const seen = this.subagentStreamed.has(parentId);
      if (!seen) {
        const blocks = (ev as any).message?.content ?? [];
        delta = blocks
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('');
      }
    }
    if (ev.type === 'stream_event' && delta) this.subagentStreamed.add(parentId);
    if (delta) this.emit({ kind: 'subagentText', parentId, delta });
  }

  private onUser(ev: UserEvent): void {
    if (ev.isReplay) {
      // The CLI took a message in. Ours or another window's: when the turn had already
      // ended, this one starts the next.
      if (ev.uuid) {
        this.unconsumed.delete(ev.uuid);
        this.emit({ kind: 'userPickedUp', id: ev.uuid });
      }
      if (this.showPhonePrompt(ev)) return;
      if (!this.busy) {
        this.setBusy(true);
        this.stats.beginTurn();
      }
      return;
    }
    if (this.showPhonePrompt(ev)) return;
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if ((b as any).type === 'tool_result') {
        const r = b as ToolResultBlock;
        this.emit({ kind: 'toolResult', toolUseId: r.tool_use_id, content: r.content, isError: r.is_error });
        // The call is over: a task it started that goes on is background work now.
        if (this.openToolCalls.delete(r.tool_use_id) && [...this.bgTasks.values()].some((v) => v.toolUseId === r.tool_use_id)) {
          this.emitBackground();
        }
      }
    }
  }

  /**
   * A prompt nobody here sent, typed on the phone / claude.ai/code over Remote Control: the CLI
   * puts it on the stream (echoed or plain), and that is the only place its text reaches this
   * window. Draws it once; false when the event is something else (tool result, subagent
   * prompt, CLI-made message) or a prompt this window already shows.
   */
  private showPhonePrompt(ev: UserEvent): boolean {
    const x = ev as any;
    if (x.parent_tool_use_id || x.isSynthetic || x.isMeta || x.isCompactSummary) return false;
    if (ev.uuid && this.shownUser.has(ev.uuid)) return false;
    const c = ev.message?.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (blocks.some((b: any) => b?.type === 'tool_result')) return false;
    if (!blocks.some((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')) return false;
    // Output of a local slash command (/model, ...): a notice, never a prompt. The command
    // line itself is already on screen where it was typed.
    const local = parseLocalCommand(blocks.map((b: any) => (b?.type === 'text' ? String(b.text) : '')).join(''));
    if (local) {
      if (local.kind === 'output' && local.text) {
        this.emit({
          kind: 'engineNotice',
          id: ev.uuid ?? `cmd:${local.text}`.slice(0, 200),
          text: local.text,
          topic: local.error ? 'local_command_error' : 'local_command',
        });
      }
      return true;
    }
    this.onRemoteUser(ev.message, ev.uuid);
    return true;
  }

  /**
   * The model that actually answered, from each assistant message. When it changes to one the
   * picker does not show, someone switched it elsewhere (`/model` in the chat or on the phone
   * over Remote Control): the picker follows. The first message only sets the baseline.
   */
  private followModel(id: unknown): void {
    if (typeof id !== 'string' || !id || id === '<synthetic>') return;
    const prev = this.seenModel;
    this.seenModel = id;
    if (prev === undefined || prev === id || this.replaying) return;
    const sel = this.model().replace(/\[1m\]/i, '').toLowerCase();
    // 'default' (or an alias) names no concrete model: whatever answers is the default's choice.
    if (sel === 'default' || id.toLowerCase().includes(sel)) return;
    this.modelOverride = id;
    this.syncSpec();
    this.hooks.onModelFollowed?.();
  }
  private seenModel?: string;

  private clearQueue(): void {
    this.unconsumed.clear();
    this.interrupting = false;
  }

  private resetStreamingState(): void {
    this.currentAssistantId = undefined;
    this.streamedText.clear();
    this.blockKind.clear();
    this.toolBuffers.clear();
    this.emittedTools.clear();
    this.subagentStreamed.clear();
  }
}

// The permission modes the picker knows; since CLI 2.1.285 the default one may be called
// `manual`. Anything else (an internal mode) is not followed.
/** Settings a running process can switch without a restart. */
type LiveSetting = 'model' | 'effort' | 'permission';

const KNOWN_MODES = new Set(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
function cliMode(mode: unknown): string | undefined {
  if (typeof mode !== 'string') return undefined;
  const m = mode === 'manual' ? 'default' : mode;
  return KNOWN_MODES.has(m) ? m : undefined;
}

// Tool label from the engine's `task_type`. Used only when the task shows up
// without us having seen the `tool_use` that launched it (resumed session, subagent).
function taskTool(taskType: unknown): string {
  switch (taskType) {
    case 'local_bash':
      return 'Bash';
    case 'workflow':
      return 'Workflow';
    default:
      return typeof taskType === 'string' && taskType ? taskType : 'Task';
  }
}

// `system` subtypes this file handles on its own — never a notice.
const KNOWN_SYSTEM = new Set([
  'init',
  'background_tasks_changed',
  'task_started',
  'task_updated',
  'task_notification',
  'compact_boundary',
]);

/**
 * A mid-session warning carried by a `system` event, recognised by SHAPE and not by an exact
 * subtype: fast mode reporting usage credits exhausted (CLI 2.1.221) and a restricted subagent
 * model falling back to the parent's (2.1.223) arrived this way, and the next release will add
 * more. Anything with a warning-ish subtype, or an explicit `warning` field, is surfaced; the
 * rest of the unknown events keep being ignored, as the stream contract requires.
 */
function engineNotice(s: any): { id: string; text: string; topic?: string } | undefined {
  const subtype = typeof s?.subtype === 'string' ? s.subtype : '';
  if (!subtype || KNOWN_SYSTEM.has(subtype)) return undefined;
  const warnish = /warn|notice|credit|limit|restrict|degrad|fallback/i.test(subtype);
  const explicit = typeof s.warning === 'string' && s.warning ? s.warning : undefined;
  if (!warnish && !explicit) return undefined;
  const text =
    explicit ??
    (typeof s.message === 'string' && s.message
      ? s.message
      : typeof s.text === 'string' && s.text
        ? s.text
        : subtype.replace(/_/g, ' '));
  return { id: `${subtype}:${text}`.slice(0, 200), text, topic: subtype };
}

function safeJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

// The model list in the `initialize` reply: the same one the official panel offers. `value` is
// what goes after `--model` (an alias like `opus` or a full id); `resolvedModel` is the model
// behind it. `default` is not a model, the picker has its own entry for it.
function extractModels(o: any): DiscoveredModel[] {
  const arr = o && typeof o === 'object' ? o.models : undefined;
  if (!Array.isArray(arr)) return [];
  const out: DiscoveredModel[] = [];
  for (const it of arr) {
    const id = typeof it?.value === 'string' ? it.value : '';
    if (!id || id === 'default') continue;
    out.push({
      id,
      displayName: typeof it.displayName === 'string' ? it.displayName : undefined,
      resolvedId: typeof it.resolvedModel === 'string' && it.resolvedModel !== id ? it.resolvedModel : undefined,
    });
  }
  return out;
}

// Extracts slash command names from the `initialize` handshake payload (tolerant
// shape: the keys vary between CLI versions). Leading "/" is stripped.
function extractSlashCommands(o: any): string[] {
  if (!o || typeof o !== 'object') return [];
  const arr = o.commands ?? o.slash_commands ?? o.slashCommands ?? o.available_commands;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const it of arr) {
    const name =
      typeof it === 'string' ? it : it && typeof it.name === 'string' ? it.name : undefined;
    if (name) out.push(name.replace(/^\//, ''));
  }
  return out;
}

// Transient error (connection drop / stall / retry / stream timeout) — NOT
// fatal: the modern CLI preserves the partial response and retries. Telling it apart from a
// real error avoids surfacing scary noise and triggering an undue auth flow.
function isTransientError(text: unknown, subtype?: unknown): boolean {
  const s = typeof text === 'string' ? text : '';
  const st = typeof subtype === 'string' ? subtype : '';
  return (
    /error_during_execution|stream (disconnect|stall|error)|connection (drop|reset|closed|error)|ECONNRESET|ETIMEDOUT|socket hang up|premature close|waiting for api response|will retry|overloaded|\b5\d{2}\b/i.test(
      s,
    ) || /error_during_execution|max_turns/i.test(st)
  );
}

// Conservative heuristic for a CLI authentication error (headless doesn't sign in).
function isAuthError(text: unknown): boolean {
  const s = typeof text === 'string' ? text : '';
  return /please run \/login|\/login|not authenticated|authentication (failed|required|error)|invalid api key|unauthorized|\b401\b|oauth|please (log ?in|sign ?in)/i.test(
    s,
  );
}

/** One short line saying what a permission request is about: the command, the file, or the note. */
function promptDetail(input: unknown, description?: string): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const pick =
    (typeof inp.command === 'string' && inp.command) ||
    (typeof inp.file_path === 'string' && inp.file_path) ||
    (typeof inp.url === 'string' && inp.url) ||
    description ||
    '';
  const line = String(pick).split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
