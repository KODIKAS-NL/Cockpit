// Webview provider: the bridge between the CLI (engine) and the React UI.
import * as vscode from 'vscode';
import { buildRef } from '../../shared/codeRef';
import { removeFeedbackImages, saveFeedbackImages, sweepFeedbackImages, withImagePaths } from '../session/FeedbackImages';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { CliProcessManager } from '../cli/CliProcessManager';
import { DaemonClient } from '../daemon/DaemonClient';
import { defaultSocketPath, expandHome } from '../daemon/paths';
import { probeDaemon } from '../daemon/service';
import type { DaemonSessionInfo } from '../../shared/daemon';
import {
  availableEngines,
  currentEngine,
  engineCaps,
  engineLabel,
  enginePath,
  tootegaEnabled,
  tootegaServer,
} from '../cli/Engine';
import type { EngineId } from '../cli/Engine';
import { loadTootegaTranscript } from '../cli/TootegaTranscript';
import { CacheKeeper } from '../cli/CacheKeeper';
import {
  discoverModels,
  resolveCreds,
  pickerIds,
  ONE_M,
  type DiscoveredModel,
} from '../cli/ModelDiscovery';
import { ensurePricing, type PricingMap } from '../cli/ModelPricing';
import {
  listSessions,
  loadTranscript,
  deleteSession,
  deleteAllSessions,
  truncateTranscriptAt,
  latestSessionId,
} from '../session/SessionStore';
import { resolveMinEffort, EFFORT_RANK } from '../session/RepoDirectives';
import { VoiceSession } from '../cli/VoiceStream';
import { workspaceTerms } from '../cli/WorkspaceTerms';
import { AudioCapture } from '../cli/AudioCapture';
import { Speller } from '../spell/Speller';
import { correctText } from '../cli/TextCorrector';
import {
  loadDictionary,
  saveDictionary,
  buildKeyterms,
  applyReplacements,
  correctorHints,
  resolveAccountKey,
  resetAccountKey,
  type VoiceDict,
} from '../cli/VoiceDictionary';
import { setInternalModel } from '../cli/AiClient';
import { listPlugins, pluginAction } from '../cli/PluginManager';
import { liveSessions } from '../cli/SessionRegistry';
import { fetchMcpList, mergeMcpStatus } from '../cli/McpStatus';
import { readClipboardFiles } from '../cli/ClipboardFiles';
import { readClaudeDefaults, oneMContextDisabled } from '../cli/ClaudeSettings';
import { computeLocalUsage } from '../session/UsageAggregator';
import { computeDailyTokens } from '../stats/DailyTokens';
import { registerModelContext, setOneMContextDisabled } from '../stats/StatsAggregator';
import { readUsageCache } from '../cli/StatuslineCache';
import { fetchAuthStatus } from '../cli/AuthStatus';
import { isEnabled as usageTrackingEnabled, enableUsageTracking } from '../cli/StatuslineInstaller';
import { fetchAccountUsage, usageDiagnostics } from '../cli/UsageApi';
import { OtelReceiver } from '../cli/OtelReceiver';
import { CredentialsStore } from '../secrets/CredentialsStore';
import { buildSystemPrompt } from '../cli/SystemPromptTemplate';
import type { ImageAttachment, LimitWindow, HostToWebview, WebviewToHost, TabInfo, UsageBucket, ScopedBucket, VoiceReplacement, ModelMeta, SkillOverride, MentionItem, ModePin } from '../../shared/protocol';
import { Session, type SessionHooks } from '../session/Session';
import { chooseLocation, type Surface } from './location';
import { resolveLocale } from '../i18n/host';
import { settings, t } from '../core/services';
import { Surfaces, HUB_ID, SIDEBAR_ID, panelId, type Surface as HostSurface } from '../core/surfaces';
import type { EditorHost, SelectionInfo } from '../core/host';
import { VsCodeHost } from '../vscode/VsCodeHost';
import { ScratchpadManager } from '../scratchpad/ScratchpadPanel';
import { latestTranscriptImage, adoptPad, deletePad, migratePad, padKey } from '../scratchpad/store';
import { daemonHome } from '../daemon/paths';
import { researchCommands } from '../cli/SlashCommandResearch';
import { getLatestCliVersion } from '../cli/CliVersion';
import { installManaged, managedRoot, managedVersion } from '../cli/ManagedCli';
import { log, dlog } from '../util/logger';

// NO curated model list. The CLI has no `models` subcommand (checked on 2.1.220: `--model`
// just takes an id/alias and validates at spawn), so the account's real catalogue comes from
// /v1/models — id, display_name, max_input_tokens and created_at are enough to build the whole
// picker. 'default' (no flag) is the only entry the extension itself contributes.
// A model whose window is 1M is offered as `<id>[1m]` — see `pickerIds` in ModelDiscovery.
const EFFORT_OPTIONS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];
// Engines on offer: see `availableEngines` — one entry while the Tootega switch is off, and
// the picker hides itself when there is nothing to choose between.
// A statusline cache older than this isn't trustworthy as the "real" % (it misleads).
const USAGE_CACHE_MAX_AGE_MS = 6 * 3600_000; // 6h

// Ways a plan can be approved (the remembered choice may never be bypass).
const PLAN_APPROVALS = ['default', 'acceptEdits', 'auto'];

// Per-session preferences persisted in globalState (tab override).
interface SessionPrefs {
  model?: string;
  effort?: string;
  permission?: string;
  allowAgents?: boolean;
  autoCompact?: string;
}

// --- Render watchdog ---
// DESATIVADO (2026-06-29): suspeito de causar tempestade de recreate de painel
// (dispose+create native webview + replayTab of a huge timeline in a burst) that
// preceded a native extension-host crash (0xC0000005). Kept in the code for
// evaluation — re-enable by flipping this flag to true. The manual reload button
// (reloadActivePanel) segue funcionando independente disto.
const WATCHDOG_ENABLED = false;
const HEARTBEAT_DEAD_MS = 30_000; // no beat for this long = render presumed dead
const WATCHDOG_TICK_MS = 10_000; // how often the visible surfaces are checked
const RELOAD_COOLDOWN_MS = 60_000; // doesn't reload the same surface before this
const RELOAD_MAX_TRIES = 2; // attempts before giving up (avoids a reload loop)
const HUB_SURFACE = '__hub__'; // key of the hub surface in the beat map
const API_KEY_SECRET = 'cockpit.apiKey'; // chave da API key no SecretStorage (keychain do SO)

export class ChatViewProvider implements vscode.WebviewViewProvider {
  // The Cockpit lives as an editor tab (WebviewPanel) + a hub in the Activity Bar
  // (WebviewView). `surfaces` guarda os webviews ativos (broadcast) — o estado
  // lives in the host and is replicated to every surface.
  // Each context (session) opens as its own WebviewPanel in the editor.
  /** Every editor operation goes through the host (see src/core/host.ts). */
  private readonly host: EditorHost = new VsCodeHost();
  private panels = new Map<string, vscode.WebviewPanel>();
  private readonly surfaces = new Surfaces();
  private webviewSession = new Map<vscode.Webview, string>();
  private hubView?: vscode.WebviewView;
  // The chat in the side bar (secondary side bar, or the Activity Bar on older VS Code): one
  // long-lived view that shows one conversation at a time. `sidebarTabs` are the conversations
  // that live there, `chatTab` the one it shows. A conversation is in the side bar or in an
  // editor tab, never both (see location.ts).
  private chatView?: vscode.WebviewView;
  private chatTab?: string;
  private sidebarTabs = new Set<string>();
  /** Tabs whose panel is being closed on purpose (moved to the side bar), not by the user. */
  private movingTabs = new Set<string>();

  // Render watchdog: the webview process (renderer) can die (VSCode GPU
  // bug) — the screen goes blank but the host stays alive (stream/stats/timeline
  // keep going). Every surface sends a periodic beat; when a VISIBLE one stops
  // beating past the limit, the HTML is force-reloaded. It NEVER touches the CLI/context.
  private lastBeat = new Map<string, number>(); // surfaceKey -> epoch ms of the last beat
  private reloadGuard = new Map<string, { at: number; count: number }>(); // cooldown/cap per surface
  private justRecreated = new Set<string>(); // tabIds recreated by the watchdog: forced replay on init
  private watchdog?: ReturnType<typeof setInterval>;
  private watchdogDisabledLogged = false; // logs only once that the watchdog is off
  private windowStateSub?: vscode.Disposable; // window focus (re-arms the beat on return)

  // Tabs: each one is a Session (CLI runtime + stats + streaming) in parallel.
  private sessions = new Map<string, Session>();
  // Claude processes live in cockpit-daemon and outlive this window (the Tootega engine is the
  // only one that still runs a child process). One connection per window, shared by every tab.
  private daemon?: DaemonClient;
  private daemonWarned = false;
  // On open: deciding which running conversation the first tab attaches to. Priming
  // slash commands meanwhile would start a throwaway session in its place.
  private daemonAutoAttachPending = false;
  // Last daemon listing for this folder (the hub's live badges, auto-attach on open).
  private daemonSessions: DaemonSessionInfo[] = [];
  // Cache keep-alive: renews the ticked contexts in the background (even closed ones).
  private cacheKeeper = new CacheKeeper({
    claudePath: () => this.claudePath(),
    pingOpen: (id) => this.pingOpenSession(id),
  });
  private tabMeta = new Map<string, { title: string; status: 'idle' | 'busy' | 'error' }>();
  // Draft/dictation mirrored per tab (loss prevention): it lives in the HOST, which survives
  // the renderer's death (blank screen). Re-injected into the webview on (re)mount.
  private draftByTab = new Map<string, string>();
  private tabOrder: string[] = [];
  private activeTab = '';
  // Last session whose panel the user closed (for "reopen closed").
  private lastClosed?: { tabId: string; sessionId?: string };
  // Ref of the editor's active selection (@file#a-b) to share via the composer.
  private lastSelRef?: string;
  private lastSelUri?: string; // the document the ref points at
  private selListeners: Array<{ dispose(): void }> = [];
  private tabSeq = 0;

  // Session overrides (in memory — they don't change the user's global settings).
  private modelOverride?: string;
  private effortOverride?: string;
  private permissionOverride?: string;
  // Baseline of the active tab's dropdowns before the user touched them. If, after
  // touching them, they create a NEW context (instead of sending a prompt), the choice was
  // for the new context: the new one is born with the chosen values and the previous tab
  // returns to this baseline. Sending a prompt confirms the choice in the current tab and
  // clears the baseline (the usual behavior). Key = the tab that was being edited.
  private comboBaseline?: {
    tab: string;
    model?: string;
    effort?: string;
    permission?: string;
    allowAgents?: boolean;
  };
  private statusBar?: vscode.StatusBarItem;
  // Reload button in the status bar: always visible while a Cockpit panel is
  // open. It recovers the gray/dead webview (same action as the watchdog) — it runs in the
  // host, so it is independent of the renderer and of the editor action settings.
  private reloadBar?: vscode.StatusBarItem;
  // Models discovered live (/v1/models + the init's active model). The picker is built
  // entirely from this map — see the header comment on why there is no curated list.
  private discoveredModels = new Map<string, DiscoveredModel>();
  private discoveryTried = false;
  // true once /v1/models returned a real model set (this run OR the cached last result).
  private discoveryComplete = false;
  // Price per model (from the pricing docs; cached once a day). Empty until loaded.
  private pricing: PricingMap = {};
  private pricingTried = false;

  // Defaults do Claude Code (effort do settings; model do settings ou init cacheado).
  private defaults: { model?: string; effort?: string } = {};
  private observedDefaultModel?: string;
  // model/effort/permission changed and the session hasn't restarted yet (warns in the UI).
  private pendingRestart = false;
  // Active voice dictation session (one at a time; there is only one mic).
  private voice?: VoiceSession;
  private voiceCapture?: AudioCapture;
  private voiceDict: VoiceDict = { terms: [], replacements: [] }; // active dictation dictionary

  // Spell-checker (hunspell-asm in the host). Lazy: instantiated on first use.
  private speller?: Speller;

  // TOTP-protected credential vault (SecretStorage). Absent when the host doesn't
  // forneceu o SecretStorage (ex.: testes).
  private creds?: CredentialsStore;

  // SecretStorage do host (keychain do SO). Guarda a API key de descoberta de
  // models encrypted — never in plain text in the settings. Absent in tests.
  private readonly secrets?: vscode.SecretStorage;

  // The extension's own globalStorage directory.
  private readonly globalStorageDir?: string;

