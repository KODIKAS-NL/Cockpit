import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScratchpadHub } from '../src/sidecar/ScratchpadHub';
import type { HostToPad } from '../src/scratchpad/messages';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function make() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-'));
  dirs.push(storageDir);
  const shown: string[] = [];
  const sent: string[] = [];
  const hub = new ScratchpadHub({
    storageDir,
    locale: () => 'en',
    onSend: (key) => sent.push(key),
    latestImage: () => undefined,
    show: (key) => shown.push(key),
    exportImage: () => undefined,
  });
  return { hub, shown, sent };
}

describe('ScratchpadHub', () => {
  it('asks the IDE to show the board and places a pending image on init', () => {
    const { hub, shown } = make();
    hub.open('k1', 'T', { mediaType: 'image/png', data: 'AA' } as never);
    expect(shown).toEqual(['k1']);
    const got: HostToPad[] = [];
    const conn = hub.attach('k1', (m) => got.push(m));
    conn.message({ kind: 'ready' });
    expect(got[0]).toMatchObject({ kind: 'init', lang: 'en', assetPath: '/pad/' });
    expect((got[0] as { image?: unknown }).image).toBeTruthy();
    conn.close();
    hub.dispose();
  });

  it('saves the board and loads it back, and forwards a send', () => {
    const { hub, sent } = make();
    const first = hub.attach('k2', () => undefined);
    first.message({ kind: 'save', json: '{"a":1}' });
    first.message({ kind: 'send', image: { mediaType: 'image/png', data: 'AA' } as never });
    first.close();
    const got: HostToPad[] = [];
    const second = hub.attach('k2', (m) => got.push(m));
    second.message({ kind: 'ready' });
    expect((got[0] as { json?: string }).json).toBe('{"a":1}');
    expect(sent).toEqual(['k2']);
    second.close();
    hub.dispose();
  });
});
