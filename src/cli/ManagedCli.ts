// Cockpit's own copy of the Claude Code CLI, downloaded from Anthropic's release server with the
// same checks as the official installers (install.sh / install.ps1): the version comes from
// `<base>/latest`, the checksum from `<base>/<version>/manifest.json`, and a download whose SHA-256
// does not match is thrown away. The official installer cannot target another folder (it always
// installs under ~/.local), so this does the download part itself.
//
// Layout (under ~/.cockpit/claude):
//   versions/<version>/claude[.exe]   the binaries (the last two are kept)
//   current                           symlink to the active binary (not on Windows)
//   current.json                      { version, path } of the active binary (always written)
//
// No VS Code imports: unit-testable, and usable by the daemon later.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RELEASE_BASE_URL = 'https://downloads.claude.ai/claude-code-releases';

const KEEP_VERSIONS = 2;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[^\s]+)?$/;

export interface PlatformInfo {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Linux only: the C library is musl (detected like install.sh does when not given). */
  musl?: boolean;
}

/** The release platform key, e.g. `darwin-arm64`, `linux-x64-musl`, `win32-x64`. */
export function platformKey(info: PlatformInfo = {}): string {
  const platform = info.platform ?? process.platform;
  const arch = (info.arch ?? process.arch) === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return `win32-${arch}`;
  if (platform === 'darwin') return `darwin-${arch}`;
  const musl = info.musl ?? isMusl();
  return `linux-${arch}${musl ? '-musl' : ''}`;
}

function isMusl(): boolean {
  return (
    fs.existsSync('/lib/libc.musl-x86_64.so.1') ||
    fs.existsSync('/lib/libc.musl-aarch64.so.1')
  );
}

/** ~/.cockpit/claude, or `root` when given (tests). */
export function managedRoot(root?: string): string {
  return root ?? path.join(os.homedir(), '.cockpit', 'claude');
}

interface CurrentPointer {
  version: string;
  path: string;
}

function readPointer(root: string): CurrentPointer | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
    if (typeof j?.version === 'string' && typeof j?.path === 'string') return j;
  } catch {
    /* none yet */
  }
  return undefined;
}

/**
 * The path to start the managed CLI from, or undefined when none is installed. On macOS and Linux
 * this is the stable `current` symlink (a path that does not change with the version, which the
 * daemon keeps in its saved sessions); on Windows the versioned binary the pointer names.
 */
export function managedBinaryPath(root?: string): string | undefined {
  const r = managedRoot(root);
  const pointer = readPointer(r);
  if (!pointer || !fs.existsSync(pointer.path)) return undefined;
  if (process.platform === 'win32') return pointer.path;
  const link = path.join(r, 'current');
  return fs.existsSync(link) ? link : pointer.path;
}

export function managedVersion(root?: string): string | undefined {
  const pointer = readPointer(managedRoot(root));
  return pointer && fs.existsSync(pointer.path) ? pointer.version : undefined;
}

export interface InstallOptions {
  /** Pin a version instead of `latest`. */
  version?: string;
  /** Release server; only https is accepted unless `allowInsecure` (tests with a local server). */
  baseUrl?: string;
  allowInsecure?: boolean;
  root?: string;
  platform?: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface InstallResult {
  version: string;
  /** The path to run it from (see managedBinaryPath). */
  path: string;
  /** False when the requested version was already installed. */
  changed: boolean;
}

function checkUrl(url: string, allowInsecure?: boolean): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) {
    throw new Error(`refusing to download over ${u.protocol}`);
  }
}

