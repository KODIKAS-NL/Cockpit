// The commands every editor offers (daemon install, usage tracking, language...). The adapters map
// their command ids to these methods and wire `onSettingsChanged` to their settings events.
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { CockpitCore } from './CockpitCore';
import type { EditorHost, KeyValueStore } from './host';
import { settings, t } from './services';
import { log, setDebugLogging } from '../util/logger';
import { enableUsageTracking, disableUsageTracking, isEnabled } from '../cli/StatuslineInstaller';
import { enableUtf8Fix, disableUtf8Fix, isEnabled as utf8FixEnabled } from '../cli/Utf8HookInstaller';
import {
  daemonLogPath,
  installLaunchAgent,
  launchAgentInstalled,
  probeDaemon,
  restartLaunchAgent,
  startDetached,
  stopDaemon,
  uninstallDaemon,
} from '../daemon/service';

const EDIT_SETTINGS = 'Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.';

export class HostCommands {
  constructor(
    private readonly host: EditorHost,
    private readonly core: CockpitCore,
    private readonly store: KeyValueStore,
    /** Folder that holds `dist/daemon.js`. */
    private readonly extensionPath: string,
    /** The node that runs the daemon when no launchd agent does. */
    private readonly nodePath: string = process.execPath,
  ) {}

  // ---- Daemon ----

  async installDaemon(): Promise<void> {
    const bundledScript = path.join(this.extensionPath, 'dist', 'daemon.js');
    const idleStopHours = settings().get<number>('daemon.idleStopHours', 0) ?? 0;
    const socketPath = this.core.daemonSocketPath();
    if (!fs.existsSync(bundledScript)) {
      void this.host.notify('error', t('dist/daemon.js is missing from this build.'));
      return;
    }
    // A daemon that runs without our launchd agent (the Cockpit Daemon menu bar app, or one
    // started by hand) already does the job: installing a second one would fight it for the
    // socket. Nothing to install.
    const runningPid = await probeDaemon(socketPath);
    if (runningPid && !launchAgentInstalled()) {
      void this.host.notify(
        'info',
        t(
          'cockpit-daemon is already running (pid {0}), for example from the Cockpit Daemon app. Nothing was installed.',
          String(runningPid),
        ),
      );
      return;
    }
    if (process.platform === 'darwin') {
      const r = installLaunchAgent({ bundledScript, fallbackNode: this.nodePath, socketPath, idleStopHours });
      log(`[daemon] install: ${r.message}`);
      if (!r.ok) {
        void this.host.notify('error', t('Could not install cockpit-daemon: {0}', r.message));
        return;
      }
    } else {
      // No launchd: a detached process that survives this window (not a reboot).
      startDetached({ node: this.nodePath, script: bundledScript, socketPath, idleStopHours });
    }
    void this.host.notify('info', t('cockpit-daemon is running. Claude keeps running when this window closes.'));
  }

  restartDaemon(): void {
    if (!launchAgentInstalled()) {
      void this.host.notify('warning', t('cockpit-daemon is not installed as a service. Run "Install daemon" first.'));
      return;
    }
    const r = restartLaunchAgent();
    if (r.ok) {
      void this.host.notify('info', t('cockpit-daemon restarted. Running turns were stopped; conversations resume on the next message.'));
    } else {
      void this.host.notify('error', t('Could not restart cockpit-daemon: {0}', r.message));
    }
  }

  async stopDaemon(): Promise<void> {
    const r = await stopDaemon(this.core.daemonSocketPath());
    log(`[daemon] stop: ${r.message}`);
    if (!r.ok) {
      void this.host.notify('error', t('Could not stop cockpit-daemon: {0}', r.message));
      return;
    }
    void this.host.notify(
      'info',
      t('cockpit-daemon stopped. Running turns ended; conversations resume on the next message once it runs again.'),
    );
  }

  async uninstallDaemon(): Promise<void> {
    const ok = await this.host.confirm(
      t('Uninstall cockpit-daemon?'),
      t(
        'It stops the daemon and the Claude processes it runs, removes the launchd agent and deletes ~/.cockpit (including its list of sessions). Claude cannot run in Cockpit until the daemon is installed again. Your conversations stay on disk.',
      ),
      t('Uninstall'),
    );
    if (!ok) return;
    const r = await uninstallDaemon(this.core.daemonSocketPath());
    log(`[daemon] uninstall: ${r.message}`);
    if (!r.ok) {
      void this.host.notify('error', t('Could not uninstall cockpit-daemon: {0}', r.message));
      return;
    }
    void this.host.notify('info', t('cockpit-daemon uninstalled. Claude cannot run until it is installed again.'));
  }

  async showDaemonLog(): Promise<void> {
    const file = daemonLogPath();
    if (!fs.existsSync(file)) {
      void this.host.notify('info', t('No daemon log yet ({0}).', file));
      return;
    }
    await this.host.openFile(file, { preview: true });
  }

  stopSession(): void {
    if (!this.core.stopActiveDaemonSession()) {
      void this.host.notify('info', t('The active tab is not running in cockpit-daemon.'));
      return;
    }
    this.host.statusMessage(t('Session stopped in cockpit-daemon.'), 3000);
  }

