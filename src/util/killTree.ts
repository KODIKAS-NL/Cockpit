// Ending an engine process together with everything it started (subagents, tools).
// Shared by the extension host (CliProcessManager) and cockpit-daemon, both of which spawn
// `claude` detached so it leads its own process group.

/**
 * Ends the tree of a detached process outside Windows. `process.kill(-pid)`
 * signals the WHOLE GROUP (leader + children). SIGTERM first (clean exit) and,
 * if something persists, SIGKILL after a grace period. Tolerant to ESRCH (already dead).
 */
export function killGroup(pid: number, graceMs = 2000): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM'); // no group (rare): at least kills the leader
    } catch {
      /* already ended */
    }
  }
  const t = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already ended */
    }
  }, graceMs);
  t.unref?.(); // doesn't hold the event loop
}
