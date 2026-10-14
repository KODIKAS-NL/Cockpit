// One Claude CLI process owned by cockpit-daemon, and the little state a window needs to
// catch up when it attaches.
//
// The daemon relays the CLI's stream-json unchanged. What it adds:
//  - one `initialize` handshake per process, answered from cache to every window;
//  - the prompts (`control_request`) still waiting, so a window attaching later sees them,
//    and first-answer-wins arbitration between windows;
//  - a busy flag: a user message arriving mid-turn is refused instead of queued;
//  - the deltas of the message being written right now (`partial`), since the transcript
//    only gets a message once it is complete.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StreamParser } from '../cli/StreamParser';
import { killGroup } from '../util/killTree';
import {
  FILE_ARG_PREFIX,
  type DaemonMessage,
  type DaemonSessionInfo,
  type SessionSnapshot,
  type SpawnSpec,
} from '../../shared/daemon';

/** A window attached to the session (one extension host connection). */
export interface SessionClient {
  id: string;
  send(msg: DaemonMessage): void;
}

export interface PersistedSession {
  id: string;
  cwd: string;
  cwdKey: string;
  spec: SpawnSpec;
  cliSessionId?: string;
  title?: string;
  createdAt: number;
  lastActivity: number;
}

export interface DaemonSessionHooks {
  log: (msg: string) => void;
  /** Something worth persisting changed (CLI session id, title, spec). */
  changed: () => void;
}

// A runaway turn must not grow the buffer without bound; old deltas are only cosmetic.
const MAX_PARTIAL = 20_000;

let initSeq = 0;

export class DaemonSession {
  readonly id: string;
  readonly cwd: string;
  readonly cwdKey: string;
  spec: SpawnSpec;
  cliSessionId?: string;
  title?: string;
  readonly createdAt: number;
  lastActivity: number;

  private readonly hooks: DaemonSessionHooks;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private parser = new StreamParser();
  private busy = false;
  private stopping = false;
  private partial: unknown[] = [];
  private pending = new Map<string, unknown>();
  private initRequestId?: string;
  private initResponse?: { response?: Record<string, unknown> };
  private initWaiters: { client: SessionClient; requestId: string }[] = [];
  private clients = new Map<string, SessionClient>();
  private tempDir?: string;

  constructor(data: PersistedSession, hooks: DaemonSessionHooks) {
    this.id = data.id;
    this.cwd = data.cwd;
    this.cwdKey = data.cwdKey;
    this.spec = data.spec;
    this.cliSessionId = data.cliSessionId ?? resumeIdOf(data.spec.args);
    this.title = data.title;
    this.createdAt = data.createdAt;
    this.lastActivity = data.lastActivity;
    this.hooks = hooks;
  }

  // ---- state ----

  isRunning(): boolean {
    return this.proc !== null;
  }

  isBusy(): boolean {
    return this.busy;
  }

