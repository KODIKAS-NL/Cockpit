// Installing cockpit-daemon as a background service. macOS: a launchd user agent that starts
// at login and is restarted if it dies. Elsewhere: a detached process (until the next reboot).
// No VS Code imports; the commands that call this live in extension.ts.
import { spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { daemonHome } from './paths';

export const SERVICE_LABEL = 'local.cockpit.daemon';

export function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function daemonLogPath(): string {
  return path.join(daemonHome(), 'daemon.log');
}

/** Where the service runs the daemon from: a stable copy, not the versioned extension folder. */
export function installedScriptPath(): string {
  return path.join(daemonHome(), 'daemon.js');
}

export interface ShellEnv {
  node?: string;
  path?: string;
}

/**
 * `node` and PATH as the user's login shell sees them. launchd starts services with a
 * bare PATH, so without this neither `node` nor `claude` (often in ~/.local/bin or a
 * Homebrew prefix) would be found.
 */
export function loginShellEnv(): ShellEnv {
  const shell = process.env.SHELL || '/bin/zsh';
  const res = spawnSync(shell, ['-lc', 'command -v node; printf "%s" "$PATH"'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (res.status !== 0 || !res.stdout) return {};
  const lines = res.stdout.split('\n');
  const pathLine = lines.pop() ?? '';
  const node = lines.map((l) => l.trim()).find((l) => l.startsWith('/'));
  return { node, path: pathLine || undefined };
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function plistXml(opts: { node: string; script: string; args: string[]; pathEnv: string; log: string }): string {
  const programArgs = [opts.node, opts.script, ...opts.args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(opts.pathEnv)}</string>
    <!-- When the fallback runtime is the editor's Electron, make it behave as Node. -->
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.log)}</string>
</dict>
</plist>
`;
}

export interface InstallOptions {
  /** dist/daemon.js inside the extension. */
  bundledScript: string;
  /** Node to run it with when the login shell has none (e.g. VS Code server's own node). */
  fallbackNode: string;
  socketPath: string;
  idleStopHours: number;
}

export interface InstallResult {
  ok: boolean;
  message: string;
}

/** Copies the daemon to ~/.cockpit and (re)loads it as a launchd agent. macOS only. */
export function installLaunchAgent(opts: InstallOptions): InstallResult {
  if (process.platform !== 'darwin') return { ok: false, message: 'launchd is only available on macOS' };
  fs.mkdirSync(daemonHome(), { recursive: true, mode: 0o700 });
  const script = installedScriptPath();
  fs.copyFileSync(opts.bundledScript, script);

  const env = loginShellEnv();
  const node = env.node ?? opts.fallbackNode;
  const local = path.join(os.homedir(), '.local', 'bin');
  const basePath = env.path ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const pathEnv = basePath.split(':').includes(local) ? basePath : `${local}:${basePath}`;
  const args = ['--socket', opts.socketPath];
  if (opts.idleStopHours > 0) args.push('--idle-stop-hours', String(opts.idleStopHours));

  const plist = plistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, plistXml({ node, script, args, pathEnv, log: daemonLogPath() }), 'utf8');

  const domain = `gui/${process.getuid?.() ?? ''}`;
  // Unload the previous version first (fails harmlessly when it isn't loaded).
  spawnSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { encoding: 'utf8' });
  const res = spawnSync('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  if (res.status !== 0) {
    return { ok: false, message: (res.stderr || res.stdout || `launchctl exited ${res.status}`).trim() };
  }
  return { ok: true, message: `cockpit-daemon installed (${node} ${script})` };
}

/** Restarts the launchd agent (macOS), killing every CLI it runs. */
export function restartLaunchAgent(): InstallResult {
  if (process.platform !== 'darwin') return { ok: false, message: 'launchd is only available on macOS' };
  const res = spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return { ok: false, message: (res.stderr || res.stdout || `exit ${res.status}`).trim() };
  return { ok: true, message: 'cockpit-daemon restarted' };
}

/**
 * Stops the daemon. With the launchd agent it is unloaded (it starts again at the next login);
 * a daemon without one (started by hand or by the menu bar app) gets a SIGTERM, which stops
 * every CLI it runs. The menu bar app starts it again by itself: quit the app to keep it off.
 */
export async function stopDaemon(socketPath: string): Promise<InstallResult> {
  if (launchAgentInstalled()) {
    const res = spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${SERVICE_LABEL}`], {
      encoding: 'utf8',
    });
    const out = (res.stderr || res.stdout || '').trim();
    // Not loaded (already stopped) is not a failure; launchctl words it differently by version.
    const notLoaded = /could not find service|no such process|not found/i.test(out);
    if (res.status !== 0 && !notLoaded) {
      return { ok: false, message: out || `launchctl exited ${res.status}` };
    }
    return { ok: true, message: 'cockpit-daemon stopped (it starts again at the next login)' };
  }
  const pid = await probeDaemon(socketPath);
  if (pid === undefined) return { ok: true, message: 'cockpit-daemon was not running' };
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { ok: false, message: String(e) };
  }
  return { ok: true, message: `cockpit-daemon (pid ${pid}) stopped` };
}

/**
 * Stops the daemon and removes what the install put on the machine: the launchd agent and
 * ~/.cockpit (the daemon copy, socket, log and its list of sessions). The conversations
 * themselves are the CLI's transcripts and stay.
 */
export async function uninstallDaemon(socketPath: string): Promise<InstallResult> {
  const stopped = await stopDaemon(socketPath);
  if (!stopped.ok) return stopped;
  try {
    fs.rmSync(plistPath(), { force: true });
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(daemonHome(), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, message: String(e) };
  }
  return { ok: true, message: 'cockpit-daemon uninstalled' };
}

export function launchAgentInstalled(): boolean {
  return process.platform === 'darwin' && fs.existsSync(plistPath());
}

/**
 * The pid of the daemon listening on `socketPath`, or undefined when none answers. Used to
 * avoid installing a second daemon next to one that already runs (e.g. the Cockpit Daemon
 * menu bar app).
 */
export function probeDaemon(socketPath: string, timeoutMs = 1500): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(undefined);
      return;
    }
    const socket = net.connect(socketPath);
    let buf = '';
    const done = (pid: number | undefined) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(pid);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(JSON.stringify({ op: 'hello', clientId: 'probe', version: 1 }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        done(msg?.type === 'hello_ok' && typeof msg.pid === 'number' ? msg.pid : undefined);
      } catch {
        done(undefined);
      }
    });
    socket.once('error', () => done(undefined));
  });
}

/**
 * Starts the daemon as a detached process that outlives this window (not a reboot).
 * `node` may be the editor's own runtime: ELECTRON_RUN_AS_NODE makes Electron act as Node.
 */
export function startDetached(opts: { node: string; script: string; socketPath: string; idleStopHours: number }): void {
  fs.mkdirSync(daemonHome(), { recursive: true, mode: 0o700 });
  const out = fs.openSync(daemonLogPath(), 'a');
  const args = [opts.script, '--socket', opts.socketPath];
  if (opts.idleStopHours > 0) args.push('--idle-stop-hours', String(opts.idleStopHours));
  const child = spawn(opts.node, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
}
