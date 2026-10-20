// The sidecar end to end: a fake IDE plugin on stdio, a fake browser view on the WebSocket.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { start } from '../src/sidecar/main';
import { RpcPeer } from '../src/sidecar/rpc';

const root = path.resolve(__dirname, '..');

describe('sidecar', () => {
  let dir: string;
  let plugin: RpcPeer;
  let url: string;
  let token: string;
  let port: number;
  const calls: Array<{ method: string; params: any }> = [];
  const received: Array<Record<string, any>> = [];
  let ws: WebSocket;

  const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
    // Keep the test away from the real daemon on this machine.
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(path.join(dir, 'state', 'jetbrains-settings.json'), JSON.stringify({ 'daemon.socketPath': path.join(dir, 'none.sock') }));
    const toSidecar = new PassThrough();
    const fromSidecar = new PassThrough();
    start(['--extension-path', root], toSidecar, fromSidecar);
    plugin = new RpcPeer(fromSidecar, toSidecar);
    for (const m of ['openFile', 'notify', 'statusMessage', 'findFiles', 'secrets.get']) {
      plugin.on(m, (params) => {
        calls.push({ method: m, params });
        return m === 'findFiles' ? [] : null;
      });
    }
    const r = await plugin.request<{ port: number; token: string }>('init', {
      workspaceRoot: dir,
      language: 'en',
      stateDir: path.join(dir, 'state'),
      theme: ':root{--vscode-foreground:#abc}',
    });
    port = r.port;
    token = r.token;
    url = `127.0.0.1:${port}`;
  });

  afterAll(async () => {
    ws?.close();
    plugin.notify('shutdown');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page only with the token, with the IDE theme in it', async () => {
    const denied = await fetch(`http://${url}/?view=sidebar`);
    expect(denied.status).toBe(403);
    const ok = await fetch(`http://${url}/?t=${token}&view=sidebar`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('window.cockpitHost');
    expect(html).toContain('--vscode-foreground:#abc');
    expect(html).toContain('"sidebar"');
  });

  it('refuses a WebSocket without the token', async () => {
    const bad = new WebSocket(`ws://${url}/ws?view=sidebar&t=wrong`);
    await new Promise<void>((resolve) => bad.on('error', () => resolve()));
  });

  it('answers the page init with the config, the tabs and the CLI status', async () => {
    ws = new WebSocket(`ws://${url}/ws?view=sidebar&t=${token}`);
    ws.on('message', (d) => received.push(JSON.parse(String(d))));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ kind: 'init' }));
    await waitFor(() => received.some((m) => m.kind === 'ready'));
    const kinds = received.map((m) => m.kind);
    expect(kinds).toContain('config');
    expect(kinds).toContain('tabs');
  });

  it('opens a file link through the plugin', async () => {
    const file = path.join(dir, 'a.ts');
    fs.writeFileSync(file, 'x\n'.repeat(5));
    ws.send(JSON.stringify({ kind: 'openLink', href: `${file}#L2` }));
    await waitFor(() => calls.some((c) => c.method === 'openFile'));
    expect(calls.find((c) => c.method === 'openFile')?.params).toMatchObject({ path: file, line: 2 });
  });

  it('runs a plugin command, and pushes a new theme to the page', async () => {
    const r = await plugin.request<{ ok: boolean }>('command', { id: 'cockpitDaemon.newSession' });
    expect(r.ok).toBe(true);
    await waitFor(() => calls.some((c) => c.method === 'statusMessage'));
    plugin.notify('theme', { css: ':root{--vscode-foreground:#def}' });
    await waitFor(() => received.some((m) => m.__cockpit === 'theme' && String(m.css).includes('#def')));
    expect((await plugin.request<{ ok: boolean }>('command', { id: 'nope' })).ok).toBe(false);
  });

  it('keeps settings in its own file, with the manifest defaults', async () => {
    const file = path.join(dir, 'state', 'jetbrains-settings.json');
    ws.send(JSON.stringify({ kind: 'setPermissionMode', mode: 'acceptEdits' }));
    await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).permissionMode === 'acceptEdits');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['daemon.socketPath']).toContain('none.sock');
  });
});