  // ---- Conversation ----

  newSession(): void {
    this.core.newSession();
    this.host.statusMessage(t('Started a new session.'), 3000);
  }

  interrupt(): void {
    this.core.interrupt();
    this.host.statusMessage(t('Agent interrupted.'), 3000);
  }

  // ---- Claude Code settings helpers ----

  enableUsageTracking(): void {
    const r = enableUsageTracking(this.store);
    if (r === 'ok') {
      void this.host.notify('info', t('Real usage tracking enabled. Run an interactive `claude` session once to populate it.'));
    } else if (r === 'unsupported') {
      // Outside Windows the statusline wrapper doesn't apply — but real usage already
      // comes from the OAuth /usage API (primary, cross-platform source). Nothing to install.
      void this.host.notify(
        'info',
        t(
          'Real account usage already comes from the Claude API on this platform — nothing to install. (The statusline wrapper is a Windows-only extra source.)',
        ),
      );
    } else {
      void this.host.notify('warning', t(EDIT_SETTINGS));
    }
    this.core.refreshUsageNow();
  }

  disableUsageTracking(): void {
    const r = disableUsageTracking(this.store);
    void this.host.notify('info', r === 'ok' ? t('Real usage tracking disabled.') : t(EDIT_SETTINGS));
    this.core.refreshUsageNow();
  }

  enableUtf8Fix(): void {
    const r = enableUtf8Fix();
    if (r === 'ok') {
      void this.host.notify('info', t('Accent fix installed. New PowerShell tool calls will return UTF-8 output.'));
    } else if (r === 'unsupported') {
      void this.host.notify('info', t('Nothing to install: shells on this platform already output UTF-8.'));
    } else {
      void this.host.notify('warning', t(EDIT_SETTINGS));
    }
  }

  disableUtf8Fix(): void {
    const r = disableUtf8Fix();
    void this.host.notify('info', r === 'ok' ? t('Accent fix removed.') : t(EDIT_SETTINGS));
  }

  async toggleLanguage(): Promise<void> {
    const current = settings().get<string>('language', 'auto');
    await settings().update('language', current === 'pt-BR' ? 'en' : 'pt-BR', 'global');
    this.core.pushLocale();
  }

  /** Offers (only once) to enable real account usage via the statusline (Windows-only for now). */
  async offerUsageTracking(): Promise<void> {
    if (process.platform !== 'win32') return;
    if (isEnabled()) return;
    if (this.store.get<boolean>('usageTrackingPrompted')) return;
    void this.store.update('usageTrackingPrompted', true);
    const enable = t('Enable');
    const pick = await this.host.notify(
      'info',
      t('Show real account usage (5h / 7-day limits) in the Cockpit? This wraps your Claude Code statusline; you can undo it anytime.'),
      enable,
    );
    if (pick !== enable) return;
    this.enableUsageTracking();
  }

  /** Offers (only once) the PowerShell tool's UTF-8 hook: a console-less shell corrupts accents. */
  async offerUtf8Fix(): Promise<void> {
    if (process.platform !== 'win32') return;
    if (utf8FixEnabled()) return;
    if (this.store.get<boolean>('utf8FixPrompted')) return;
    void this.store.update('utf8FixPrompted', true);
    const install = t('Install');
    const pick = await this.host.notify(
      'info',
      t(
        'Fix garbled accents in PowerShell command output? Installs a small Claude Code hook that forces UTF-8; it never blocks a command and you can remove it anytime.',
      ),
      install,
    );
    if (pick !== install) return;
    this.enableUtf8Fix();
  }

  // ---- Settings changes ----

  /**
   * A setting changed. `affects(section)` says whether that `cockpitDaemon.<section>` (or a key
   * below it) changed; the adapter answers from its own settings event.
   */
  onSettingsChanged(affects: (section: string) => boolean): void {
    const any = (...keys: string[]): boolean => keys.some((k) => affects(k));
    if (affects('language')) this.core.pushLocale();
    // Switching engine changes which binary is spawned: the running process
    // has to go, or the next turn would still be answered by the old one.
    if (any('tootegaEnabled', 'engine', 'claudePath', 'tootegaPath', 'tootegaServer')) this.core.applyEngineChange();
    if (any('daemon', 'engine')) void this.core.reportDaemonStatus();
    if (affects('internalModel')) this.core.applyInternalModel();
    if (affects('enableTodoTools')) this.core.applyTodoToolsChange();
    if (affects('debugLog')) setDebugLogging(settings().get<boolean>('debugLog', false));
    // Model/effort/permission change: resets overrides + reflects them in the dropdowns.
    if (any('model', 'effort', 'permissionMode', 'allowAgents')) this.core.applyDefaultsFromSettings();
    // UI-only prefs: re-push the config without restarting the session.
    if (
      any('hideThinking', 'showBashDescription', 'expandToolCards', 'scrollOnSend', 'spellCheck', 'voiceCorrect', 'userName', 'verbosity')
    ) {
      this.core.pushConfig();
    }
  }
}
