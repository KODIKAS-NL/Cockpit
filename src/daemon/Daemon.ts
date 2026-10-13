// cockpit-daemon: owns Claude CLI processes so they outlive the VS Code windows that use
// them. Windows (one connection per extension host) open, attach to and detach from
// sessions over a Unix socket; see shared/daemon.ts for the protocol.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DaemonSession, resumeIdOf, type PersistedSession, type SessionClient } from './DaemonSession';
import { normalizeCwd } from './paths';
import {
  DAEMON_PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
} from '../../shared/daemon';

export interface DaemonOptions {
  socketPath: string;
  /** Where sessions are remembered across daemon restarts. Undefined = not persisted. */
  stateFile?: string;
  /** Stop a CLI that is idle, unattended and has no prompt waiting for this long. 0 = never. */
  idleStopHours?: number;
  log?: (msg: string) => void;
}

interface Connection extends SessionClient {
  socket: net.Socket;
  sessions: Set<string>;
}

export class Daemon {
  private readonly opts: DaemonOptions;
  private readonly log: (msg: string) => void;
  private sessions = new Map<string, DaemonSession>();
  private server?: net.Server;
  private connections = new Set<Connection>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    this.load();
    await this.prepareSocket();
    fs.mkdirSync(path.dirname(this.opts.socketPath), { recursive: true, mode: 0o700 });
    const server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Owner-only from the first instant: the umask covers the window between bind and chmod.
      const prevMask = process.umask(0o177);
      server.listen(this.opts.socketPath, () => {
        process.umask(prevMask);
        server.off('error', reject);
        resolve();
      });
    });
    try {
      fs.chmodSync(this.opts.socketPath, 0o600);
    } catch {
      /* best effort; the umask already applied */
    }
    this.server = server;
    const hours = this.opts.idleStopHours ?? 0;
    if (hours > 0) {
      this.idleTimer = setInterval(() => this.stopIdle(hours * 3_600_000), 60_000);
      this.idleTimer.unref?.();
    }
    this.log(`listening on ${this.opts.socketPath} (${this.sessions.size} sessions known)`);
  }

  /** Ends every CLI and closes the socket. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.flushSave();
    for (const s of this.sessions.values()) s.stop();
    for (const c of this.connections) c.socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    try {
      fs.unlinkSync(this.opts.socketPath);
    } catch {
      /* already gone */
    }
    this.log('stopped');
  }

  /** A socket file left by a daemon that died is removed; a live daemon is an error. */
  private async prepareSocket(): Promise<void> {
    if (!fs.existsSync(this.opts.socketPath)) return;
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(this.opts.socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (alive) throw new Error(`another daemon is already listening on ${this.opts.socketPath}`);
    fs.unlinkSync(this.opts.socketPath);
  }

  // ---- connections ----

  private onConnection(socket: net.Socket): void {
    const conn: Connection = {
      id: randomUUID(),
      socket,
      sessions: new Set(),
      send: (msg: DaemonMessage) => {
        if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
      },
    };
    this.connections.add(conn);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          conn.send({ type: 'error', message: 'invalid JSON line' });
          continue;
        }
        try {
          this.onMessage(conn, msg);
        } catch (e) {
          const reqId = (msg as { reqId?: string }).reqId;
          conn.send({ type: 'error', reqId, message: e instanceof Error ? e.message : String(e) });
        }
      }
    });
    const drop = () => {
      if (!this.connections.delete(conn)) return;
      for (const id of conn.sessions) {
        const s = this.sessions.get(id);
        if (!s) continue;
        s.detach(conn.id);
        this.releaseIfUnused(s);
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private onMessage(conn: Connection, msg: ClientMessage): void {
    switch (msg.op) {
      case 'hello': {
        // The client's id prefixes its own control request ids, so answers route back to it.
        if (typeof msg.clientId === 'string' && msg.clientId && !msg.clientId.includes(':')) {
          conn.id = msg.clientId;
        }
        conn.send({ type: 'hello_ok', version: DAEMON_PROTOCOL_VERSION, pid: process.pid });
        return;
      }
      case 'list': {
        const key = msg.cwd ? normalizeCwd(msg.cwd) : undefined;
        const sessions = [...this.sessions.values()]
          .filter((s) => !key || s.cwdKey === key)
          .map((s) => s.info())
          .sort((a, b) => b.lastActivity - a.lastActivity);
        conn.send({ type: 'sessions', reqId: msg.reqId, sessions });
        return;
      }
      case 'open': {
        const session = this.findOrCreate(msg.cwd, msg.cliSessionId, msg.spawn);
        conn.sessions.add(session.id);
        const snapshot = session.attach(conn);
        conn.send({ type: 'snapshot', reqId: msg.reqId, snapshot });
        return;
      }
      case 'detach': {
        const s = this.sessions.get(msg.sessionId);
        conn.sessions.delete(msg.sessionId);
        if (s) {
          s.detach(conn.id);
          this.releaseIfUnused(s);
        }
        return;
      }
      case 'send':
        this.need(msg.sessionId).send(conn, msg.msg);
        return;
      case 'stop':
        this.need(msg.sessionId).stop();
        return;
      case 'forget': {
        const s = this.need(msg.sessionId);
        s.stop();
        this.sessions.delete(s.id);
        this.scheduleSave();
        return;
      }
      default:
        conn.send({ type: 'error', message: `unknown op ${(msg as { op?: string }).op}` });
    }
  }

  private need(id: string): DaemonSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }

  /**
   * The session of this CLI session id in this folder — or a new one. A session that is not
   * running takes the newest spawn spec (the window may have changed model or permission
   * mode since); a running one keeps what it was started with.
   */
  private findOrCreate(cwd: string, cliSessionId: string | undefined, spec: PersistedSession['spec']): DaemonSession {
    const cwdKey = normalizeCwd(cwd);
    const wanted = cliSessionId ?? resumeIdOf(spec.args);
    if (wanted) {
      for (const s of this.sessions.values()) {
        if (s.cwdKey !== cwdKey || s.cliSessionId !== wanted) continue;
        if (!s.isRunning()) {
          s.spec = spec;
          this.scheduleSave();
        }
        s.ensureRunning();
        return s;
      }
    }
    const now = Date.now();
    const session = this.makeSession({
      id: randomUUID(),
      cwd,
      cwdKey,
      spec,
      cliSessionId: wanted,
      createdAt: now,
      lastActivity: now,
    });
    this.sessions.set(session.id, session);
    session.ensureRunning();
    this.scheduleSave();
    return session;
  }

  /**
   * A session that never became a conversation (no message sent, so no CLI session id, and
   * nothing it could be found by again) is dropped once no window holds it. Windows start
   * one to load slash commands; without this each would leave a process behind.
   */
  private releaseIfUnused(s: DaemonSession): void {
    if (s.clientCount() > 0 || s.cliSessionId || s.isBusy()) return;
    s.stop();
    this.sessions.delete(s.id);
    this.scheduleSave();
  }

  private makeSession(data: PersistedSession): DaemonSession {
    return new DaemonSession(data, { log: this.log, changed: () => this.scheduleSave() });
  }

  private stopIdle(maxIdleMs: number): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.isRunning() || s.isBusy() || s.pendingCount() > 0 || s.clientCount() > 0) continue;
      if (now - s.lastActivity < maxIdleMs) continue;
      this.log(`[${s.id}] idle for ${Math.round((now - s.lastActivity) / 60_000)} min: stopping`);
      s.stop();
    }
  }

  // ---- persistence ----

  private load(): void {
    const file = this.opts.stateFile;
    if (!file || !fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions?: PersistedSession[] };
      for (const p of data.sessions ?? []) {
        if (p?.id && p.cwd && p.spec?.claudePath) this.sessions.set(p.id, this.makeSession(p));
      }
    } catch (e) {
      this.log(`state file unreadable, starting empty: ${String(e)}`);
    }
  }

  private scheduleSave(): void {
    if (!this.opts.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flushSave(), 500);
    this.saveTimer.unref?.();
  }

  private flushSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const file = this.opts.stateFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      const sessions = [...this.sessions.values()].map((s) => s.persisted());
      // The spec can carry the user's system prompt text: owner-only.
      fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      this.log(`could not save state: ${String(e)}`);
    }
  }
}