  // Scratchpad boards (Excalidraw), one per conversation; `padTabs` says which tab a board's
  // exported image goes back to.
  // Boards live in ~/.cockpit (not the per-server extension storage) so every VS Code server on
  // this machine, e.g. code-server and Remote-SSH, sees the same ones.
  private readonly padDir = daemonHome();
  private readonly scratchpads: ScratchpadManager;
  private readonly padTabs = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memory: vscode.Memento,
    statusBar?: vscode.StatusBarItem,
    secrets?: vscode.SecretStorage,
    globalStorageUri?: vscode.Uri,
  ) {
    this.globalStorageDir = globalStorageUri?.fsPath;
    this.scratchpads = new ScratchpadManager(extensionUri, this.padDir, () => resolveLocale(), (key, image) =>
      this.onPadSend(key, image),
    (key) => this.latestChatImage(key));
    this.secrets = secrets;
    if (secrets) this.creds = new CredentialsStore(secrets);
    this.defaults = readClaudeDefaults();
    setOneMContextDisabled(oneMContextDisabled(this.workspaceCwd()));
    sweepFeedbackImages(this.workspaceCwd()); // images left behind by a window that closed mid-turn
    this.observedDefaultModel = this.memory.get<string>('defaultModel');
    this.restoreDiscovery();
    this.statusBar = statusBar;
    this.updateStatusBar(false);
    // Reload button (status bar, right). Hidden until a context is opened.
    this.reloadBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.reloadBar.text = '$(refresh)';
    this.reloadBar.tooltip = t('Reload Cockpit view (fix gray/blank panel)');
    this.reloadBar.command = 'cockpitDaemon.reloadView';
    this.updateReloadBar();
    setInternalModel(this.cfg().get<string>('internalModel', '')); // model of the internal calls
    // Account-bound extras only exist for the Claude engine; running them
    // against the local agent would spawn it just to fail.
    if (engineCaps().account) void resolveAccountKey(this.claudePath());
    // Editor's active selection → shareable @file#a-b ref in the composer.
    // It follows the selection, the active editor, and the file's tab: closing the file drops the ref.
    // An undefined active editor is NOT a reason to clear: it is also what a focused chat tab reports.
    this.selListeners.push(
      this.host.onSelection((sel) => this.setSelection(sel)),
      this.host.onTabsChanged(() => this.dropSelectionIfClosed()),
      this.host.onCopySource((text, ref) => this.post({ kind: 'copySource', text, ref })),
    );
    void this.cacheKeeper; // kept for a future clean reimplementation (without polluting the transcript)
    // OTEL telemetry (opt-in, default OFF): starts the local receiver that collects LOC/
    // sessions/commits from the CLI. When enabled, it injects the export env before the first spawn.
    if (this.cfg().get<boolean>('otel.enabled', false)) {
      try {
        this.otel.start();
      } catch (e) {
        log(`[otel] start falhou: ${String(e)}`);
      }
    }
  }

  // Local OTLP receiver (opt-in). Always instantiated; it only listens when enabled.
  private readonly otel = new OtelReceiver();

  /** Shuts down background resources (called in the extension's deactivate). */
  /** Opens the scratchpad of a conversation (the active one by default). */
  openScratchpad(tab?: string, image?: ImageAttachment): void {
    const id = tab ?? this.activeTab;
    if (!id) return;
    const s = this.sessions.get(id);
    const sessionId = s?.sessionId ?? s?.resumeId;
    if (sessionId) adoptPad(this.padDir, id, sessionId);
    const key = padKey(sessionId, id);
    if (this.globalStorageDir) migratePad(this.globalStorageDir, this.padDir, key); // boards of 1.0.308+
    this.padTabs.set(key, id);
    const title = this.tabMeta.get(id)?.title || 'Cockpit';
    this.scratchpads.open(key, t('Scratchpad: {0}', title), image);
  }

  /** The newest image sent in the conversation behind a board. */
  private latestChatImage(key: string): ImageAttachment | undefined {
    const tab = this.padTabs.get(key);
    const s = tab ? this.sessions.get(tab) : undefined;
    const sessionId = s?.sessionId ?? s?.resumeId;
    if (!sessionId) return undefined;
    return latestTranscriptImage(loadTranscript(this.workspaceCwd(), sessionId));
  }

  /** The board was sent: attach it to the composer of its conversation and show that chat. */
  private onPadSend(key: string, image: ImageAttachment): void {
    const tab = this.padTabs.get(key);
    if (!tab || !this.sessions.has(tab)) return;
    this.post({ kind: 'attachImages', images: [image] }, tab);
    const panel = this.panels.get(tab);
    if (panel) panel.reveal(undefined, false);
  }

  dispose(): void {
    this.scratchpads.dispose();
    // Every engine process dies with the extension host.
    //
    // On Windows a child does NOT die with its parent, so each reload of the
    // host left the previous engines running — seven agent.exe at once, on a
    // machine where each one is a live conversation.
    // Claude's processes are not ours to end: the window lets go and the
    // conversations keep running for the next window that opens them.
    for (const s of this.sessions.values()) s.detach();
    this.daemon?.dispose();
    this.cacheKeeper.stop();
    this.otel.stop();
    if (this.watchdog) clearInterval(this.watchdog);
    this.windowStateSub?.dispose();
    this.reloadBar?.dispose();
    for (const d of this.selListeners) d.dispose();
  }

  /** Updates the selection ref (@rel#a-b) and notifies the composer. Empty = no selection. */
  private setSelection(sel: SelectionInfo | undefined): void {
    const ref = sel ? buildRef(sel.path, sel.startLine, sel.endLine, sel.endChar) : undefined;
    this.publishSelection(ref, sel?.docKey);
  }

  /** The file the ref points at lost its tab (closed): the reference goes with it. */
  private dropSelectionIfClosed(): void {
    if (!this.lastSelUri) return;
    if (!this.host.isDocumentOpen(this.lastSelUri)) this.publishSelection(undefined, undefined);
  }

  private publishSelection(ref: string | undefined, uri: string | undefined): void {
    this.lastSelUri = uri;
    if (ref === this.lastSelRef) return;
    this.lastSelRef = ref;
    this.post({ kind: 'selection', ref });
  }

  /** Shows the reload button while at least one Cockpit panel is open. */
  private updateReloadBar(): void {
    if (!this.reloadBar) return;
    if (this.panels.size > 0) this.reloadBar.show();
    else this.reloadBar.hide();
  }

  /**
   * Keep-alive of a context that is OPEN in a tab: it pings through the session's live
   * CLI (no parallel --resume, which would conflict). 'busy' = a turn in progress already
   * keeps it warm; 'pinged' = ping sent; 'none' = there is no open session (the
   * keeper then uses the ephemeral spawn for a closed context).
   */
  private pingOpenSession(sessionId: string): 'busy' | 'pinged' | 'none' {
    for (const s of this.sessions.values()) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        if (s.busy) return 'busy';
        return s.keepAlivePing() ? 'pinged' : 'busy';
      }
    }
    // A closed tab's conversation may still have its process in the daemon.
    // An ephemeral `--resume` next to it would be two processes on one transcript: skip it.
    if (this.daemonSessions.some((d) => d.cliSessionId === sessionId && d.state !== 'idle')) return 'busy';
    return 'none';
  }

  // ---- Tabs / parallel sessions ----

  /** The active tab's session (creates the first tab when there is none yet). */
  private active(): Session {
    if (!this.activeTab || !this.sessions.has(this.activeTab)) this.createTab();
    return this.sessions.get(this.activeTab)!;
  }

  private hooksFor(tabId: string): SessionHooks {
    return {
      emit: (msg) => this.post(msg, tabId),
      onBusy: (busy) => {
        this.setTabStatus(tabId, busy ? 'busy' : 'idle');
        // Turn finished on the local engine: repaint from the transcript the
        // agent just wrote. It is the source of truth, and it costs a file
        // read once per turn.
        //
        // The live stream can miss — a webview hidden during a long prefill is
        // destroyed by VSCode, and every message sent to it in the meantime is
        // dropped. That is how a finished turn ended up showing the tool card
        // and not the answer.
        if (!busy && this.sessions.get(tabId)?.engine() === 'tootega') {
          this.replayTab(tabId, true);
        }
      },
      onResult: () => {
        // Images pasted into feedback were read during this turn: they are not needed any more.
        removeFeedbackImages(this.feedbackImages.splice(0));
        this.notifyComplete();
        void this.refreshUsage(); // fetches fresh usage at the end of each interaction (no persisted cache)
        this.sendSessions(); // the new/updated session is already on disk — reflected in the context list
      },
      onInteraction: () => {
        // Ensures the context is visible (creates/focuses its panel) for the permission/question.
        this.openSessionPanel(tabId);
      },
      onPermissionPrompt: (p) => this.offerPermissionNotice(tabId, p),
      onPromptClosed: (requestId) => this.closePermissionNotice(requestId),
      modePin: (mode) => this.modePins()[mode],
      onModeChanged: () => {
        const s = this.sessions.get(tabId);
        if (s) this.saveSessionModel(s);
        if (tabId === this.activeTab) this.sendConfig();
      },
      onModelFollowed: () => {
        // Shown, not saved: a fallback model that answered once is not the user's choice.
        if (tabId === this.activeTab) this.sendConfig();
      },
      onCompactChanged: () => {
        if (tabId === this.activeTab) this.sendConfig();
      },
      onInit: (model, cmds) => this.onSessionInit(model, cmds, tabId),
      onModels: (models) => this.onCliModels(models),
      onAuthRequired: () => this.post({ kind: 'authRequired' }, tabId),
      onTurnError: (info) => {
        const message =
          info.kind === 'aborted'
            ? t(
                'Claude process exited unexpectedly (code {0}) before finishing the turn. Send again to continue.',
                String(info.code ?? '?'),
              )
            : info.kind === 'transient'
              ? t('Connection was unstable — the turn may be incomplete. Send again if needed.{0}', info.text ? ` (${info.text})` : '')
              : t('The turn ended with an error.{0}', info.text ? ` ${info.text}` : '');
        this.post({ kind: 'error', message }, tabId);
        this.updateStatusBar(this.anyBusy());
      },
      fileText: (tool, input) => this.currentFileText(tool, input),
      onToolUse: (tool, input) => this.autoSaveForTool(tool, input),
      savePlan: (plan) => this.savePlanFile(plan),
      claudePath: (engine) => this.claudePath(engine),
      cwd: () => this.workspaceCwd(),
      engine: () => currentEngine(),
      engineServer: () => tootegaServer(),
      settings: () => ({
        model: this.cfg().get<string>('model', '') || 'default',
        effort: this.cfg().get<string>('effort', 'default') || 'default',
        permission: this.cfg().get<string>('permissionMode', 'default') || 'default',
        allowAgents: this.cfg().get<boolean>('allowAgents', false),
        autoCompact: this.cfg().get<string>('autoCompact', 'auto') || 'auto',
        enableTodoTools: this.cfg().get<boolean>('enableTodoTools', false),
        thinking: this.cfg().get<string>('thinking', 'cli'),
      }),
      askLanguage: () => this.askLanguageCode(),
      extraSystemPrompt: () => this.extraSystemPrompt(),
      quietPrompt: () => this.quietPrompt(),
      daemon: () => this.daemonClient(),
    };
  }

  // ---- The daemon ----

  /** Socket the daemon listens on (setting, `~` expanded). */
  daemonSocketPath(): string {
    const configured = this.cfg().get<string>('daemon.socketPath', '').trim();
    return configured ? expandHome(configured) : defaultSocketPath();
  }

  /**
   * The connection to cockpit-daemon, which runs every Claude conversation. When the daemon is
   * missing the user is told once (with the way to install it); the tab then fails like a CLI
   * that cannot start, there is no local fallback.
   */
  private daemonClient(): DaemonClient {
    const socketPath = this.daemonSocketPath();
    if (!this.daemon || this.daemon.socketPath !== socketPath) {
      this.daemon?.dispose();
      this.daemon = new DaemonClient(socketPath, log);
    }
    if (!this.daemon.socketExists()) {
      if (!this.daemonWarned) {
        this.daemonWarned = true;
        const install = t('Install daemon');
        void this.host
          .notify(
            'warning',
            t('cockpit-daemon is not running ({0}). Claude cannot run until it is: install or start it.', socketPath),
            install,
          )
          .then((pick) => {
            if (pick === install) this.host.installDaemon();
          });
      }
    }
    return this.daemon;
  }

  /** Refreshes the daemon's sessions for this folder (best effort: empty on any failure). */
  private async refreshDaemonSessions(): Promise<DaemonSessionInfo[]> {
    try {
      this.daemonSessions = await this.daemonClient().list(this.workspaceCwd());
    } catch (e) {
      log(`[daemon] list failed: ${String(e)}`);
      this.daemonSessions = [];
    }
    return this.daemonSessions;
  }

  /** Ends the active tab's process in the daemon (the conversation stays on disk). */
  stopActiveDaemonSession(): boolean {
    const s = this.sessions.get(this.activeTab);
    if (!s || !s.isPersistent()) return false;
    s.stop();
    void this.refreshDaemonSessions().then(() => this.sendSessions());
    return true;
  }

  /**
   * Texto do usuário para o system prompt (settings), já expandido contra a máquina real.
   * Desligado ou vazio = nada é injetado. A expansão remove as linhas que falam de um
   * shell/pasta que não existe aqui — uma tabela citando WSL numa máquina sem WSL
   * induziria o agente ao erro.
   */
  private extraSystemPrompt(): string | undefined {
    if (!this.cfg().get<boolean>('systemPrompt.enabled', false)) return undefined;
    const text = this.cfg().get<string>('systemPrompt.text', '');
    return buildSystemPrompt(text, this.workspaceCwd());
  }

  /**
   * Diretiva "quiet": manda o agente parar de narrar a execução e de fechar com
   * relatório/sumário. Campo próprio, independente de `systemPrompt.enabled` — vazio é a
   * única condição de desligamento, e é o que a caixa vazia significa.
   */
  private quietPrompt(): string | undefined {
    const text = this.cfg().get<string>('systemPrompt.quiet', '');
    return text.trim() || undefined;
  }

  /** Creates a new tab and its Session; returns the id. It becomes the active tab. */
  private createTab(): string {
    const id = `t${++this.tabSeq}`;
    const s = new Session(this.hooksFor(id));
    if (this.lastLimits) s.applyLimits(this.lastLimits, this.lastLimitsSource);
    this.applySkillOverrides(s);
    // A new conversation starts on the model/effort pinned to its mode; a resumed one then
    // restores its own saved picks over it.
    s.applyModePin(s.permission(), false);
    this.sessions.set(id, s);
    this.tabMeta.set(id, { title: '', status: 'idle' });
    this.tabOrder.push(id);
    this.activeTab = id;
    return id;
  }

  private setActive(tabId: string): void {
    if (!this.sessions.has(tabId)) return;
    this.activeTab = tabId;
    this.postTabs();
    // Combos (model/effort/permission) e stats refletem a aba ativa.
    this.sendConfig();
    this.post({ kind: 'stats', stats: this.sessions.get(tabId)!.snapshot() }, tabId);
    this.sessions.get(tabId)!.sendTimeline(); // timeline/compactions of the active tab
    this.replayTab(tabId); // guarantees the history on every surface
  }

  // Captures the baseline of `tab`'s dropdowns (once per edit). Called before
  // applying any dropdown change, so it can be reverted if the user chooses to
  // levar a escolha a um novo contexto.
  private snapComboBaseline(tab: string): void {
    const s = this.sessions.get(tab);
    if (!s || this.comboBaseline?.tab === tab) return;
    this.comboBaseline = {
      tab,
      model: s.modelOverride,
      effort: s.effortOverride,
      permission: s.permissionOverride,
      allowAgents: s.allowAgentsOverride,
    };
  }

  /** Cria um contexto novo (conversa vazia) e abre seu painel. */
  private openNewTab(): void {
    // The new context inherits the values currently chosen in the active tab's dropdowns.
    const prevTab = this.activeTab;
    const prev = this.sessions.get(prevTab);
    const inherited = prev
      ? {
          model: prev.modelOverride,
          effort: prev.effortOverride,
          permission: prev.permissionOverride,
          allowAgents: prev.allowAgentsOverride,
          autoCompact: prev.autoCompactOverride,
        }
      : undefined;
    // If the dropdowns were edited over the active tab, the choice was for the new
    // context: the previous tab is reverted to the baseline (it isn't mutated unduly).
    if (prev && this.comboBaseline?.tab === prevTab) {
      prev.restoreSettings(this.comboBaseline);
      this.saveSessionModel(prev);
      this.pendingRestart = false; // the previous tab is back to the original: no pending restart
    }
    this.comboBaseline = undefined;

    const id = this.createTab();
    if (inherited) {
      const s = this.sessions.get(id)!;
      s.modelOverride = inherited.model;
      s.effortOverride = inherited.effort;
      s.permissionOverride = inherited.permission;
      s.allowAgentsOverride = inherited.allowAgents;
      s.autoCompactOverride = inherited.autoCompact;
      // What the previous tab left on the CLI default comes from the inherited mode's pin.
      const pin = this.modePins()[s.permission()];
      if (pin?.model && inherited.model === undefined) s.modelOverride = pin.model;
      if (pin?.effort && inherited.effort === undefined) s.effortOverride = pin.effort;
      this.saveSessionModel(s);
    }
    this.openSessionPanel(id);
    this.post({ kind: 'history', items: [] }, id);
  }

  private closeTab(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s) return;
    // Closing the tab is not ending the conversation: it keeps running in the daemon and
    // shows as live in the session list. (The Tootega process is the exception: detach() stops it.)
    s.detach();
    const p = this.panels.get(tabId);
    if (p) {
      try {
        p.dispose();
      } catch {
        /* noop */
      }
    }
    this.sessions.delete(tabId);
    this.tabMeta.delete(tabId);
    this.tabOrder = this.tabOrder.filter((x) => x !== tabId);
    this.sidebarTabs.delete(tabId);
    if (this.chatTab === tabId) this.chatTab = [...this.sidebarTabs].pop();
    if (this.activeTab === tabId) this.activeTab = this.chatTab ?? this.tabOrder[this.tabOrder.length - 1] ?? '';
    // The side bar chat always has a conversation to type into.
    if (this.chatView && this.sidebarTabs.size === 0) this.ensureChatTab();
    this.postTabs();
  }

  private setTabStatus(tabId: string, status: 'idle' | 'busy' | 'error'): void {
    const m = this.tabMeta.get(tabId);
    if (m && m.status !== status) {
      m.status = status;
      this.postTabs();
    }
    this.updateStatusBar(this.anyBusy());
  }

  private setTabTitle(tabId: string, title: string): void {
    const m = this.tabMeta.get(tabId);
    if (m) {
      m.title = title;
      const p = this.panels.get(tabId);
      if (p) p.title = title || 'Cockpit for Claude Code';
      this.postTabs();
    }
  }

  private anyBusy(): boolean {
    for (const s of this.sessions.values()) if (s.busy) return true;
    return false;
  }

  private postTabs(): void {
    const tabs: TabInfo[] = this.tabOrder.map((id) => {
      const s = this.sessions.get(id);
      return {
        id,
        title: this.tabMeta.get(id)?.title || '',
        status: this.tabMeta.get(id)?.status || 'idle',
        sessionId: s?.sessionId ?? s?.resumeId,
        surface: this.panels.has(id) ? 'editor' : this.sidebarTabs.has(id) ? 'sidebar' : undefined,
      };
    });
    this.post({ kind: 'tabs', tabs, activeTab: this.activeTab, chatTab: this.chatTab });
  }

  /**
   * The CLI's own model list (from its `initialize` reply). It needs no API key or token, which
   * the /v1/models route does, so the picker is complete for every account that can run the CLI.
   * Entries from /v1/models, when they exist, keep their richer metadata (context size, date).
   */
  private onCliModels(models: DiscoveredModel[]): void {
    let changed = false;
    for (const m of models) {
      const known = this.discoveredModels.get(m.id);
      if (known && known.displayName === m.displayName && known.resolvedId === m.resolvedId) continue;
      this.discoveredModels.set(m.id, { ...known, ...m });
      changed = true;
    }
    if (!changed) return;
    void this.memory.update('modelCatalog', [...this.discoveredModels.values()]);
    log(`Model list from the CLI: ${models.length} models`);
    this.sendConfig();
  }

  /** Global side of a session's init: model discovery + default cache. */
  private onSessionInit(model?: string, slashCommands?: string[], tabId?: string): void {
    void this.researchSlash(slashCommands);
    // Re-reads ~/.claude/settings.json: `model`/`effortLevel` can change outside VS Code (the
    // CLI's own /config), and reading it only in the constructor made *Default (…)* show a
    // stale value until the window was reloaded. A session init is exactly when it matters —
    // the CLI has just resolved its default from that very file.
    this.defaults = readClaudeDefaults();
    // Same reasoning for the 1M switch: it lives in the environment / the settings `env` block
    // and decides where the CLI auto-compacts, so the meter's ceiling is re-read here too.
    setOneMContextDisabled(oneMContextDisabled(this.workspaceCwd()));
    this.refreshContextLimits();
    const s = tabId ? this.sessions.get(tabId) : undefined;
    if (tabId) {
      // the sessionId now exists: persists the override (when there is one) of this new session.
      if (s) this.saveSessionModel(s);
    }
    if (typeof model === 'string' && model) {
      // The init reports the id the CLI resolved, possibly with the [1m] suffix; the
      // catalogue is keyed by the bare id (as /v1/models returns it).
      const baseId = model.replace(/\[1m\]/i, '');
      if (!this.discoveredModels.has(baseId)) {
        // Seen live but not (yet) in the catalogue: registers it with no metadata, so a model
        // the account has before /v1/models answers is still selectable.
        this.discoveredModels.set(baseId, { id: baseId });
        this.sendConfig();
      }
      const settingsModel = this.cfg().get<string>('model', '') || 'default';
      // Only a session that ran WITHOUT a per-tab model override reveals the engine's real
      // default. A tab pinned to a concrete model (e.g. Opus 4.8 1M) reports that pinned id at
      // init — caching it as "default" is wrong and made "Default (…)" lie (it stuck on the
      // pinned model instead of the CLI's actual default, now Opus 5 on 2.1.219+).
      const overridden = !!s?.modelOverride && s.modelOverride !== 'default';
      if (
        settingsModel === 'default' &&
        !this.defaults.model &&
        !overridden &&
        this.observedDefaultModel !== model
      ) {
        this.observedDefaultModel = model;
        void this.memory.update('defaultModel', model);
        this.sendConfig();
      }
    }
    // A freshly started session already has a transcript on disk: refreshes the context grid.
    this.sendSessions();
  }

  private lastLimits?: { fiveHour?: LimitWindow; sevenDay?: LimitWindow };
  private lastLimitsSource: 'real' | 'estimate' = 'estimate';
  // Origem detalhada p/ o modal Usage (api > statusline > estimate).
  private lastUsageSource: 'api' | 'statusline' | 'estimate' = 'estimate';
  private lastScoped?: ScopedBucket[];
  private usageStarted = false;

  /** Starts (once) the periodic computation of local usage (5h/7d). */
  /** Tells the dashboard whether the daemon (Claude's engine) is in use and answers. Cheap: one connect. */
  async reportDaemonStatus(): Promise<void> {
    // The Tootega engine runs locally: nothing to report for it.
    if (currentEngine() !== 'claude') {
      this.post({ kind: 'daemonStatus', enabled: false, connected: false });
      return;
    }
    const pid = await probeDaemon(this.daemonSocketPath(), 1000);
    this.post({ kind: 'daemonStatus', enabled: true, connected: pid !== undefined, pid });
  }

  private daemonStatusTimer?: ReturnType<typeof setInterval>;

  /** Keeps the status fresh (the daemon can stop or start without this window noticing). */
  private startDaemonStatusTimer(): void {
    if (this.daemonStatusTimer) return;
    this.daemonStatusTimer = setInterval(() => void this.reportDaemonStatus(), 5000);
    this.daemonStatusTimer.unref?.();
  }

  private startUsageTimer(): void {
    if (this.usageStarted) return;
    this.usageStarted = true;
    void this.refreshUsage();
    setInterval(() => void this.refreshUsage(), 120_000);
  }

  /** The account's limit windows for the dashboard bars: real percentages only, never the local estimate. */
  private postAccountLimits(): void {
    const live = currentEngine() === 'claude' && this.lastLimitsSource === 'real';
    const toBucket = (w?: LimitWindow) => (w && typeof w.usedPct === 'number' ? { usedPct: w.usedPct, resetsAt: w.resetsAt } : undefined);
    this.post({
      kind: 'accountLimits',
      live,
      fiveHour: live ? toBucket(this.lastLimits?.fiveHour) : undefined,
      sevenDay: live ? toBucket(this.lastLimits?.sevenDay) : undefined,
      weeklyScoped: live ? this.lastScoped : undefined,
    });
  }

  private async refreshUsage(force = false): Promise<void> {
    const before = this.lastUsageSource;
    try {
      // 0) REAL account usage via the OAuth API (read-only, no token spend). It is the
      // mesma fonte do /usage do CLI — bate exatamente. Melhor fonte. Já resiliente:
      // retenta e reaproveita a última leitura boa antes de deixar cair na estimativa.
      const api = await fetchAccountUsage(force);
      if (api && (api.fiveHour || api.sevenDay)) {
        this.lastLimits = { fiveHour: api.fiveHour, sevenDay: api.sevenDay };
        this.lastScoped = api.weeklyScoped;
        this.lastLimitsSource = 'real';
        this.lastUsageSource = 'api';
      } else {
        // 1) Statusline cache (rate_limits). Only trusted when FRESH.
        const real = readUsageCache();
        const fresh = real != null && (real.ageMs == null || real.ageMs < USAGE_CACHE_MAX_AGE_MS);
        if (real && fresh && (real.fiveHour || real.sevenDay)) {
          this.lastLimits = { fiveHour: real.fiveHour, sevenDay: real.sevenDay };
          this.lastScoped = real.weeklyScoped;
          this.lastLimitsSource = 'real';
          this.lastUsageSource = 'statusline';
        } else {
          // 2) Fallback: local token usage (no %, only accumulated USD/tokens).
          const u = await computeLocalUsage(Date.now());
          this.lastLimits = {
            fiveHour: {
              usd: u.fiveHourUsd,
              tokens: u.fiveHourTokens,
              usedPct: undefined,
            },
            sevenDay: {
              usd: u.sevenDayUsd,
              tokens: u.sevenDayTokens,
              usedPct: undefined,
            },
          };
          this.lastScoped = undefined;
          this.lastLimitsSource = 'estimate';
          this.lastUsageSource = 'estimate';
        }
      }
      // Losing the real % is worth a line in the log — it is the difference between the panel
      // showing the account's actual percentage and showing a local USD estimate.
      if (before !== this.lastUsageSource) {
        const why = usageDiagnostics().lastError;
        log(`usage source: ${before} -> ${this.lastUsageSource}${why ? ` (${why})` : ''}`);
      }
      for (const [id, s] of this.sessions) {
        s.applyLimits(this.lastLimits, this.lastLimitsSource);
        this.post({ kind: 'stats', stats: s.snapshot() }, id);
      }
      this.postAccountLimits();
    } catch {
      /* ignora */
    }
  }

  private updateStatusBar(busy: boolean): void {
    if (!this.statusBar) return;
    this.statusBar.text = busy ? '$(loading~spin) Cockpit' : '$(sparkle) Cockpit';
    this.statusBar.tooltip = 'Cockpit for Claude Code';
    this.statusBar.command = 'cockpitDaemon.open';
    this.statusBar.show();
  }

  /** Opens the active conversation in an editor tab (moving it out of the side bar if needed). */
  openInEditor(): void {
    const id = this.activeTab && this.sessions.has(this.activeTab) ? this.activeTab : this.createTab();
    this.openSessionPanel(id, 'editor');
  }

  /** Opens the active conversation where the user prefers it (side bar by default). */
  openPreferred(): void {
    const id = this.activeTab && this.sessions.has(this.activeTab) ? this.activeTab : this.createTab();
    this.openSessionPanel(id);
  }

  /** Moves the active conversation into the side bar chat (closing its editor tab). */
  moveToSidebar(): void {
    const id = this.activeTab && this.sessions.has(this.activeTab) ? this.activeTab : this.createTab();
    this.openSessionPanel(id, 'sidebar');
  }

  /** Shows the side bar chat (focus), for the command and the status bar. */
  focusSidebar(): void {
    void vscode.commands.executeCommand('cockpitDaemon.chat.focus');
  }

  private preferredLocation(): Surface {
    return this.cfg().get<string>('preferredLocation', 'sidebar') === 'editor' ? 'editor' : 'sidebar';
  }

  /**
   * Shows a conversation in the side bar chat. One that has an editor tab is moved: the tab is
   * closed (not recorded as "closed by the user") and the chat repaints from the transcript.
   */
  private showInSidebar(tabId: string): void {
    const panel = this.panels.get(tabId);
    if (panel) {
      this.movingTabs.add(tabId);
      try {
        panel.dispose();
      } catch {
        this.movingTabs.delete(tabId);
      }
    }
    this.sidebarTabs.add(tabId);
    this.chatTab = tabId;
    this.setActive(tabId);
    this.postTabs();
    this.focusSidebar();
  }

  /** Opens (or focuses) a conversation where it belongs: its editor tab or the side bar chat. */
  private openSessionPanel(tabId: string, explicit?: Surface): void {
    const where = chooseLocation({
      preferred: this.preferredLocation(),
      explicit,
      inEditor: this.panels.has(tabId),
      inSidebar: this.sidebarTabs.has(tabId),
    });
    if (where === 'sidebar') {
      this.showInSidebar(tabId);
      return;
    }
    // Editor: a conversation coming from the side bar leaves it.
    if (this.sidebarTabs.delete(tabId)) {
      if (this.chatTab === tabId) this.chatTab = [...this.sidebarTabs][0];
    }
    const existing = this.panels.get(tabId);
    if (existing) {
      try {
        existing.reveal();
        this.setActive(tabId);
        return;
      } catch {
        this.panels.delete(tabId);
        this.surfaces.remove(panelId(tabId));
        this.webviewSession.delete(existing.webview);
      }
    }
    const panel = vscode.window.createWebviewPanel(
      'cockpitDaemon.cockpit.editor',
      this.tabMeta.get(tabId)?.title || 'Cockpit for Claude Code',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
      },
    );
    // Editor tabs don't mask the icon (raw render) -> colored version.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-color.svg');
    this.bindPanel(panel, tabId);
    this.setActive(tabId);
    this.postTabs();
  }

  /** Binds a WebviewPanel to a specific session. */
  private bindPanel(panel: vscode.WebviewPanel, tabId: string): void {
    try {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
      };
      panel.webview.html = this.getHtml(panel.webview, 'chat', tabId);
    } catch {
      return;
    }
    this.panels.set(tabId, panel);
    this.webviewSession.set(panel.webview, tabId);
    this.surfaces.set(panelId(tabId), this.panelSurface(panel.webview, tabId));
    this.updateReloadBar();
    const sub = panel.webview.onDidReceiveMessage((m: WebviewToHost) =>
      this.onWebviewMessage(m, panel.webview),
    );
    const vs = panel.onDidChangeViewState(() => {
      if (panel.active) this.setActive(tabId);
      // A dedicated context key for the refresh button in the title bar (more reliable than
      // activeWebviewPanelId for webview panels). True when THIS panel is active.
      void vscode.commands.executeCommand('setContext', 'cockpitDaemon.cockpitActive', panel.active);
      // Shown again: timers were throttled while hidden — re-arms the clock so
      // the watchdog doesn't mistake the gap for a dead render.
      if (panel.visible) this.lastBeat.set(tabId, Date.now());
    });
    // A freshly created panel is born active: arm the context key right away.
    void vscode.commands.executeCommand('setContext', 'cockpitDaemon.cockpitActive', true);
    this.lastBeat.set(tabId, Date.now()); // armed now: a freshly created panel hasn't beaten yet
    // Ref captured NOW: reading `panel.webview`/`panel.active` AFTER the dispose
    // throws "Webview is disposed" (assertNotDisposed getter) and aborts the rest of the
    // handler — vazando os listeners e os mapas de pulso. Captura evita o getter.
    const wv = panel.webview;
    panel.onDidDispose(() => {
      // A genuine close by the user (not a watchdog recreate): the map still
      // points to THIS panel. Stored for "reopen closed session".
      if (this.panels.get(tabId) === panel && !this.movingTabs.has(tabId)) {
        const s = this.sessions.get(tabId);
        this.lastClosed = { tabId, sessionId: s?.sessionId ?? s?.resumeId };
      }
      this.movingTabs.delete(tabId);
      this.panels.delete(tabId);
      this.surfaces.remove(panelId(tabId));
      this.webviewSession.delete(wv);
      this.lastBeat.delete(tabId);
      this.reloadGuard.delete(tabId);
      this.updateReloadBar();
      // Doesn't read panel.active (the getter throws post-dispose): clears the context key directly.
      void vscode.commands.executeCommand('setContext', 'cockpitDaemon.cockpitActive', false);
      this.postTabs(); // the conversation's surface changed (the side bar tab strip follows)
      sub.dispose();
      vs.dispose();
    });
  }

  /** Surface key for the watchdog: the panel's tabId, or HUB_SURFACE for the hub. */
  private surfaceKey(webview?: vscode.Webview): string | undefined {
    if (!webview) return undefined;
    const tab = this.webviewSession.get(webview);
    if (tab) return tab;
    if (webview === this.hubView?.webview) return HUB_SURFACE;
    return undefined;
  }

  /** Starts the periodic render checker (idempotent). */
  private startWatchdog(): void {
    if (!WATCHDOG_ENABLED) {
      if (!this.watchdogDisabledLogged) {
        this.watchdogDisabledLogged = true;
        log('Render watchdog DISABLED (usage evaluation) — no automatic webview reload');
      }
      return;
    }
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkSurfaces(), WATCHDOG_TICK_MS);
    // Window focus: Chromium FREEZES the renderer's timers when the VSCode window
    // goes to the background (background throttling) — the heartbeat stops even
    // with the panel "visible" and WITHOUT firing onDidChangeViewState. On regaining focus,
    // it re-arms the beat clock of every surface so the watchdog doesn't mistake
    // that gap for a dead render and close/reload the tab (and the Hub) unduly.
    this.windowStateSub ??= vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) this.rearmAllBeats();
    });
  }

  /** Re-arms the beat clock of every visible surface (now). */
  private rearmAllBeats(): void {
    const now = Date.now();
    for (const [tabId, panel] of this.panels) if (panel.visible) this.lastBeat.set(tabId, now);
    if (this.hubView?.visible) this.lastBeat.set(HUB_SURFACE, now);
    dlog('watchdog', 'janela reganhou foco — pulsos rearmados');
  }

  /** Sweeps VISIBLE surfaces; a hidden one is throttled/discarded, it doesn't count. */
  private checkSurfaces(): void {
    // Window in the background: the renderer's timers are frozen (this isn't a real
    // death). Nothing is reloaded — liveness is only evaluated with the window focused.
    if (!vscode.window.state.focused) {
      dlog('watchdog', 'tick skipped: window not focused');
      return;
    }
    const now = Date.now();
    for (const [tabId, panel] of this.panels) {
      if (panel.visible) this.maybeReload(tabId, panel.webview, now);
    }
    if (this.hubView?.visible) this.maybeReload(HUB_SURFACE, this.hubView.webview, now);
  }

  /**
   * Render presumed dead (beat stopped past the limit) → forces an HTML reload:
   * it remounts React, which re-sends 'init' and the host repaints via replayTab. The replay
   * cost (large timeline) is only paid HERE, in the recovery — never on the healthy path.
   * A cooldown + cap avoid a loop when the reload doesn't revive it (broken environment).
   */
  private maybeReload(key: string, webview: vscode.Webview, now: number): void {
    const beat = this.lastBeat.get(key);
    if (beat === undefined) {
      this.lastBeat.set(key, now); // first observation: arms the clock, doesn't act
      return;
    }
    const gap = now - beat;
    dlog('watchdog', `${key}: ${gap}ms since the last beat (limit ${HEARTBEAT_DEAD_MS}ms)`);
    if (gap < HEARTBEAT_DEAD_MS) return; // vivo
    const g = this.reloadGuard.get(key) ?? { at: 0, count: 0 };
    if (now - g.at < RELOAD_COOLDOWN_MS) {
      dlog('watchdog', `${key}: beat stopped (${gap}ms) but in cooldown — no reload`);
      return; // cooldown ativo
    }
    if (g.count >= RELOAD_MAX_TRIES) {
      dlog('watchdog', `${key}: beat stopped (${gap}ms) but hit the attempt cap — giving up`);
      return; // already tried too many times: gives up (no loop)
    }
    // Always logged (not only in debug): this is the ONLY place that restarts a webview.
    log(`Watchdog: beat of '${key}' stopped ${gap}ms ago (focus=${vscode.window.state.focused}) — reloading`);
    try {
      // A crashed renderer IGNORES a webview.html reassignment — only recreating the panel
      // respawns the process. The Hub is a WebviewView (owned by VSCode): only the html is left.
      if (key === HUB_SURFACE) {
        webview.html = this.getHtml(webview, 'hub');
      } else if (!this.recreatePanel(key)) {
        webview.html = this.getHtml(webview, 'chat', key); // fallback se recriar falhar
      }
    } catch {
      return;
    }
    this.reloadGuard.set(key, { at: now, count: g.count + 1 }); // after the recreate (survives the dispose)
    this.lastBeat.set(key, now); // grace window to remount and start beating again
    log(`Webview render dead (${key}) — recovered (try ${g.count + 1})`);
  }

  /**
   * Recreates a tab's WebviewPanel: dispose of the old one + a new createWebviewPanel,
   * keeping the SAME tabId/session (CLI and context untouched). The only path that
   * respawna um renderer morto. O painel novo manda 'init' → replayTab repinta.
   */
  private recreatePanel(tabId: string): boolean {
    const old = this.panels.get(tabId);
    if (!old) return false;
    const col = old.viewColumn ?? vscode.ViewColumn.Active;
    const title = this.tabMeta.get(tabId)?.title || 'Cockpit for Claude Code';
    // Unbinds before disposing: the old one's onDidDispose would erase the records
    // of the tabId that will belong to the new panel.
    this.panels.delete(tabId);
    this.surfaces.remove(panelId(tabId));
    this.webviewSession.delete(old.webview);
    try {
      old.dispose();
    } catch {
      /* already dead */
    }
    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel('cockpitDaemon.cockpit.editor', title, col, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      });
    } catch {
      return false;
    }
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-color.svg');
    this.justRecreated.add(tabId); // the new panel's init must force a replay even when busy
    log(`recreatePanel: painel da aba '${tabId}' recriado (renderer respawnado)`);
    this.bindPanel(panel, tabId);
    return true;
  }

  /**
   * Manual reload (refresh button in the tab's title bar): forces the same recovery
   * as the watchdog on the active tab, but IGNORING the cooldown/cap — it is an explicit
   * user request to resurrect a gray/blank panel (dead renderer). It runs in the host,
   * so it works even with the renderer stuck.
   */
  reloadActivePanel(): void {
    let tabId: string | undefined;
    for (const [id, p] of this.panels) {
      if (p.active) {
        tabId = id;
        break;
      }
    }
    tabId ??= this.activeTab;
    if (!tabId || !this.panels.has(tabId)) return;
    this.reloadGuard.delete(tabId); // clears the guard: user action, no cap
    try {
      if (!this.recreatePanel(tabId)) {
        const p = this.panels.get(tabId);
        if (p) p.webview.html = this.getHtml(p.webview, 'chat', tabId);
      }
    } catch {
      return;
    }
    this.lastBeat.set(tabId, Date.now()); // grace window to remount
    log(`Webview manual reload (${tabId})`);
  }

  /** A panel restored by the serializer has no session binding: discarded. */
  attachPanel(panel: vscode.WebviewPanel): void {
    try {
      panel.dispose();
    } catch {
      /* noop */
    }
  }

  // ---- Commands exposed to the extension ----

  newSession(): void {
    this.openNewTab();
  }

  private workspaceCwd(): string {
    return this.host.workspaceRoot() ?? process.cwd();
  }

  /**
   * Writes a plan-mode plan to `Planing/<timestamp>-<slug>.md` at the repo root and opens it in
   * the editor. Returns the workspace-relative path, or undefined when nothing could be written.
   *
   * The file is the plan's primary surface now — the permission card keeps only the approval
   * gate. The name carries a sortable timestamp plus a short slug taken from the first heading,
   * so the folder reads as a history rather than one overwritten file.
   */
  private savePlanFile(plan: string): string | undefined {
    const root = this.workspaceCwd();
    if (!root) return undefined;
    try {
      const dir = path.join(root, 'Planing');
      fs.mkdirSync(dir, { recursive: true });

      // Several windows on one daemon session each see the same ExitPlanMode prompt: the
      // first writes the plan, the others find it and open that file instead of a copy.
      const body = plan.endsWith('\n') ? plan : plan + '\n';
      const recent = findRecentPlan(dir, body);
      if (recent) {
        this.host.openQuietly(recent);
        return path.relative(root, recent).split(path.sep).join('/');
      }

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
      const slug = planSlug(plan);
      const name = slug ? `${stamp}-${slug}.md` : `${stamp}.md`;
      const abs = path.join(dir, name);

      fs.writeFileSync(abs, body, 'utf8');

      // Open it without stealing focus from the approval card the user is about to act on.
      this.host.openQuietly(abs);

      return path.relative(root, abs).split(path.sep).join('/');
    } catch (e) {
      log(`plan: could not save the plan file: ${(e as Error)?.message ?? e}`);
      return undefined;
    }
  }

  /** Path relative to the cwd when inside it; absolute otherwise. */
  private resolvePath(absPathRaw: string): string {
    const absPath = absPathRaw.normalize('NFC');
    const cwd = this.workspaceCwd().normalize('NFC');
    const rel = path.relative(cwd, absPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/'); // dentro do contexto -> relativo
    }
    return absPath; // fora do contexto -> absoluto
  }

  /** Resolved path in quotes (handles spaces). */
  private quoteResolved(absPath: string): string {
    return `"${this.resolvePath(absPath)}"`;
  }

  /** Opens a link from the chat: external URL or file (relative to the cwd / absolute / by name). */
  private async openLink(href: string, preview = false): Promise<void> {
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      this.host.openExternal(href);
      return;
    }
    let raw = href;
    // line anchor (#L12)
    let line: number | undefined;
    const lm = raw.match(/#L(\d+)\s*$/i);
    if (lm) {
      line = parseInt(lm[1], 10);
      raw = raw.slice(0, raw.length - lm[0].length);
    }
    raw = raw.replace(/^file:\/\//i, '').replace(/^["']|["']$/g, '');
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* already decoded */
    }
    raw = raw.normalize('NFC');

    const abs = path.isAbsolute(raw) ? raw : path.join(this.workspaceCwd(), raw);
    let file = abs;

    if (!fs.existsSync(abs)) {
      // fallback: looks for the file name in the workspace
      const base = path.basename(raw);
      const safe = base.replace(/[*?[\]{}]/g, '');
      const found = safe ? await this.host.findFiles(`**/${safe}`, '**/node_modules/**', 1) : [];
      if (found.length) file = found[0];
      else {
        void this.host.notify('warning', t('File not found: {0}', base));
        return;
      }
    }

    // Preview mode ("View" link): markdown -> native preview, unless the user chose an editor for
    // Markdown files; the rest -> default opener (see EditorHost.previewFile).
    if (preview) {
      await this.host.previewFile(file);
      return;
    }

    try {
      await this.host.openFile(file, { line });
    } catch {
      void this.host.notify('warning', t('File not found: {0}', raw));
    }
  }

  /**
   * "Warms up" a chat tab's session: it starts the CLI process right when opening,
   * so the `init` event brings the slash commands before the first send. It only acts when
   * there is no process/commands yet and the CLI exists (avoids a useless spawn/error).
   */
  private primeCommands(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.cli || s.busy || s.slashCommands.length) return;
    if (!this.cliAvailable) return; // resolved in reportCliStatus (which runs earlier in init)
    if (this.daemonAutoAttachPending) return; // autoAttachDaemon primes when it is done
    try {
      s.ensureCli();
    } catch (e) {
      log(`primeCommands falhou: ${String(e)}`);
    }
  }

  /**
   * Enriquece os slash commands via IA (cache global ~/.claude/tootega) e envia os
   * metadata (category/hint/detail) to the webview. Best-effort: it only researches the ones
   * missing from the cache; a failure doesn't break the UI. Language = the Cockpit locale.
   */
  private async researchSlash(slashCommands?: string[]): Promise<void> {
    if (!slashCommands || slashCommands.length === 0) return;
    let started = false;
    try {
      const meta = await researchCommands({
        commands: slashCommands,
        locale: resolveLocale(),
        onResearchStart: () => {
          started = true;
          this.post({ kind: 'slashResearching', busy: true });
        },
      });
      if (Object.keys(meta).length) this.post({ kind: 'slashMeta', meta });
    } catch (e) {
      log(`researchSlash: ${String(e)}`);
    } finally {
      if (started) this.post({ kind: 'slashResearching', busy: false });
    }
  }

  private sendSessions(): void {
    const cwd = this.workspaceCwd();
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    const sessions = listSessions(cwd).map((s) =>
      names[s.id] ? { ...s, title: names[s.id] } : s,
    );
    // LIVE sessions (in-memory tabs) may not have a listable transcript on
    // disk yet on the CLI's first response. They are merged so the hub reflects running
    // contexts right away, without waiting for the turn to end.
    // Only BUSY (running) tabs are merged: an idle tab with content already comes from
    // listSessions (the .jsonl exists on disk); an idle, empty tab must NOT
    // reappear — otherwise it becomes a "ghost" that returns after deleting everything.
    const known = new Set(sessions.map((s) => s.id));
    for (const tabId of this.tabOrder) {
      const s = this.sessions.get(tabId);
      if (!s || !s.busy) continue;
      const id = s.sessionId ?? s.resumeId;
      if (!id || known.has(id)) continue;
      known.add(id);
      const nowIso = new Date().toISOString();
      sessions.push({
        id,
        title: names[id] || this.tabMeta.get(tabId)?.title || '',
        updatedAt: nowIso,
        createdAt: nowIso,
        messageCount: 0,
      });
    }
    sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (this.daemonSessions.length) {
      const live = new Map<string, 'busy' | 'running'>();
      for (const d of this.daemonSessions) {
        if (d.cliSessionId && d.state !== 'idle') live.set(d.cliSessionId, d.state);
      }
      for (const info of sessions) {
        const state = live.get(info.id);
        if (state) info.live = state;
      }
    }
    this.post({ kind: 'sessions', sessions, cwd });
  }

  /** Lists plugins + marketplaces and sends them to the modal. force = re-validate URLs (Haiku). */
  private async sendPlugins(force = false): Promise<void> {
    this.post({ kind: 'pluginsBusy', busy: true });
    try {
      const data = await listPlugins(this.claudePath(), force);
      this.post({ kind: 'pluginsData', data });
    } catch (e) {
      this.post({ kind: 'pluginsError', message: String(e) });
    } finally {
      this.post({ kind: 'pluginsBusy', busy: false });
    }
  }

  /** Runs a plugin action (install/uninstall/…); reloads the list at the end. */
  private async runPluginAction(
    action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'marketAdd' | 'marketRemove',
    arg: string,
    scope?: string,
  ): Promise<void> {
    this.post({ kind: 'pluginsBusy', busy: true, label: `${action} ${arg}` });
    try {
      const r = await pluginAction(this.claudePath(), action, arg, scope);
      if (!r.ok) this.post({ kind: 'pluginsError', message: r.message ?? 'failed' });
      const data = await listPlugins(this.claudePath());
      this.post({ kind: 'pluginsData', data });
    } catch (e) {
      this.post({ kind: 'pluginsError', message: String(e) });
    } finally {
      this.post({ kind: 'pluginsBusy', busy: false });
    }
  }

  /**
   * MCP servers (MCP button): merges the session's `init` inventory (tools per
   * server) with `claude mcp list` (pending approval + command/URL).
   * When the session hasn't done init yet (new tab), the panel shows only `mcp list`.
   */
  private async sendMcp(s: Session): Promise<void> {
    this.post({ kind: 'mcpBusy', busy: true });
    try {
      const list = await fetchMcpList(this.claudePath());
      const servers = mergeMcpStatus(s.lastTools, s.lastMcpServers, list, s.lastMcpErrors);
      this.post({ kind: 'mcpData', data: { servers, generatedAt: new Date().toISOString() } });
    } catch (e) {
      log(`sendMcp: ${String(e)}`);
      this.post({ kind: 'mcpData', data: { servers: [], generatedAt: new Date().toISOString() } });
    } finally {
      this.post({ kind: 'mcpBusy', busy: false });
    }
  }

  /** Gathers the account + real (hot) limits and sends them to the webview (Usage button). */
  private async sendUsage(): Promise<void> {
    try {
      await this.refreshUsage(true); // forces a fresh API call (hot data on click)
      const fetched = await fetchAuthStatus(this.claudePath());
      // A failed check is not "Not signed in": show what the last good answer would (logged in).
      const account = fetched.unknown ? { loggedIn: true } : fetched;
      const cache = readUsageCache();
      const scoped = this.lastScoped ?? cache?.weeklyScoped;
      // Session flags (fast mode, model label, effort) come only from the statusline
      // payload. Mark them stale when the cache is older than the trust window.
      if (account && cache?.session) {
        account.session = {
          ...cache.session,
          stale: cache.ageMs != null && cache.ageMs >= USAGE_CACHE_MAX_AGE_MS,
        };
      }
      // Detalhamento local 7d (por modelo / origem) — sempre estimativa de tabela,
      // independent of the account's real %. It scans this machine's transcripts.
      const [local, tokens] = await Promise.all([
        computeLocalUsage(Date.now()),
        computeDailyTokens(),
      ]);
      this.post({
        kind: 'usageData',
        data: {
          account,
          buckets: {
            fiveHour: toBucket(this.lastLimits?.fiveHour),
            sevenDay: toBucket(this.lastLimits?.sevenDay),
            weeklyScoped: scoped,
          },
          source: this.lastUsageSource,
          // Falling back to the estimate is never silent: the modal says why the real source
          // (OAuth API) didn't answer.
          sourceError:
            this.lastUsageSource === 'estimate' ? usageDiagnostics().lastError : undefined,
          trackingEnabled: usageTrackingEnabled(),
          breakdown: local.breakdown,
          attribution: local.attribution,
          tokens,
          otel: this.otel.stats(),
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      log(`sendUsage: ${String(e)}`);
    }
  }

  private autoResumeDone = false;

  /** Resumes the most recent session ONCE (on the first init). Sessions created later
   *  by the user ("New Session") must start empty, not resume the last one. */
  private autoResumeLast(): void {
    if (this.autoResumeDone) return;
    this.autoResumeDone = true;
    // A conversation still running for this folder wins over the latest transcript, and the
    // tab attaches to it right away.
    if (currentEngine() === 'claude') {
      this.daemonAutoAttachPending = true;
      void this.autoAttachDaemon().finally(() => {
        this.daemonAutoAttachPending = false;
        // Nothing to attach to: prime the (new) tab now, as the window normally does.
        if (this.activeTab) this.primeCommands(this.activeTab);
      });
      return;
    }
    if (!this.cfg().get<boolean>('autoResumeLastSession', true)) return;
    const s = this.active();
    if (s.resumeId || s.cli || s.sessionId) return; // there is already an active session
    const id = latestSessionId(this.workspaceCwd());
    if (id) {
      s.resume(id);
      this.restoreSessionModel(s, id); // restaura model/effort salvos
      this.sendConfig(); // reflects the restored model/effort in the dropdowns
    }
  }

  /**
   * On open: attach the active tab to the most recently active live session of
   * this folder (one with a process). Without one, falls back to the latest transcript (the
   * usual auto-resume), whose process the daemon starts on the first message.
   */
  private async autoAttachDaemon(): Promise<void> {
    const live = (await this.refreshDaemonSessions()).filter((d) => d.state !== 'idle' && d.cliSessionId);
    const tab = this.activeTab || this.createTab();
    const s = this.sessions.get(tab);
    if (!s || s.resumeId || s.cli || s.sessionId) return;
    const id = live[0]?.cliSessionId ??
      (this.cfg().get<boolean>('autoResumeLastSession', true) ? latestSessionId(this.workspaceCwd()) : undefined);
    if (!id) return;
    this.resumeInTab(tab, id);
    this.sendConfig();
    if (live.length > 1) {
      log(`[daemon] ${live.length} live sessions in this folder; attached to the most recent, the others are in the session list`);
    }
  }

  /**
   * Re-sends a tab's conversation (from the transcript) to ALL surfaces — to
   * populate a freshly opened panel or when switching tabs. It is skipped when the tab is
   * busy (live streaming) so the turn in progress isn't overwritten.
   */
  private replayTab(tabId: string, force = false): void {
    const s = this.sessions.get(tabId);
    // Normal: skipped when busy (doesn't overwrite the live turn). Recovery (force):
    // the panel has just remounted blank — repaints the persisted history; the
    // deltas em voo continuam chegando e se anexam.
    if (!s || (s.busy && !force)) return;
    const id = s.sessionId ?? s.resumeId;
    if (!id) return;

    // The local engine keeps its own transcript (the agent writes it after
    // every turn, because it exits when idle). Repainting from it is what makes
    // a hidden panel survive: VSCode destroys a hidden webview and re-mounts it
    // empty, and answering with an empty list would look like the turn vanished
    // — which is exactly what happened while this read `items: []`.
    const items =
      s.engine() === 'tootega'
        ? loadTootegaTranscript(id)
        : loadTranscript(this.workspaceCwd(), id);
    if (!this.tabMeta.get(tabId)?.title) {
      const names = this.memory.get<Record<string, string>>('sessionNames', {});
      this.setTabTitle(tabId, names[id] || this.titleFromItems(items));
    }
    this.post({ kind: 'history', items }, tabId);
    // Repainting history clears the prompt cards: show the ones still waiting again.
    s.reemitPrompts();
  }

  /**
   * Opens a session (double click in the list): focuses the tab that already has it; otherwise
   * opens it in a NEW tab. It never overwrites the active tab's conversation.
   */
  private openSession(sessionId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        this.openSessionPanel(id); // foca o painel existente
        return;
      }
    }
    const tab = this.createTab();
    this.resumeInTab(tab, sessionId);
    this.openSessionPanel(tab); // opens the context in its own webview
    this.sendConfig();
  }

  /**
   * Reload (↻ button on the card): recovers the context's gray/dead webview. When the
   * panel is open, it recreates it (same tabId/session untouched) and reveals it; otherwise
   * it opens fresh. It runs in the host → it works even with the renderer stuck.
   */
  private reloadSession(sessionId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        if (this.panels.has(id)) {
          this.reloadGuard.delete(id); // explicit request: ignores cooldown/cap
          if (this.recreatePanel(id)) this.panels.get(id)?.reveal();
        } else {
          this.openSessionPanel(id);
        }
        return;
      }
    }
    this.openSession(sessionId); // it wasn't loaded: opens it from scratch
  }

  /**
   * Toggles Remote Control for a conversation. The daemon's own CLI process runs the bridge, so
   * the phone / claude.ai/code joins the live session as one more client and every Cockpit
   * window keeps working on it. Nothing is stopped or handed over.
   */
  private async remoteControl(sessionId: string): Promise<void> {
    // Toggled in place: an open conversation is not focused, and one that is not loaded yet is
    // loaded in the background — pressing the button on a Hub card must not move the user.
    let entry = [...this.sessions].find(([, s]) => s.sessionId === sessionId || s.resumeId === sessionId);
    if (!entry) {
      const prevActive = this.activeTab;
      const tab = this.createTab();
      this.resumeInTab(tab, sessionId);
      this.activeTab = prevActive;
      this.postTabs();
      this.sendConfig();
      const loaded = this.sessions.get(tab);
      if (loaded) entry = [tab, loaded];
    }
    if (!entry) return;
    const [tabId, s] = entry;
    // The attach tells whether Remote Control is already on: read it before deciding what to do.
    s.ensureCli();
    await s.whenAttached();
    const on = !s.remoteActive;
    log(`remote control toggle for tab ${tabId}: window believed it was ${s.remoteActive ? 'on' : 'off'}, asking for ${on ? 'on' : 'off'}`);
    if (on) this.post({ kind: 'remoteState', active: true, phase: 'connecting' }, tabId);
    void s.setRemote(on).then((r) => {
      if (!r.ok) {
        this.post({ kind: 'remoteState', active: false, phase: 'failed', detail: r.error }, tabId);
        this.post(
          {
            kind: 'engineNotice',
            id: `remote-fail:${Date.now()}`,
            text: t('Remote Control did not start: {0}', r.error ?? ''),
            topic: 'remote_control',
          },
          tabId,
        );
        return;
      }
      this.post(
        {
          kind: 'engineNotice',
          id: `remote:${Date.now()}`,
          text: on
            ? t(
                'Remote Control is on: open {0} on your phone or at claude.ai/code. This conversation stays open in every window.',
                r.url ?? '',
              )
            : t('Remote Control is off.'),
          topic: 'remote_control',
        },
        tabId,
      );
    });
  }

  /** Reopens the last session the user closed (Ctrl+Shift+T). */
  reopenClosed(): void {
    const lc = this.lastClosed;
    if (!lc) return;
    this.lastClosed = undefined;
    // Session still alive in memory (only the panel was closed): reopens its panel.
    if (this.sessions.has(lc.tabId)) {
      this.openSessionPanel(lc.tabId);
    } else if (lc.sessionId) {
      this.openSession(lc.sessionId); // recarrega do transcript
    }
  }

  /** Loads a session's history into a specific tab and arms --resume. */
  private resumeInTab(tab: string, sessionId: string): void {
    const s = this.sessions.get(tab);
    s?.resume(sessionId);
    if (s) this.restoreSessionModel(s, sessionId); // model/effort saved for this session
    const items = loadTranscript(this.workspaceCwd(), sessionId);
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    this.setTabTitle(tab, names[sessionId] || this.titleFromItems(items));
    this.post({ kind: 'history', items }, tab);
    this.postTabs();
    log(`Resuming session ${sessionId} (${items.length} items) in ${tab}`);
    // Attach now, so a conversation running elsewhere streams in without waiting for a message
    // from this window (the daemon starts it if it isn't running). The Tootega engine is local.
    if (s && s.engine() === 'claude') {
      try {
        s.ensureCli();
      } catch (e) {
        log(`[daemon] attach failed: ${String(e)}`);
      }
    }
  }

  // ---- Skills ----

  /**
   * Overrides de listing de skills, guardados POR WORKSPACE: `.claude/skills/` é do
   * projeto (o engine reporta `projectSettings`), então um override de skill daqui não
   * deve vazar para outra pasta. Persiste no globalState — sobrevive a reiniciar o VS
   * Code — e é aplicado via `--settings` no spawn: o `~/.claude/settings.json` do usuário
   * NUNCA é tocado e o CLI fora do Cockpit segue intacto.
   */
  private skillOverrideMap(): Record<string, Record<string, SkillOverride>> {
    return this.memory.get<Record<string, Record<string, SkillOverride>>>('skillOverrides', {});
  }

  private applySkillOverrides(s: Session): void {
    const all = this.skillOverrideMap();
    s.skillOverrides = { ...(all[this.workspaceCwd()] ?? {}) };
    s.stats.setSkillOverrides(s.skillOverrides);
  }

  /** Muda o override de uma skill e reinicia os CLIs para o novo listing valer. */
  private setSkillOverride(name: string, value: SkillOverride): void {
    const all = this.skillOverrideMap();
    const key = this.workspaceCwd();
    const map = { ...(all[key] ?? {}) };
    if (value === 'on') delete map[name];
    else map[name] = value;
    all[key] = map;
    void this.memory.update('skillOverrides', all);
    for (const s of this.sessions.values()) s.setSkillOverride(name, value);
  }

  /** Relê os metadados de skills da sessão (control_request: sem turno, sem tokens). */
  private async sendSkills(s: Session): Promise<void> {
    this.post({ kind: 'skillsBusy', busy: true });
    try {
      await s.refreshSkills();
    } catch (e) {
      log(`sendSkills: ${String(e)}`);
    } finally {
      this.post({ kind: 'skillsBusy', busy: false });
    }
  }

  /** Persists a session's model/effort/permission (override) by sessionId, to restore later. */
  private saveSessionModel(s: Session): void {
    const id = s.sessionId ?? s.resumeId;
    if (!id) return; // a new session without an id yet: saved when init brings the id
    const map = this.memory.get<Record<string, SessionPrefs>>('sessionModels', {});
    map[id] = {
      model: s.modelOverride,
      effort: s.effortOverride,
      permission: s.permissionOverride,
      allowAgents: s.allowAgentsOverride,
      autoCompact: s.autoCompactOverride,
    };
    void this.memory.update('sessionModels', map);
  }

  /** Restores a session's saved model/effort (without restarting — there is no CLI yet). */
  private restoreSessionModel(s: Session, id: string): void {
    const map = this.memory.get<Record<string, SessionPrefs>>('sessionModels', {});
    const o = map[id];
    if (!o) return;
    if (o.model) s.modelOverride = o.model;
    if (o.effort) s.effortOverride = o.effort;
    if (o.permission && PERMISSION_MODES.includes(o.permission)) s.permissionOverride = o.permission;
    if (typeof o.allowAgents === 'boolean') s.allowAgentsOverride = o.allowAgents;
    if (o.autoCompact) s.autoCompactOverride = o.autoCompact;
  }

  /**
   * Rewinds the conversation to the (index)-th user prompt: cuts the transcript
   * at that prompt (removing it and everything after), re-arms --resume of the truncated session and
   * reloads the history in the webview. The next message continues from that point.
   */
  private rewind(tabId: string, index: number): void {
    const s = this.sessions.get(tabId);
    if (!s || s.busy) return; // doesn't rewind a turn in progress
    const id = s.sessionId ?? s.resumeId;
    if (!id) return;
    const cwd = this.workspaceCwd();
    const users = loadTranscript(cwd, id).filter((i) => i.kind === 'user');
    const target = users[index];
    if (!target) return;
    if (!truncateTranscriptAt(cwd, id, target.id)) {
      log(`rewind: prompt #${index} (uuid ${target.id}) not found in the transcript`);
      return;
    }
    s.resume(id); // limpa a conversa e rearma --resume a partir do transcript truncado
    this.replayTab(tabId); // reloads the (already cut) history in the webview
    this.postTabs();
    this.sendSessions();
    log(`rewind: session ${id} cut at prompt #${index}`);
  }

  /**
   * Inicia o ditado por voz (STT) p/ a aba: abre o WS OAuth, captura o mic NO
   * HOST (via ffmpeg — the webview blocks getUserMedia) and routes the transcriptions
   * back to the surface. It ends a previous session, when there is one.
   */
  private async startVoice(tabId: string, language?: string): Promise<void> {
    this.stopVoice();
    // Language: an explicit setting (cockpitDaemon.voiceLanguage) wins; otherwise the
    // webview locale; otherwise the Cockpit locale. Normalized to short (pt-BR->pt).
    const forced = this.cfg().get<string>('voiceLanguage', '').trim();
    const lang = ((forced || language || this.voiceLanguage()).split('-')[0] || 'en').toLowerCase();
    // Account dictionary: terms bias the STT (keyterms) + replacements applied
    // to the text. The key is resolved (cached) to match what the modal saved.
    // Reloaded from disk on every dictation (reflects modal edits immediately).
    this.voiceDict = loadDictionary();
    // Keyterms = the user's dictionary (priority) + the project name + terms
    // harvested from the workspace (deps + tech glossary). Since the STT runs monolingual
    // (the proxy rejects language=multi), keyterms is the anchor for the literal spelling of
    // jargon/English dictated inside pt-BR.
    const cwd = this.workspaceCwd();
    const keyterms = buildKeyterms(this.voiceDict, [path.basename(cwd), ...workspaceTerms(cwd)]);
    dlog(
      'voice',
      `dict: ${this.voiceDict.terms.length} terms, ${this.voiceDict.replacements.length} replacements | keyterms="${keyterms.slice(0, 240)}"`,
    );
    const capture = new AudioCapture({
      ffmpegPath: this.cfg().get<string>('ffmpegPath', '') || undefined,
    });
    this.voiceCapture = capture;
    let firstFrame = false; // sinaliza 'pronto' no 1º PCM real (mic vivo + WS aberto)
    this.voice = new VoiceSession(lang, keyterms, {
      onOpen: () => {
        // WS ready: start capturing and pushing PCM.
        void capture.start(
          (buf) => {
            if (!firstFrame) {
              firstFrame = true;
              // Only now is the dictation REALLY valid (WS + audio flowing):
              // the webview drops the spinner and enables "you may speak". Avoids losing
              // as 1ªs palavras faladas durante o setup do WS/ffmpeg.
              this.post({ kind: 'voiceReady' }, tabId);
            }
            this.voice?.pushAudio(buf);
          },
          (message) => {
            this.post({ kind: 'voiceError', message }, tabId);
            this.stopVoice();
          },
          () => {
            /* ffmpeg saiu: o stop() do WS cuida do encerramento */
          },
        );
      },
      onTranscript: (text, isFinal) => {
        const fixed = applyReplacements(text, this.voiceDict);
        if (isFinal && fixed !== text) dlog('voice', `replacement applied: "${text}" → "${fixed}"`);
        this.post({ kind: 'voiceTranscript', text: fixed, isFinal }, tabId);
      },
      onError: (message) => this.post({ kind: 'voiceError', message }, tabId),
      onClose: () => {
        this.voiceCapture?.stop();
        this.voiceCapture = undefined;
        this.voice = undefined;
        this.post({ kind: 'voiceClosed' }, tabId);
      },
    });
    this.voice.start();
  }

  /** Encerra a captura e o WS de voz, se ativos. */
  private stopVoice(): void {
    this.voiceCapture?.stop();
    this.voiceCapture = undefined;
    this.voice?.stop();
  }

  /** Corrects the dictated text via Haiku (isolated one-shot) and returns it to the surface. */
  private async correctVoice(tabId: string, text: string): Promise<void> {
    const t = text.trim();
    if (!t) {
      this.post({ kind: 'voiceCorrectError' }, tabId);
      return;
    }
    // Applies the dictionary replacements BEFORE and steers Haiku to preserve
    // the account's terms (not to "fix" proper nouns/jargon).
    const dict = loadDictionary();
    const pre = applyReplacements(t, dict);
    const corrected = await correctText(pre, correctorHints(dict));
    if (corrected) this.post({ kind: 'voiceCorrected', text: corrected }, tabId);
    else this.post({ kind: 'voiceCorrected', text: pre }, tabId); // Haiku failed: at least the replacements
  }

  /**
   * Exporta a conversa p/ a RAIZ do projeto. mode 'direct' grava o snapshot .html que o
   * webview montou a partir do DOM vivo — a timeline como está na tela, com CSS e imagens
   * embutidos; 'ai' rewrites the markdown via the CLI (same model/effort as the tab, spends
   * tokens) into a .md. Unique name (avoids overwriting); opens the file at the end.
   */
  private async exportConversation(
    tabId: string,
    markdown: string | undefined,
    html: string | undefined,
    fileName: string | undefined,
    mode: 'direct' | 'ai',
  ): Promise<void> {
    const pt = resolveLocale().startsWith('pt');
    try {
      let content: string;
      if (mode === 'ai') {
        const gen = markdown ? await this.generateDocAI(tabId, markdown) : undefined;
        if (!gen) {
          void this.host.notify(
            'error',
            pt ? 'Falha ao gerar o documento com IA.' : 'Failed to generate the document with AI.',
          );
          return;
        }
        content = gen;
      } else {
        // The snapshot is built in the webview (only there is the rendered DOM); without it
        // there is nothing to write — never fall back to the markdown, which would silently
        // hand the user a different format than the one requested.
        if (!html) {
          void this.host.notify(
            'error',
            pt ? 'Falha ao capturar a timeline.' : 'Failed to capture the timeline.',
          );
          return;
        }
        content = html;
      }
      const fallback = mode === 'ai' ? 'conversa.md' : 'conversa.html';
      const target = uniqueFilePath(path.join(this.workspaceCwd(), fileName || fallback));
      await fs.promises.writeFile(target, content, 'utf8');
      await this.host.openFile(target, { preview: false });
    } catch (e) {
      log(`exportConversation: ${String(e)}`);
      void this.host.notify('error', pt ? 'Falha ao exportar a conversa.' : 'Failed to export the conversation.');
    }
  }

  /**
   * Generates the document via a CLI one-shot (a separate process — it does NOT pollute the tab),
   * with the session's SAME effective model/effort. It spends subscription tokens.
   * Retorna o Markdown gerado, ou undefined em falha.
   */
  private generateDocAI(tabId: string, sourceMd: string): Promise<string | undefined> {
    const s = this.sessions.get(tabId) ?? this.active();
    const model = s.model();
    const effort = s.effort();
    const prompt = `${DOC_PROMPT}\n\n--- REGISTRO DA CONVERSA ---\n\n${sourceMd}`;
    // The prompt goes through STDIN (not argv): the conversation can be long and blow the
    // command-line limit (Windows ~32k). `claude -p` with no arg reads stdin.
    const args = ['-p', '--output-format', 'json'];
    if (model && model !== 'default') args.push('--model', model);
    if (effort && effort !== 'default') args.push('--effort', effort);
    const useShell = process.platform === 'win32';
    const exe = useShell && /\s/.test(this.claudePath()) ? `"${this.claudePath()}"` : this.claudePath();

    return Promise.resolve(this.host.withProgress<string | undefined>(
      this.docProgressTitle(model, effort),
      (progress) =>
        new Promise((resolve) => {
          let out = '';
          const proc = spawn(exe, args, { cwd: this.workspaceCwd(), env: process.env, shell: useShell });
          const killer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } }, 180_000);
          progress.onCancel(() => { try { proc.kill(); } catch { /* noop */ } });
          try {
            proc.stdin?.write(prompt);
            proc.stdin?.end();
          } catch { /* pipe fechou: o close devolve o que houver */ }
          proc.stdout?.setEncoding('utf8');
          proc.stdout?.on('data', (c: string) => (out += c));
          proc.on('error', (e) => { clearTimeout(killer); log(`generateDocAI spawn: ${String(e)}`); resolve(undefined); });
          proc.on('close', () => {
            clearTimeout(killer);
            resolve(extractCliResult(out));
          });
        }),
      { cancellable: true },
    ));
  }

  private docProgressTitle(model: string, effort: string): string {
    const pt = resolveLocale().startsWith('pt');
    const m = model && model !== 'default' ? model : pt ? 'padrão' : 'default';
    const e = effort && effort !== 'default' ? effort : pt ? 'padrão' : 'default';
    return pt
      ? `Gerando documento com IA (modelo ${m}, effort ${e})…`
      : `Generating document with AI (model ${m}, effort ${e})…`;
  }

  /** Loads the machine dictionary (dictation + spell-checker) and sends it to the modal. */
  private sendVoiceDict(tabId: string): void {
    const d = loadDictionary();
    this.post({ kind: 'voiceDict', data: { ...d, spellWords: this.getSpeller().userDict() } }, tabId);
  }

  /** Saves dictation + spell-checker dictionary (single per-machine file). */
  private saveVoiceDict(
    tabId: string,
    terms: string[],
    replacements: VoiceReplacement[],
    spellWords?: string[],
  ): void {
    if (spellWords) this.getSpeller().setUserDict(spellWords);
    // The dictation terms changed: reflected in the spell-checker (they aren't errors).
    this.getSpeller().setProjectTerms([...workspaceTerms(this.workspaceCwd()), ...terms]);
    const words = this.getSpeller().userDict();
    saveDictionary({ terms, replacements, spellWords: words });
    this.voiceDict = loadDictionary(); // applied right away to the next transcriptions
    this.post({ kind: 'voiceDict', data: { ...this.voiceDict, spellWords: words } }, tabId);
  }

  /** Spell-checker (lazy). Dictionaries in dict/ (data files). */
  private getSpeller(): Speller {
    if (!this.speller) {
      const dir = vscode.Uri.joinPath(this.extensionUri, 'dict').fsPath;
      // The spell-checker words come from the single per-machine file (~/.claude/tootega).
      const dict = loadDictionary();
      this.speller = new Speller(dir, dict.spellWords ?? []);
      // Technical terms (workspace deps/glossary + dictation dictionary terms)
      // count as known: the spell-checker doesn't flag them as errors.
      this.speller.setProjectTerms([...workspaceTerms(this.workspaceCwd()), ...dict.terms]);
    }
    return this.speller;
  }

  /** Checks a batch of words and returns the wrong ones to the tab that asked. */
  private async handleSpellCheck(tabId: string, words: string[]): Promise<void> {
    const sp = this.getSpeller();
    await sp.ensure();
    this.post({ kind: 'spellResult', bad: sp.check(words) }, tabId);
  }

  /** Correction suggestions (per language) for a word. */
  private async handleSpellSuggest(tabId: string, requestId: string, word: string): Promise<void> {
    const sp = this.getSpeller();
    await sp.ensure();
    const s = sp.suggest(word);
    this.post({ kind: 'spellSuggestResult', requestId, word, pt: s.pt, en: s.en }, tabId);
  }

  /** Dictation language: Cockpit locale -> short BCP47 code (pt-BR -> pt). */
  private voiceLanguage(): string {
    const loc = resolveLocale();
    return (loc.split('-')[0] || 'en').toLowerCase();
  }

  /**
   * Language of the agent's questions (AskUserQuestion). Same priority as dictation:
   * explicit `cockpitDaemon.voiceLanguage` setting > Cockpit locale. Short code.
   */
  private askLanguageCode(): string {
    const forced = this.cfg().get<string>('voiceLanguage', '').trim();
    return ((forced || resolveLocale()).split('-')[0] || 'en').toLowerCase();
  }

  /** Short title from the user's first utterance in the transcript. */
  private titleFromItems(items: { kind: string; text?: string }[]): string {
    const first = items.find((i) => i.kind === 'user' && i.text)?.text ?? '';
    return first.replace(/\s+/g, ' ').trim().slice(0, 28);
  }

  /** Current file content (for the Write diff). Empty when new/unreadable/large. */
  private currentFileText(tool: string, input: unknown): string | undefined {
    if (tool !== 'Write') return undefined;
    const fp = (input as { file_path?: unknown })?.file_path;
    if (typeof fp !== 'string' || !fp) return undefined;
    try {
      const abs = path.isAbsolute(fp) ? fp : path.join(this.workspaceCwd(), fp);
      if (!fs.existsSync(abs)) return ''; // arquivo novo -> tudo adicionado
      const st = fs.statSync(abs);
      if (st.size > 512 * 1024) return undefined; // grande demais p/ diff
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  }

  // Auto-save: before the agent reads/writes a file, it saves the open buffer when
  // dirty (prevents the agent from working on an old version). Setting cockpitDaemon.autosave.
  private autoSaveForTool(tool: string, input: unknown): void {
    if (!this.cfg().get<boolean>('autosave', true)) return;
    if (!/^(Edit|Write|MultiEdit|NotebookEdit|Read)$/.test(tool)) return;
    const fp = (input as { file_path?: unknown })?.file_path;
    if (typeof fp !== 'string' || !fp) return;
    const abs = path.isAbsolute(fp) ? fp : path.join(this.workspaceCwd(), fp);
    this.host.saveIfDirty(abs);
  }

  /** Abre o diff proposto (Edit/Write/MultiEdit) no diff nativo do VS Code. */
  private async openNativeDiff(tool: string, input: unknown): Promise<void> {
    const inp = (input ?? {}) as Record<string, unknown>;
    const fp = typeof inp.file_path === 'string' ? inp.file_path : '';
    if (!fp) return;
    const abs = path.isAbsolute(fp) ? fp : path.join(this.workspaceCwd(), fp);
    let oldText = '';
    try {
      oldText = fs.readFileSync(abs, 'utf8');
    } catch {
      /* arquivo novo */
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    let newText = oldText;
    if (tool === 'Write') newText = str(inp.content);
    else if (tool === 'Edit') newText = oldText.split(str(inp.old_string)).join(str(inp.new_string));
    else if (tool === 'MultiEdit' && Array.isArray(inp.edits)) {
      for (const e of inp.edits as Record<string, unknown>[]) {
        newText = newText.split(str(e.old_string)).join(str(e.new_string));
      }
    }
    const fileExists = fs.existsSync(abs);
    const title = `${path.basename(abs)} — proposed (${tool})`;
    await this.host.showDiff(fileExists ? { path: abs } : { text: oldText }, { text: newText }, abs, title);
  }

  /**
   * Busca resultados p/ o autocomplete de @-mention: sessões vivas (por nome) + arquivos do
   * workspace (fuzzy por path). As sessões vêm primeiro — são poucas e mais específicas que a
   * varredura de arquivos, e é o que o CLI 2.1.232 passou a resolver como `@nome` -> SendMessage.
   * A própria conversa é excluída: mencionar a si mesma não faz sentido.
   */
  private async searchMentions(tabId: string, requestId: string, query: string): Promise<void> {
    const items: MentionItem[] = [];
    // Sessões vivas com nome, que casem a query (prefixo, case-insensitive), menos a atual.
    try {
      const self = this.sessions.get(tabId);
      const selfIds = new Set([self?.sessionId, self?.resumeId].filter((i): i is string => !!i));
      const q = query.toLowerCase();
      for (const s of await liveSessions()) {
        if (!s.name || selfIds.has(s.sessionId)) continue;
        if (q && !s.name.toLowerCase().includes(q)) continue;
        items.push({ label: s.name, kind: 'session' });
      }
      items.sort((a, b) => a.label.length - b.label.length);
    } catch {
      /* registry unavailable: fall through to files */
    }
    // Arquivos do workspace.
    try {
      const glob = query ? `**/*${query.replace(/[^\w./-]/g, '')}*` : '**/*';
      const found = await this.host.findFiles(glob, '**/node_modules/**', 30);
      const files = found
        .map((f) => this.host.relativePath(f))
        .sort((a, b) => a.length - b.length)
        .map((label): MentionItem => ({ label, kind: 'file' }));
      items.push(...files);
    } catch {
      /* no workspace */
    }
    this.post({ kind: 'mentionResults', requestId, items: items.slice(0, 12) }, tabId);
  }

  /**
   * "Focus waiting prompt": open the chat that has a permission request or a question waiting
   * (the active conversation first) and put keyboard focus on it.
   */
  focusWaitingPrompt(): void {
    const order = [this.activeTab, ...this.sessions.keys()];
    const tabId = order.find((id) => id && this.sessions.get(id)?.hasPendingPrompt());
    if (!tabId) {
      void this.host.notify('info', t('No prompt is waiting for an answer.'));
      return;
    }
    this.openSessionPanel(tabId);
    setTimeout(() => this.post({ kind: 'focusPrompt' }, tabId), 200);
  }

  /** Permission requests currently also shown as a native notification. */
  private permissionNotices = new Set<string>();

  /** Is the chat that shows this conversation on screen right now? */
  private chatInView(tabId: string): boolean {
    if (this.panels.get(tabId)?.visible) return true;
    return this.sidebarTabs.has(tabId) && !!this.chatView?.visible;
  }

  /**
   * Besides the card in the chat, raise a native notification with Allow / Deny when the chat is
   * not in view (side bar closed, another editor tab on top). The panel is revealed first (see
   * onInteraction) and that takes a moment, so look again shortly. Answering in either place
   * closes the other.
   */
  private offerPermissionNotice(
    tabId: string,
    p: { requestId: string; title: string; detail: string; canAlways: boolean },
  ): void {
    if (!this.cfg().get<boolean>('notifyOnPermission', true)) return;
    setTimeout(() => {
      const session = this.sessions.get(tabId);
      if (!session?.hasPendingPermission(p.requestId) || this.chatInView(tabId)) return;
      const allow = t('Allow');
      const always = t('Always allow');
      const deny = t('Deny');
      this.permissionNotices.add(p.requestId);
      void this.host
        .notify(
          'warning',
          t('Claude wants to use {0}: {1}', p.title, p.detail),
          ...(p.canAlways ? [allow, always, deny] : [allow, deny]),
        )
        .then((pick) => {
          this.permissionNotices.delete(p.requestId);
          const s = this.sessions.get(tabId);
          if (!pick || !s?.hasPendingPermission(p.requestId)) return; // dismissed, or answered in the chat
          s.decideFromHost(p.requestId, pick === allow ? 'allow' : pick === always ? 'allow_always' : 'deny');
        });
    }, 800);
  }

  /** The request was answered or withdrawn: take its notification down. */
  private closePermissionNotice(requestId: string): void {
    if (this.permissionNotices.delete(requestId)) {
      this.host.hideNotifications();
    }
  }

  private notifyComplete(): void {
    if (!this.cfg().get<boolean>('notifyOnComplete', true)) return;
    // Notifies when no chat panel is visible.
    for (const p of this.panels.values()) if (p.visible) return;
    if (this.chatView?.visible) return;
    void this.host.notify('info', t('Claude finished responding.'));
  }

  private renameSession(id: string, name: string): void {
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    const next = { ...names };
    const trimmed = name.trim();
    if (trimmed) next[id] = trimmed;
    else delete next[id];
    void this.memory.update('sessionNames', next);
    // Immediately updates the title of that session's open tab/webview (when there is one).
    // Matched by sessionId (a turn already ran) OR resumeId (resumed without a turn yet).
    for (const [tabId, s] of this.sessions) {
      if (s.sessionId === id || s.resumeId === id) {
        this.setTabTitle(tabId, trimmed);
        break;
      }
    }
    this.sendSessions();
  }

  /**
   * Shuts down a tab's live CLI before deleting its transcript. Without this the
   * open session's `claude` process holds the `.jsonl` handle (on Windows the
   * unlink fails and the file survives) OR recreates it on the next flush/keep-alive —
   * the "ghost session" that reappears in the hub. clearConversation() kills the process
   * e zera sessionId/resumeId, detachando a aba do transcript apagado.
   * `all=true` detacha todas as abas vivas (usado no "apagar tudo").
   */
  private detachLiveSessions(sessionId?: string, all = false, end = false): void {
    for (const [tabId, s] of this.sessions) {
      const match = all || s.sessionId === sessionId || s.resumeId === sessionId;
      if (!match) continue;
      const wasOpen = !!(s.sessionId || s.resumeId || s.cli);
      s.clearConversation(end);
      if (!wasOpen) continue;
      // Reflete a limpeza na webview aberta desta aba (se houver).
      this.setTabTitle(tabId, '');
      this.post({ kind: 'history', items: [] }, tabId);
    }
  }

  /**
   * Before a transcript is deleted: ends the conversation's process everywhere. Detaching is
   * not enough for Claude, since the process lives on in the daemon and writes the
   * transcript again as it exits, so the "deleted" conversation comes back as an empty one.
   * Resolves once the daemon's processes have exited.
   */
  private async endLiveSessions(sessionId?: string, all = false): Promise<void> {
    this.detachLiveSessions(sessionId, all, true);
    const client = this.daemonClient();
    try {
      const mine = (await this.refreshDaemonSessions()).filter((d) => all || d.cliSessionId === sessionId);
      await Promise.all(mine.map((d) => client.forgetAndWait(d.id)));
    } catch (e) {
      log(`[daemon] could not end the process before deleting: ${String(e)}`);
    }
    await this.refreshDaemonSessions();
  }

  // They reflect the active tab (tab override ?? settings default).
  private currentModel(): string {
    return this.active().model();
  }
  private currentEffort(): string {
    return this.active().effort();
  }
  private currentPermissionMode(): string {
    return this.active().permission();
  }
  private currentAllowAgents(): boolean {
    return this.active().allowAgents();
  }

  private userName(): string {
    const set = this.cfg().get<string>('userName', '').trim();
    if (set) return set;
    try {
      return os.userInfo().username || '';
    } catch {
      return '';
    }
  }

  /**
   * Queries /v1/models once. It uses the API key (when present) or the subscription's
   * OAuth token — so a model released to the account shows up on its own, with no list to
   * edit. It is a no-op only when there is no credential at all.
   */
  private async tryDiscoverModels(): Promise<void> {
    // The price is independent of the credential (public docs) — fetched in parallel.
    void this.tryFetchPricing();
    if (this.discoveryTried) return;
    this.discoveryTried = true;
    const creds = resolveCreds(await this.getApiKey());
    if (!creds) return; // no credential: the picker lives off the cached catalogue
    try {
      const models = await discoverModels(creds);
      if (models.length === 0) return; // offline/denied: keeps the cached catalogue
      this.discoveryComplete = true;
      for (const m of models) {
        this.discoveredModels.set(m.id, m);
        registerModelContext(m.id, m.contextTokens); // fonte p/ o limite da barra (1M nativo)
      }
      void this.memory.update('modelCatalog', models);
      log(`Discovered ${models.length} models via /v1/models`);
      this.sendConfig();
      this.refreshContextLimits(); // post-init discovery: fixes the bar of the 1M models
    } catch {
      /* silent — the cached catalogue already covers it */
    }
  }

  /**
   * Last successful /v1/models result, cached in globalState. It is what the picker shows
   * before discovery answers (and when it can't: offline, no credential) — the alternative
   * would be a hardcoded list, which goes stale exactly when a new model ships.
   */
  private restoreDiscovery(): void {
    const cached = this.memory.get<DiscoveredModel[]>('modelCatalog');
    if (!Array.isArray(cached) || cached.length === 0) return;
    for (const m of cached) {
      if (!m?.id) continue;
      this.discoveredModels.set(m.id, m);
      registerModelContext(m.id, m.contextTokens);
    }
    this.discoveryComplete = true;
  }

  /** Loads prices from the docs (cached once a day). No-op after the first time. */
  private async tryFetchPricing(): Promise<void> {
    if (this.pricingTried || !this.globalStorageDir) return;
    this.pricingTried = true;
    try {
      const map = await ensurePricing(this.globalStorageDir);
      if (Object.keys(map).length > 0) {
        this.pricing = map;
        log(`Loaded pricing for ${Object.keys(map).length} models`);
        this.sendConfig();
      }
    } catch {
      /* silent — the price column stays empty */
    }
  }

  // Reapplies the (auto) context limit of every tab and re-emits the stats of the
  // ones that changed. Used when discovery arrives after the session init.
  private refreshContextLimits(): void {
    for (const [tab, s] of this.sessions) {
      if (s.stats.refreshContextLimit()) {
        this.post({ kind: 'stats', stats: s.snapshot() }, tab);
      }
    }
  }

  private planApproval(): string {
    const v = this.memory.get<string>('planApproval');
    return v && PLAN_APPROVALS.includes(v) ? v : 'default';
  }

  private sendConfig(): void {
    // The picker: 'default' (no --model flag) plus the account's catalogue, straight from
    // discovery. Nothing is hardcoded — see the header comment.
    const models = dedupe(['default', ...pickerIds([...this.discoveredModels.values()])]);
    // The tab's current model may be an id the catalogue doesn't offer (a pinned bare id, a
    // custom one): it still needs a label/context, hence it goes into the meta too.
    const defaultModel = this.defaults.model ?? this.observedDefaultModel;
    const meta = this.buildModelMeta(
      dedupe([...models, this.currentModel(), ...(defaultModel ? [defaultModel] : [])]),
      defaultModel,
    );
    this.post({
      kind: 'config',
      config: {
        engine: this.active().engine(),
        engines: availableEngines(),
        model: this.currentModel(),
        effort: this.currentEffort(),
        models,
        modelMeta: meta,
        efforts: EFFORT_OPTIONS,
        defaultModel,
        defaultEffort: this.defaults.effort,
        permissionMode: this.currentPermissionMode(),
        planApproval: this.planApproval(),
        permissionModes: PERMISSION_MODES,
        allowAgents: this.currentAllowAgents(),
        autoCompact: this.active().autoCompact(),
        hideThinking: this.cfg().get<boolean>('hideThinking', false),
        showBashDescription: this.cfg().get<boolean>('showBashDescription', true),
        spellCheck: this.cfg().get<boolean>('spellCheck', false),
        expandToolCards: this.cfg().get<boolean>('expandToolCards', false),
        scrollOnSend: this.cfg().get<boolean>('scrollOnSend', true),
        modePins: this.modePins(),
        pendingRestart: this.pendingRestart,
        userName: this.userName(),
        voiceCorrect: this.cfg().get<boolean>('voiceCorrect', false),
        verbosity: this.cfg().get<string>('verbosity', 'verbose') || 'verbose',
      },
    });
  }

  /**
   * Per-model metadata for the selector columns. The label and the context are REAL from the
   * Models API (display_name / max_input_tokens); the price comes from the docs (base id,
   * without the [1m] suffix). The multiplier reads "relative to your default model" (1x = the
   * default): anchoring it on a model pinned in the code would be one more thing to go stale.
   */
  private buildModelMeta(models: string[], anchorId?: string): Record<string, ModelMeta> {
    const priceOf = (id: string): PricingMap[string] | undefined =>
      // Price key: without the [1m] suffix and without a dated snapshot (-YYYYMMDD).
      this.pricing[
        (this.discoveredModels.get(id.replace(/\[1m\]/i, ''))?.resolvedId ?? id)
          .replace(/\[1m\]/i, '')
          .replace(/-\d{8}$/, '')
      ];
    // No known default (or no price for it): falls back to the priciest model on offer.
    const anchor =
      (anchorId ? priceOf(anchorId)?.inMTok : undefined) ??
      Math.max(0, ...models.map((id) => priceOf(id)?.inMTok ?? 0));
    const meta: Record<string, ModelMeta> = {};
    for (const id of models) {
      if (id === 'default') continue;
      const known = this.discoveredModels.get(id.replace(/\[1m\]/i, ''));
      const price = priceOf(id);
      meta[id] = {
        label: known?.displayName,
        contextTokens: known?.contextTokens ?? (/\[1m\]/i.test(id) || /muse-spark/i.test(id) || /(?:fable|sonnet|opus|haiku|mythos|spark)-5\b/i.test(id) ? ONE_M : 200_000),
        inMTok: price?.inMTok,
        outMTok: price?.outMTok,
        priceMult:
          price && anchor > 0 ? Math.round((price.inMTok / anchor) * 100) / 100 : undefined,
      };
    }
    return meta;
  }

  interrupt(): void {
    this.active().interrupt();
  }

  pushLocale(): void {
    this.post({ kind: 'locale', locale: resolveLocale() });
  }

  /** Retries model discovery (e.g. after changing the API key). */
  refreshModels(): void {
    this.discoveryTried = false;
    void this.tryDiscoverModels();
  }

  /** API key da descoberta de modelos, lida do SecretStorage (cifrada). '' se ausente. */
  private async getApiKey(): Promise<string> {
    if (!this.secrets) return '';
    try {
      return (await this.secrets.get(API_KEY_SECRET)) ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Asks the user for the API key (masked input) and writes it to SecretStorage.
   * Empty = removes the key. It re-runs model discovery at the end.
   * Comando `cockpitDaemon.setApiKey`.
   */
  async setApiKeyInteractive(): Promise<void> {
    if (!this.secrets) {
      void this.host.notify('warning', t('SecretStorage unavailable — cannot store the API key on this host.'));
      return;
    }
    const current = await this.getApiKey();
    const value = await this.host.inputBox({
      title: t('Anthropic API key (model discovery)'),
      prompt: t('Stored encrypted in the OS keychain. Leave empty to remove.'),
      password: true,
      value: current,
      placeholder: 'sk-ant-…',
    });
    if (value === undefined) return; // cancelou
    const trimmed = value.trim();
    if (trimmed) {
      await this.secrets.store(API_KEY_SECRET, trimmed);
      void this.host.notify('info', t('API key saved to the OS keychain.'));
    } else {
      await this.secrets.delete(API_KEY_SECRET);
      void this.host.notify('info', t('API key removed.'));
    }
    this.refreshModels();
  }

  /** Remove a API key do SecretStorage. Comando `cockpitDaemon.clearApiKey`. */
  async clearApiKey(): Promise<void> {
    if (this.secrets) await this.secrets.delete(API_KEY_SECRET);
    void this.host.notify('info', t('API key removed.'));
    this.refreshModels();
  }

  /**
   * One-off migration: the first `systemPrompt.quiet` default reached the model but was too
   * weak to override the CLI's own instinct to summarize its work, so the agent kept narrating
   * even with the box filled. The default was rewritten to a stronger, imperative form. A user
   * who never touched the box has the OLD text persisted, so the new default never reaches them;
   * this rewrites it — but ONLY when the saved value is byte-for-byte the old default, so a real
   * customization is never clobbered. Best-effort, silent.
   */
  async migrateQuietPromptDefault(): Promise<void> {
    const OLD_DEFAULT =
      'Work silently. While executing the task, do not narrate it: no commentary on what you are about to do, what you are doing, or what you have just done, and no running explanation between tool calls. When the work is finished, do not produce a report, a summary, or a list of the changes — state only that it is finished. Answer direct questions normally; this rule is about narration and closing reports, not about replying to the user.';
    try {
      const cfg = this.cfg();
      const inspected = cfg.inspect<string>('systemPrompt.quiet');
      const newDefault = inspected?.defaultValue ?? '';
      // Rewrite only the scopes whose EXPLICIT value is the old default (an untouched user has
      // no explicit value at all — that one already gets the new default for free).
      const scopes: Array<[string | undefined, 'global' | 'workspace' | 'folder']> = [
        [inspected?.global, 'global'],
        [inspected?.workspace, 'workspace'],
        [inspected?.folder, 'folder'],
      ];
      for (const [value, target] of scopes) {
        if (value === OLD_DEFAULT) {
          await cfg.update('systemPrompt.quiet', newDefault, target);
          log(`[quiet] stale default rewritten to the stronger form (scope ${target})`);
        }
      }
    } catch (e) {
      log(`[quiet] default migration failed: ${String(e)}`);
    }
  }

  /**
   * One-off migration: when the old `cockpitDaemon.apiKey` setting (plain text) has a value,
   * move p/ o SecretStorage e apaga a setting. Best-effort, silencioso.
   */
  async migrateApiKeyFromSettings(): Promise<void> {
    if (!this.secrets) return;
    const legacy = this.cfg().get<string>('apiKey', '').trim();
    if (!legacy) return;
    try {
      if (!(await this.secrets.get(API_KEY_SECRET))) {
        await this.secrets.store(API_KEY_SECRET, legacy);
      }
      // Cleared from all 3 scopes so no plain-text trace is left.
      const cfg = this.cfg();
      await cfg.update('apiKey', undefined, 'global');
      await cfg.update('apiKey', undefined, 'workspace');
      await cfg.update('apiKey', undefined, 'folder');
      log('[apiKey] migrada da setting p/ SecretStorage; setting removida');
      this.refreshModels();
    } catch (e) {
      log(`[apiKey] migration failed: ${String(e)}`);
    }
  }

  /** Applies the internal model (cockpitDaemon.internalModel) to the AI helper. */
  applyInternalModel(): void {
    setInternalModel(this.cfg().get<string>('internalModel', ''));
  }

  /** Recomputes local usage (e.g. after changing the budget in the settings). */
  refreshUsageNow(): void {
    void this.refreshUsage();
  }

  /**
   * The engine settings changed (default engine, a path, or the server).
   *
   * Only the tabs WITHOUT an override follow it — a tab that the user pinned to
   * an engine stays on it. The ones that follow have to be stopped: their live
   * process belongs to the old binary and would keep answering.
   */
  applyEngineChange(): void {
    log(`default engine: ${engineLabel()} (${enginePath()})`);
    this.resolvedPaths.clear();
    // The switch went off: a tab pinned to Tootega would keep talking to the local server with
    // no way back (the picker is gone), so the pin is dropped and the tab falls to Claude.
    if (!tootegaEnabled()) {
      for (const s of this.sessions.values()) {
        if (s.engineOverride === 'tootega') s.engineOverride = undefined;
      }
    }
    for (const s of this.sessions.values()) if (!s.engineOverride) s.stop();
    this.reportCliStatus();
    this.reportAuth();
    this.pushConfig();
  }

  /**
   * `cockpitDaemon.enableTodoTools` changed. It is an env var of the engine process, so it only
   * reaches a live tab through a respawn: stopping is enough, the next message resumes the
   * same conversation with the new environment (same path as a model switch).
   */
  applyTodoToolsChange(): void {
    for (const s of this.sessions.values()) s.stop();
  }

  /**
   * Tab pinned to an engine.
   *
   * Only ONE tab may be on Tootega at a time, and that is not a UI whim: the
   * local server answers one request at a time AND keeps a single KV cache, so
   * a second tab would both queue behind the first and destroy its prefix
   * cache on every turn — at ~11 tok/s of prefill that is minutes per turn, in
   * both tabs. Slots (M3) are what lifts this.
   */
  private setTabEngine(tabId: string, engine: EngineId): void {
    const s = this.sessions.get(tabId);
    if (!s) return;

    if (engine === 'tootega') {
      // Master switch off: the local engine does not exist here. Guarded in the host, not
      // just in the UI, so a stale message or a leftover override can't spawn `agent.exe`.
      if (!tootegaEnabled()) {
        this.sendConfig();
        return;
      }
      for (const [id, other] of this.sessions) {
        if (id !== tabId && other.engine() === 'tootega') {
          void this.host.notify(
            'warning',
            t('Only one Tootega tab at a time: the local server answers one request at a time and keeps a single cache.'),
          );
          this.sendConfig();
          return;
        }
      }
    }

    s.setEngine(engine);
    log(`tab ${tabId}: engine ${engine}`);
    this.reportCliStatus();
    this.reportAuth();
    this.sendConfig();
  }

  /** The model/effort settings changed: clears overrides and reflects them in the UI dropdowns. */
  applyDefaultsFromSettings(): void {
    // The default settings changed: tabs without an override now follow them.
    this.active().stop();
    this.sendConfig();
  }

  /** UI-only prefs (thinking/tool cards/name/verbosity): re-pushes the config without touching the session. */
  pushConfig(): void {
    this.sendConfig();
  }

  /** Opens the session list in the UI (command/shortcut). */
  openSessions(): void {
    this.post({ kind: 'openSessions' });
    this.sendSessions();
  }

  // Escopo (modelo, effort) p/ segmentar os tempos: prefere o modelo REAL
  // resolved by the CLI (snapshot), falling back to the selected one. Effort: the CLI doesn't
  // echo the level in the stream, so we resolve 'default' to the Cockpit setting and,
  // when still 'default', to the CLI's REAL effortLevel (~/.claude/settings.json) —
  // that way the key doesn't stay on an ambiguous 'default'.
  private timingScope(s: Session): { model: string; effort: string; verbosity: string } {
    const model = s.stats.snapshot().model || s.model() || 'default';
    let effort = s.effort() || 'default';
    if (effort === 'default') effort = this.cfg().get<string>('effort', 'default') || 'default';
    if (effort === 'default') effort = this.defaults.effort || 'default';
    const verbosity = this.cfg().get<string>('verbosity', 'verbose') || 'verbose';
    return { model, effort, verbosity };
  }

  // ---- Mensagens vindas do webview ----

  private onWebviewMessage(m: WebviewToHost, webview?: vscode.Webview): void {
    // Any message proves the render is alive: arms the watchdog clock.
    const sk = this.surfaceKey(webview);
    if (sk) {
      this.lastBeat.set(sk, Date.now());
      const g = this.reloadGuard.get(sk);
      if (g && Date.now() - g.at > RELOAD_COOLDOWN_MS) this.reloadGuard.delete(sk); // recuperou: zera o cap
    }
    // Origin session: chat panel -> its session; hub/unbound -> the active one.
    const bound = webview
      ? this.webviewSession.get(webview) ?? (webview === this.chatView?.webview ? this.chatTab : undefined)
      : undefined;
    const srcTab = bound && this.sessions.has(bound) ? bound : this.activeTab;
    const srcSession = (): Session => this.sessions.get(srcTab) ?? this.active();
    // The side bar chat acts on the conversation it shows: make that the active one first, so the
    // parts of the host that follow the active tab (combos, stats) agree with it.
    if (
      webview &&
      webview === this.chatView?.webview &&
      bound &&
      this.sessions.has(bound) &&
      this.activeTab !== bound &&
      m.kind !== 'heartbeat' &&
      m.kind !== 'init' &&
      m.kind !== 'switchTab'
    ) {
      this.setActive(bound);
    }
    switch (m.kind) {
      case 'heartbeat':
        this.startWatchdog(); // idempotente: garante o checador rodando
        break;
      case 'init':
        if (this.tabOrder.length === 0) this.createTab();
        if (webview && webview === this.chatView?.webview) {
          this.ensureChatTab();
          if (this.chatTab) this.primeCommands(this.chatTab);
        }
        this.startWatchdog();
        this.post({ kind: 'ready', locale: resolveLocale() });
        this.sendConfig();
        this.reportCliStatus();
        void this.tryDiscoverModels();
        this.startUsageTimer();
        this.postAccountLimits();
        this.startDaemonStatusTimer();
        void this.reportDaemonStatus();
        this.reportAuth(); // login state for the Sign in/out button
        this.autoResumeLast();
        this.postTabs();
        // init = a freshly mounted panel (open/reopen/recreate). It ALWAYS forces a replay
        // of the history, even with the session busy: otherwise reopening a running
        // context would show only the part that arrives after reopening. The deltas in flight
        // append to the repainted history.
        this.justRecreated.delete(bound ?? this.activeTab);
        this.replayTab(bound ?? this.activeTab, true);
        if (bound) this.primeCommands(bound); // loads slash commands without waiting for the first send
        // Recupera o rascunho/ditado espelhado (ex.: tela branca durante o ditado).
        {
          const draft = this.draftByTab.get(bound ?? this.activeTab);
          if (draft) this.post({ kind: 'draftRestore', text: draft }, bound ?? this.activeTab);
        }
        break;
      case 'sendMessage': {
        // Minimum effort gate: resolved NOW from the CLAUDE.md applicable to the session's
        // working folder (it doesn't live in the config — different folders, different
        // values). Below the minimum and without 'force' → asks for confirmation and does NOT send.
        const s = srcSession();
        const cwd = this.workspaceCwd();
        const min = resolveMinEffort(cwd, cwd);
        const eff = this.timingScope(s).effort;
        log(`sendMessage: effort=${eff} minEffort=${min ?? 'none'} force=${!!m.force}`);
        if (
          !m.force &&
          min &&
          eff in EFFORT_RANK &&
          EFFORT_RANK[eff] < (EFFORT_RANK[min] ?? 0)
        ) {
          this.post({ kind: 'effortGate', selected: eff, min }, srcTab);
          break; // blocked: the webview confirms and re-sends with force
        }
        const body = m.text;
        if (!this.tabMeta.get(srcTab)?.title && body.trim()) {
          this.setTabTitle(srcTab, body.replace(/\s+/g, ' ').trim().slice(0, 28));
        }
        // Enviar prompt confirma as escolhas de combo na aba atual: descarta o
        // baseline (there is no pending revert for a new context anymore).
        if (this.comboBaseline?.tab === srcTab) this.comboBaseline = undefined;
        if (this.pendingRestart) {
          // The model/effort/permission change is applied now (restart): the warning goes away.
          this.pendingRestart = false;
          this.sendConfig();
        }
        // Shares the editor selection as context, when the composer asked for it.
        const sel = m.selection ? `${m.selection}\n` : '';
        const text = `${sel}${body}`;
        if (m.now) s.sendNow(text, m.images, m.uuid);
        else s.send(text, m.images, m.uuid);
        this.draftByTab.delete(srcTab); // enviado: descarta o rascunho espelhado
        break;
      }
      case 'resolvePaths':
        this.post({
          kind: 'resolvedPath',
          requestId: m.requestId,
          text: m.absPaths.map((p) => this.quoteResolved(p)).join(' '),
        });
        break;
      case 'readClipboardFiles': {
        // The OS clipboard is the one of the machine this host runs on. Over Remote-SSH or in
        // a browser (code-server) that is not where you copied, so the paste's own content
        // (the webview's fallback) is the only right answer there.
        const local = this.host.isLocalUi();
        const paths = local ? readClipboardFiles() : [];
        this.post({
          kind: 'resolvedPath',
          requestId: m.requestId,
          text: paths.map((p) => this.quoteResolved(p)).join(' '),
        });
        break;
      }
      case 'interrupt':
        srcSession().interrupt();
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'permissionDecision': {
        // Remember how a plan was approved: the card highlights it next time. Never bypass.
        if (m.decision === 'allow' && srcSession().pendingTool(m.requestId) === 'ExitPlanMode') {
          const choice = m.mode ?? 'default';
          if (PLAN_APPROVALS.includes(choice) && choice !== this.memory.get<string>('planApproval')) {
            void this.memory.update('planApproval', choice);
            this.sendConfig();
          }
        }
        srcSession().decide(
          m.requestId,
          m.decision,
          m.decision === 'deny' && m.images?.length ? this.attachFeedback(m.message ?? '', m.images) : m.message,
          m.mode,
        );
        break;
      }
      case 'askResponse':
        srcSession().answer(
          m.requestId,
          m.images
            ? Object.fromEntries(Object.entries(m.answers).map(([q, a]) => [q, this.attachFeedback(a, m.images?.[q])]))
            : m.answers,
        );
        break;
      case 'setModel':
        this.snapComboBaseline(srcTab);
        srcSession().setModel(m.model); // switched live in the running process
        this.saveSessionModel(srcSession()); // persiste por contexto
        this.sendConfig();
        break;
      case 'removeModel': {
        const baseId = m.model.replace(/\[1m\]/i, '');
        const key = baseId.toLowerCase();
        // Só remove modelos que foram adicionados (custom/observados): não apaga o catálogo descoberto real
        // mas a remoção é permitida para qualquer entrada — descoberta recria os oficiais no próximo tryDiscoverModels.
        let removed = false;
        for (const k of [...this.discoveredModels.keys()]) {
          if (k.toLowerCase() === key) {
            this.discoveredModels.delete(k);
            removed = true;
          }
        }
        // Também remove a variante [1m] se existir
        for (const k of [...this.discoveredModels.keys()]) {
          if (k.toLowerCase() === `${key}[1m]`.toLowerCase()) {
            this.discoveredModels.delete(k);
            removed = true;
          }
        }
        // Se a sessão estava pinada no modelo removido, volta para default (mesmo se não estava no catálogo)
        const cur = srcSession().modelOverride;
        let curCleared = false;
        if (cur && cur.replace(/\[1m\]/i, '').toLowerCase() === key) {
          srcSession().setModel('default');
          this.saveSessionModel(srcSession());
          curCleared = true;
        }
        if (removed) {
          const remaining = [...this.discoveredModels.values()];
          void this.memory.update('modelCatalog', remaining);
        }
        if (removed || curCleared) this.sendConfig();
        break;
      }
      case 'setEffort':
        this.snapComboBaseline(srcTab);
        srcSession().setEffort(m.effort);
        this.saveSessionModel(srcSession()); // persiste por contexto
        this.sendConfig();
        break;
      case 'setPermissionMode': {
        this.snapComboBaseline(srcTab);
        srcSession().setPermission(m.mode);
        this.saveSessionModel(srcSession()); // persiste por contexto
        // The last choice is where new conversations start. Not Bypass: a new chat that
        // silently skips every permission prompt is too easy to miss.
        if (m.mode !== 'bypassPermissions' && PERMISSION_MODES.includes(m.mode)) {
          void this.cfg().update('permissionMode', m.mode, 'global');
        }
        this.sendConfig();
        break;
      }
      case 'pinMode': {
        // Pins the current model/effort to a mode for every conversation (user setting).
        if (!PERMISSION_MODES.includes(m.mode)) break;
        const pins = { ...this.modePins(), [m.mode]: { model: m.model, effort: m.effort } };
        void this.cfg().update('modePins', pins, 'global').then(() => this.sendConfig());
        break;
      }
      case 'unpinMode': {
        const pins = { ...this.modePins() };
        delete pins[m.mode];
        void this.cfg().update('modePins', pins, 'global').then(() => this.sendConfig());
        break;
      }
      case 'setEngine':
        this.setTabEngine(srcTab, m.engine === 'tootega' ? 'tootega' : 'claude');
        break;
      case 'setAutoCompact':
        // Claude: the daemon restarts the process itself (after the turn, when busy).
        if (!srcSession().setAutoCompact(m.value)) this.pendingRestart = true;
        this.saveSessionModel(srcSession());
        this.sendConfig();
        break;
      case 'setAllowAgents':
        this.snapComboBaseline(srcTab);
        srcSession().setAllowAgents(m.value);
        this.saveSessionModel(srcSession()); // persiste por contexto
        this.pendingRestart = true;
        this.sendConfig();
        break;
      case 'renameSession':
        this.renameSession(m.sessionId, m.name);
        break;
      case 'listSessions':
        this.sendSessions();
        // Badges for the conversations kept running, once the daemon answers.
        void this.refreshDaemonSessions().then(() => this.sendSessions());
        break;
      case 'resumeSession':
        this.openSession(m.sessionId);
        break;
      case 'reloadSession':
        this.reloadSession(m.sessionId);
        break;
      case 'remoteControl':
        void this.remoteControl(m.sessionId);
        break;
      case 'deleteSession':
        // Confirmation already done in the webview (elegant modal). Detaches the live tab
        // (releases the handle / prevents recreation) and then deletes the transcript.
        void this.endLiveSessions(m.sessionId).then(() => {
          deleteSession(this.workspaceCwd(), m.sessionId);
          deletePad(this.padDir, m.sessionId);
          if (this.globalStorageDir) deletePad(this.globalStorageDir, m.sessionId);
          this.sendSessions();
        });
        break;
      case 'deleteAllSessions':
        // Confirmation already done in the webview. Detaches ALL live tabs before
        // deleting — otherwise the open session holds/recreates its .jsonl and it reappears.
        const ids = listSessions(this.workspaceCwd(), 100000).map((x) => x.id);
        void this.endLiveSessions(undefined, true).then(() => {
          deleteAllSessions(this.workspaceCwd());
          for (const id of ids) {
            deletePad(this.padDir, id);
            if (this.globalStorageDir) deletePad(this.globalStorageDir, id);
          }
          this.sendSessions();
        });
        break;
      case 'newTab':
        this.openNewTab();
        break;
      case 'closeTab':
        this.closeTab(m.tabId);
        break;
      case 'switchTab':
        if (webview && webview === this.chatView?.webview && this.sidebarTabs.has(m.tabId)) this.chatTab = m.tabId;
        this.setActive(m.tabId);
        break;
      case 'openSettings':
        // Single entry point: the command resolves the extension id from the manifest.
        this.host.openSettings();
        break;
      case 'openLink':
        void this.openLink(m.href, m.preview);
        break;
      case 'installCli':
        this.installCli();
        break;
      case 'daemonInstall':
        this.host.installDaemon();
        break;
      case 'updateCli':
        this.updateCli();
        break;
      case 'recheckCli':
        this.reportCliStatus();
        this.reportAuth();
        break;
      case 'loginCli':
        this.loginCli();
        break;
      case 'logoutCli':
        this.logoutCli();
        break;
      case 'clearContext': {
        // Limpa o contexto do contexto de origem (conversa nova).
        srcSession().clearConversation();
        this.setTabTitle(srcTab, '');
        this.post({ kind: 'history', items: [] }, srcTab);
        break;
      }
      case 'compactContext':
        // Compacta o contexto via slash command do CLI.
        srcSession().send('/compact');
        break;
      case 'setKeepCacheAlive':
        // Liga/desliga o keep-alive de cache do contexto de origem (persistido).
        srcSession().setKeepCacheAlive(m.value);
        break;
      case 'mentionSearch':
        void this.searchMentions(srcTab, m.requestId, m.query);
        break;
      case 'openDiff':
        void this.openNativeDiff(m.tool, m.input);
        break;
      case 'draftChanged':
        // Mirrors the draft/dictation in the host (survives the renderer's death).
        if (m.text) this.draftByTab.set(srcTab, m.text);
        else this.draftByTab.delete(srcTab);
        break;
      case 'setLocale':
        this.post({ kind: 'locale', locale: m.locale });
        break;
      case 'openEditor':
        this.openInEditor();
        break;
      case 'openFolder':
        // Abre a pasta no gerenciador de arquivos do SO (Explorer/Finder).
        this.host.openPath(m.path);
        break;
      case 'saveImage':
        void this.saveImage(m.mediaType, m.data);
        break;
      case 'openScratchpad':
        this.openScratchpad(srcTab, m.image);
        break;
      case 'spellCheck':
        void this.handleSpellCheck(srcTab, m.words);
        break;
      case 'spellSuggest':
        void this.handleSpellSuggest(srcTab, m.requestId, m.word);
        break;
      case 'spellAdd': {
        // Persists into the single per-machine file (preserves the existing dictation data).
        this.getSpeller().addWord(m.word);
        const cur = loadDictionary();
        saveDictionary({ ...cur, spellWords: this.getSpeller().userDict() });
        break;
      }
      case 'rewind':
        this.rewind(srcTab, m.index);
        break;
      case 'voiceStart':
        log('[voice] start requested by webview');
        void this.startVoice(srcTab, m.language);
        break;
      case 'voiceStop':
        log('[voice] webview requested stop');
        this.stopVoice();
        break;
      case 'voiceCorrect':
        void this.correctVoice(srcTab, m.text);
        break;
      case 'exportMd':
        void this.exportConversation(srcTab, m.markdown, m.html, m.fileName, m.mode);
        break;
      case 'voiceDictGet':
        this.sendVoiceDict(srcTab);
        break;
      case 'voiceDictSave':
        this.saveVoiceDict(srcTab, m.data.terms, m.data.replacements, m.data.spellWords);
        break;
      case 'pluginsRefresh':
        void this.sendPlugins(m.force);
        break;
      case 'mcpRefresh':
        void this.sendMcp(srcSession());
        break;
      case 'skillsRefresh':
        void this.sendSkills(srcSession());
        break;
      case 'skillOverrideSet':
        this.setSkillOverride(m.name, m.value);
        break;
      case 'pluginAction':
        void this.runPluginAction(m.action, m.arg, m.scope);
        break;
      case 'fetchUsage':
        void this.sendUsage(); // hot data: fetches account + limits + breakdown on click
        break;
      case 'enableUsageTracking': {
        // Installs the statusline wrapper (captures the real rate_limits on the next render).
        const r = enableUsageTracking(this.memory);
        const msg =
          r === 'ok'
            ? t('Usage tracking enabled. Real limits appear after Claude refreshes the statusline.')
            : r === 'unsupported'
              ? t('Live usage tracking is only available on Windows for now.')
              : t('Could not enable usage tracking (settings.json could not be updated).');
        void this.host.notify('info', msg);
        void this.sendUsage(); // reflete o novo estado de tracking no modal
        break;
      }
      case 'credsLoad':
      case 'credsEnrollBegin':
      case 'credsEnrollConfirm':
      case 'credsAdd':
      case 'credsEdit':
      case 'credsUse':
      case 'credsDelete':
        void this.handleCreds(m);
        break;
    }
  }

  /** Credential vault (TOTP 2FA). Every sensitive action validates the code in the host. */
  private async handleCreds(m: WebviewToHost): Promise<void> {
    const tab = this.activeTab;
    const store = this.creds;
    if (!store) {
      this.post({ kind: 'credsError', message: t('Secret storage is unavailable.') }, tab);
      return;
    }
    const sendData = async () => {
      this.post(
        { kind: 'credsData', enrolled: await store.isEnrolled(), items: await store.list() },
        tab,
      );
    };
    try {
      switch (m.kind) {
        case 'credsLoad':
          await sendData();
          break;
        case 'credsEnrollBegin': {
          const setup = await store.beginEnroll();
          this.post({ kind: 'credsSetup', ...setup }, tab);
          break;
        }
        case 'credsEnrollConfirm': {
          const ok = await store.confirmEnroll(m.code);
          this.post({ kind: 'credsResult', ok, action: 'enroll' }, tab);
          if (ok) await sendData();
          break;
        }
        case 'credsAdd': {
          const r = await store.add(m.code, {
            name: m.name,
            username: m.username,
            value: m.value,
            note: m.note,
          });
          this.post(
            { kind: 'credsResult', ok: r.ok, action: 'add', message: r.reason },
            tab,
          );
          if (r.ok) await sendData();
          break;
        }
        case 'credsEdit': {
          const r = await store.edit(m.code, m.id, {
            name: m.name,
            username: m.username,
            value: m.value,
            note: m.note,
          });
          this.post({ kind: 'credsResult', ok: r.ok, action: 'edit', message: r.reason }, tab);
          if (r.ok) await sendData();
          break;
        }
        case 'credsUse': {
          const r = await store.use(m.code, m.id);
          if (!r.ok) {
            this.post({ kind: 'credsResult', ok: false, action: 'use', message: r.reason }, tab);
            break;
          }
          const meta = (await store.list()).find((c) => c.id === m.id);
          this.post(
            { kind: 'credsValue', id: m.id, name: meta?.name ?? '', value: r.value ?? '' },
            tab,
          );
          break;
        }
        case 'credsDelete': {
          const r = await store.remove(m.code, m.id);
          this.post({ kind: 'credsResult', ok: r.ok, action: 'delete', message: r.reason }, tab);
          if (r.ok) await sendData();
          break;
        }
      }
    } catch (e) {
      // Never log values/secrets: only the error's generic message.
      this.post({ kind: 'credsError', message: String((e as Error)?.message ?? e) }, tab);
    }
  }

  /** Saves a pasted image (base64) to disk via VSCode's native dialog. */
  /** Files of images pasted into plan feedback / answers, removed when the turn ends. */
  private feedbackImages: string[] = [];

  /** Saves pasted feedback images and returns the text with their paths named. */
  private attachFeedback(text: string, images?: import('../../shared/protocol').ImageAttachment[]): string {
    if (!images?.length) return text;
    const saved = saveFeedbackImages(this.workspaceCwd(), images);
    this.feedbackImages.push(...saved.abs);
    return withImagePaths(text, saved.rel);
  }

  private async saveImage(mediaType: string, data: string): Promise<void> {
    const ext = (mediaType.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg');
    const def = `image-${Date.now()}.${ext}`;
    const target = await this.host.saveDialog({
      defaultPath: path.join(this.workspaceCwd(), def),
      filters: { [t('Images')]: [ext] },
    });
    if (!target) return; // the user cancelled
    try {
      fs.writeFileSync(target, Buffer.from(data, 'base64'));
    } catch (e) {
      void this.host.notify('error', t('Failed to save image: {0}', String(e)));
    }
  }

  // ---- CLI ----

  /** The model/effort pinned to each permission mode (setting cockpitDaemon.modePins). */
  private modePins(): Record<string, ModePin> {
    const raw = this.cfg().get<Record<string, ModePin>>('modePins', {}) ?? {};
    const out: Record<string, ModePin> = {};
    for (const [mode, pin] of Object.entries(raw)) {
      if (!PERMISSION_MODES.includes(mode) || !pin || typeof pin !== 'object') continue;
      const model = typeof pin.model === 'string' && pin.model.trim() ? pin.model.trim() : undefined;
      const effort = typeof pin.effort === 'string' && pin.effort.trim() ? pin.effort.trim() : undefined;
      if (model || effort) out[mode] = { model, effort };
    }
    return out;
  }

  private cfg() {
    return settings();
  }

  // Resolved path per engine: with tabs on different engines, both binaries
  // have to be findable at the same time.
  private resolvedPaths = new Map<EngineId, string>();
  private cliUpdatePoll: ReturnType<typeof setInterval> | undefined;
  private cliAvailable = false;
  private pathFixed = false; // already tried adding ~/.local/bin to the user's PATH

  /** Caminho efetivo do CLI (resolvido) — usado p/ spawn/pesquisa/install.
   *
   *  Segue o motor escolhido: com `cockpitDaemon.engine = "tootega"` isto aponta para
   *  o agente local, e é o único ponto que precisa saber disso — tudo o que
   *  gera processo passa por aqui. */
  private claudePath(engine: EngineId = currentEngine()): string {
    return this.resolvedPaths.get(engine) ?? enginePath(engine);
  }

  /** Comando p/ rodar o claude num TERMINAL (PATH ou ~/.local/bin fora do PATH).
   *  Without spaces: runs directly (PowerShell and cmd). With spaces: uses the call operator. */
  private claudeCmd(): string {
    const exe = this.claudePath();
    if (!/\s/.test(exe)) return exe;
    return process.platform === 'win32' ? `& "${exe}"` : `"${exe}"`;
  }

  private reportCliStatus(): void {
    const engine = currentEngine();
    const r = CliProcessManager.resolve(enginePath(engine), engine);
    if (r.ok) this.resolvedPaths.set(engine, r.path);
    else this.resolvedPaths.delete(engine);
    this.cliAvailable = r.ok;
    const cockpitVersion = this.cockpitVersion();
    this.post({ kind: 'cliStatus', available: r.ok, version: r.version, error: r.error, cockpitVersion });
    if (r.ok) {
      log(`${engineLabel()} detected: ${r.version} @ ${r.path}`);
      // Both are Claude-specific: the npm package and the native installer's
      // directory. The local agent ships with the engine and has neither.
      if (engineCaps().account) {
        this.ensureLocalBinOnPath(r.path); // native installer: makes sure ~/.local/bin is in the user's PATH
        // Latest version (npm) in the background → repost with `latest` to flag it as outdated.
        void getLatestCliVersion().then((latest) => {
          if (latest) {
            this.post({ kind: 'cliStatus', available: true, version: r.version, latest, cockpitVersion });
          }
        });
      }
    } else {
      log(`${engineLabel()} not found: ${r.error}`);
    }
  }

  /**
   * Makes sure the native installer's dir (~/.local/bin) is in the USER's PATH
   * (Windows). Idempotent, User scope only (it doesn't touch the system PATH). It only
   * acts when claude was resolved from that dir and it isn't in the PATH yet.
   */
  private ensureLocalBinOnPath(exePath: string): void {
    if (process.platform !== 'win32' || this.pathFixed) return;
    const bin = path.dirname(exePath);
    if (!/[\\/]\.local[\\/]bin$/i.test(bin)) return; // only the native installer's dir
    if ((process.env.PATH ?? '').toLowerCase().includes(bin.toLowerCase())) return; // already in the PATH
    this.pathFixed = true;
    const ps =
      `$b='${bin.replace(/'/g, "''")}'; ` +
      `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; ` +
      `if(($p -split ';') -notcontains $b){ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';')+';'+$b), 'User') }`;
    try {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        timeout: 8000,
      });
      log(`Added to user PATH: ${bin}`);
      void this.host.notify('info', 
        t('Added Claude to your PATH: {0}. Restart open terminals to use it.', bin),
      );
    } catch (e) {
      log(`PATH update failed: ${String(e)}`);
    }
  }

  /** Runs `claude update` in a visible terminal (the user follows the progress). */
  private updateCli(): void {
    // Cockpit's own copy is updated by downloading the new version next to the old one; any other
    // install is left to the CLI's own updater.
    const inUse = this.resolvedPaths.get('claude');
    if (managedVersion() && inUse && inUse.startsWith(managedRoot())) {
      void this.downloadManagedCli(true);
      return;
    }
    const before = CliProcessManager.resolve(enginePath(), currentEngine()).version;
    this.host.runInTerminal('Claude Update', `${this.claudeCmd()} update`);
    this.pollForCliUpdate(before);
  }

  /**
   * After `claude update` in a terminal: the terminal gives no reliable "finished" signal (shell
   * integration is missing in some setups, and not every shell reports it), so the version is
   * re-read every few seconds until it differs from the old one, then the dashboard is refreshed.
   */
  private pollForCliUpdate(before: string | undefined): void {
    if (this.cliUpdatePoll) clearInterval(this.cliUpdatePoll);
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const r = CliProcessManager.resolve(enginePath(), currentEngine());
      const changed = r.ok && r.version !== before;
      if (changed || tries > 60) {
        clearInterval(iv);
        this.cliUpdatePoll = undefined;
        if (changed) {
          this.reportCliStatus();
          void this.host.notify('info', 
            t('Claude Code CLI detected: {0}', r.version ?? ''),
          );
        }
      }
    }, 3000);
    this.cliUpdatePoll = iv;
  }

  /** This extension's version (read from the bundle's package.json). */
  private cockpitVersion(): string | undefined {
    try {
      const p = path.join(this.extensionUri.fsPath, 'package.json');
      return JSON.parse(fs.readFileSync(p, 'utf8')).version as string;
    } catch {
      return undefined;
    }
  }

  /** On activation: when the CLI is missing, it asks (with consent) and installs. */
  async promptInstallIfMissing(): Promise<void> {
    // `resolve`, not `detect`: a window started from the Dock has no ~/.local/bin on its PATH,
    // and the bare name then fails although the CLI is installed (resolve also probes there).
    const path = this.cfg().get<string>('claudePath', 'claude');
    if (CliProcessManager.resolve(path).ok) return;
    const download = t('Download');
    const installer = t('Use the official installer');
    const docs = t('Documentation');
    const pick = await this.host.notify('warning', 
      t(
        'Claude Code CLI not found. Cockpit can keep its own copy (about 230 MB, downloaded from Anthropic and checked against its published checksum).',
      ),
      download,
      installer,
      docs,
    );
    if (pick === download) this.installCli();
    else if (pick === installer) this.installCliInTerminal();
    else if (pick === docs) {
      this.host.openExternal('https://docs.claude.com/en/docs/claude-code/overview');
    }
  }

  /** Instala o Claude Code CLI globalmente num terminal integrado (guiado). */
  private installCli(): void {
    void this.downloadManagedCli(false);
  }

  /**
   * Downloads Cockpit's own copy of the CLI (see ManagedCli) with a progress notification, then
   * re-detects. `update` = the copy exists and is being brought to the newest version. When the
   * download fails the user is offered the official installer in a terminal instead.
   */
  private async downloadManagedCli(update: boolean): Promise<void> {
    try {
      const result = await this.host.withProgress(
        update ? t('Updating Claude Code CLI…') : t('Downloading Claude Code CLI…'),
        async (progress) => {
          let last = 0;
          return installManaged({
            onProgress: (done, total) => {
              if (!total) return;
              const pct = Math.floor((done / total) * 100);
              if (pct > last) {
                progress.report(pct - last, `${pct}%`);
                last = pct;
              }
            },
          });
        },
      );
      log(`[cli] managed copy ${result.changed ? 'installed' : 'already current'}: ${result.version} @ ${result.path}`);
      this.reportCliStatus();
      void this.host.notify('info', 
        t('Claude Code CLI {0} is ready (kept in {1}).', result.version, managedRoot()),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`[cli] managed download failed: ${message}`);
      const installer = t('Use the official installer');
      const pick = await this.host.notify('error', 
        t('Could not download Claude Code CLI: {0}', message),
        installer,
      );
      if (pick === installer) this.installCliInTerminal();
    }
  }

  /** The official installer in a terminal (installs for the user under ~/.local). */
  private installCliInTerminal(): void {
    // Official NATIVE installer: it doesn't depend on Node/npm (solves the "npm not
    // recognized" case). It brings Claude Code's own runtime.
    const cmd =
      process.platform === 'win32'
        ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
        : 'curl -fsSL https://claude.ai/install.sh | bash';
    this.host.runInTerminal('Claude Code · install', cmd);
    void this.host.notify('info', 
      t('Installing Claude Code CLI… it will be detected automatically when ready.'),
    );
    this.pollForCli();
  }

  /** After installing: re-probes the CLI (including ~/.local/bin) until it is found; then refreshes. */
  private pollForCli(): void {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const r = CliProcessManager.resolve(enginePath(), currentEngine());
      if (r.ok || tries > 60) {
        clearInterval(iv);
        if (r.ok) {
          this.reportCliStatus(); // validates + restores version/latest in the Cockpit
          void this.host.notify('info', 
            t('Claude Code CLI detected: {0}', r.version ?? ''),
          );
        }
      }
    }, 4000);
  }

  /**
   * Login NATIVO do CLI via OAuth no browser (`claude auth login`, default
   * --claudeai = subscription). A dedicated subcommand drives the flow; there is no need
   * to open the REPL or type /login. The Cockpit never touches credentials.
   */
  loginCli(): void {
    this.host.runInTerminal('Claude Code · login', `${this.claudeCmd()} auth login`); // abre OAuth no browser; --console p/ API billing
    void this.host.notify('info', 
      t('Signing in via your browser. Approve the request, then click "Re-check".'),
    );
    this.scheduleAuthRefresh(); // the flow is asynchronous in the terminal: re-check right after
  }

  /** Native CLI logout (`claude auth logout`) in a terminal. The Cockpit never touches credentials. */
  logoutCli(): void {
    this.host.runInTerminal('Claude Code · logout', `${this.claudeCmd()} auth logout`);
    void this.host.notify('info', 
      t('Signing out in the terminal. Use Sign in when you want to log back in.'),
    );
    this.scheduleAuthRefresh();
  }

  /** Fetches the login state and pushes it to the webview (shows Sign in OR Sign out). */
  reportAuth(): void {
    // The local engine has no account: it is always "logged in", and saying so
    // keeps the Sign in button out of the way.
    if (!engineCaps().account) {
      this.post({ kind: 'auth', loggedIn: true });
      return;
    }
    // A check already running may have started before the login changed: ask for one more after it.
    if (this.authChecking) {
      this.authAgain = true;
      return;
    }
    resetAccountKey(); // login/logout may have changed the account → re-resolve the dictionary
    void resolveAccountKey(this.claudePath());
    this.authChecking = true;
    void fetchAuthStatus(this.claudePath()).then((a) => {
      this.authChecking = false;
      if (this.authAgain) {
        this.authAgain = false;
        this.reportAuth();
        return;
      }
      if (!a.unknown) {
        this.authRetries = 0;
        this.post({ kind: 'auth', loggedIn: a.loggedIn });
        return;
      }
      // Unknown is not logged out: the button keeps its state, and the check is tried again.
      log(`auth status: unknown (${a.error ?? 'no reason'})`);
      const wait = [5000, 15000][this.authRetries++];
      if (wait !== undefined) setTimeout(() => this.reportAuth(), wait);
      else this.authRetries = 0;
    });
  }
  private authChecking = false;
  private authAgain = false;
  private authRetries = 0;

  /** Re-checa o login algumas vezes (o fluxo de login/logout roda no terminal). */
  private scheduleAuthRefresh(): void {
    for (const ms of [3000, 8000, 15000]) setTimeout(() => this.reportAuth(), ms);
  }

  // ---- util ----

  private post(msg: HostToWebview, tab?: string): void {
    this.surfaces.post(msg, tab);
  }

  private panelSurface(w: vscode.Webview, tab: string): HostSurface {
    return { kind: 'panel', tab, post: (m) => void w.postMessage(m) };
  }

  private getHtml(webview: vscode.Webview, mode: 'chat' | 'hub' | 'sidebar' = 'chat', sessionTab?: string): string {
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
    // The extension icon for the activity indicator (img in the webview). media/ isn't
    // in localResourceRoots by default — included alongside dist/webview.
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${resolveLocale()}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Cockpit for Claude Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__TOOTEGA_VIEW__ = ${JSON.stringify(mode)}; window.__TOOTEGA_SESSION__ = ${JSON.stringify(sessionTab ?? '')}; window.__TOOTEGA_REGION__ = ${JSON.stringify(viewRegionLocale(this.host.isWebUi()))}; window.__TOOTEGA_ICON__ = ${JSON.stringify(iconUri.toString())};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /** Provider da view na Activity Bar (hub). Mesma bundle, modo 'hub'. */
  /** The side bar chat needs a conversation to show: the active one if it has no editor tab. */
  private ensureChatTab(): void {
    if (this.chatTab && this.sessions.has(this.chatTab) && this.sidebarTabs.has(this.chatTab)) return;
    const first = [...this.sidebarTabs].find((id) => this.sessions.has(id));
    const candidate =
      first ?? (this.activeTab && this.sessions.has(this.activeTab) && !this.panels.has(this.activeTab) ? this.activeTab : undefined);
    const id = candidate ?? this.createTab();
    this.sidebarTabs.add(id);
    this.chatTab = id;
    if (this.activeTab !== id) this.activeTab = id;
  }

  /** The side bar chat view: same webview app, `sidebar` mode (a chat that can switch tabs). */
  resolveChatView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.getHtml(view.webview, 'sidebar');
    this.chatView = view;
    this.surfaces.set(SIDEBAR_ID, { kind: 'sidebar', post: (m) => void view.webview.postMessage(m) });
    const setKey = (): void => {
      void vscode.commands.executeCommand('setContext', 'cockpitDaemon.sideBarActive', view.visible);
    };
    setKey();
    const sub = view.webview.onDidReceiveMessage((m: WebviewToHost) => this.onWebviewMessage(m, view.webview));
    const visSub = view.onDidChangeVisibility(() => {
      setKey();
      if (view.visible && this.chatTab) this.setActive(this.chatTab);
    });
    view.onDidDispose(() => {
      sub.dispose();
      visSub.dispose();
      void vscode.commands.executeCommand('setContext', 'cockpitDaemon.sideBarActive', false);
      if (this.chatView === view) {
        this.chatView = undefined;
        this.surfaces.remove(SIDEBAR_ID);
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.getHtml(view.webview, 'hub');
    this.hubView = view;
    this.surfaces.set(HUB_ID, { kind: 'hub', post: (m) => void view.webview.postMessage(m) });
    this.lastBeat.set(HUB_SURFACE, Date.now());
    dlog('watchdog', 'hub-view montado (resolveWebviewView)');
    const sub = view.webview.onDidReceiveMessage((m: WebviewToHost) =>
      this.onWebviewMessage(m, view.webview),
    );
    const visSub = view.onDidChangeVisibility(() => {
      if (view.visible) this.lastBeat.set(HUB_SURFACE, Date.now()); // shown again: re-arms the clock
    });
    view.onDidDispose(() => {
      sub.dispose();
      visSub.dispose();
      this.lastBeat.delete(HUB_SURFACE);
      this.reloadGuard.delete(HUB_SURFACE);
      if (this.hubView === view) {
        this.hubView = undefined;
        this.surfaces.remove(HUB_ID);
      }
    });
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

/**
 * A short filename slug from a plan's first meaningful line — the first heading when there is
 * one, otherwise the first non-empty line. Lowercased, ASCII words joined by '-', capped so the
 * path stays sane. Empty when the plan has no usable text (the caller then names by timestamp only).
 */
function planSlug(plan: string): string {
  const lines = plan.split('\n').map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s+/.test(l));
  const first = heading ? heading.replace(/^#{1,6}\s+/, '') : lines.find((l) => l.length > 0) ?? '';
  return first
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

// Instruction for the "Generate with AI" option: it produces an organized, coherent document
// from the conversation record. It focuses on the reasoning/decisions and the outcome;
// it omits technical noise. It keeps the conversation's language.
const DOC_PROMPT = [
  'You are a technical editor. From the conversation record below (between a developer and an AI assistant),',
  'write a DOCUMENT in Markdown — organized, high level and coherent — telling the story of the work:',
  'what was asked, what was thought and decided, what was done, WHY and HOW, and the final outcome.',
  'Prioritize the reasoning, the decisions and the motivation. OMIT technical noise (commands, tool output, raw diffs).',
  'Structure it with headings, sections and lists when that helps reading. Be faithful to the content — do not invent.',
  'Write in the SAME language that predominates in the conversation.',
  'Answer ONLY with the document Markdown — no comments, no code fence around the whole thing.',
].join(' ');

/** Unique path: when the file already exists, it inserts -2, -3… before the extension. */
function uniqueFilePath(full: string): string {
  if (!safeExistsSync(full)) return full;
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const base = path.basename(full, ext);
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${base}-${i}${ext}`);
    if (!safeExistsSync(cand)) return cand;
  }
  return full;
}

function safeExistsSync(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Extrai o texto do resultado do `claude -p --output-format json`. Tolerante. */
function extractCliResult(out: string): string | undefined {
  const trimmed = out.trim();
  if (!trimmed) return undefined;
  try {
    const j = JSON.parse(trimmed);
    const arr = Array.isArray(j) ? j : [j];
    for (const o of arr) {
      if (typeof o?.result === 'string' && o.result.trim()) return stripWrappingFence(o.result.trim());
    }
  } catch {
    /* non-JSON: uses the raw text as a fallback */
  }
  return stripWrappingFence(trimmed);
}

/** Removes a code fence wrapping the whole document (```markdown … ```). */
function stripWrappingFence(s: string): string {
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}

/** LimitWindow (interno) -> UsageBucket (protocolo do modal Usage). */
function toBucket(w?: LimitWindow): UsageBucket | undefined {
  if (!w) return undefined;
  return { usedPct: w.usedPct, resetsAt: w.resetsAt, tokens: w.tokens, usd: w.usd };
}

// The OS REGION locale (date/time format), NOT the UI language.
// On Windows VS Code forces Node's locale to the display language (en),
// so Node's Intl is useless — we read the regional culture via PowerShell
// `(Get-Culture).Name` (= "pt-BR", the same the taskbar uses). Memoized.
let cachedRegion: string | undefined;
function osRegionLocale(): string {
  if (cachedRegion) return cachedRegion;
  let loc = '';
  if (process.platform === 'win32') {
    try {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '[System.Globalization.CultureInfo]::CurrentCulture.Name'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true },
      );
      loc = (r.stdout || '').trim();
    } catch {
      /* fallback abaixo */
    }
  }
  if (process.platform === 'darwin') {
    // Node takes its locale from LANG, which says nothing about System Settings > Region.
    // `AppleLocale` has both, e.g. "en_US@rg=nlzzzz": English, with the Netherlands as the region.
    try {
      const r = spawnSync('defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 2000 });
      const raw = (r.stdout || '').trim();
      const m = /^([a-z]{2,3})(?:[_-][A-Za-z]+)?(?:@rg=([a-z]{2})zzzz)?/i.exec(raw);
      if (m) {
        const region = m[2] ? m[2].toUpperCase() : /[_-]([A-Za-z]{2})\b/.exec(raw)?.[1]?.toUpperCase();
        loc = region ? `${m[1].toLowerCase()}-${region}` : m[1].toLowerCase();
      }
    } catch {
      /* fallback below */
    }
  }
  if (!loc) {
    try {
      loc = new Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      loc = 'en';
    }
  }
  cachedRegion = loc || 'en';
  return cachedRegion;
}

/**
 * The locale for dates and times in the webviews.
 *  1. `cockpitDaemon.dateLocale`, when set (and valid).
 *  2. Empty in a browser (code-server): the host's region says nothing about the viewer's, and
 *     the browser knows its own, so the webview falls back to its `navigator.language`.
 *  3. Otherwise the region of the machine the host runs on. Under Remote-SSH that is the remote
 *     machine, but a desktop webview only gets VS Code's display language, no region, so this is
 *     the best there is; `cockpitDaemon.dateLocale` overrides it.
 */
function viewRegionLocale(webUi: boolean): string {
  const set = (settings().get<string>('dateLocale', '') ?? '').trim();
  if (set) {
    try {
      new Intl.DateTimeFormat(set);
      return set;
    } catch {
      /* not a valid locale: ignore it */
    }
  }
  if (webUi) return '';
  return osRegionLocale();
}

function makeNonce(): string {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}

/** A plan file written in the last 15 minutes with exactly this content, if any. */
function findRecentPlan(dir: string, body: string): string | undefined {
  const cutoff = Date.now() - 15 * 60_000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(dir, name);
      const st = fs.statSync(file);
      if (st.mtimeMs < cutoff || st.size !== Buffer.byteLength(body, 'utf8')) continue;
      if (fs.readFileSync(file, 'utf8') === body) return file;
    }
  } catch {
    /* no folder yet */
  }
  return undefined;
}
