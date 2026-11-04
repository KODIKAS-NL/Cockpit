// REAL account usage via the Claude OAuth endpoint (the same source as the CLI's /usage).
// GET https://api.anthropic.com/api/oauth/usage — read-only, spends NO tokens.
// Uses the OAuth accessToken from ~/.claude/.credentials.json (read-only; never writes
// nor logs credentials). Short in-memory cache so it isn't repeated on every refresh.
//
// Resilience matters more than freshness here: a single timeout/5xx used to drop the whole
// panel back to the local $ estimate, which is a much worse answer than a real % read a few
// minutes ago. So a failed fetch retries once and then falls back to the last good reading
// while it is still meaningful (STALE_OK_MS).
//
// One reading per MACHINE, not per window. Every window (VS Code, code-server, the Rider
// sidecar) polls on its own and also refreshes at the end of each turn, which is how an
// ordinary day of work earned an HTTP 429 from an endpoint nobody is really hammering. The
// reading is shared through ~/.cockpit/usage-api.json: whoever fetched last serves the others,
// only one process fetches at a time (a lock file), a window that reloads starts from the file
// instead of from nothing, and a 429 backs every window off until the window it asked for.
import * as https from 'node:https';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LimitWindow, ScopedBucket } from '../../shared/protocol';
import { dlog } from '../util/logger';

export interface ApiUsage {
  fiveHour?: LimitWindow; // kind:'session'
  sevenDay?: LimitWindow; // kind:'weekly_all'
  weeklyScoped?: ScopedBucket[]; // kind:'weekly_scoped' (um por modelo escopado)
  ageMs?: number; // >0 when this is a reused reading (the live fetch failed)
}

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const MEM_TTL_MS = 30_000; // in-process cache: a burst of refreshes is one answer
const SHARED_TTL_MS = 5 * 60_000; // how often this MACHINE really asks the API
const FORCE_MIN_MS = 30_000; // floor for a forced read (the Usage button)
const FAIL_TTL_MS = 60_000; // negative cache: a failure repeated every few seconds is what earns a 429
const STALE_OK_MS = 30 * 60_000; // last good reading still usable while the API is unreachable
const LOCK_MS = 20_000; // a fetch lock older than this belonged to a process that died
const BACKOFF_MIN_MS = 60_000; // first 429: wait a minute
const BACKOFF_MAX_MS = 30 * 60_000;
const RETRY_DELAY_MS = 700;

let cache: { at: number; data?: ApiUsage } | undefined;
let lastGood: { at: number; data: ApiUsage } | undefined;
let lastError: string | undefined;
/** Set by a 429 (or its Retry-After): nobody asks again before this. */
let blockedUntil = 0;
let backoffMs = 0;

/** The reading shared by every Cockpit process on this machine. */
interface SharedUsage {
  at: number;
  /** Absent when the file carries only a hold: a 429 before this machine ever had a reading. */
  data?: ApiUsage;
  blockedUntil?: number;
  backoffMs?: number;
}

const sharedFile = (): string => path.join(os.homedir(), '.cockpit', 'usage-api.json');
const lockFile = (): string => path.join(os.homedir(), '.cockpit', 'usage-api.lock');

/** Reads the machine's reading and adopts it when it is newer than the one in hand. */
function adoptShared(): void {
  let j: SharedUsage | undefined;
  try {
    j = JSON.parse(fs.readFileSync(sharedFile(), 'utf8')) as SharedUsage;
  } catch {
    return; // no file yet, or being written right now
  }
  if (!j || typeof j.at !== 'number') return;
  if (j.at > Date.now() + 60_000) return; // a clock that jumped: ignore it
  if (typeof j.blockedUntil === 'number' && j.blockedUntil > blockedUntil) {
    blockedUntil = j.blockedUntil;
    backoffMs = Math.max(backoffMs, Number(j.backoffMs) || 0);
  }
  if (j.data && (!lastGood || j.at > lastGood.at)) lastGood = { at: j.at, data: j.data };
}

