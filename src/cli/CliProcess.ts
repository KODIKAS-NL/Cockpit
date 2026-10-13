// The surface Session uses to talk to an engine process, whoever owns it.
//
// Two implementations:
//  - CliProcessManager: spawns the CLI as a child of the extension host (the original mode).
//  - RemoteCliProcess:  the process lives in cockpit-daemon and survives the window; this
//    class relays the same JSON lines over a Unix socket.
//
// Events (EventEmitter): 'event' (ClaudeEvent), 'exit' (code|null), 'stderr' (text).
// RemoteCliProcess adds 'snapshot', 'settled', 'rejected' and 'remoteUser' (see there).
import type { EventEmitter } from 'node:events';

export interface CliProcess extends EventEmitter {
  start(): void;
  isRunning(): boolean;
  setResumeId(id: string): void;
  sendUserMessage(text: string, images?: { mediaType: string; data: string }[]): void;
  sendControlResponse(requestId: string, response: Record<string, unknown>): void;
  requestControl(subtype: string, timeoutMs?: number): Promise<unknown>;
  interrupt(): void;
  /** Ends the engine process. The next message starts it again (with --resume). */
  stop(): void;
  /**
   * Lets go of the process WITHOUT ending it, when something else keeps it alive (the
   * daemon). For a process the extension host owns, there is nothing to let go of: it stops.
   */
  detach(): void;
  /** True when the process outlives this window (daemon mode). */
  readonly persistent: boolean;
}
