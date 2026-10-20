// The VS Code side of the Cockpit: webview views and panels, the HTML they load, the status bar
// items, context keys and the render watchdog. Everything else lives in CockpitCore.
import * as vscode from 'vscode';
import type { WebviewToHost } from '../../shared/protocol';
import type { ImageAttachment } from '../../shared/protocol';
import { CockpitCore, makeNonce, viewRegionLocale } from '../core/CockpitCore';
import { HUB_ID, SIDEBAR_ID, panelId, type Surface } from '../core/surfaces';
import { t } from '../core/services';
import type { KeyValueStore, SecretStore } from '../core/host';
import { resolveLocale } from '../i18n/host';
import { log, dlog } from '../util/logger';
import { daemonHome } from '../daemon/paths';
import { ScratchpadManager } from './ScratchpadPanel';
import { VsCodeHost } from './VsCodeHost';

const WATCHDOG_ENABLED = false;
const HEARTBEAT_DEAD_MS = 30_000; // no beat for this long = render presumed dead
const WATCHDOG_TICK_MS = 10_000; // how often the visible surfaces are checked
const RELOAD_COOLDOWN_MS = 60_000; // doesn't reload the same surface before this
const RELOAD_MAX_TRIES = 2; // attempts before giving up (avoids a reload loop)
const HUB_SURFACE = '__hub__'; // key of the hub surface in the beat map

export class ChatViewProvider extends CockpitCore implements vscode.WebviewViewProvider {
  // The Cockpit lives as an editor tab (WebviewPanel) + a hub in the Activity Bar (WebviewView)
  // + a chat in the side bar. The state lives in the core and is replicated to every surface.
  private panels = new Map<string, vscode.WebviewPanel>();
  private webviewSession = new Map<vscode.Webview, string>();
  private hubView?: vscode.WebviewView;
  private chatView?: vscode.WebviewView;
  private statusBar?: vscode.StatusBarItem;
  // Reload button in the status bar: always visible while a Cockpit panel is
  // open. It recovers the gray/dead webview (same action as the watchdog) — it runs in the
  // host, so it is independent of the renderer and of the editor action settings.
  private reloadBar?: vscode.StatusBarItem;
  private readonly scratchpads: ScratchpadManager;

  // Render watchdog: the webview process (renderer) can die (VSCode GPU
  // bug) — the screen goes blank but the host stays alive (stream/stats/timeline
  // keep going). Every surface sends a periodic beat; when a VISIBLE one stops
  // beating past the limit, the HTML is force-reloaded. It NEVER touches the CLI/context.
  private lastBeat = new Map<string, number>(); // surfaceKey -> epoch ms of the last beat
  private reloadGuard = new Map<string, { at: number; count: number }>(); // cooldown/cap per surface
  private watchdog?: ReturnType<typeof setInterval>;
  private watchdogDisabledLogged = false; // logs only once that the watchdog is off
  private windowStateSub?: vscode.Disposable; // window focus (re-arms the beat on return)

  constructor(
    private readonly extensionUri: vscode.Uri,
    memory: KeyValueStore,
    statusBar?: vscode.StatusBarItem,
    secrets?: SecretStore,
    globalStorageUri?: vscode.Uri,
  ) {
    super(new VsCodeHost(), extensionUri.fsPath, memory, secrets, globalStorageUri?.fsPath);
    this.scratchpads = new ScratchpadManager(extensionUri, daemonHome(), () => resolveLocale(), (key, image) =>
      this.onPadSend(key, image),
    (key) => this.latestChatImage(key));
    this.statusBar = statusBar;
    this.updateStatusBar(false);
    // Reload button (status bar, right). Hidden until a context is opened.
    this.reloadBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.reloadBar.text = '$(refresh)';
    this.reloadBar.tooltip = t('Reload Cockpit view (fix gray/blank panel)');
    this.reloadBar.command = 'cockpitDaemon.reloadView';
    this.updateReloadBar();
  }

