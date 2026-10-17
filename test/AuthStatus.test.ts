import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchAuthStatus } from '../src/cli/AuthStatus';

// A fake `claude` whose `auth status --json` prints what each test needs.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-auth-'));
function fake(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('fetchAuthStatus', () => {
  it('reads a signed-in account', async () => {
    const a = await fetchAuthStatus(fake('in', `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'`));
    expect(a).toMatchObject({ loggedIn: true, authMethod: 'claude.ai', plan: 'max' });
    expect(a.unknown).toBeUndefined();
  });

  it('reads an explicit logged-out answer', async () => {
    const a = await fetchAuthStatus(fake('out', `echo '{"loggedIn":false}'`));
    expect(a.loggedIn).toBe(false);
    expect(a.unknown).toBeUndefined();
  });

  it('tolerates a banner line around the JSON', async () => {
    const a = await fetchAuthStatus(fake('banner', `echo 'Update available'; echo '{"loggedIn":true}'`));
    expect(a.loggedIn).toBe(true);
  });

  it('calls a failed check unknown, not logged out', async () => {
    expect((await fetchAuthStatus(fake('junk', `echo nonsense`))).unknown).toBe(true);
    expect((await fetchAuthStatus(fake('fail', `exit 1`))).unknown).toBe(true);
    expect((await fetchAuthStatus(path.join(dir, 'missing'))).unknown).toBe(true);
    expect((await fetchAuthStatus(fake('slow', `sleep 5`), 200)).error).toBe('timeout');
  });
});