  clientCount(): number {
    return this.clients.size;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  info(): DaemonSessionInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      cwdKey: this.cwdKey,
      cliSessionId: this.cliSessionId,
      title: this.title,
      state: !this.proc ? 'idle' : this.busy ? 'busy' : 'running',
      pendingPrompts: this.pending.size,
      clients: this.clients.size,
      lastActivity: this.lastActivity,
      createdAt: this.createdAt,
    };
  }

  persisted(): PersistedSession {
    return {
      id: this.id,
      cwd: this.cwd,
      cwdKey: this.cwdKey,
      spec: this.spec,
      cliSessionId: this.cliSessionId,
      title: this.title,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    };
  }

  // ---- windows ----

  attach(client: SessionClient): SessionSnapshot {
    this.clients.set(client.id, client);
    return {
      session: this.info(),
      partial: [...this.partial],
      pendingControl: [...this.pending.values()],
    };
  }

  detach(clientId: string): void {
    this.clients.delete(clientId);
    this.initWaiters = this.initWaiters.filter((w) => w.client.id !== clientId);
  }

  // ---- process ----

  /** Starts the CLI when it is not running. With a known session id it always resumes it. */
  ensureRunning(): void {
    if (this.proc) return;
    const args = this.resolveArgs();
    this.hooks.log(`[${this.id}] spawn ${this.spec.claudePath} ${args.join(' ')} (cwd=${this.cwd})`);
    this.parser = new StreamParser();
    this.stopping = false;
    const proc = spawn(this.spec.claudePath, args, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.spec.env ?? {}) },
      // Own process group, so stop() ends claude AND its subagents/tools.
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      for (const ev of this.parser.push(chunk)) this.onEvent(ev as unknown as Record<string, any>);
    });
    proc.stderr.on('data', (text: string) => this.broadcast({ type: 'stderr', sessionId: this.id, text }));
    proc.on('close', (code) => {
      for (const ev of this.parser.flush()) this.onEvent(ev as unknown as Record<string, any>);
      if (this.proc === proc) this.onExit(code);
    });
    proc.on('error', (err) => {
      this.hooks.log(`[${this.id}] spawn failed: ${err.message}`);
      this.broadcast({ type: 'stderr', sessionId: this.id, text: err.message });
    });
    // A dead reader must not crash the daemon (EPIPE on a process that just exited).
    proc.stdin.on('error', () => {});
    this.proc = proc;
    // One handshake per process, made by the daemon: every window's `initialize` is
    // answered from its response.
    this.initRequestId = `daemon-init-${++initSeq}`;
    this.initResponse = undefined;
    this.write({ type: 'control_request', request_id: this.initRequestId, request: { subtype: 'initialize' } });
  }

  /** Resolves when the process is gone (at once when there is none), or after `timeoutMs`. */
  whenStopped(timeoutMs = 5000): Promise<void> {
    if (!this.proc) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== done);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.exitWaiters.push(done);
    });
  }

  private exitWaiters: Array<() => void> = [];

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    try {
      proc.stdin.end();
    } catch {
      /* noop */
    }
    if (proc.pid != null) killGroup(proc.pid);
    else proc.kill('SIGTERM');
  }

  // ---- from a window ----

  send(client: SessionClient, msg: Record<string, any>): void {
    this.lastActivity = Date.now();
    switch (msg.type) {
      case 'user': {
        if (this.busy) {
          client.send({ type: 'rejected', sessionId: this.id, reason: 'busy' });
          return;
        }
        if (!this.title) {
          const title = titleOf(msg.message);
          if (title) {
            this.title = title;
            this.hooks.changed();
          }
        }
        this.ensureRunning();
        this.busy = true;
        this.partial = [];
        this.write(msg);
        for (const c of this.clients.values()) {
          if (c.id !== client.id) c.send({ type: 'remote_user', sessionId: this.id, message: msg.message });
        }
        return;
      }
      case 'control_request': {
        const subtype = msg.request?.subtype;
        const requestId = String(msg.request_id ?? '');
        if (subtype === 'initialize') {
          this.ensureRunning();
          if (this.initResponse) this.answerInit(client, requestId);
          else this.initWaiters.push({ client, requestId });
          return;
        }
        if (!this.proc) {
          // Nothing to ask (e.g. context usage of a stopped session): fail fast instead of
          // starting a process just to answer, and instead of letting the caller time out.
          if (subtype !== 'interrupt') {
            client.send({
              type: 'event',
              sessionId: this.id,
              event: { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'not running' } },
            });
          }
          return;
        }
        this.write(msg);
        return;
      }
      case 'control_response': {
        const requestId = String(msg.response?.request_id ?? '');
        // First answer wins. A second window answering the same prompt (or a prompt that
        // died with its process) is dropped: the CLI must never see two answers.
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        this.write(msg);
        for (const c of this.clients.values()) {
          if (c.id !== client.id) c.send({ type: 'control_settled', sessionId: this.id, requestId });
        }
        return;
      }
      default:
        this.ensureRunning();
        this.write(msg);
    }
  }

  // ---- from the CLI ----

  private onEvent(ev: Record<string, any>): void {
    this.lastActivity = Date.now();
    switch (ev.type) {
      case 'control_response': {
        const requestId = String(ev.response?.request_id ?? '');
        if (requestId && requestId === this.initRequestId) {
          this.initResponse = ev;
          const waiters = this.initWaiters;
          this.initWaiters = [];
          for (const w of waiters) this.answerInit(w.client, w.requestId);
          return;
        }
        // Answers to a window's own requests (context usage, …) go to that window only:
        // ids are prefixed `<clientId>:` by the client.
        const owner = requestId.includes(':') ? requestId.slice(0, requestId.indexOf(':')) : undefined;
        const target = owner ? this.clients.get(owner) : undefined;
        if (target) target.send({ type: 'event', sessionId: this.id, event: ev });
        else this.broadcast({ type: 'event', sessionId: this.id, event: ev });
        return;
      }
      case 'control_request':
        if (ev.request_id != null) this.pending.set(String(ev.request_id), ev);
        break;
      case 'control_cancel_request':
        if (ev.request_id != null) this.pending.delete(String(ev.request_id));
        break;
      case 'system':
        if (ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id !== this.cliSessionId) {
          this.cliSessionId = ev.session_id;
          this.hooks.changed();
        }
        // A background task that finished opens a turn on its own.
        if (ev.subtype === 'task_notification' && (ev.status === 'completed' || ev.status === 'failed')) {
          this.busy = true;
        }
        break;
      case 'stream_event':
        this.partial.push(ev);
        if (this.partial.length > MAX_PARTIAL) this.partial.splice(0, this.partial.length - MAX_PARTIAL);
        break;
      case 'assistant':
      case 'user':
        // The message is complete, so it is in the transcript now.
        if (!ev.parent_tool_use_id) this.partial = [];
        break;
      case 'result':
        this.busy = false;
        this.partial = [];
        break;
    }
    this.broadcast({ type: 'event', sessionId: this.id, event: ev });
  }

  private onExit(code: number | null): void {
    const deliberate = this.stopping;
    this.hooks.log(`[${this.id}] exit ${code}${deliberate ? ' (stopped)' : ''}`);
    this.proc = null;
    this.busy = false;
    this.stopping = false;
    this.partial = [];
    this.pending.clear();
    this.initResponse = undefined;
    this.initRequestId = undefined;
    this.initWaiters = [];
    this.removeTempDir();
    this.broadcast({ type: 'exit', sessionId: this.id, code });
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();
  }

  // ---- helpers ----

  private answerInit(client: SessionClient, requestId: string): void {
    const resp = this.initResponse?.response ?? {};
    client.send({
      type: 'event',
      sessionId: this.id,
      event: { type: 'control_response', response: { ...resp, request_id: requestId } },
    });
  }

  private broadcast(msg: DaemonMessage): void {
    for (const c of this.clients.values()) c.send(msg);
  }

  private write(obj: unknown): void {
    this.proc?.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** The spec's arguments with file placeholders written out and the right --resume. */
  private resolveArgs(): string[] {
    this.removeTempDir();
    const files = this.spec.files ?? {};
    const args: string[] = [];
    for (let i = 0; i < this.spec.args.length; i++) {
      const a = this.spec.args[i];
      if (a === '--resume') {
        i++; // replaced below by the session id the daemon knows
        continue;
      }
      if (a.startsWith(FILE_ARG_PREFIX)) {
        const name = a.slice(FILE_ARG_PREFIX.length);
        const content = files[name];
        if (content === undefined) continue;
        args.push(this.writeFile(name, content));
        continue;
      }
      args.push(a);
    }
    // Once the CLI has named the session, every (re)start continues it: without --resume
    // the CLI would open a NEW transcript and the conversation would split in two.
    if (this.cliSessionId) args.push('--resume', this.cliSessionId);
    return args;
  }

  private writeFile(name: string, content: string): string {
    if (!this.tempDir) this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daemon-'));
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(this.tempDir, safe);
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
    return file;
  }

  private removeTempDir(): void {
    if (!this.tempDir) return;
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      /* the OS cleans tmp eventually */
    }
    this.tempDir = undefined;
  }
}

/** The value after `--resume` in an argument list. */
export function resumeIdOf(args: string[]): string | undefined {
  const i = args.indexOf('--resume');
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** First line of a user message's text, for the session list. */
function titleOf(message: any): string | undefined {
  const content = message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const block = content.find((b: any) => b?.type === 'text' && typeof b.text === 'string');
    text = block?.text ?? '';
  }
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
