// cockpit-sidecar: runs the editor-neutral core for an IDE plugin (Rider). The plugin starts this
// with Node, talks to it over stdio (RpcPeer) and shows `url` in a browser view.
//   node sidecar.js --extension-path <dir holding dist/, l10n/, media/, package.json>
import * as path from 'node:path';
import { RpcPeer } from './rpc';
import { RpcHost, RpcSecrets } from './RpcHost';
import { FileSettings, FileStore, manifestDefaults } from './state';
import { SidecarCore } from './SidecarCore';
import { WebServer } from './WebServer';
import { runCommand } from './commands';
import { HostCommands } from '../core/HostCommands';
import { bundleLocalizer } from '../core/BundleLocalizer';
import { setLocalizer, setSettings } from '../core/services';
import { setDebugLogging, setLogSink, log } from '../util/logger';
import { daemonHome } from '../daemon/paths';

interface InitParams {
  workspaceRoot?: string;
  /** The IDE's UI language, e.g. `en` or `pt-BR`. */
  language: string;
  /** The IDE UI runs on this machine (false when the UI is a remote client). */
  localUi?: boolean;
  /** CSS mapping the IDE colours to `--vscode-*` variables. */
  theme?: string;
  /** Overrides ~/.cockpit (tests). */
  stateDir?: string;
}

export function start(argv: string[], input = process.stdin, output = process.stdout): RpcPeer {
  const i = argv.indexOf('--extension-path');
  const extensionPath = path.resolve(i >= 0 ? argv[i + 1] : path.join(__dirname, '..'));
  // stdout is the RPC channel: logs go to stderr, where the plugin picks them up.
  setLogSink((line) => process.stderr.write(line + '\n'));
  const rpc = new RpcPeer(input, output);

  rpc.on('init', async (p: InitParams) => {
    let language = p.language || 'en';
    let theme = p.theme ?? '';
    const stateDir = p.stateDir ?? daemonHome();
    const settings = new FileSettings(path.join(stateDir, 'jetbrains-settings.json'), manifestDefaults(extensionPath));
    setSettings(settings);
    setLocalizer(bundleLocalizer(path.join(extensionPath, 'l10n'), () => language));
    setDebugLogging(settings.get<boolean>('debugLog', false));

    const host = new RpcHost(rpc);
    host.root = p.workspaceRoot;
    host.localUi = p.localUi ?? true;
    host.settingsFile = () => settings.file;

    const store = new FileStore(path.join(stateDir, 'jetbrains-state.json'));
    const core = new SidecarCore(host, extensionPath, store, new RpcSecrets(rpc));
    core.bind(rpc);
    const commands = new HostCommands(host, core, store, extensionPath);
    host.installDaemonHandler = () => void commands.installDaemon();

    const web = new WebServer({
      extensionPath,
      surfaces: core.webSurfaces,
      onMessage: (m, from) => core.receive(m, from),
      theme: () => theme,
    });
    const port = await web.listen();

    rpc.on('command', (c: { id: string }) => ({ ok: runCommand(c.id, core, commands) }));
    rpc.on('theme', (t: { css: string }) => {
      theme = t.css;
      web.pushTheme();
    });
    rpc.on('language', (l: { language: string }) => {
      language = l.language;
      core.pushLocale();
    });
    rpc.on('sidebarVisible', (v: { visible: boolean }) => {
      core.sidebarShown = v.visible;
    });
    rpc.on('workspaceRoot', (w: { path?: string }) => {
      host.root = w.path;
    });
    // The settings file was edited by hand.
    rpc.on('settingsFileChanged', () => {
      const changed = settings.reload();
      commands.onSettingsChanged((section) => changed.some((k) => k === section || k.startsWith(section + '.')));
    });
    rpc.on('shutdown', () => {
      core.dispose();
      web.close();
      setTimeout(() => process.exit(0), 50);
    });

    void core.migrateApiKeyFromSettings();
    void core.migrateQuietPromptDefault();
    log(`sidecar ready on 127.0.0.1:${port}`);
    return { port, token: web.token };
  });

  return rpc;
}

if (require.main === module) start(process.argv.slice(2));
