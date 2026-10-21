// One Claude CLI process owned by cockpit-daemon, and the little state a window needs to
// catch up when it attaches.
//
// The daemon relays the CLI's stream-json unchanged. What it adds:
//  - one `initialize` handshake per process, answered from cache to every window;
//  - the prompts (`control_request`) still waiting, so a window attaching later sees them,
//    and first-answer-wins arbitration between windows;
//  - a busy flag. A user message arriving mid-turn goes to the CLI anyway: the CLI queues it
//    and folds it into the turn, or runs it as the next turn. With --replay-user-messages the
//    CLI echoes each message when it takes it in, so busy holds until none is left waiting;
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
  /** Remote Control was on: re-enable it on the process the next time it starts. */
  remoteOn?: boolean;
  /** The conversation's auto-compact ('auto' | 'off' | tokens): wins over any window's spec. */
  autoCompact?: string;
}

export interface DaemonSessionHooks {
  log: (msg: string) => void;
  /** Something worth persisting changed (CLI session id, title, spec). */
  changed: () => void;
  /** Delays between restarts after a crash under Remote Control (tests shorten them). */
  keepAliveBackoffMs?: number[];
}

// A runaway turn must not grow the buffer without bound; old deltas are only cosmetic.
const MAX_PARTIAL = 20_000;

let initSeq = 0;
let remoteReqSeq = 0;
const RESYNC_ATTEMPTS = 4;
const RESYNC_DELAY_MS = 2000;
// Keeping a Remote Control session's process up: a deliberate stop restarts at once, a crash
// backs off; a process that lived this long counts as healthy again.
const KEEPALIVE_AFTER_STOP_MS = 1000;
const KEEPALIVE_BACKOFF_MS = [2000, 10_000, 30_000, 60_000];
const KEEPALIVE_MAX_FAILURES = 5;
const KEEPALIVE_HEALTHY_MS = 120_000;

