import { describe, expect, it } from 'vitest';
import { buildRef, parseRef, refLines, sameCopy, splitLeadingRefs, isRefWorthy, findRefs, refAt, expandRefsForFeedback } from '../shared/codeRef';

describe('codeRef', () => {
  it('builds a ref', () => {
    expect(buildRef('src/a.ts', 12, 30)).toBe('@src/a.ts#L12-30');
    expect(buildRef('src/a.ts', 5, 5)).toBe('@src/a.ts#L5');
    expect(buildRef('src/a.ts', 5, 9, 0)).toBe('@src/a.ts#L5-8'); // ends at column 0: the line before
    expect(buildRef('src/a.ts', 5, 6, 0)).toBe('@src/a.ts#L5');
  });
  it('parses new and old formats', () => {
    const p = parseRef('@webview/src/App.tsx#L3-9');
    expect(p).toMatchObject({ path: 'webview/src/App.tsx', name: 'App.tsx', dir: 'webview/src', start: 3, end: 9 });
    expect(refLines(p)).toBe('3-9');
    expect(refLines(parseRef('@App.tsx#7'))).toBe('7');
    expect(refLines(parseRef('@App.tsx#L7-7'))).toBe('7');
    expect(parseRef('@App.tsx')).toMatchObject({ name: 'App.tsx', dir: '', start: undefined });
  });
  it('splits leading refs from the message', () => {
    expect(splitLeadingRefs('@a.ts#L1-2\n@b/c.ts#L4\nfix this')).toEqual({ refs: ['@a.ts#L1-2', '@b/c.ts#L4'], rest: 'fix this' });
    expect(splitLeadingRefs('no refs\n@a.ts#L1')).toEqual({ refs: [], rest: 'no refs\n@a.ts#L1' });
  });
  it('matches a paste with the last copy', () => {
    expect(sameCopy('a\r\nb\r\n', 'a\nb')).toBe(true);
    expect(sameCopy('a\nb', 'a\nc')).toBe(false);
    expect(sameCopy('', '')).toBe(false);
  });
  it('only multi-line copies are references', () => {
    expect(isRefWorthy('a\nb', 1, 2)).toBe(true);
    expect(isRefWorthy('word', 3, 3)).toBe(false);
    expect(isRefWorthy('  \n  ', 1, 2)).toBe(false);
  });
  it('finds inline refs', () => {
    const t = 'see @a/b.ts#L3-5, and @c.ts#L9 or email@x.com#L1';
    expect(findRefs(t).map((r) => r.ref)).toEqual(['@a/b.ts#L3-5', '@c.ts#L9']);
    const r = findRefs(t)[0];
    expect(t.slice(r.start, r.end)).toBe('@a/b.ts#L3-5');
  });
  it('finds the token at the caret', () => {
    const t = 'x @a.ts#L1 y';
    expect(refAt(t, 10, 'back')?.ref).toBe('@a.ts#L1');
    expect(refAt(t, 10, 'fwd')).toBeUndefined();
    expect(refAt(t, 2, 'fwd')?.ref).toBe('@a.ts#L1');
    expect(refAt(t, 2, 'in')).toBeUndefined();
    expect(refAt(t, 5, 'in')?.ref).toBe('@a.ts#L1');
  });
  it('expands references in plan feedback', () => {
    const plan = 'one\ntwo\nthree\nfour\n';
    const pasted = new Map([['@b.ts#L1-2', 'x\ny']]);
    const out = expandRefsForFeedback('fix @Planing/p.md#L2-3 and @b.ts#L1-2 and @c.ts#L9', plan, 'Planing/p.md', pasted);
    expect(out).toBe('fix The plan, lines 2-3:\n> two\n> three and @b.ts#L1-2:\n> x\n> y and @c.ts#L9');
  });
});
