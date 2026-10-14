// The extension host's connection to cockpit-daemon. One per window, shared by all its tabs.
// No VS Code imports, so it can be unit-tested against a real daemon.
import * as fs from 'node:fs';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  DAEMON_PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
  type DaemonSessionInfo,
  type SessionSnapshot,
  type SpawnSpec,
} from '../../shared/daemon';

/** Daemon messages for one session, plus `disconnected` when the socket drops. */
export type SessionMessage = DaemonMessage | { type: 'disconnected' };
export type SessionHandler = (msg: SessionMessage) => void;

const REQUEST_TIMEOUT_MS = 15_000;

export class DaemonClient {
  /** Prefix of this window's own control request ids (`<clientId>:…`). Never contains ':'. */
  readonly clientId = `w${randomBytes(6).toString('hex')}`;
  private socket?: net.Socket;
  private connecting?: Promise<void>;
  private outbox: string[] = [];
  private seq = 0;
  private requests = new Map<
    string,
    { resolve: (m: DaemonMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; onSnapshot?: SessionHandler }
  >();
  private handlers = new Map<string, SessionHandler>();

  constructor(
    readonly socketPath: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** A socket file exists (it may still belong to a daemon that died). */
  socketExists(): boolean {
    return fs.existsSync(this.socketPath);
  }

  async list(cwd?: string): Promise<DaemonSessionInfo[]> {
    const m = await this.request({ op: 'list', reqId: this.nextId('l'), cwd });
    return m.type === 'sessions' ? m.sessions : [];
  }

  /**
   * Attaches to (or starts) the session for this folder and CLI session id. `handler` gets
   * the snapshot first and then every message for the session, with nothing lost in between:
   * it is registered in the same tick the snapshot is read.
   */
  async open(cwd: string, cliSessionId: string | undefined, spawn: SpawnSpec, handler: SessionHandler): Promise<SessionSnapshot> {
    const m = await this.request({ op: 'open', reqId: this.nextId('o'), cwd, cliSessionId, spawn }, handler);
    if (m.type !== 'snapshot') throw new Error('unexpected reply to open');
    return m.snapshot;
  }

  send(sessionId: string, msg: Record<string, unknown>): void {
    this.post({ op: 'send', sessionId, msg });
  }

  stop(sessionId: string): void {
    this.post({ op: 'stop', sessionId });
  }

  forget(sessionId: string): void {
    this.post({ op: 'forget', sessionId });
  }

  /** Forgets a session and resolves once its process has exited (the CLI writes on its way out). */
  async forgetAndWait(sessionId: string): Promise<void> {
    await this.request({ op: 'forget', sessionId, reqId: this.nextId('f') });
  }

  /** Stops receiving a session's messages; the session keeps running in the daemon. */
  detach(sessionId: string): void {
    this.handlers.delete(sessionId);
    if (this.socket && !this.socket.destroyed) this.post({ op: 'detach', sessionId });
  }

  unsubscribe(sessionId: string, handler: SessionHandler): void {
    if (this.handlers.get(sessionId) === handler) this.handlers.delete(sessionId);
  }

  dispose(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  // ---- transport ----

  private nextId(kind: string): string {
    return `${kind}${++this.seq}`;
  }

  private request(msg: ClientMessage & { reqId: string }, onSnapshot?: SessionHandler): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(msg.reqId);
        reject(new Error(`cockpit-daemon did not answer (${msg.op})`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.requests.set(msg.reqId, { resolve, reject, timer, onSnapshot });
      this.post(msg);
    });
  }

  private post(msg: ClientMessage): void {
    this.outbox.push(JSON.stringify(msg) + '\n');
    void this.ensureConnected().then(
      () => this.flush(),
      (e: Error) => this.failAll(e),
    );
  }

  private flush(): void {
    const s = this.socket;
    if (!s || s.destroyed) return;
    const lines = this.outbox;
    this.outbox = [];
    for (const l of lines) s.write(l);
  }

  private ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      let buf = '';
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        // hello first: it sets the id the daemon routes our own answers by.
        socket.write(JSON.stringify({ op: 'hello', clientId: this.clientId, version: DAEMON_PROTOCOL_VERSION }) + '\n');
        this.socket = socket;
        this.connecting = undefined;
        this.log(`[daemon] connected to ${this.socketPath}`);
        resolve();
      });
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            this.dispatch(JSON.parse(line) as DaemonMessage);
          } catch (e) {
            this.log(`[daemon] bad message: ${String(e)}`);
          }
        }
      });
      socket.on('error', (e) => {
        if (this.connecting) {
          this.connecting = undefined;
          reject(new Error(`cockpit-daemon is not reachable at ${this.socketPath} (${e.message})`));
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.log('[daemon] connection closed');
        this.failAll(new Error('cockpit-daemon connection closed'));
        // Every attached session must re-open (re-attach) on its next use.
        const handlers = [...this.handlers.values()];
        this.handlers.clear();
        for (const h of handlers) h({ type: 'disconnected' });
      });
    });
    return this.connecting;
  }

  private failAll(e: Error): void {
    this.outbox = [];
    const pending = [...this.requests.values()];
    this.requests.clear();
    for (const r of pending) {
      clearTimeout(r.timer);
      r.reject(e);
    }
  }

  private dispatch(m: DaemonMessage): void {
    const reqId = (m as { reqId?: string }).reqId;
    if (reqId && this.requests.has(reqId)) {
      const r = this.requests.get(reqId)!;
      this.requests.delete(reqId);
      clearTimeout(r.timer);
      if (m.type === 'error') {
        r.reject(new Error(m.message));
        return;
      }
      if (m.type === 'snapshot' && r.onSnapshot) {
        // Registered before anything else on this socket is read: no event can slip
        // between the snapshot and the live stream.
        this.handlers.set(m.snapshot.session.id, r.onSnapshot);
        r.onSnapshot(m);
      }
      r.resolve(m);
      return;
    }
    if (m.type === 'error') {
      this.log(`[daemon] error: ${m.message}`);
      if (!m.sessionId) return;
    }
    const sessionId = (m as { sessionId?: string }).sessionId;
    if (sessionId) this.handlers.get(sessionId)?.(m);
  }
}
