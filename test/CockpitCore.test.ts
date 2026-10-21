// The core runs against fake host interfaces and a recording surface: no editor involved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CockpitCore } from '../src/core/CockpitCore';
import { setSettings } from '../src/core/services';
import { HUB_ID, type Surface } from '../src/core/surfaces';
import type { WebviewToHost } from '../src/../shared/protocol';
import { FakeHost, FakeSettings, FakeStore } from './fakeHost';

class TestCore extends CockpitCore {
  constructor(host: FakeHost) {
    super(host, path.resolve(__dirname, '..'), new FakeStore());
  }
  get hub(): { surface: Surface; got: Array<Record<string, unknown>> } {
    return this._hub;
  }
  private _hub = (() => {
    const got: Array<Record<string, unknown>> = [];
    return { got, surface: { kind: 'hub', post: (m: unknown) => void got.push(m as Record<string, unknown>) } as Surface };
  })();
  attach(): void {
    this.surfaces.set(HUB_ID, this._hub.surface);
  }
  send(m: WebviewToHost): void {
    this.onWebviewMessage(m, HUB_ID);
  }
  protected hasPanel = () => false;
  protected panelVisible = () => false;
  protected anyPanelVisible = () => false;
  protected revealPanel = () => false;
  protected revealPanelQuietly = () => {};
  protected createPanel = () => {};
  protected disposePanel = () => false;
  protected setPanelTitle = () => {};
  protected reloadPanel = () => {};
  protected sidebarOpen = () => false;
  protected sidebarVisible = () => false;
  protected focusSidebar = () => {};
  protected updateStatusBar = () => {};
  protected startWatchdog = () => {};
  protected onSurfaceAlive = () => {};
  protected openPad = () => {};
  protected disposePads = () => {};
}

describe('CockpitCore', () => {
  let settings: FakeSettings;
  let host: FakeHost;
  let core: TestCore;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
    settings = new FakeSettings();
    settings.values.set('daemon.enabled', false);
    setSettings(settings);
    host = new FakeHost();
    host.root = dir;
    core = new TestCore(host);
    core.attach();
  });
  afterEach(() => {
    core.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('init posts the config, the tabs and the CLI status', () => {
    core.send({ kind: 'init' } as WebviewToHost);
    const kinds = core.hub.got.map((m) => m.kind);
    expect(kinds).toContain('ready');
    expect(kinds).toContain('config');
    expect(kinds).toContain('tabs');
  });

  it('openLink opens the file at the line through the host', async () => {
    const file = path.join(dir, 'a.ts');
    fs.writeFileSync(file, 'x\n'.repeat(10));
    core.send({ kind: 'openLink', href: `${file}#L3` } as WebviewToHost);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.opened[0]).toMatchObject({ path: file, line: 3 });
  });

  it('setPermissionMode writes the setting', () => {
    core.send({ kind: 'init' } as WebviewToHost);
    core.send({ kind: 'setPermissionMode', mode: 'acceptEdits' } as WebviewToHost);
    expect(settings.updates).toContainEqual({ key: 'permissionMode', value: 'acceptEdits', scope: 'global' });
  });

  it('uploadFiles saves the bytes in the workspace and answers with the path', () => {
    const data = Buffer.from('hello').toString('base64');
    core.send({ kind: 'uploadFiles', requestId: 'r1', files: [{ name: '../evil name.txt', data }] } as WebviewToHost);
    const reply = core.hub.got.find((m) => m.kind === 'resolvedPath') as { requestId: string; text: string };
    expect(reply.requestId).toBe('r1');
    const rel = reply.text.replace(/"/g, '');
    expect(rel.startsWith('.cockpit/uploads/')).toBe(true);
    expect(rel).toMatch(/evil name\.txt$/);
    expect(fs.readFileSync(path.join(dir, rel), 'utf8')).toBe('hello');
  });
});
