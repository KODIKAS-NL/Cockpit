// Conta da assinatura via `claude auth status --json` (fonte oficial do CLI).
// Equivalent to the ACCOUNT block of /usage: auth method, e-mail, org and plan.
// Asynchronous so it doesn't block the extension host.
import { spawn } from 'node:child_process';
import { readLoginExpiry } from './AiClient';
import type { UsageAccount } from '../../shared/protocol';

export interface AccountInfo {
  loggedIn: boolean;
  authMethod?: string; // 'claude.ai' | 'console' | …
  apiProvider?: string; // 'firstParty' | …
  email?: string;
  orgName?: string;
  plan?: string; // subscriptionType ('max' | 'pro' | …)
  // Login validity (epoch ms). It does NOT come from `auth status --json` — it is read
  // from ~/.claude/.credentials.json. Used to warn before the login expires (the CLI
  // started warning in 2.1.203) so long/background sessions aren't interrupted.
  loginExpiresAt?: number;
  // Session flags (fast mode, model label, …) filled in later from the statusline cache.
  session?: UsageAccount['session'];
  /** The check failed: the state is not known (never read as logged out). */
  unknown?: true;
  /** Why it failed (no output contents: they can carry the e-mail). */
  error?: string;
}

/**
 * Fetches the account live (hot data). Only the CLI saying `loggedIn: false` means logged out: a
 * check that failed (could not start, timed out, printed no JSON) is `unknown`, and must not
 * turn a signed-in user's button into "Sign in".
 */
export function fetchAuthStatus(claudePath: string, timeoutMs = 8000): Promise<AccountInfo> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (info: AccountInfo) => {
      if (!done) {
        done = true;
        resolve(info);
      }
    };
    const unknown = (error: string): AccountInfo => ({ loggedIn: false, unknown: true, error });
    try {
      const useShell = process.platform === 'win32';
      const exe =
        useShell && /\s/.test(claudePath) && !claudePath.startsWith('"')
          ? `"${claudePath}"`
          : claudePath;
      const p = spawn(exe, ['auth', 'status', '--json'], { shell: useShell, windowsHide: true });
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* noop */
        }
        finish(unknown('timeout'));
      }, timeoutMs);
      let out = '';
      p.stdout?.setEncoding('utf8');
      p.stdout?.on('data', (c: string) => (out += c));
      p.on('error', () => {
        clearTimeout(timer);
        finish(unknown('spawn error'));
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        finish(parse(out) ?? unknown(code ? `exit ${code}, no JSON` : 'unparseable output'));
      });
    } catch {
      finish(unknown('spawn error'));
    }
  });
}

// The JSON object in the output: tolerant of a banner or warning line around it.
function parse(out: string): AccountInfo | undefined {
  const a = out.indexOf('{');
  const b = out.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    const j = JSON.parse(out.slice(a, b + 1));
    if (typeof j?.loggedIn !== 'boolean') return undefined;
    return {
      loggedIn: j.loggedIn,
      authMethod: str(j.authMethod),
      apiProvider: str(j.apiProvider),
      email: str(j.email),
      orgName: str(j.orgName),
      plan: str(j.subscriptionType),
      loginExpiresAt: j.loggedIn ? readLoginExpiry() : undefined,
    };
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
