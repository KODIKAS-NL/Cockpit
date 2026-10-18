import { describe, it, expect } from 'vitest';
import { foreignLive, type LiveSession } from '../src/cli/SessionRegistry';

const proc = (over: Partial<LiveSession>): LiveSession => ({ pid: 1, sessionId: 's1', entrypoint: 'claude-vscode', ...over });
const alive = () => true;

describe('foreignLive', () => {
  it('finds another live process on the session', () => {
    const other = proc({ pid: 5, status: 'busy' });
    expect(foreignLive([proc({ pid: 4, sessionId: 'other' }), other], 's1', alive)).toBe(other);
  });
  it('ignores the processes the daemon started', () => {
    expect(foreignLive([proc({ entrypoint: 'sdk-cli' })], 's1', alive)).toBeUndefined();
  });
  it('ignores a stale file whose process is gone', () => {
    expect(foreignLive([proc({ pid: 9 })], 's1', (pid) => pid !== 9)).toBeUndefined();
  });
  it('is undefined for a session nobody else has', () => {
    expect(foreignLive([proc({})], 'nope', alive)).toBeUndefined();
  });
});