  dispose(): void {
    super.dispose();
    if (this.watchdog) clearInterval(this.watchdog);
    this.windowStateSub?.dispose();
    this.reloadBar?.dispose();
  }

  // ---- Window plumbing for the core ----

  protected hasPanel(tab: string): boolean {
    return this.panels.has(tab);
  }

  protected panelVisible(tab: string): boolean {
    return this.panels.get(tab)?.visible === true;
  }

  protected anyPanelVisible(): boolean {
    for (const p of this.panels.values()) if (p.visible) return true;
    return false;
  }

  protected revealPanel(tab: string): boolean {
    const existing = this.panels.get(tab);
    if (!existing) return false;
    try {
      existing.reveal();
      return true;
    } catch {
      this.panels.delete(tab);
      this.surfaces.remove(panelId(tab));
      this.webviewSession.delete(existing.webview);
      return false;
    }
  }

  protected revealPanelQuietly(tab: string): void {
    this.panels.get(tab)?.reveal(undefined, false);
  }

  protected createPanel(tabId: string, title: string): void {
    const panel = vscode.window.createWebviewPanel('cockpitDaemon.cockpit.editor', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    });
    // Editor tabs don't mask the icon (raw render) -> colored version.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-color.svg');
    this.bindPanel(panel, tabId);
  }

  protected disposePanel(tab: string): boolean {
    const p = this.panels.get(tab);
    if (!p) return false;
    try {
      p.dispose();
      return true;
    } catch {
      return false;
    }
  }

  protected setPanelTitle(tab: string, title: string): void {
    const p = this.panels.get(tab);
    if (p) p.title = title;
  }

  protected reloadPanel(id: string): void {
    this.reloadGuard.delete(id); // explicit request: ignores cooldown/cap
    if (this.recreatePanel(id)) this.panels.get(id)?.reveal();
  }

  protected sidebarOpen(): boolean {
    return !!this.chatView;
  }

  protected sidebarVisible(): boolean {
    return this.chatView?.visible === true;
  }

  protected onSurfaceAlive(from: string | undefined): void {
    // Any message proves the render is alive: arms the watchdog clock.
    const sk = from === HUB_ID ? HUB_SURFACE : from?.startsWith('panel:') ? from.slice('panel:'.length) : undefined;
    if (!sk) return;
    this.lastBeat.set(sk, Date.now());
    const g = this.reloadGuard.get(sk);
    if (g && Date.now() - g.at > RELOAD_COOLDOWN_MS) this.reloadGuard.delete(sk); // recuperou: zera o cap
  }

  protected openPad(key: string, title: string, image?: ImageAttachment): void {
    this.scratchpads.open(key, title, image);
  }

  protected disposePads(): void {
    this.scratchpads.dispose();
  }

  /** Shows the reload button while at least one Cockpit panel is open. */
  private updateReloadBar(): void {
    if (!this.reloadBar) return;
    if (this.panels.size > 0) this.reloadBar.show();
    else this.reloadBar.hide();
  }

  protected updateStatusBar(busy: boolean): void {
    if (!this.statusBar) return;
    this.statusBar.text = busy ? '$(loading~spin) Cockpit' : '$(sparkle) Cockpit';
    this.statusBar.tooltip = 'Cockpit for Claude Code';
    this.statusBar.command = 'cockpitDaemon.open';
    this.statusBar.show();
  }

  /** Shows the side bar chat (focus), for the command and the status bar. */
  focusSidebar(): void {
    void vscode.commands.executeCommand('cockpitDaemon.chat.focus');
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
      this.onWebviewMessage(m, panelId(tabId)),
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

  /** Starts the periodic render checker (idempotent). */
  protected startWatchdog(): void {
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

  private panelSurface(w: vscode.Webview, tab: string): Surface {
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
    const sub = view.webview.onDidReceiveMessage((m: WebviewToHost) => this.onWebviewMessage(m, SIDEBAR_ID));
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
      this.onWebviewMessage(m, HUB_ID),
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
