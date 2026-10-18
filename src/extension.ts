// Extension entry point.
import * as vscode from 'vscode';
import { ChatViewProvider } from './panel/ChatViewProvider';
import { enableUsageTracking, disableUsageTracking, isEnabled } from './cli/StatuslineInstaller';
import {
  enableUtf8Fix,
  disableUtf8Fix,
  isEnabled as utf8FixEnabled,
} from './cli/Utf8HookInstaller';
import { flushStats } from './stats/StatsStore';
import { log, setDebugLogging } from './util/logger';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  daemonLogPath,
  installLaunchAgent,
  launchAgentInstalled,
  probeDaemon,
  restartLaunchAgent,
  startDetached,
  stopDaemon,
  uninstallDaemon,
} from './daemon/service';

export function activate(context: vscode.ExtensionContext): void {
  setDebugLogging(vscode.workspace.getConfiguration('cockpitDaemon').get<boolean>('debugLog', false));
  log('Cockpit for Claude Code activating…');

  // Restart/reload: VSCode tries to restore the contexts' webview tabs, but
  // without state they end up "dead". Close them all on activate — start clean.
  closeStaleCockpitTabs();

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const provider = new ChatViewProvider(
    context.extensionUri,
    context.globalState,
    statusBar,
    context.secrets,
    context.globalStorageUri,
  );
  context.subscriptions.push({ dispose: () => provider.dispose() }); // for the CacheKeeper

  // The Cockpit lives as an editor tab (WebviewPanel). No sidebar view.
  // The status bar item (created by the provider) and the command/shortcut open the editor.

  // One-off migration: drops the old `cockpitDaemon.apiKey` setting (plain text) and moves it
  // p/ o SecretStorage (keychain do SO). Best-effort, silencioso.
  void provider.migrateApiKeyFromSettings();

  // One-off migration: rewrites the weak first `systemPrompt.quiet` default (which reached the
  // model but let the agent keep narrating) to the stronger form — only when never customized.
  void provider.migrateQuietPromptDefault();

  // On activation (onStartupFinished): if the CLI is missing, offer to install it.
  void provider.promptInstallIfMissing();
  // Offer (once) to enable real account usage via the statusline — it enriches the
  // always-visible %. The automatic channel (rate_limit_event in the stream) already works
  // without it; the statusline complements it at low usage.
  void maybeOfferUsageTracking(context, provider);
  // Offer (once) the hook that fixes the accents of the PowerShell tool on
  // Windows — see Utf8HookInstaller for the why.
  void maybeOfferUtf8Fix(context);

  // The secondary side bar exists from VS Code 1.106; before that the chat view sits in the Activity Bar.
  {
    const [major, minor] = vscode.version.split('.').map((n) => parseInt(n, 10));
    const noSecondary = major < 1 || (major === 1 && minor < 106);
    void vscode.commands.executeCommand('setContext', 'cockpitDaemon.noSecondarySidebar', noSecondary);
  }

  context.subscriptions.push(
    // Opens Cockpit where the user prefers it (cockpitDaemon.preferredLocation: side bar or editor tab).
    vscode.commands.registerCommand('cockpitDaemon.open', () => {
      provider.openPreferred();
    }),
    vscode.commands.registerCommand('cockpitDaemon.scratchpad', () => provider.openScratchpad()),
    vscode.commands.registerCommand('cockpitDaemon.openInSidebar', () => {
      provider.moveToSidebar();
    }),
    // ---- Daemon mode (cockpit-daemon keeps Claude running across windows/devices) ----
    vscode.commands.registerCommand('cockpitDaemon.daemon.install', async () => {
      const cfg = vscode.workspace.getConfiguration('cockpitDaemon');
      const bundledScript = path.join(context.extensionPath, 'dist', 'daemon.js');
      const idleStopHours = cfg.get<number>('daemon.idleStopHours', 0) ?? 0;
      const socketPath = provider.daemonSocketPath();
      if (!fs.existsSync(bundledScript)) {
        void vscode.window.showErrorMessage(vscode.l10n.t('dist/daemon.js is missing from this build.'));
        return;
      }
      // A daemon that runs without our launchd agent (the Cockpit Daemon menu bar app, or one
      // started by hand) already does the job: installing a second one would fight it for the
      // socket. Nothing to install.
      const runningPid = await probeDaemon(socketPath);
      if (runningPid && !launchAgentInstalled()) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'cockpit-daemon is already running (pid {0}), for example from the Cockpit Daemon app. Nothing was installed.',
            String(runningPid),
          ),
        );
        return;
      }
      if (process.platform === 'darwin') {
        const r = installLaunchAgent({ bundledScript, fallbackNode: process.execPath, socketPath, idleStopHours });
        log(`[daemon] install: ${r.message}`);
        if (!r.ok) {
          void vscode.window.showErrorMessage(vscode.l10n.t('Could not install cockpit-daemon: {0}', r.message));
          return;
        }
      } else {
        // No launchd: a detached process that survives this window (not a reboot).
        startDetached({ node: process.execPath, script: bundledScript, socketPath, idleStopHours });
      }
      void vscode.window.showInformationMessage(
        vscode.l10n.t('cockpit-daemon is running. Claude keeps running when this window closes.'),
      );
    }),
    vscode.commands.registerCommand('cockpitDaemon.daemon.restart', () => {
      if (!launchAgentInstalled()) {
        void vscode.window.showWarningMessage(vscode.l10n.t('cockpit-daemon is not installed as a service. Run "Install daemon" first.'));
        return;
      }
      const r = restartLaunchAgent();
      if (r.ok) void vscode.window.showInformationMessage(vscode.l10n.t('cockpit-daemon restarted. Running turns were stopped; conversations resume on the next message.'));
      else void vscode.window.showErrorMessage(vscode.l10n.t('Could not restart cockpit-daemon: {0}', r.message));
    }),
    vscode.commands.registerCommand('cockpitDaemon.daemon.stop', async () => {
      const r = await stopDaemon(provider.daemonSocketPath());
      log(`[daemon] stop: ${r.message}`);
      if (!r.ok) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not stop cockpit-daemon: {0}', r.message));
        return;
      }
      void vscode.window.showInformationMessage(
        vscode.l10n.t('cockpit-daemon stopped. Running turns ended; conversations resume on the next message once it runs again.'),
      );
    }),
    vscode.commands.registerCommand('cockpitDaemon.daemon.uninstall', async () => {
      const remove = vscode.l10n.t('Uninstall');
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t('Uninstall cockpit-daemon?'),
        {
          modal: true,
          detail: vscode.l10n.t(
            'It stops the daemon and the Claude processes it runs, removes the launchd agent and deletes ~/.cockpit (including its list of sessions). Claude cannot run in Cockpit until the daemon is installed again. Your conversations stay on disk.',
          ),
        },
        remove,
      );
      if (pick !== remove) return;
      const r = await uninstallDaemon(provider.daemonSocketPath());
      log(`[daemon] uninstall: ${r.message}`);
      if (!r.ok) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not uninstall cockpit-daemon: {0}', r.message));
        return;
      }
      void vscode.window.showInformationMessage(vscode.l10n.t('cockpit-daemon uninstalled. Claude cannot run until it is installed again.'));
    }),
    vscode.commands.registerCommand('cockpitDaemon.daemon.showLog', async () => {
      const file = daemonLogPath();
      if (!fs.existsSync(file)) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No daemon log yet ({0}).', file));
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
    }),
    vscode.commands.registerCommand('cockpitDaemon.daemon.stopSession', () => {
      if (!provider.stopActiveDaemonSession()) {
        void vscode.window.showInformationMessage(vscode.l10n.t('The active tab is not running in cockpit-daemon.'));
        return;
      }
      vscode.window.setStatusBarMessage(vscode.l10n.t('Session stopped in cockpit-daemon.'), 3000);
    }),
    vscode.commands.registerCommand('cockpitDaemon.newSession', () => {
      provider.newSession();
      vscode.window.setStatusBarMessage(vscode.l10n.t('Started a new session.'), 3000);
    }),
    vscode.commands.registerCommand('cockpitDaemon.interrupt', () => {
      provider.interrupt();
      vscode.window.setStatusBarMessage(vscode.l10n.t('Agent interrupted.'), 3000);
    }),
    vscode.commands.registerCommand('cockpitDaemon.openSessions', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.cockpitDaemon');
      provider.openSessions();
    }),
    vscode.commands.registerCommand('cockpitDaemon.settings', () => {
      // The id comes from the manifest (publisher.name): hardcoding it breaks the
      // filter whenever the extension is republished under another publisher.
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`,
      );
    }),
    vscode.commands.registerCommand('cockpitDaemon.openInEditor', () => {
      provider.openInEditor();
    }),
    vscode.commands.registerCommand('cockpitDaemon.focusPrompt', () => {
      provider.focusWaitingPrompt();
    }),
    vscode.commands.registerCommand('cockpitDaemon.reloadView', () => {
      provider.reloadActivePanel();
    }),
    vscode.commands.registerCommand('cockpitDaemon.reopenClosed', () => {
      provider.reopenClosed();
    }),
    vscode.commands.registerCommand('cockpitDaemon.login', () => {
      provider.loginCli();
    }),
    vscode.commands.registerCommand('cockpitDaemon.logout', () => {
      provider.logoutCli();
    }),
    vscode.commands.registerCommand('cockpitDaemon.setApiKey', () => {
      void provider.setApiKeyInteractive();
    }),
    vscode.commands.registerCommand('cockpitDaemon.clearApiKey', () => {
      void provider.clearApiKey();
    }),
    // The chat in the side bar (secondary side bar; the Activity Bar on VS Code older than 1.106).
    vscode.window.registerWebviewViewProvider(
      'cockpitDaemon.chat',
      { resolveWebviewView: (view) => provider.resolveChatView(view) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    // Hub na Activity Bar (WebviewView). Mesma bundle, modo 'hub'.
    vscode.window.registerWebviewViewProvider('cockpitDaemon.hub', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Restores the editor panel (and its width/position) when the window reloads.
    vscode.window.registerWebviewPanelSerializer('cockpitDaemon.cockpit.editor', {
      deserializeWebviewPanel: async (panel) => {
        provider.attachPanel(panel);
      },
    }),
    vscode.commands.registerCommand('cockpitDaemon.enableUsageTracking', () => {
      const r = enableUsageTracking(context.globalState);
      if (r === 'ok') {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Real usage tracking enabled. Run an interactive `claude` session once to populate it.'),
        );
      } else if (r === 'unsupported') {
        // Outside Windows the statusline wrapper doesn't apply — but real usage already
        // comes from the OAuth /usage API (primary, cross-platform source). Nothing to install.
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Real account usage already comes from the Claude API on this platform — nothing to install. (The statusline wrapper is a Windows-only extra source.)',
          ),
        );
      } else {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
        );
      }
      provider.refreshUsageNow();
    }),
    vscode.commands.registerCommand('cockpitDaemon.disableUsageTracking', () => {
      const r = disableUsageTracking(context.globalState);
      void vscode.window.showInformationMessage(
        r === 'ok'
          ? vscode.l10n.t('Real usage tracking disabled.')
          : vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
      );
      provider.refreshUsageNow();
    }),
    vscode.commands.registerCommand('cockpitDaemon.enableUtf8Fix', () => {
      const r = enableUtf8Fix();
      if (r === 'ok') {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Accent fix installed. New PowerShell tool calls will return UTF-8 output.'),
        );
      } else if (r === 'unsupported') {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Nothing to install: shells on this platform already output UTF-8.'),
        );
      } else {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
        );
      }
    }),
    vscode.commands.registerCommand('cockpitDaemon.disableUtf8Fix', () => {
      const r = disableUtf8Fix();
      void vscode.window.showInformationMessage(
        r === 'ok'
          ? vscode.l10n.t('Accent fix removed.')
          : vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
      );
    }),
    vscode.commands.registerCommand('cockpitDaemon.toggleLanguage', async () => {
      const cfg = vscode.workspace.getConfiguration('cockpitDaemon');
      const current = cfg.get<string>('language', 'auto');
      const next = current === 'pt-BR' ? 'en' : 'pt-BR';
      await cfg.update('language', next, vscode.ConfigurationTarget.Global);
      provider.pushLocale();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cockpitDaemon.language')) provider.pushLocale();
      // Switching engine changes which binary is spawned: the running process
      // has to go, or the next turn would still be answered by the old one.
      if (
        e.affectsConfiguration('cockpitDaemon.tootegaEnabled') ||
        e.affectsConfiguration('cockpitDaemon.engine') ||
        e.affectsConfiguration('cockpitDaemon.claudePath') ||
        e.affectsConfiguration('cockpitDaemon.tootegaPath') ||
        e.affectsConfiguration('cockpitDaemon.tootegaServer')
      ) {
        provider.applyEngineChange();
      }
      if (e.affectsConfiguration('cockpitDaemon.daemon') || e.affectsConfiguration('cockpitDaemon.engine')) void provider.reportDaemonStatus();
      if (e.affectsConfiguration('cockpitDaemon.internalModel')) provider.applyInternalModel();
      if (e.affectsConfiguration('cockpitDaemon.enableTodoTools')) provider.applyTodoToolsChange();
      if (e.affectsConfiguration('cockpitDaemon.debugLog')) {
        setDebugLogging(vscode.workspace.getConfiguration('cockpitDaemon').get<boolean>('debugLog', false));
      }
      // Model/effort/permission change: resets overrides + reflects them in the dropdowns.
      if (
        e.affectsConfiguration('cockpitDaemon.model') ||
        e.affectsConfiguration('cockpitDaemon.effort') ||
        e.affectsConfiguration('cockpitDaemon.permissionMode') ||
        e.affectsConfiguration('cockpitDaemon.allowAgents')
      ) {
        provider.applyDefaultsFromSettings();
      }
      // UI-only prefs: re-push the config without restarting the session.
      if (
        e.affectsConfiguration('cockpitDaemon.hideThinking') ||
        e.affectsConfiguration('cockpitDaemon.showBashDescription') ||
        e.affectsConfiguration('cockpitDaemon.expandToolCards') ||
        e.affectsConfiguration('cockpitDaemon.userName') ||
        e.affectsConfiguration('cockpitDaemon.verbosity')
      ) {
        provider.pushConfig();
      }
    }),
  );

  // URI handler: vscode://KODIKAS-NL.cockpit-claude-code-daemon/open
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path === '/open' || uri.path === '') {
          void vscode.commands.executeCommand('cockpitDaemon.open');
        }
      },
    }),
  );

  log('Cockpit for Claude Code activated.');
}

export function deactivate(): void {
  flushStats(); // writes each session's pending statistics before exiting
  log('Cockpit for Claude Code deactivated.');
}

/** Closes the Cockpit webview tabs (viewType cockpitDaemon.cockpit.editor) that VSCode
 *  tried to restore without state after a reload/restart. */
function closeStaleCockpitTabs(): void {
  try {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputWebview &&
          input.viewType.includes('cockpitDaemon.cockpit.editor')
        ) {
          void vscode.window.tabGroups.close(tab);
        }
      }
    }
  } catch (e) {
    log(`closeStaleCockpitTabs: ${String(e)}`);
  }
}

/**
 * Offers (only once) to enable real account usage via the statusline. Windows-only
 * for now. It doesn't insist: it writes a flag in globalState after the first offer.
 */
async function maybeOfferUsageTracking(
  context: vscode.ExtensionContext,
  provider: ChatViewProvider,
): Promise<void> {
  if (process.platform !== 'win32') return; // instalador Windows-only por ora
  if (isEnabled()) return; // already on
  if (context.globalState.get<boolean>('usageTrackingPrompted')) return;
  void context.globalState.update('usageTrackingPrompted', true);
  const enable = vscode.l10n.t('Enable');
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Show real account usage (5h / 7-day limits) in the Cockpit? This wraps your Claude Code statusline; you can undo it anytime.',
    ),
    enable,
  );
  if (pick !== enable) return;
  const r = enableUsageTracking(context.globalState);
  if (r === 'ok') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Real usage tracking enabled. Run an interactive `claude` session once to populate it.',
      ),
    );
  } else if (r !== 'unsupported') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.',
      ),
    );
  }
  provider.refreshUsageNow();
}

/**
 * Offers (only once) to install the PowerShell tool's UTF-8 hook. Windows-only:
 * that's where a console-less shell falls back to the OEMCP and corrupts accents in the output.
 */
async function maybeOfferUtf8Fix(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform !== 'win32') return;
  if (utf8FixEnabled()) return;
  if (context.globalState.get<boolean>('utf8FixPrompted')) return;
  void context.globalState.update('utf8FixPrompted', true);
  const install = vscode.l10n.t('Install');
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Fix garbled accents in PowerShell command output? Installs a small Claude Code hook that forces UTF-8; it never blocks a command and you can remove it anytime.',
    ),
    install,
  );
  if (pick !== install) return;
  const r = enableUtf8Fix();
  if (r === 'ok') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Accent fix installed. New PowerShell tool calls will return UTF-8 output.'),
    );
  } else if (r !== 'unsupported') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.',
      ),
    );
  }
}
