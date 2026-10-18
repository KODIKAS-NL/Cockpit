// Live-session registry the CLI keeps in ~/.claude/sessions/<pid>.json — one file per running
// process, written at startup and removed on exit. Measured on CLI 2.1.224; it is the same
// registry that backs `ListAgents` and cross-session messaging.
//
// We read it to know which conversations a live CLI process has open (see `liveSessions`).
//
// Version-tolerant, like the stream parser: unknown fields are ignored, a malformed or
// half-written file is skipped, and a missing directory just means "nothing is running".
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DIR = path.join(os.homedir(), '.claude', 'sessions');

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  kind?: string; // interactive | ... (not pinned: the CLI may add kinds)
  entrypoint?: string;
  name?: string;
  version?: string;
  status?: string; // busy | idle (not pinned)
}

/** Every session the CLI currently reports as running. Never throws. */
export async function liveSessions(): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(DIR);
  } catch {
    return []; // no registry yet: nothing is running
  }
  const out: LiveSession[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(DIR, n), 'utf8');
      const o = JSON.parse(raw) as Partial<LiveSession>;
      if (typeof o?.sessionId !== 'string' || typeof o?.pid !== 'number') continue;
      out.push(o as LiveSession);
    } catch {
      continue; // being written, or not ours to understand
    }
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, but not ours to signal
  }
}

/** The registry, read synchronously (a small folder). Never throws. */
export function liveSessionsSync(): LiveSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(DIR);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')) as Partial<LiveSession>;
      if (typeof o?.sessionId === 'string' && typeof o?.pid === 'number') out.push(o as LiveSession);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * A live CLI process that has `sessionId` open and is not one the daemon started (those have
 * the `sdk-cli` entrypoint, and the daemon keeps one per conversation itself). Two processes on
 * one conversation write the same transcript and neither sees the other's turns, so the window
 * does not start a second one without being told. Stale files (the process is gone) are ignored.
 */
export function foreignLive(
  all: LiveSession[],
  sessionId: string,
  alive: (pid: number) => boolean = pidAlive,
): LiveSession | undefined {
  return all.find((s) => s.sessionId === sessionId && s.entrypoint !== 'sdk-cli' && alive(s.pid));
}