/** How long a finished background task may keep the session busy before a turn must have started. */
const NOTICE_TURN_MS = 20_000;

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
  /** User messages written but not yet echoed back by the CLI (--replay-user-messages only). */
  private unconsumed = 0;
  private stopping = false;
  private partial: unknown[] = [];
  private pending = new Map<string, unknown>();
  private initRequestId?: string;
  private initResponse?: { response?: Record<string, unknown> };
  private initWaiters: { client: SessionClient; requestId: string }[] = [];
  /** Work queued for once the process has completed its init handshake. */
  private afterInit: Array<() => void> = [];
  private clients = new Map<string, SessionClient>();
  private tempDir?: string;
  // Remote Control: a phone / claude.ai/code pairs with THIS process (no handover, no second
  // process). `remoteOn` is what the user asked for — persisted, and re-sent to the CLI every
  // time the process (re)starts, so the pairing survives a daemon restart.
  private remoteOn = false;
  private remoteUrl?: string;
  private autoCompact: string;
  private remotePending = new Map<string, { client?: SessionClient; reqId?: string; on: boolean; attempt?: number }>();
  private resyncTimer?: ReturnType<typeof setTimeout>;
  /** Guards the busy state a finished background task sets: no turn follows → it is cleared. */
  private noticeTimer?: ReturnType<typeof setTimeout>;
  // Keep-alive under Remote Control (see keepAlive): the phone can only reach a running process.
  private disposed = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private startedAt = 0;
  private quickFailures = 0;
  /** A setting the CLI only reads at start changed mid-turn: restart once the turn is over. */
  private restartWhenIdle = false;
  /** Background tasks the CLI reports running (a restart would kill them). */
  private bgTasks = 0;

  constructor(data: PersistedSession, hooks: DaemonSessionHooks) {
    this.id = data.id;
    this.cwd = data.cwd;
    this.cwdKey = data.cwdKey;
    this.spec = data.spec;
    this.cliSessionId = data.cliSessionId ?? resumeIdOf(data.spec.args);
    this.title = data.title;
    this.createdAt = data.createdAt;
    this.lastActivity = data.lastActivity;
    this.remoteOn = data.remoteOn === true;
    this.autoCompact = validCompact(data.autoCompact) ?? compactOfSpec(data.spec);
    this.hooks = hooks;
  }

  // ---- state ----

  isRunning(): boolean {
    return this.proc !== null;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Stores the conversation's limit. The CLI only reads it at start, so a running process is
   * restarted to apply it: at once when idle, after the turn's `result` when busy.
   */
  setAutoCompact(value: string): void {
    const v = validCompact(value);
    if (!v || v === this.autoCompact) return;
    this.autoCompact = v;
    this.hooks.changed();
    this.broadcast({ type: 'autocompact_state', sessionId: this.id, value: v });
    if (!this.proc) return;
    if (this.busy || this.bgTasks > 0) this.restartWhenIdle = true;
    else this.restart();
  }

  /** Remote Control on: the idle stop must leave the process running for the phone. */
  hasRemote(): boolean {
    return this.remoteOn;
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
      remote: this.remoteOn ? { on: true, url: this.remoteUrl } : undefined,
      autoCompact: this.autoCompact,
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
      remoteOn: this.remoteOn || undefined,
      autoCompact: this.autoCompact,
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
    this.restartWhenIdle = false;
    this.clearRestartTimer();
    this.startedAt = Date.now();
    const proc = spawn(this.spec.claudePath, args, {
      cwd: this.cwd,
      env: this.processEnv(),
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

  /**
   * Remote Control is on: the phone can only reach a running process, so start one. Called
   * when the daemon starts, and after the process exits (see onExit).
   */
  keepAlive(): void {
    if (this.disposed || !this.remoteOn || this.proc) return;
    this.hooks.log(`[${this.id}] remote control on: starting the process for the phone`);
    this.ensureRunning();
  }

  /** Stops the process and starts it again with the current settings (`--autocompact`). */
  restart(): void {
    this.restartWhenIdle = false;
    if (!this.proc) return;
    this.hooks.log(`[${this.id}] restart to apply new settings`);
    void this.whenStopped().then(() => {
      if (!this.disposed && !this.proc) this.ensureRunning();
    });
    this.stop();
  }

  /** The session is being forgotten or the daemon shuts down: stop, and never come back. */
  dispose(): void {
    this.disposed = true;
    this.clearRestartTimer();
    this.clearNoticeTimer();
    this.stop();
  }

  /** Tells every attached window the session is gone (forgotten), so none keeps sending to it. */
  announceGone(): void {
    this.broadcast({ type: 'gone', sessionId: this.id });
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

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

  /** Without the echo nothing would ever count a queued message as taken in. */
  private tracksReplay(): boolean {
    return this.spec.args.includes('--replay-user-messages');
  }

  /**
   * A phone / claude.ai/code shares THIS process — no handover, no second process. The CLI's
   * own bridge accepts this on a running `-p` session: `remote_control { enabled }`, answered
   * with the pairing link. Queued until the process has completed its init handshake (sending
   * it any earlier races the CLI's own startup).
   */
  setRemote(client: SessionClient, on: boolean, reqId: string): void {
    this.hooks.log(`[${this.id}] remote control ${on ? 'on' : 'off'} requested by ${client.id}`);
    if (!on) this.clearRestartTimer();
    this.ensureRunning();
    const go = (): void => {
      const requestId = `daemon-remote-${++remoteReqSeq}`;
      this.remotePending.set(requestId, { client, reqId, on });
      this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'remote_control', enabled: on } });
    };
    if (this.initResponse) go();
    else this.afterInit.push(go);
  }

  /** The process (re)started with Remote Control already on: re-enables it, nobody waiting. */
  private resyncRemote(attempt = 1): void {
    this.resyncTimer = undefined;
    if (!this.remoteOn || !this.proc) return;
    const requestId = `daemon-remote-${++remoteReqSeq}`;
    this.remotePending.set(requestId, { on: true, attempt });
    this.hooks.log(`[${this.id}] remote control: re-enabling after start (attempt ${attempt})`);
    this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'remote_control', enabled: true } });
  }

  // ---- from a window ----

  send(client: SessionClient, msg: Record<string, any>): void {
    this.lastActivity = Date.now();
    switch (msg.type) {
      case 'user': {
        if (!this.title) {
          const title = titleOf(msg.message);
          if (title) {
            this.title = title;
            this.hooks.changed();
          }
        }
        this.ensureRunning();
        if (!this.busy) {
          this.busy = true;
          this.partial = [];
        }
        if (this.tracksReplay()) this.unconsumed++;
        this.write(msg);
        for (const c of this.clients.values()) {
          if (c.id !== client.id) c.send({ type: 'remote_user', sessionId: this.id, message: msg.message, uuid: msg.uuid });
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
    if (ev.type === 'stream_event' || ev.type === 'assistant' || ev.type === 'user' || ev.type === 'result') this.clearNoticeTimer();
    switch (ev.type) {
      case 'control_response': {
        const requestId = String(ev.response?.request_id ?? '');
        if (requestId && requestId === this.initRequestId) {
          this.initResponse = ev;
          const waiters = this.initWaiters;
          this.initWaiters = [];
          for (const w of waiters) this.answerInit(w.client, w.requestId);
          const queued = this.afterInit;
          this.afterInit = [];
          for (const fn of queued) fn();
          this.resyncRemote();
          return;
        }
        if (requestId && this.remotePending.has(requestId)) {
          const pend = this.remotePending.get(requestId)!;
          this.remotePending.delete(requestId);
          const r = ev.response as Record<string, unknown> | undefined;
          const ok = r?.subtype === 'success';
          this.hooks.log(
            `[${this.id}] remote control ${pend.on ? 'on' : 'off'}${pend.client ? '' : ' (resync)'}: ${ok ? 'ok' : `failed (${String(r?.error ?? 'no reason')})`}`,
          );
          if (!ok && !pend.client && pend.on && (pend.attempt ?? 1) < RESYNC_ATTEMPTS) {
            // The intent survives a failed re-enable (the CLI may not be ready right after
            // init): try again before giving up and showing it as off.
            const next = (pend.attempt ?? 1) + 1;
            this.resyncTimer = setTimeout(() => this.resyncRemote(next), RESYNC_DELAY_MS * (next - 1));
            this.resyncTimer.unref?.();
            return;
          }
          if (ok) {
            this.remoteOn = pend.on;
            this.remoteUrl = pend.on ? ((r?.response as Record<string, unknown> | undefined)?.session_url as string | undefined) : undefined;
          } else if (!pend.client) {
            // A resync (nobody waiting) failed: reflect that it really is off now.
            this.remoteOn = false;
            this.remoteUrl = undefined;
          }
          this.hooks.changed();
          if (pend.client && pend.reqId) {
            pend.client.send({
              type: 'remote_result',
              sessionId: this.id,
              reqId: pend.reqId,
              ok,
              url: this.remoteUrl,
              error: ok ? undefined : String(r?.error ?? 'remote control failed'),
            });
          }
          this.broadcast({ type: 'remote_state', sessionId: this.id, on: this.remoteOn, url: this.remoteUrl });
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
        if (ev.subtype === 'background_tasks_changed') {
          this.bgTasks = Array.isArray(ev.tasks) ? ev.tasks.length : 0;
        }
        // A background task that finished opens a turn on its own.
        if (ev.subtype === 'task_notification' && (ev.status === 'completed' || ev.status === 'failed')) {
          if (!this.busy) {
            this.busy = true;
            // The CLI answers it with a turn, but not always (it may have been read during a turn
            // already). If no turn event shows up, the session is not busy: do not stay stuck.
            this.clearNoticeTimer();
            this.noticeTimer = setTimeout(() => {
              this.noticeTimer = undefined;
              if (!this.busy || this.unconsumed > 0) return;
              this.hooks.log(`[${this.id}] busy after a task notification, but no turn followed: clearing`);
              this.busy = false;
              this.hooks.changed();
            }, NOTICE_TURN_MS);
          }
        }
        break;
      case 'stream_event':
        this.partial.push(ev);
        if (this.partial.length > MAX_PARTIAL) this.partial.splice(0, this.partial.length - MAX_PARTIAL);
        break;
      case 'user':
        // A queued message the CLI just took in: when the previous turn already ended, it
        // opens the next one. Any top-level user event (not a tool result) starts/continues a
        // turn — including one neither we nor another window sent: Remote Control lets a
        // phone / claude.ai/code start a turn directly in the CLI, which we only see on the
        // stream, never on our stdin.
        if (ev.isReplay === true && this.unconsumed > 0) this.unconsumed--;
        if (!ev.parent_tool_use_id) {
          this.busy = true;
          this.partial = [];
        }
        break;
      case 'assistant':
        if (!ev.parent_tool_use_id) this.partial = [];
        break;
      case 'result':
        // Messages still waiting run as the next turn: stay busy for them.
        this.busy = this.unconsumed > 0;
        this.partial = [];
        break;
    }
    this.broadcast({ type: 'event', sessionId: this.id, event: ev });
    // The turn a settings change waited for is over (and nothing else is queued or asked).
    // Idle means no turn, no prompt waiting and no background task: a restart would kill them.
    const settled =
      (ev.type === 'result' || (ev.type === 'system' && ev.subtype === 'background_tasks_changed')) &&
      this.restartWhenIdle &&
      !this.busy &&
      this.pending.size === 0 &&
      this.bgTasks === 0;
    if (settled) this.restart();
  }

  private onExit(code: number | null): void {
    const deliberate = this.stopping;
    this.hooks.log(`[${this.id}] exit ${code}${deliberate ? ' (stopped)' : ''}`);
    this.proc = null;
    this.clearNoticeTimer();
    this.busy = false;
    this.bgTasks = 0;
    this.unconsumed = 0;
    this.stopping = false;
    this.partial = [];
    this.pending.clear();
    this.initResponse = undefined;
    this.initRequestId = undefined;
    this.initWaiters = [];
    this.afterInit = [];
    // remoteOn itself is left alone: a window's intent, resynced the next time this starts.
    this.remoteUrl = undefined;
    for (const pend of this.remotePending.values()) {
      if (pend.client && pend.reqId) {
        pend.client.send({ type: 'remote_result', sessionId: this.id, reqId: pend.reqId, ok: false, error: 'process exited' });
      }
    }
    this.remotePending.clear();
    // A retry still waiting belongs to the process that just died.
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
    this.restartWhenIdle = false;
    this.removeTempDir();
    if (this.remoteOn) this.broadcast({ type: 'remote_state', sessionId: this.id, on: true, url: undefined });
    this.broadcast({ type: 'exit', sessionId: this.id, code, ...(deliberate ? { stopped: true } : {}) });
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();
    this.scheduleKeepAlive(deliberate);
  }

  /**
   * Remote Control on and the process gone: start it again for the phone. A deliberate stop
   * (settings change) comes back at once; a crash backs off, and after too many quick ones in
   * a row Remote Control is turned off instead of showing "connecting" forever.
   */
  private scheduleKeepAlive(deliberate: boolean): void {
    if (this.disposed || !this.remoteOn || this.proc || this.restartTimer) return;
    let delay = KEEPALIVE_AFTER_STOP_MS;
    if (!deliberate) {
      if (Date.now() - this.startedAt >= KEEPALIVE_HEALTHY_MS) this.quickFailures = 0;
      this.quickFailures++;
      if (this.quickFailures >= KEEPALIVE_MAX_FAILURES) {
        this.hooks.log(`[${this.id}] remote control: the process exited ${this.quickFailures} times in a row, turning it off`);
        this.quickFailures = 0;
        this.remoteOn = false;
        this.hooks.changed();
        this.broadcast({ type: 'remote_state', sessionId: this.id, on: false, url: undefined });
        return;
      }
      const backoff = this.hooks.keepAliveBackoffMs ?? KEEPALIVE_BACKOFF_MS;
      delay = backoff[Math.min(this.quickFailures - 1, backoff.length - 1)];
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.keepAlive();
    }, delay);
    this.restartTimer.unref?.();
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

  private processEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.spec.env ?? {}) };
    delete env.DISABLE_AUTO_COMPACT;
    if (this.autoCompact === 'off') env.DISABLE_AUTO_COMPACT = '1';
    return env;
  }

  /** The spec's arguments with file placeholders written out and the right --resume. */
  private resolveArgs(): string[] {
    this.removeTempDir();
    const files = this.spec.files ?? {};
    const args: string[] = [];
    for (let i = 0; i < this.spec.args.length; i++) {
      const a = this.spec.args[i];
      if (a === '--resume' || a === '--autocompact') {
        i++; // --resume: replaced below by the session id the daemon knows; --autocompact: the daemon's value wins
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
    if (/^\d+$/.test(this.autoCompact)) args.push('--autocompact', this.autoCompact);
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

const COMPACT_MIN = 100_000;
const COMPACT_MAX = 1_000_000;

function validCompact(v: unknown): string | undefined {
  if (v === 'auto' || v === 'off') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= COMPACT_MIN && n <= COMPACT_MAX) return v;
  }
  return undefined;
}

/** What a window's spawn spec asks for: the seed for a conversation that has no stored value. */
function compactOfSpec(spec: SpawnSpec): string {
  const i = spec.args.indexOf('--autocompact');
  const fromArg = i >= 0 ? validCompact(spec.args[i + 1]) : undefined;
  if (fromArg) return fromArg;
  return spec.env?.DISABLE_AUTO_COMPACT === '1' ? 'off' : 'auto';
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
