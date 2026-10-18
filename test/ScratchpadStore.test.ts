import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptPad, deletePad, loadPad, padFile, padKey, savePad, latestTranscriptImage } from '../src/scratchpad/store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('scratchpad store', () => {
  it('keys by session id, or by tab until there is one', () => {
    expect(padKey('abc-123', 't1')).toBe('abc-123');
    expect(padKey(undefined, 't1')).toBe('tab-t1');
  });

  it('keeps a key from escaping the folder', () => {
    expect(path.dirname(padFile(dir, '../../etc/passwd'))).toBe(path.join(dir, 'scratchpads'));
  });

  it('saves, loads and deletes a board', () => {
    expect(loadPad(dir, 'a')).toBeUndefined();
    savePad(dir, 'a', '{"elements":[]}');
    expect(loadPad(dir, 'a')).toBe('{"elements":[]}');
    expect(deletePad(dir, 'a')).toBe(true);
    expect(loadPad(dir, 'a')).toBeUndefined();
    expect(deletePad(dir, 'a')).toBe(false);
  });

  it('treats a corrupt file as no board', () => {
    fs.mkdirSync(path.join(dir, 'scratchpads'));
    fs.writeFileSync(padFile(dir, 'bad'), '{not json');
    expect(loadPad(dir, 'bad')).toBeUndefined();
  });

  it('moves a tab board to the session key once, without overwriting', () => {
    savePad(dir, padKey(undefined, 't1'), '{"a":1}');
    adoptPad(dir, 't1', 'sess');
    expect(loadPad(dir, 'sess')).toBe('{"a":1}');
    expect(loadPad(dir, padKey(undefined, 't1'))).toBeUndefined();
    savePad(dir, padKey(undefined, 't2'), '{"b":2}');
    savePad(dir, 'sess2', '{"keep":true}');
    adoptPad(dir, 't2', 'sess2');
    expect(loadPad(dir, 'sess2')).toBe('{"keep":true}');
  });
});

import { migratePad } from '../src/scratchpad/store';
describe('scratchpad migration', () => {
  it('copies an older board once and never overwrites', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pad2-'));
    try {
      savePad(other, 'k', '{"old":1}');
      migratePad(other, dir, 'k');
      expect(loadPad(dir, 'k')).toBe('{"old":1}');
      savePad(dir, 'k', '{"new":1}');
      migratePad(other, dir, 'k');
      expect(loadPad(dir, 'k')).toBe('{"new":1}');
      migratePad(dir, dir, 'k');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('latestTranscriptImage', () => {
  const user = (images?: string[]) => ({ kind: 'user' as const, id: 'u', text: '', images });
  it('is undefined without user images', () => {
    expect(latestTranscriptImage([user(), user([])])).toBeUndefined();
  });
  it('takes the newest image', () => {
    const items = [user(['data:image/png;base64,AAA']), user(['data:image/jpeg;base64,BBB', 'data:image/png;base64,CCC'])];
    expect(latestTranscriptImage(items)).toEqual({ mediaType: 'image/png', data: 'CCC' });
  });
  it('skips a malformed data URL', () => {
    expect(latestTranscriptImage([user(['data:image/png;base64,AAA', 'nonsense'])])).toEqual({ mediaType: 'image/png', data: 'AAA' });
  });
});
