// Two windows, one conversation: real Sessions with RemoteCliProcess, through a real
// cockpit-daemon, against the fake CLI. Checks what the user sees in each window: prompts
// shown on attach and closed when the other window answers, the other window's message,
// a message sent mid-turn (queued by the CLI), and that closing a window leaves the conversation
// running.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Daemon as DaemonT } from '../src/daemon/Daemon';
import type { DaemonClient as DaemonClientT } from '../src/daemon/DaemonClient';
import type { Session as SessionT, SessionHooks } from '../src/session/Session';
import type { HostToWebview } from '../shared/protocol';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

let dir: string;
let project: string;
let daemon: DaemonT;
let mods: {
  Daemon: typeof import('../src/daemon/Daemon').Daemon;
  DaemonClient: typeof import('../src/daemon/DaemonClient').DaemonClient;
  Session: typeof import('../src/session/Session').Session;
};
const clients: DaemonClientT[] = [];
const prevHome = process.env.HOME;

interface Window {
  session: SessionT;
  ui: HostToWebview[];
  errors: unknown[];
}

function makeWindow(sock: string): Window {
  const client = new mods.DaemonClient(sock);
  clients.push(client);
  const ui: HostToWebview[] = [];
  const errors: unknown[] = [];
  const hooks: SessionHooks = {
    emit: (m) => ui.push(m),
    onBusy: () => {},
    onResult: () => {},
    onInteraction: () => {},
    onInit: () => {},
    onAuthRequired: () => {},
    fileText: () => undefined,
    savePlan: () => 'Planing/x.md',
    claudePath: () => FAKE,
    cwd: () => project,
    settings: () => ({ model: 'default', effort: 'default', permission: 'default', allowAgents: true }),
    askLanguage: () => 'en',
    extraSystemPrompt: () => undefined,
    quietPrompt: () => undefined,
    daemon: () => client,
    onTurnError: (e) => errors.push(e),
  };
  return { session: new mods.Session(hooks), ui, errors };
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const kinds = (w: Window, kind: string) => w.ui.filter((m) => m.kind === kind) as any[];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-sessions-test-'));
  // Session persists stats under ~/.claude: keep it in the temp folder. Set before the
  // modules load (StatsStore reads the home folder at import).
  process.env.HOME = dir;
  process.env.FAKE_LOG = path.join(dir, 'cli.log');
  project = path.join(dir, 'project');
  fs.mkdirSync(project);
  mods = {
    Daemon: (await import('../src/daemon/Daemon')).Daemon,
    DaemonClient: (await import('../src/daemon/DaemonClient')).DaemonClient,
    Session: (await import('../src/session/Session')).Session,
  };
  daemon = new mods.Daemon({ socketPath: path.join(dir, 'd.sock') });
  await daemon.start();
});

afterAll(async () => {
  for (const c of clients) c.dispose();
  await daemon.shutdown();
  process.env.HOME = prevHome;
  delete process.env.FAKE_LOG;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('two windows on one daemon session', () => {
  it('follows prompts and messages across windows, queued ones included', async () => {
    const sock = path.join(dir, 'd.sock');
    const a = makeWindow(sock);
    const b = makeWindow(sock);

    // Window A starts a conversation; the CLI asks for permission.
    a.session.send('ASK can I?');
    await until(() => kinds(a, 'permissionRequest').length === 1, 'A sees the prompt');
    const requestId = kinds(a, 'permissionRequest')[0].requestId;
    const cliId = a.session.sessionId!;
    expect(cliId).toBeTruthy();

    // Window B opens the same conversation while the prompt waits: it shows it too.
    b.session.resume(cliId);
    b.session.ensureCli();
    await until(() => kinds(b, 'permissionRequest').length === 1, 'B sees the waiting prompt');
    expect(kinds(b, 'permissionRequest')[0].requestId).toBe(requestId);
    expect(b.session.busy).toBe(true);

    // A answers: B's card closes, both see the turn end.
    a.session.decide(requestId, 'allow');
    await until(() => kinds(b, 'promptSettled').length === 1, 'B closes the prompt');
    await until(() => !a.session.busy && !b.session.busy, 'turn ends in both windows');
    expect(kinds(b, 'assistantText').concat(kinds(b, 'assistantDone')).length).toBeGreaterThan(0);

    // A sends a slow message: B shows it as a user bubble and follows the turn.
    a.session.send('SLOW one');
    await until(() => kinds(b, 'remoteUser').length === 1, 'B shows A\'s message');
    expect(kinds(b, 'remoteUser')[0].text).toBe('SLOW one');
    expect(b.session.busy).toBe(true);

    // B sends mid-turn: the CLI queues it. A shows it as queued until the CLI takes it in,
    // and both windows stay busy until it has run.
    b.session.send('me too', undefined, 'u-b');
    await until(() => kinds(a, 'remoteUser').length === 1, 'A shows B\'s message');
    expect(kinds(a, 'remoteUser')[0]).toMatchObject({ text: 'me too', id: 'u-b', queued: true });
    await until(() => kinds(a, 'userPickedUp').some((m) => m.id === 'u-b'), 'A sees it taken in');
    await until(() => kinds(b, 'turnComplete').length >= 3, 'the queued message ran');
    await until(() => !a.session.busy && !b.session.busy, 'both turns end');

    // A closes its window: the conversation keeps running for B.
    a.session.detach();
    b.session.send('after A left');
    await until(() => !b.session.busy && kinds(b, 'turnComplete').length >= 4, 'B continues alone');

    const log = fs
      .readFileSync(process.env.FAKE_LOG!, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const users = log.filter((l) => l.type === 'user').map((l) => l.message.content[0].text);
    expect(users).toEqual(['ASK can I?', 'SLOW one', 'me too', 'after A left']);
    expect(log.filter((l) => l.argv).length).toBe(1); // one process the whole time
  });

  it('"Send now" interrupts the turn and runs the message, without an error', async () => {
    const sock = path.join(dir, 'd.sock');
    const a = makeWindow(sock);
    a.session.send('SLOW long one');
    await until(() => kinds(a, 'assistantText').length > 0 || a.session.busy, 'turn running');
    await new Promise((r) => setTimeout(r, 100));
    a.session.sendNow('do this instead', undefined, 'u-now');
    expect(a.session.busy).toBe(true);
    await until(() => kinds(a, 'userPickedUp').some((m) => m.id === 'u-now'), 'the message is taken in');
    await until(() => !a.session.busy, 'its turn ends');
    expect(a.errors).toEqual([]);
    const log = fs
      .readFileSync(process.env.FAKE_LOG!, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(log.some((l) => l.request?.subtype === 'interrupt')).toBe(true);
    expect(log.filter((l) => l.type === 'user').map((l) => l.message.content[0].text).slice(-2)).toEqual([
      'SLOW long one',
      'do this instead',
    ]);
    a.session.detach();
  });
});
