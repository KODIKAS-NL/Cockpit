// Wire protocol between cockpit-daemon and its clients (the extension host of each window).
//
// Transport: newline-delimited JSON over a Unix socket (default ~/.cockpit/daemon.sock,
// mode 0600). Client messages carry `op`; daemon messages carry `type`. Requests that
// expect an answer carry a `reqId` the reply echoes.
//
// The daemon relays the CLI's own stream-json lines unchanged: it never interprets a
// conversation, it only keeps what a newly attached window needs to catch up (see
// SessionSnapshot). The conversation history itself comes from the CLI's transcript
// (~/.claude/projects/<cwd>/<id>.jsonl), as it always did.

export const DAEMON_PROTOCOL_VERSION = 1;

export type DaemonSessionState = 'busy' | 'running' | 'idle';

export interface DaemonSessionInfo {
  /** The daemon's own id for the session (stable while the daemon keeps it). */
  id: string;
  /** Working directory as the client sent it. */
  cwd: string;
  /** Normalized working directory (realpath, no trailing separator): the matching key. */
  cwdKey: string;
  /** The CLI's session id (the transcript name). Known after `--resume` or the first init. */
  cliSessionId?: string;
  /** First line of the first prompt, for lists. */
  title?: string;
  /** busy = a turn is running; running = process up and idle; idle = no process. */
  state: DaemonSessionState;
  /** Permission prompts / questions waiting for an answer. */
  pendingPrompts: number;
  /** Number of windows attached right now. */
  clients: number;
  lastActivity: number;
  createdAt: number;
  /** Remote Control's bridge is on for this session (phone / claude.ai/code share it). */
  remote?: { on: boolean; url?: string };
}

/**
 * How to start the CLI. The client builds the argument list (it owns the settings); the
 * daemon only runs it. Files the CLI must read are sent as contents: an argument equal to
 * `@file:<name>` is replaced by the path of a file the daemon writes with `files[name]`.
 */
export interface SpawnSpec {
  claudePath: string;
  args: string[];
  /** Added to the daemon's own environment (which carries PATH from the service). */
  env?: Record<string, string>;
  files?: Record<string, string>;
}

/** What a window gets when it attaches, to catch up with a session already running. */
export interface SessionSnapshot {
  session: DaemonSessionInfo;
  /**
   * Events since the last complete message (assistant/user): the deltas of the message
   * being written right now. Everything before that is in the transcript already.
   */
  partial: unknown[];
  /** `control_request`s from the CLI nobody has answered yet, in arrival order. */
  pendingControl: unknown[];
}

export type ClientMessage =
  | { op: 'hello'; clientId: string; version: number }
  | { op: 'list'; reqId: string; cwd?: string }
  /**
   * Attach to the session of this CLI session id in this folder, starting it when it is not
   * running; or create a new one when `cliSessionId` is absent or unknown. Answered with
   * `snapshot`, after which the client receives the session's events.
   */
  | { op: 'open'; reqId: string; cwd: string; cliSessionId?: string; spawn: SpawnSpec }
  | { op: 'detach'; sessionId: string }
  /** Turns Remote Control on/off inside the session's own process. Answered with `remote_result`. */
  | { op: 'remote'; sessionId: string; on: boolean; reqId: string }
  /** One JSON line for the CLI's stdin (the same objects the CLI's stream-json takes). */
  | { op: 'send'; sessionId: string; msg: Record<string, unknown> }
  /** Ends the CLI process; the session stays listed (idle) and restarts on the next send. */
  | { op: 'stop'; sessionId: string }
  /** Ends the process and drops the session from the daemon's list. */
  /**
   * With a `reqId` the daemon answers `forgotten` once the process has really exited: the CLI
   * writes to its transcript while it shuts down, so a caller about to delete that file must
   * wait for it.
   */
  | { op: 'forget'; sessionId: string; reqId?: string };

export type DaemonMessage =
  | { type: 'hello_ok'; version: number; pid: number }
  | { type: 'sessions'; reqId: string; sessions: DaemonSessionInfo[] }
  | { type: 'forgotten'; reqId: string }
  | { type: 'snapshot'; reqId: string; snapshot: SessionSnapshot }
  | { type: 'event'; sessionId: string; event: unknown }
  /** Another window answered this prompt: close it here. */
  | { type: 'control_settled'; sessionId: string; requestId: string }
  /** Another window sent this prompt: show it, the turn is now running. */
  | { type: 'remote_user'; sessionId: string; message: unknown; uuid?: string }
  /** Answers the window's own `remote` op (not broadcast: only that window gets it). */
  | { type: 'remote_result'; sessionId: string; reqId: string; ok: boolean; url?: string; error?: string }
  /** Remote Control's bridge state, to every window: on/off, and the pairing link once known. */
  | { type: 'remote_state'; sessionId: string; on: boolean; url?: string }
  | { type: 'exit'; sessionId: string; code: number | null }
  | { type: 'stderr'; sessionId: string; text: string }
  | { type: 'error'; reqId?: string; sessionId?: string; message: string };

/** Placeholder prefix for files in SpawnSpec.args. */
export const FILE_ARG_PREFIX = '@file:';