function writeShared(): void {
  // Written even with no reading yet: a 429 is worth sharing on its own.
  const body: SharedUsage = { at: lastGood?.at ?? 0, data: lastGood?.data, blockedUntil, backoffMs };
  try {
    fs.mkdirSync(path.dirname(sharedFile()), { recursive: true });
    // Written whole (a reader never sees half a file) and readable only by its owner, as
    // everything under ~/.cockpit. It carries percentages, never a credential.
    const tmp = `${sharedFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, sharedFile());
  } catch {
    /* read-only home, no disk: the in-memory cache still works */
  }
}

/** True when this process may do the fetch: only one at a time, per machine. */
function takeLock(retry = true): boolean {
  const f = lockFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > LOCK_MS && retry) {
        fs.rmSync(f, { force: true });
        return takeLock(false);
      }
    } catch {
      /* gone between the two calls: whoever took it is fetching */
    }
    return false;
  }
}

function dropLock(): void {
  try {
    fs.rmSync(lockFile(), { force: true });
  } catch {
    /* already gone */
  }
}

/** Why the last live fetch failed, how old the reading in hand is, and the 429 hold (diagnostics). */
export function usageDiagnostics(): { lastError?: string; lastGoodAgeMs?: number; retryInMs?: number } {
  const hold = blockedUntil - Date.now();
  return {
    lastError,
    lastGoodAgeMs: lastGood ? Date.now() - lastGood.at : undefined,
    retryInMs: hold > 0 ? hold : undefined,
  };
}

/** The accessToken inside a credentials JSON blob (file or keychain entry). */
function tokenOf(raw: string): string | undefined {
  try {
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

// macOS: the CLI keeps its login in the login keychain, not in the file. A locked keychain
// (SSH / headless session) just yields nothing, so a failed read is not retried for a while.
const KEYCHAIN_RETRY_MS = 60_000;
let keychainFailedAt = 0;

function readKeychainToken(): string | undefined {
  if (process.platform !== 'darwin' || Date.now() - keychainFailedAt < KEYCHAIN_RETRY_MS) return undefined;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tok = tokenOf(out);
    if (!tok) keychainFailedAt = Date.now();
    return tok;
  } catch {
    keychainFailedAt = Date.now();
    return undefined;
  }
}

/** OAuth accessToken (read-only): the credentials file, else the macOS keychain. The server is the authority on validity. */
function readToken(): string | undefined {
  try {
    const tok = tokenOf(fs.readFileSync(CREDS, 'utf8'));
    if (tok) return tok;
  } catch {
    /* no file: try the keychain */
  }
  return readKeychainToken();
}

/** API window ({utilization|percent:0..100, resets_at}) -> LimitWindow (usedPct 0..1). */
function win(w: any): LimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const pct = typeof w.utilization === 'number' ? w.utilization : w.percent;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  const resetsAt = typeof w.resets_at === 'string' ? w.resets_at : undefined;
  return { usedPct: Math.max(0, Math.min(1, pct / 100)), resetsAt };
}

/**
 * Extracts the windows from the payload. Current format: a `limits[]` array with
 * `kind` = session | weekly_all | weekly_scoped, and `scope.model.display_name`
 * naming the model of the scoped window (it used to be fixed `seven_day_opus`/`_sonnet`).
 * Falls back to the legacy top-level fields when `limits[]` is absent.
 */
export function parseUsage(j: any): ApiUsage {
  const out: ApiUsage = {};
  const scoped: ScopedBucket[] = [];
  if (Array.isArray(j?.limits)) {
    for (const l of j.limits) {
      const w = win(l);
      if (!w) continue;
      if (l.kind === 'session') out.fiveHour = w;
      else if (l.kind === 'weekly_all') out.sevenDay = w;
      else if (l.kind === 'weekly_scoped') {
        const label = l?.scope?.model?.display_name;
        if (typeof label === 'string' && label) scoped.push({ ...w, label });
      }
    }
  }
  out.fiveHour ??= win(j?.five_hour);
  out.sevenDay ??= win(j?.seven_day);
  if (!scoped.length) {
    // Legacy: per-model weekly windows in fixed top-level fields.
    for (const [label, key] of [
      ['Opus', 'seven_day_opus'],
      ['Sonnet', 'seven_day_sonnet'],
    ] as const) {
      const w = win(j?.[key]);
      if (w) scoped.push({ ...w, label });
    }
  }
  if (scoped.length) out.weeklyScoped = scoped;
  return out;
}

type Attempt =
  | { ok: true; data: ApiUsage }
  | { ok: false; reason: string; retry: boolean; status?: number; retryAfterMs?: number };

/** `Retry-After`: seconds, or an HTTP date. */
function retryAfterMs(raw: string | string[] | undefined): number | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** One GET. `retry` tells whether the failure is transient (network/timeout/5xx). */
function requestUsage(token: string): Promise<Attempt> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) {
            try {
              resolve({ ok: true, data: parseUsage(JSON.parse(body)) });
            } catch (e) {
              resolve({ ok: false, reason: `bad JSON: ${String(e)}`, retry: false });
            }
            return;
          }
          // 401 = token expired/revoked; the CLI refreshes it — retrying now won't help.
          // 429 is not retried either: asking again is exactly what it is complaining about.
          resolve({
            ok: false,
            reason: `HTTP ${code}`,
            retry: code >= 500,
            status: code,
            retryAfterMs: code === 429 ? retryAfterMs(res.headers?.['retry-after']) : undefined,
          });
        });
      },
    );
    req.on('error', (e) =>
      resolve({ ok: false, reason: `network: ${String((e as Error)?.message || e)}`, retry: true }),
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout (8s)', retry: true });
    });
    req.end();
  });
}

/** Last successful reading, while it is recent enough to still be worth showing. */
function staleFallback(): ApiUsage | undefined {
  if (!lastGood) return undefined;
  const age = Date.now() - lastGood.at;
  if (age > STALE_OK_MS) return undefined;
  return { ...lastGood.data, ageMs: age };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches the real account usage, at most once every SHARED_TTL_MS per MACHINE (FORCE_MIN_MS
 * with `force`, the Usage button). Everything else is served from the reading the last fetch
 * left behind, in memory and in ~/.cockpit/usage-api.json, so a second window costs nothing.
 * On failure it retries once (transient causes only) and then reuses the last good reading;
 * it returns undefined only when there is no usable real data at all.
 */
export async function fetchAccountUsage(force = false): Promise<ApiUsage | undefined> {
  const now = Date.now();
  if (cache && !force) {
    const age = now - cache.at;
    if (age < (cache.data ? MEM_TTL_MS : FAIL_TTL_MS)) return cache.data ?? staleFallback();
  }
  // What another window read counts as ours: that is the whole point of the shared file.
  adoptShared();
  const age = lastGood ? now - lastGood.at : Infinity;
  if (age < (force ? FORCE_MIN_MS : SHARED_TTL_MS)) {
    cache = { at: now, data: lastGood!.data };
    return lastGood!.data;
  }
  if (now < blockedUntil) {
    // Rate-limited: asking again before the window it gave us only pushes it further out.
    return staleFallback();
  }
  const token = readToken();
  if (!token) {
    lastError = 'no OAuth accessToken (~/.claude/.credentials.json or the macOS keychain)';
    dlog('usage-api', lastError);
    cache = { at: now, data: undefined };
    return staleFallback();
  }
  if (!takeLock()) {
    // Another window is fetching right now; its answer lands in the shared file in a moment.
    dlog('usage-api', 'another process is fetching: using the shared reading');
    return staleFallback();
  }
  let last: Attempt = { ok: false, reason: 'not attempted', retry: false };
  try {
    for (let i = 0; i < 2; i++) {
      if (i > 0) await sleep(RETRY_DELAY_MS);
      last = await requestUsage(token);
      if (last.ok || !last.retry) break;
      dlog('usage-api', `attempt ${i + 1} failed (${last.reason})`);
    }
  } finally {
    dropLock();
  }
  if (last.ok) {
    lastError = undefined;
    blockedUntil = 0;
    backoffMs = 0;
    lastGood = { at: Date.now(), data: last.data };
    cache = { at: Date.now(), data: last.data };
    writeShared();
    return last.data;
  }
  if (last.status === 429) {
    // Exponential, and never shorter than what the server asked for. Written to the shared
    // file so every other window on this machine holds off too.
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
    blockedUntil = Date.now() + Math.max(backoffMs, last.retryAfterMs ?? 0);
    writeShared();
    dlog('usage-api', `rate limited: holding off for ${Math.round((blockedUntil - Date.now()) / 1000)}s`);
  }
  lastError = last.reason;
  dlog('usage-api', `giving up: ${last.reason}`);
  cache = { at: Date.now(), data: undefined };
  return staleFallback();
}

/** Test helper: drops every cached state. */
export function resetUsageCache(): void {
  cache = undefined;
  lastGood = undefined;
  lastError = undefined;
  blockedUntil = 0;
  backoffMs = 0;
  try {
    fs.rmSync(sharedFile(), { force: true });
    fs.rmSync(lockFile(), { force: true });
  } catch {
    /* nothing to drop */
  }
}
