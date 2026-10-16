// cockpit-daemon against a fake CLI (test/fixtures/fake-claude.mjs): the arbitration
// between windows, catching up on attach, busy rejection, path matching, respawn with
// --resume and persistence across a daemon restart.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../src/daemon/Daemon';
import type { DaemonMessage, SpawnSpec } from '../shared/daemon';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

/** A raw protocol client: collects every daemon message, answers waits by predicate. */
class Peer {
  msgs: DaemonMessage[] = [];
  private waiters: { pred: (m: DaemonMessage) => boolean; resolve: (m: DaemonMessage) => void }[] = [];
  private seq = 0;
  private constructor(private socket: net.Socket) {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as DaemonMessage;
        this.msgs.push(m);
        for (const w of [...this.waiters]) {
          if (w.pred(m)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(m);
          }
        }
      }
    });
  }
  static async connect(sock: string, clientId: string): Promise<Peer> {
    const socket = net.connect(sock);
    await new Promise<void>((r, j) => {
      socket.once('connect', () => r());
      socket.once('error', j);
    });
    const p = new Peer(socket);
    p.write({ op: 'hello', clientId, version: 1 });
    await p.wait((m) => m.type === 'hello_ok');
    return p;
  }
  write(obj: unknown): void {
    this.socket.write(JSON.stringify(obj) + '\n');
  }
  wait(pred: (m: DaemonMessage) => boolean, ms = 4000): Promise<DaemonMessage> {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for daemon message')), ms);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }
  async open(cwd: string, spawn: SpawnSpec, cliSessionId?: string): Promise<any> {
    const reqId = `r${++this.seq}`;
    this.write({ op: 'open', reqId, cwd, cliSessionId, spawn });
    const m = (await this.wait((x) => (x as any).reqId === reqId)) as any;
    if (m.type === 'error') throw new Error(m.message);
    return m.snapshot;
  }
  async list(cwd?: string): Promise<any[]> {
    const reqId = `l${++this.seq}`;
    this.write({ op: 'list', reqId, cwd });
    return ((await this.wait((x) => (x as any).reqId === reqId)) as any).sessions;
  }
  send(sessionId: string, msg: unknown): void {
    this.write({ op: 'send', sessionId, msg });
  }
  user(sessionId: string, text: string): void {
    this.send(sessionId, { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }
  events(type?: string): any[] {
    return this.msgs
      .filter((m) => m.type === 'event')
      .map((m) => (m as any).event)
      .filter((e) => !type || e.type === type);
  }
  close(): void {
    this.socket.destroy();
  }
}

let dir: string;
let sock: string;
let state: string;
let logFile: string;
let project: string;
let daemon: Daemon;
const peers: Peer[] = [];

function spec(extra: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    claudePath: process.execPath,
    args: [FAKE, '-p', '--output-format', 'stream-json', ...(extra.args ?? [])],
    env: { FAKE_LOG: logFile, ...(extra.env ?? {}) },
    files: extra.files,
  };
}

/** Every line the fake CLI processes received, in order (argv records included). */
function cliLog(): any[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function peer(id: string): Promise<Peer> {
  const p = await Peer.connect(sock, id);
  peers.push(p);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daemon-test-'));
  sock = path.join(dir, 'd.sock');
  state = path.join(dir, 'sessions.json');
  logFile = path.join(dir, 'cli.log');
  project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
  daemon = new Daemon({ socketPath: sock, stateFile: state });
  await daemon.start();
});

afterEach(async () => {
  for (const p of peers.splice(0)) p.close();
  await daemon.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cockpit-daemon', () => {
  it('runs one initialize per process and answers every window from it', async () => {
    const a = await peer('A');
    const snap = await a.open(project, spec());
    const id = snap.session.id;
    a.send(id, { type: 'control_request', request_id: 'A:init', request: { subtype: 'initialize' } });
    const ra = await a.wait((m) => m.type === 'event' && (m as any).event.response?.request_id === 'A:init');
    expect((ra as any).event.response.response.commands[0].name).toBe('help');

    // B attaches to A's session by id once the CLI named it.
    a.user(id, 'hello');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
    const cliId = (await a.list(project)).find((s) => s.id === id).cliSessionId;
    const b = await peer('B');
    const snapB = await b.open(project, spec(), cliId);
    expect(snapB.session.id).toBe(id);
    b.send(id, { type: 'control_request', request_id: 'B:init', request: { subtype: 'initialize' } });
    await b.wait((m) => m.type === 'event' && (m as any).event.response?.request_id === 'B:init');

    const inits = cliLog().filter((l) => l.request?.subtype === 'initialize');
    // One per process, made by the daemon itself: windows never reach the CLI with theirs.
    expect(inits.length).toBe(1);
    expect(inits[0].request_id.startsWith('daemon-init-')).toBe(true);
  });

  it('shows a prompt sent from one window to the others', async () => {
    const a = await peer('A');
    const b = await peer('B');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-1'] }));
    await b.open(project, spec(), 'sess-1');
    a.user(s.session.id, 'from A');
    const remote = (await b.wait((m) => m.type === 'remote_user')) as any;
    expect(remote.message.content[0].text).toBe('from A');
    await b.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
    expect(a.msgs.some((m) => m.type === 'remote_user')).toBe(false);
  });

  it('passes a message sent mid-turn to the CLI and stays busy until it has run', async () => {
    const a = await peer('A');
    const b = await peer('B');
    const replay = { args: ['--resume', 'sess-2', '--replay-user-messages'] };
    const s = await a.open(project, spec(replay));
    await b.open(project, spec(replay), 'sess-2');
    a.user(s.session.id, 'SLOW please');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'stream_event');
    b.send(s.session.id, { type: 'user', uuid: 'u-2', message: { role: 'user', content: [{ type: 'text', text: 'SLOW me too' }] } });
    // A sees B's message right away, before the CLI takes it in.
    const remote = (await a.wait((m) => m.type === 'remote_user')) as any;
    expect(remote.message.content[0].text).toBe('SLOW me too');
    const results = () => a.events('result').length;
    await until(() => results() === 1);
    // The first turn is over, but the queued message is still running.
    expect((await a.list(project))[0].state).toBe('busy');
    await a.wait((m) => m.type === 'event' && (m as any).event.isReplay && (m as any).event.uuid === 'u-2');
    await until(() => results() === 2);
    expect((await a.list(project))[0].state).toBe('running');
    expect(cliLog().filter((l) => l.type === 'user').length).toBe(2);
  });

  it('runs a queued message after an interrupt', async () => {
    const a = await peer('A');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-2b', '--replay-user-messages'] }));
    a.user(s.session.id, 'SLOW please');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'stream_event');
    a.send(s.session.id, { type: 'user', uuid: 'u-now', message: { role: 'user', content: [{ type: 'text', text: 'now this' }] } });
    a.send(s.session.id, { type: 'control_request', request_id: 'A:int', request: { subtype: 'interrupt' } });
    await a.wait((m) => m.type === 'event' && (m as any).event.result === 'interrupted');
    await a.wait((m) => m.type === 'event' && (m as any).event.result === 'echo now this');
    expect((await a.list(project))[0].state).toBe('running');
  });

  it('turns Remote Control on inside the session and tells every window', async () => {
    const a = await peer('A');
    const b = await peer('B');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-r'] }));
    await b.open(project, spec(), 'sess-r');
    a.write({ op: 'remote', sessionId: s.session.id, on: true, reqId: 'rr1' });
    const res = (await a.wait((m) => m.type === 'remote_result')) as any;
    expect(res.ok).toBe(true);
    expect(res.url).toContain('claude.ai/code');
    const seen = (await b.wait((m) => m.type === 'remote_state')) as any;
    expect(seen.on).toBe(true);
    expect(seen.url).toBe(res.url);
    expect(b.msgs.some((m) => m.type === 'remote_result')).toBe(false);
    expect(cliLog().some((l) => l.request?.subtype === 'remote_control' && l.request.enabled === true)).toBe(true);
    // A window attaching later sees it in the snapshot, and sending still works.
    const c = await peer('C');
    const snap = await c.open(project, spec(), 'sess-r');
    expect(snap.session.remote).toEqual({ on: true, url: res.url });
    c.user(s.session.id, 'hello');
    await c.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
    a.write({ op: 'remote', sessionId: s.session.id, on: false, reqId: 'rr2' });
    await b.wait((m) => m.type === 'remote_state' && (m as any).on === false);
  });

  it('marks a turn started from the phone as busy and keeps the process alive', async () => {
    const a = await peer('A');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-p'], env: { FAKE_PHONE: 'typed on phone' } }));
    a.write({ op: 'remote', sessionId: s.session.id, on: true, reqId: 'rp1' });
    await a.wait((m) => m.type === 'remote_result');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'user');
    expect((await a.list()).find((x) => x.id === s.session.id).state).toBe('busy');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
  });

  it('turns Remote Control on again when the process restarts', async () => {
    const a = await peer('A');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-s'] }));
    a.write({ op: 'remote', sessionId: s.session.id, on: true, reqId: 'rs1' });
    await a.wait((m) => m.type === 'remote_result');
    a.write({ op: 'stop', sessionId: s.session.id });
    await a.wait((m) => m.type === 'exit');
    const before = cliLog().filter((l) => l.request?.subtype === 'remote_control').length;
    a.user(s.session.id, 'again');
    await until(() => cliLog().filter((l) => l.request?.subtype === 'remote_control').length > before);
  });

  it('keeps Remote Control on when re-enabling fails once after a restart', async () => {
    const flaky = path.join(os.tmpdir(), `fake-rc-${process.pid}-${Date.now()}`);
    const a = await peer('A');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-f'], env: { FAKE_RC_FLAKY: flaky } }));
    a.write({ op: 'remote', sessionId: s.session.id, on: true, reqId: 'rf1' });
    await a.wait((m) => m.type === 'remote_result');
    a.write({ op: 'stop', sessionId: s.session.id });
    await a.wait((m) => m.type === 'exit');
    a.user(s.session.id, 'again');
    // The first re-enable fails, the retry succeeds: the window gets the link again, never an 'off'.
    const seen = (await a.wait((m) => m.type === 'remote_state' && (m as any).on === true && !!(m as any).url)) as any;
    expect(seen.url).toContain('https://claude.ai/code/');
    expect(a.msgs.some((m) => m.type === 'remote_state' && (m as any).on === false)).toBe(false);
    expect((await a.list()).find((x) => x.id === s.session.id).remote?.on).toBe(true);
  }, 15_000);

  it('keeps the conversation\'s auto-compact across restarts, whatever window opens it', async () => {
    const a = await peer('A');
    const b = await peer('B');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-c', '--autocompact', '300000'] }));
    expect(s.session.autoCompact).toBe('300000');
    await b.open(project, spec(), 'sess-c');
    a.write({ op: 'autocompact', sessionId: s.session.id, value: '500000' });
    const seen = (await b.wait((m) => m.type === 'autocompact_state')) as any;
    expect(seen.value).toBe('500000');
    // The process stops; a window with another setting opens it again: the stored value still wins.
    a.write({ op: 'stop', sessionId: s.session.id });
    await a.wait((m) => m.type === 'exit');
    const before = cliLog().filter((l) => l.argv).length;
    const snap = await b.open(project, spec({ args: ['--autocompact', '150000'] }), 'sess-c');
    expect(snap.session.autoCompact).toBe('500000');
    await until(() => cliLog().filter((l) => l.argv).length > before);
    const argv = cliLog().filter((l) => l.argv).pop().argv as string[];
    expect(argv.filter((x) => x === '--autocompact').length).toBe(1);
    expect(argv[argv.indexOf('--autocompact') + 1]).toBe('500000');
    // Off becomes the environment switch, with no window argument left over.
    a.write({ op: 'autocompact', sessionId: s.session.id, value: 'off' });
    await b.wait((m) => m.type === 'autocompact_state' && (m as any).value === 'off');
    b.write({ op: 'stop', sessionId: s.session.id });
    await until(() => b.msgs.filter((m) => m.type === 'exit').length >= 2);
    const n = cliLog().filter((l) => l.argv).length;
    b.write({ op: 'detach', sessionId: s.session.id });
    await b.open(project, spec({ args: ['--autocompact', '200000'] }), 'sess-c');
    await until(() => cliLog().filter((l) => l.argv).length > n);
    const rec = cliLog().filter((l) => l.argv).pop();
    expect(rec.argv).not.toContain('--autocompact');
    expect(rec.env.DISABLE_AUTO_COMPACT).toBe('1');
    // A value outside the CLI's range is ignored.
    a.write({ op: 'autocompact', sessionId: s.session.id, value: '5' });
    await sleep(100);
    expect((await a.list()).find((x) => x.id === s.session.id).autoCompact).toBe('off');
  });

  it('lets the first answer win and tells the other windows', async () => {
    const a = await peer('A');
    const b = await peer('B');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-3'] }));
    const id = s.session.id;
    a.user(id, 'ASK first');
    const req = (await a.wait((m) => m.type === 'event' && (m as any).event.type === 'control_request')) as any;
    const requestId = req.event.request_id;

    // B attaches while the prompt is waiting: it gets it in the snapshot.
    const snapB = await b.open(project, spec(), 'sess-3');
    expect(snapB.pendingControl.map((c: any) => c.request_id)).toEqual([requestId]);
    expect(snapB.session.state).toBe('busy');

    const answer = (who: string) => ({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { behavior: who === 'A' ? 'allow' : 'deny', updatedInput: {} } },
    });
    a.send(id, answer('A'));
    const settled = (await b.wait((m) => m.type === 'control_settled')) as any;
    expect(settled.requestId).toBe(requestId);
    b.send(id, answer('B')); // too late: dropped
    const result = (await a.wait((m) => m.type === 'event' && (m as any).event.type === 'result')) as any;
    expect(result.event.result).toBe('decided allow');
    await sleep(100);
    expect(cliLog().filter((l) => l.type === 'control_response').length).toBe(1);
  });

  it('hands a window attaching mid-message the deltas written so far', async () => {
    const a = await peer('A');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-4'] }));
    a.user(s.session.id, 'SLOW');
    await a.wait((m) => m.type === 'event' && (m as any).event.event?.type === 'content_block_delta');
    const b = await peer('B');
    const snap = await b.open(project, spec(), 'sess-4');
    expect(snap.partial.length).toBe(2);
    expect(snap.partial[1].event.delta.text).toBe('half');
    await b.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
    const c = await peer('C');
    const after = await c.open(project, spec(), 'sess-4');
    expect(after.partial.length).toBe(0); // complete now: it's in the transcript
    expect(after.session.state).toBe('running');
  });

  it('routes a window\'s own control answers to that window only', async () => {
    const a = await peer('A');
    const b = await peer('B');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-5'] }));
    await b.open(project, spec(), 'sess-5');
    a.send(s.session.id, { type: 'control_request', request_id: 'A:get_context_usage_1', request: { subtype: 'get_context_usage' } });
    const r = (await a.wait((m) => m.type === 'event' && (m as any).event.response?.request_id === 'A:get_context_usage_1')) as any;
    expect(r.event.response.response.used).toBe(42);
    await sleep(100);
    expect(b.events('control_response').some((e) => e.response?.request_id === 'A:get_context_usage_1')).toBe(false);
  });

  it('matches sessions by real folder, not by prefix', async () => {
    const a = await peer('A');
    await a.open(project, spec({ args: ['--resume', 'sess-6'] }));
    const link = path.join(dir, 'link');
    fs.symlinkSync(project, link);
    expect((await a.list(project + '/')).map((s) => s.cliSessionId)).toEqual(['sess-6']);
    expect((await a.list(link)).map((s) => s.cliSessionId)).toEqual(['sess-6']);
    expect(await a.list(path.join(project, 'sub'))).toEqual([]);
    expect(await a.list(dir)).toEqual([]);
    // Same CLI id from another folder is a different session, never an attach.
    const other = await a.open(path.join(project, 'sub'), spec(), 'sess-6');
    expect(other.session.cwdKey).toBe(fs.realpathSync(path.join(project, 'sub')));
    expect((await a.list()).length).toBe(2);
  });

  it('writes file arguments, applies env, and resumes the CLI session after a stop', async () => {
    const a = await peer('A');
    const s = await a.open(
      project,
      spec({ args: ['--settings', '@file:settings'], env: { FAKE_FLAG: 'on' }, files: { settings: '{"x":1}' } }),
    );
    const id = s.session.id;
    a.user(id, 'first');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
    const first = cliLog().find((l) => l.argv);
    const settingsPath = first.argv[first.argv.indexOf('--settings') + 1];
    expect(settingsPath.startsWith('@file:')).toBe(false);
    expect(first.env.FAKE_FLAG).toBe('on');
    expect(first.cwd).toBe(fs.realpathSync(project));
    const cliId = (await a.list(project))[0].cliSessionId;
    expect(cliId).toBeTruthy();

    a.write({ op: 'stop', sessionId: id });
    await a.wait((m) => m.type === 'exit');
    expect((await a.list(project))[0].state).toBe('idle');

    a.user(id, 'second');
    await a.wait((m) => m.type === 'event' && (m as any).event.result === 'echo second');
    const argvs = cliLog().filter((l) => l.argv);
    expect(argvs.length).toBe(2);
    const second = argvs[1].argv;
    expect(second[second.indexOf('--resume') + 1]).toBe(cliId);
    expect(second.filter((x: string) => x === '--resume').length).toBe(1);
  });

  it('remembers sessions across a daemon restart', async () => {
    const a = await peer('A');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-7'] }));
    a.user(s.session.id, 'title line\nmore');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
    a.close();
    await daemon.shutdown();
    daemon = new Daemon({ socketPath: sock, stateFile: state });
    await daemon.start();
    const b = await peer('B');
    const list = await b.list(project);
    expect(list.length).toBe(1);
    expect(list[0].cliSessionId).toBe('sess-7');
    expect(list[0].state).toBe('idle');
    expect(list[0].title).toBe('title line');
    const snap = await b.open(project, spec(), 'sess-7');
    expect(snap.session.id).toBe(s.session.id);
  });

  it('drops a session that never got a message once no window holds it', async () => {
    const a = await peer('A');
    const empty = await a.open(project, spec());
    const kept = await a.open(project, spec({ args: ['--resume', 'sess-8'] }));
    expect((await a.list(project)).length).toBe(2);
    a.write({ op: 'detach', sessionId: empty.session.id });
    a.write({ op: 'detach', sessionId: kept.session.id });
    await sleep(50);
    expect((await a.list(project)).map((s) => s.cliSessionId)).toEqual(['sess-8']);
    // Same when the window's connection just goes away.
    const b = await peer('B');
    await b.open(project, spec());
    expect((await a.list(project)).length).toBe(2);
    b.close();
    await sleep(100);
    expect((await a.list(project)).map((s) => s.cliSessionId)).toEqual(['sess-8']);
  });

  it('does not bring back a session that never got a message after a restart', async () => {
    const a = await peer('A');
    await a.open(project, spec()); // still held when the daemon goes down
    await a.open(project, spec({ args: ['--resume', 'sess-10'] }));
    await daemon.shutdown();
    daemon = new Daemon({ socketPath: sock, stateFile: state });
    await daemon.start();
    const b = await peer('B');
    expect((await b.list(project)).map((s) => s.cliSessionId)).toEqual(['sess-10']);
  });

  it('answers a forget only after the process has exited', async () => {
    const a = await peer('A');
    const s = await a.open(project, spec({ args: ['--resume', 'sess-9'] }));
    a.user(s.session.id, 'hello');
    await a.wait((m) => m.type === 'event' && (m as any).event.type === 'result');
    a.write({ op: 'forget', sessionId: s.session.id, reqId: 'f1' });
    await a.wait((m) => m.type === 'forgotten' && (m as any).reqId === 'f1');
    const exitAt = a.msgs.findIndex((m) => m.type === 'exit');
    const forgottenAt = a.msgs.findIndex((m) => m.type === 'forgotten');
    expect(exitAt).toBeGreaterThanOrEqual(0);
    expect(exitAt).toBeLessThan(forgottenAt);
    expect(await a.list(project)).toEqual([]);
  });

  it('replaces a stale socket file and refuses to run twice', async () => {
    const second = new Daemon({ socketPath: sock });
    await expect(second.start()).rejects.toThrow('already listening');
    await daemon.shutdown();
    fs.writeFileSync(sock, ''); // a leftover from a daemon that died
    daemon = new Daemon({ socketPath: sock, stateFile: state });
    await daemon.start();
    const a = await peer('A');
    expect((await a.list()).length).toBe(0);
  });
});
