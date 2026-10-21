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
  savePlan(plan: string, previous?: string): string | undefined {
    return this.savePlanFile(plan, previous);
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

  it('a plan revision replaces the earlier file and takes the name of the revision', () => {
    const first = core.savePlan('# Plan one\nv1')!;
    expect(first).toMatch(/^Planing\/\d{4}-\d{2}-\d{2}-\d{4}-plan-one\.md$/);
    const outside = path.join(dir, 'keep.md');
    fs.writeFileSync(outside, 'x');

    const second = core.savePlan('# Plan one, renamed\nv2', first)!;
    expect(second).toMatch(/plan-one-renamed\.md$/);
    expect(fs.existsSync(path.join(dir, first))).toBe(false);
    expect(fs.readFileSync(path.join(dir, second), 'utf8')).toBe('# Plan one, renamed\nv2\n');
    expect(fs.readdirSync(path.join(dir, 'Planing'))).toEqual([path.basename(second)]);

    // only a plan file of Planing/ is ever removed
    core.savePlan('# Plan two', 'keep.md');
    expect(fs.existsSync(outside)).toBe(true);
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

  it('uploadFiles saves the bytes once per content, and deleteUpload removes the file', () => {
    const data = Buffer.from('hello').toString('base64');
    const up = (id: string) => {
      core.send({ kind: 'uploadFiles', requestId: id, files: [{ name: '../evil name.txt', data }] } as WebviewToHost);
      return core.hub.got.filter((m) => m.kind === 'uploadedFiles').pop() as unknown as {
        requestId: string;
        files: { abs: string; rel: string; name: string; size: number }[];
      };
    };
    const one = up('r1');
    expect(one.requestId).toBe('r1');
    expect(one.files[0].rel.startsWith('.cockpit/uploads/')).toBe(true);
    expect(one.files[0].rel).toMatch(/evil name\.txt$/);
    expect(fs.readFileSync(one.files[0].abs, 'utf8')).toBe('hello');
    const two = up('r2');
    expect(two.files[0].abs).toBe(one.files[0].abs); // the same content is the same file
    expect(fs.readdirSync(path.join(dir, '.cockpit', 'uploads'))).toHaveLength(1);
    core.send({ kind: 'deleteUpload', abs: path.join(dir, 'outside.txt') } as WebviewToHost); // not in the folder: ignored
    core.send({ kind: 'deleteUpload', abs: one.files[0].abs } as WebviewToHost);
    expect(fs.existsSync(one.files[0].abs)).toBe(false);
  });

  it('old uploads are swept at start, young ones stay', () => {
    const up = path.join(dir, '.cockpit', 'uploads');
    fs.mkdirSync(up, { recursive: true });
    const old = path.join(up, 'old.txt');
    const young = path.join(up, 'young.txt');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(young, 'x');
    const past = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(old, past, past);
    new TestCore(host).dispose();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
  });
});
