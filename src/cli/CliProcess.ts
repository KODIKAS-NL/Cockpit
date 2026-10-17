// The surface Session uses to talk to an engine process, whoever owns it.
//
// Two implementations:
//  - CliProcessManager: spawns the CLI as a child of the extension host (the Tootega engine's agent).
//  - RemoteCliProcess:  the process lives in cockpit-daemon and survives the window; this
//    class relays the same JSON lines over a Unix socket.
//
// Events (EventEmitter): 'event' (ClaudeEvent), 'exit' (code|null, reason?: 'stopped' | 'daemon' — the daemon stopped it on request / went away), 'stderr' (text).
// RemoteCliProcess adds 'snapshot', 'settled' and 'remoteUser' (see there).
import type { EventEmitter } from 'node:events';
import type { CliOptions } from './CliProcessManager';

export interface CliProcess extends EventEmitter {
  start(): void;
  isRunning(): boolean;
  setResumeId(id: string): void;
  /** `uuid`: with --replay-user-messages the CLI echoes it back when it takes the message in. */
  sendUserMessage(text: string, images?: { mediaType: string; data: string }[], uuid?: string): void;
  sendControlResponse(requestId: string, response: Record<string, unknown>): void;
  /** `payload`: the request's other fields (`set_model` → `{ model }`). */
  requestControl(subtype: string, timeoutMs?: number, payload?: Record<string, unknown>): Promise<unknown>;
  interrupt(): void;
  /** Ends the engine process. The next message starts it again (with --resume). */
  stop(): void;
  /**
   * Lets go of the process WITHOUT ending it, when something else keeps it alive (the
   * daemon). For a process the extension host owns, there is nothing to let go of: it stops.
   */
  detach(): void;
  /**
   * Settings switched live (model, effort, permission mode) that a later restart must keep.
   * Only the daemon restarts on its own; the Tootega process is respawned from these options.
   */
  updateOptions?(patch: Partial<CliOptions>): void;
  /** True when the process outlives this window (the daemon's). */
  readonly persistent: boolean;
}
