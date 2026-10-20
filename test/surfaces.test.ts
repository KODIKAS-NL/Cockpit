import { describe, it, expect } from 'vitest';
import { Surfaces, HUB_ID, SIDEBAR_ID, panelId, type Surface } from '../src/core/surfaces';

function rec(kind: Surface['kind'], tab?: string) {
  const got: unknown[] = [];
  return { got, s: { kind, tab, post: (m: unknown) => void got.push(m) } as Surface };
}

describe('Surfaces', () => {
  it('routes a tab message to the hub, the side bar and that tab only', () => {
    const r = new Surfaces();
    const hub = rec('hub'), side = rec('sidebar'), a = rec('panel', 'a'), b = rec('panel', 'b');
    r.set(HUB_ID, hub.s); r.set(SIDEBAR_ID, side.s); r.set(panelId('a'), a.s); r.set(panelId('b'), b.s);
    r.post({ kind: 'error', message: 'x' } as never, 'a');
    expect(hub.got).toHaveLength(1);
    expect(side.got).toHaveLength(1);
    expect(a.got).toEqual([{ kind: 'error', message: 'x', tab: 'a' }]);
    expect(b.got).toHaveLength(0);
  });
  it('sends a global message to every panel and survives a dead surface', () => {
    const r = new Surfaces();
    const a = rec('panel', 'a'), b = rec('panel', 'b');
    r.set(panelId('a'), { kind: 'panel', tab: 'a', post: () => { throw new Error('gone'); } });
    r.set(panelId('b'), b.s);
    r.post({ kind: 'authRequired' } as never);
    expect(b.got).toHaveLength(1);
    r.remove(panelId('b'));
    r.post({ kind: 'authRequired' } as never);
    expect(b.got).toHaveLength(1);
    expect(a.got).toHaveLength(0);
  });
});
