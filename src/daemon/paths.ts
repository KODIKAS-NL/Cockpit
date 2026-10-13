// Locations and path normalization shared by cockpit-daemon and its client.
// No VS Code imports: the daemon runs as a plain Node process.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** ~/.cockpit: the daemon's socket, state and log live here. */
export function daemonHome(): string {
  return path.join(os.homedir(), '.cockpit');
}

export function defaultSocketPath(): string {
  return path.join(daemonHome(), 'daemon.sock');
}

/** Expands a leading `~` (settings are written by hand). */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The key two windows must agree on to share a session: the real path of the folder,
 * without a trailing separator. A symlink, `..` or a trailing slash must not hide a
 * session; a different folder (even a parent or a child) must not show it.
 */
export function normalizeCwd(cwd: string): string {
  let p = path.resolve(expandHome(cwd));
  try {
    p = fs.realpathSync.native(p);
  } catch {
    /* folder gone: keep the resolved path, it still matches what was stored */
  }
  if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) p = p.slice(0, -1);
  return p;
}
