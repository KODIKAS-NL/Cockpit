// Entry point of cockpit-daemon (bundled to dist/daemon.js). Meant to run under launchd:
// logs go to stdout/stderr, SIGTERM stops every CLI and exits cleanly.
//
//   node daemon.js [--socket <path>] [--state <file>] [--idle-stop-hours <n>]
import * as path from 'node:path';
import { Daemon } from './Daemon';
import { daemonHome, defaultSocketPath, expandHome } from './paths';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (msg: string) => process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);

const daemon = new Daemon({
  socketPath: expandHome(arg('--socket') ?? defaultSocketPath()),
  stateFile: expandHome(arg('--state') ?? path.join(daemonHome(), 'sessions.json')),
  idleStopHours: Number(arg('--idle-stop-hours') ?? 0) || 0,
  log,
});

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  void daemon.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

daemon.start().catch((e) => {
  log(`failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
