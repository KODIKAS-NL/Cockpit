// The managed CLI downloader against a local release server: checksum gate, atomic switch of the
// active version, pruning, and the platform mapping used for the download path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installManaged,
  latestVersion,
  managedBinaryPath,
  managedVersion,
  platformKey,
  updateAvailable,
} from '../src/cli/ManagedCli';

const PLATFORM = 'linux-x64';

let server: http.Server;
let base: string;
let root: string;
let latest = '2.1.10';
let corrupt = false;
const payload = (v: string) => Buffer.from(`#!/bin/sh\necho "${v} (Claude Code)"\n`);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cli-'));
  latest = '2.1.10';
  corrupt = false;
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/latest') return void res.end(latest);
    const m = /^\/([^/]+)\/(manifest\.json|([^/]+)\/claude)$/.exec(url);
    if (!m) return void res.writeHead(404).end();
    const [, v, what] = m;
    if (what === 'manifest.json') {
      res.end(JSON.stringify({ version: v, platforms: { [PLATFORM]: { binary: 'claude', checksum: sha(payload(v)), size: payload(v).length } } }));
    } else {
      res.end(corrupt ? Buffer.from('tampered') : payload(v));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

const opts = () => ({ baseUrl: base, allowInsecure: true, root, platform: PLATFORM });

describe('ManagedCli', () => {
  it('installs the latest version, verified and executable, behind a stable path', async () => {
    const r = await installManaged(opts());
    expect(r).toMatchObject({ version: '2.1.10', changed: true });
    expect(fs.readFileSync(r.path).equals(payload('2.1.10'))).toBe(true);
    expect(fs.statSync(r.path).mode & 0o111).toBeTruthy();
    expect(managedVersion(root)).toBe('2.1.10');
    expect(managedBinaryPath(root)).toBe(path.join(root, 'current'));
  });

  it('refuses a download whose checksum does not match and leaves nothing behind', async () => {
    corrupt = true;
    await expect(installManaged(opts())).rejects.toThrow('checksum verification failed');
    expect(managedVersion(root)).toBeUndefined();
    const dir = path.join(root, 'versions', '2.1.10');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('keeps the old version when an update fails', async () => {
    await installManaged(opts());
    latest = '2.1.11';
    corrupt = true;
    await expect(installManaged(opts())).rejects.toThrow('checksum');
    expect(managedVersion(root)).toBe('2.1.10');
    expect(fs.readFileSync(managedBinaryPath(root)!).equals(payload('2.1.10'))).toBe(true);
  });

  it('does nothing when the version is already installed', async () => {
    await installManaged(opts());
    expect((await installManaged(opts())).changed).toBe(false);
  });

  it('switches versions atomically and keeps only the newest two', async () => {
    for (const v of ['2.1.10', '2.1.11', '2.1.12']) {
      latest = v;
      await installManaged(opts());
    }
    expect(managedVersion(root)).toBe('2.1.12');
    expect(fs.readdirSync(path.join(root, 'versions')).sort()).toEqual(['2.1.11', '2.1.12']);
    expect(fs.readFileSync(managedBinaryPath(root)!).equals(payload('2.1.12'))).toBe(true);
  });

  it('reports an update only when the server has a newer version', async () => {
    await installManaged(opts());
    expect(await updateAvailable({ root, baseUrl: base, allowInsecure: true })).toBeUndefined();
    latest = '2.2.0';
    expect(await updateAvailable({ root, baseUrl: base, allowInsecure: true })).toBe('2.2.0');
  });

  it('refuses plain http unless allowed and rejects a non-version answer', async () => {
    await expect(latestVersion({ baseUrl: base })).rejects.toThrow('refusing');
    latest = '<html>error</html>';
    await expect(latestVersion({ baseUrl: base, allowInsecure: true })).rejects.toThrow('not a version');
  });

  it('fails clearly for a platform missing from the manifest', async () => {
    await expect(installManaged({ ...opts(), platform: 'linux-arm64' })).rejects.toThrow('not found in the manifest');
  });

  it('maps node platforms to release platforms like the official installers', () => {
    expect(platformKey({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64');
    expect(platformKey({ platform: 'darwin', arch: 'x64' })).toBe('darwin-x64');
    expect(platformKey({ platform: 'linux', arch: 'x64', musl: false })).toBe('linux-x64');
    expect(platformKey({ platform: 'linux', arch: 'arm64', musl: true })).toBe('linux-arm64-musl');
    expect(platformKey({ platform: 'win32', arch: 'x64' })).toBe('win32-x64');
    expect(platformKey({ platform: 'win32', arch: 'arm64' })).toBe('win32-arm64');
  });
});
