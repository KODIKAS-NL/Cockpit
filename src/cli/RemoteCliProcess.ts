// A CLI process that lives in cockpit-daemon instead of in this extension host, so it keeps
// running when the window closes or the laptop sleeps, and other windows can attach to it.
//
// Same surface as CliProcessManager (see CliProcess), plus events the Session uses to stay in
// step with other windows:
//  - 'snapshot' (SessionSnapshot): attached; catch up on the message being written and the
//    prompts still waiting. Always the first thing after start().
//  - 'settled' (requestId): another window answered this prompt.
//  - 'remoteUser' (message, uuid?): another window sent this prompt.
import { EventEmitter } from 'node:events';
import type { CliProcess } from './CliProcess';
import { buildClaudeArgs, engineEnvOverrides, type CliOptions } from './CliProcessManager';
import type { DaemonClient, SessionMessage } from '../daemon/DaemonClient';
import { FILE_ARG_PREFIX, type SpawnSpec } from '../../shared/daemon';

export class RemoteCliProcess extends EventEmitter implements CliProcess {
  readonly persistent = true;
  private sessionId?: string;
  private opening?: Promise<void>;
  private attached = false;
  private running = false;
  private closed = false;
  private queue: Record<string, unknown>[] = [];
  private reqSeq = 0;
  private pendingControl = new Map<string, (payload: unknown) => void>();
  private readonly handler = (m: SessionMessage) => this.onDaemon(m);

  constructor(
    private readonly opts: CliOptions,
    private readonly client: DaemonClient,
  ) {
    super();
  }

  /** The daemon's id for the session, once attached. */
  get daemonSessionId(): string | undefined {
    return this.sessionId;
  }

  start(): void {
    if (this.attached || this.opening || this.closed) return;
    this.opening = this.open().finally(() => {
      this.opening = undefined;
    });
  }

  isRunning(): boolean {
    return this.attached && this.running;
  }

  setResumeId(id: string): void {
    if (id) this.opts.resumeSessionId = id;
  }

  sendUserMessage(text: string, images?: { mediaType: string; data: string }[], uuid?: string): void {
    const content: unknown[] = [];
    if (text) content.push({ type: 'text', text });
    for (const img of images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });
    this.write({ type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content } });
  }

  sendControlResponse(requestId: string, response: Record<string, unknown>): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  requestControl(subtype: string, timeoutMs = 5000): Promise<unknown> {
    // Prefixed with the window's id: the daemon sends the answer back to this window only.
    const id = `${this.client.clientId}:${subtype}_${++this.reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(id);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.pendingControl.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      this.write({ type: 'control_request', request_id: id, request: { subtype } });
    });
  }

  interrupt(): void {
    if (!this.attached) return;
    this.write({
      type: 'control_request',
      request_id: `${this.client.clientId}:interrupt_${++this.reqSeq}`,
      request: { subtype: 'interrupt' },
    });
  }

  /** Ends the process in the daemon (model/permission change, explicit stop). */
  stop(): void {
    if (this.sessionId) {
      this.client.stop(this.sessionId);
      // This instance is done either way (a later start makes a new one, which re-attaches).
      this.client.detach(this.sessionId);
    }
    this.close();
  }

  /** Leaves the process running in the daemon; this window just stops following it. */
  detach(): void {
    if (this.sessionId) this.client.detach(this.sessionId);
    this.close();
  }

  // ---- internals ----

  private close(): void {
    this.closed = true;
    if (this.sessionId) this.client.unsubscribe(this.sessionId, this.handler);
    this.attached = false;
    this.running = false;
    this.queue = [];
    for (const done of this.pendingControl.values()) done(undefined);
    this.pendingControl.clear();
  }

  private spawnSpec(): SpawnSpec {
    const files: Record<string, string> = {};
    let n = 0;
    // --resume is the daemon's business: it knows the session id (from the open request or
    // from the CLI's init) and adds it on every (re)start.
    const args = buildClaudeArgs({ ...this.opts, resumeSessionId: undefined }, (kind, content) => {
      const key = `${kind}-${++n}`;
      files[key] = content;
      return `${FILE_ARG_PREFIX}${key}`;
    });
    return { claudePath: this.opts.claudePath, args, env: engineEnvOverrides(this.opts), files };
  }

  private async open(): Promise<void> {
    try {
      await this.client.open(this.opts.cwd, this.opts.resumeSessionId, this.spawnSpec(), this.handler);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit('stderr', msg);
      // Messages written while opening are gone: say so the way a dead process would.
      const hadWork = this.queue.length > 0;
      this.queue = [];
      if (hadWork) this.emit('exit', 1);
      return;
    }
    if (this.closed) return;
    // The handshake, like a local process: the daemon answers it from its cache.
    this.client.send(this.sessionId!, {
      type: 'control_request',
      request_id: `${this.client.clientId}:init_${++this.reqSeq}`,
      request: { subtype: 'initialize' },
    });
    const queued = this.queue;
    this.queue = [];
    for (const msg of queued) this.client.send(this.sessionId!, msg);
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed) return;
    if (this.attached && this.sessionId) {
      this.client.send(this.sessionId, msg);
      return;
    }
    this.queue.push(msg);
    this.start();
  }

  private onDaemon(m: SessionMessage): void {
    switch (m.type) {
      case 'snapshot':
        this.sessionId = m.snapshot.session.id;
        this.attached = true;
        this.running = m.snapshot.session.state !== 'idle';
        if (m.snapshot.session.cliSessionId) this.setResumeId(m.snapshot.session.cliSessionId);
        this.emit('snapshot', m.snapshot);
        return;
      case 'event': {
        const ev = m.event as Record<string, any>;
        this.running = true;
        if (ev?.type === 'control_response') {
          const id = ev.response?.request_id;
          const done = typeof id === 'string' ? this.pendingControl.get(id) : undefined;
          if (done) {
            this.pendingControl.delete(id);
            done(ev.response?.subtype === 'success' ? ev.response.response : undefined);
          }
        }
        if (ev?.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
          this.setResumeId(ev.session_id);
        }
        this.emit('event', ev);
        return;
      }
      case 'control_settled':
        this.emit('settled', m.requestId);
        return;
      case 'remote_user':
        this.emit('remoteUser', m.message, m.uuid);
        return;
      case 'stderr':
        this.emit('stderr', m.text);
        return;
      case 'exit':
        this.running = false;
        for (const done of this.pendingControl.values()) done(undefined);
        this.pendingControl.clear();
        this.emit('exit', m.code);
        return;
      case 'disconnected':
        // The daemon went away (restart, crash). The next message re-opens: the session is
        // found again by its CLI session id and resumed.
        this.attached = false;
        this.running = false;
        for (const done of this.pendingControl.values()) done(undefined);
        this.pendingControl.clear();
        this.emit('exit', null);
        return;
      default:
        return;
    }
  }
}
