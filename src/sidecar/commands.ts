// Maps the plugin's action ids (the same `cockpitDaemon.*` ids as the VS Code manifest) to the core.
import type { CockpitCore } from '../core/CockpitCore';
import type { HostCommands } from '../core/HostCommands';

export function runCommand(id: string, core: CockpitCore, commands: HostCommands): boolean {
  const table: Record<string, () => unknown> = {
    'cockpitDaemon.open': () => core.openPreferred(),
    'cockpitDaemon.openInSidebar': () => core.moveToSidebar(),
    'cockpitDaemon.openInEditor': () => core.openInEditor(),
    'cockpitDaemon.scratchpad': () => core.openScratchpad(),
    'cockpitDaemon.newSession': () => commands.newSession(),
    'cockpitDaemon.interrupt': () => commands.interrupt(),
    'cockpitDaemon.openSessions': () => core.openSessions(),
    'cockpitDaemon.focusPrompt': () => core.focusWaitingPrompt(),
    'cockpitDaemon.reopenClosed': () => core.reopenClosed(),
    'cockpitDaemon.login': () => core.loginCli(),
    'cockpitDaemon.logout': () => core.logoutCli(),
    'cockpitDaemon.setApiKey': () => core.setApiKeyInteractive(),
    'cockpitDaemon.clearApiKey': () => core.clearApiKey(),
    'cockpitDaemon.daemon.install': () => commands.installDaemon(),
    'cockpitDaemon.daemon.restart': () => commands.restartDaemon(),
    'cockpitDaemon.daemon.stop': () => commands.stopDaemon(),
    'cockpitDaemon.daemon.uninstall': () => commands.uninstallDaemon(),
    'cockpitDaemon.daemon.showLog': () => commands.showDaemonLog(),
    'cockpitDaemon.daemon.stopSession': () => commands.stopSession(),
    'cockpitDaemon.enableUsageTracking': () => commands.enableUsageTracking(),
    'cockpitDaemon.disableUsageTracking': () => commands.disableUsageTracking(),
    'cockpitDaemon.toggleLanguage': () => commands.toggleLanguage(),
  };
  const run = table[id];
  if (!run) return false;
  void Promise.resolve(run()).catch(() => undefined);
  return true;
}
