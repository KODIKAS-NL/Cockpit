// Where lines go is the host's business: VS Code installs an OutputChannel, another editor its own
// log. Until a sink is installed, lines are held (bounded) and replayed to the first sink.
export type LogSink = (line: string) => void;

let sink: LogSink | undefined;
const pending: string[] = [];
const PENDING_MAX = 500;

export function setLogSink(fn: LogSink): void {
  sink = fn;
  for (const line of pending.splice(0)) fn(line);
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (sink) {
    sink(line);
    return;
  }
  pending.push(line);
  if (pending.length > PENDING_MAX) pending.shift();
}

// Detailed diagnostic log: only writes when the flag is on (cockpitDaemon.debugLog).
// The flag lives in memory (set in activate and in onDidChangeConfiguration) so
// dlog doesn't hit the VSCode API on every call — and doesn't break tests.
let debugEnabled = false;

export function setDebugLogging(on: boolean): void {
  debugEnabled = on;
}

export function isDebugLogging(): boolean {
  return debugEnabled;
}

/** Structured debug line `[scope] msg`, only when debugLog is on. */
export function dlog(scope: string, msg: string): void {
  if (debugEnabled) log(`[${scope}] ${msg}`);
}