async function getText(url: string, opts: InstallOptions): Promise<string> {
  checkUrl(url, opts.allowInsecure);
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

/** The newest released version. Rejects anything that does not look like one (an error page). */
export async function latestVersion(opts: Pick<InstallOptions, 'baseUrl' | 'allowInsecure' | 'signal'> = {}): Promise<string> {
  const base = opts.baseUrl ?? RELEASE_BASE_URL;
  const v = await getText(`${base}/latest`, opts);
  if (!VERSION_RE.test(v)) {
    throw new Error('unexpected answer from the release server (not a version)');
  }
  return v;
}

/** Downloads to `file`, returning the SHA-256 of what was written. */
async function download(url: string, file: string, opts: InstallOptions): Promise<string> {
  checkUrl(url, opts.allowInsecure);
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file, { mode: 0o700 });
  let done = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
      opts.onProgress?.(done, total);
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  return hash.digest('hex');
}

/**
 * Installs (or updates to) a version: downloads it next to the existing ones, verifies the checksum
 * from the manifest, and only then points `current` at it. A running process keeps the file it
 * started from, so switching versions never disturbs conversations already running.
 */
export async function installManaged(opts: InstallOptions = {}): Promise<InstallResult> {
  const base = opts.baseUrl ?? RELEASE_BASE_URL;
  const root = managedRoot(opts.root);
  const platform = opts.platform ?? platformKey();
  const version = opts.version ?? (await latestVersion(opts));
  if (!VERSION_RE.test(version)) throw new Error(`invalid version: ${version}`);

  const existing = readPointer(root);
  if (existing && existing.version === version && fs.existsSync(existing.path)) {
    return { version, path: managedBinaryPath(opts.root) ?? existing.path, changed: false };
  }

  const manifest = JSON.parse(await getText(`${base}/${version}/manifest.json`, opts));
  const entry = manifest?.platforms?.[platform];
  const checksum = typeof entry?.checksum === 'string' ? entry.checksum.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`platform ${platform} not found in the manifest`);
  const binaryName = typeof entry.binary === 'string' && entry.binary ? entry.binary : platform.startsWith('win32') ? 'claude.exe' : 'claude';

  const dir = path.join(root, 'versions', version);
  const target = path.join(dir, binaryName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = `${target}.partial`;
  try {
    const actual = await download(`${base}/${version}/${platform}/${binaryName}`, partial, opts);
    if (actual !== checksum) throw new Error('checksum verification failed');
    fs.chmodSync(partial, 0o755);
    fs.renameSync(partial, target);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw e;
  }

  activate(root, version, target);
  prune(root, version);
  return { version, path: managedBinaryPath(opts.root) ?? target, changed: true };
}

/** Points `current` (symlink where possible) and `current.json` at a binary, atomically. */
function activate(root: string, version: string, binary: string): void {
  if (process.platform !== 'win32') {
    const link = path.join(root, 'current');
    const tmp = `${link}.${process.pid}`;
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(binary, tmp);
    fs.renameSync(tmp, link);
  }
  const pointer = path.join(root, 'current.json');
  const tmp = `${pointer}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version, path: binary }), 'utf8');
  fs.renameSync(tmp, pointer);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Keeps the active version and the newest others, up to KEEP_VERSIONS. Best effort. */
function prune(root: string, active: string): void {
  try {
    const dir = path.join(root, 'versions');
    const all = fs.readdirSync(dir).filter((v) => VERSION_RE.test(v));
    all.sort(compareVersions).reverse();
    const keep = new Set([active, ...all.filter((v) => v !== active)].slice(0, KEEP_VERSIONS));
    for (const v of all) {
      if (!keep.has(v)) fs.rmSync(path.join(dir, v), { recursive: true, force: true });
    }
  } catch {
    /* leftovers are harmless */
  }
}

/** True when a newer version than the installed one is available. Network errors read as "no". */
export async function updateAvailable(opts: { root?: string; baseUrl?: string; allowInsecure?: boolean } = {}): Promise<string | undefined> {
  const current = managedVersion(opts.root);
  if (!current) return undefined;
  try {
    const latest = await latestVersion(opts);
    return compareVersions(latest, current) > 0 ? latest : undefined;
  } catch {
    return undefined;
  }
}
