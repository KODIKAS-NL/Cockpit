// Extension entry point.
import * as vscode from 'vscode';
import { ChatViewProvider } from './vscode/ChatViewProvider';
import { HostCommands } from './core/HostCommands';
import { VsCodeHost } from './vscode/VsCodeHost';
import { flushStats } from './stats/StatsStore';
import { log, setDebugLogging } from './util/logger';
import { registerVsCodeServices } from './vscode/VsCodeServices';

export function activate(context: vscode.ExtensionContext): void {
  registerVsCodeServices();
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
  const commands = new HostCommands(new VsCodeHost(), provider, context.globalState, context.extensionPath);

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
  void commands.offerUsageTracking();
  // Offer (once) the hook that fixes the accents of the PowerShell tool on
  // Windows — see Utf8HookInstaller for the why.
  void commands.offerUtf8Fix();

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
    vscode.commands.registerCommand('cockpitDaemon.daemon.install', () => commands.installDaemon()),
    vscode.commands.registerCommand('cockpitDaemon.daemon.restart', () => commands.restartDaemon()),
    vscode.commands.registerCommand('cockpitDaemon.daemon.stop', () => commands.stopDaemon()),
    vscode.commands.registerCommand('cockpitDaemon.daemon.uninstall', () => commands.uninstallDaemon()),
    vscode.commands.registerCommand('cockpitDaemon.daemon.showLog', () => commands.showDaemonLog()),
    vscode.commands.registerCommand('cockpitDaemon.daemon.stopSession', () => commands.stopSession()),
    vscode.commands.registerCommand('cockpitDaemon.newSession', () => commands.newSession()),
    vscode.commands.registerCommand('cockpitDaemon.interrupt', () => commands.interrupt()),
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
    vscode.commands.registerCommand('cockpitDaemon.enableUsageTracking', () => commands.enableUsageTracking()),
    vscode.commands.registerCommand('cockpitDaemon.disableUsageTracking', () => commands.disableUsageTracking()),
    vscode.commands.registerCommand('cockpitDaemon.enableUtf8Fix', () => commands.enableUtf8Fix()),
    vscode.commands.registerCommand('cockpitDaemon.disableUtf8Fix', () => commands.disableUtf8Fix()),
    vscode.commands.registerCommand('cockpitDaemon.toggleLanguage', () => commands.toggleLanguage()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) =>
      commands.onSettingsChanged((section) => e.affectsConfiguration(`cockpitDaemon.${section}`)),
    ),
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
