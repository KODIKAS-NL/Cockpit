#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the
// daemon tests. It speaks just enough of the protocol:
//  - `initialize` control_request → control_response with a command list;
//  - a user message → system/init (first time), then a reply; text containing
//      ASK  → a can_use_tool prompt first, the reply only after it is answered
//      SLOW → partial deltas, a pause, then the reply
//  - one turn at a time, like the real CLI: a user message arriving mid-turn waits in a queue
//    and runs as the next turn; with --replay-user-messages each one is echoed back
//    (`isReplay: true`, its `uuid`) when its turn starts;
//  - `interrupt` → ends the running turn with an error result, keeps the queue;
//    `get_context_usage` → a small answer; `set_model`, `set_permission_mode` and
//    `apply_flag_settings` → success (recorded in the log like every line);
//  - a text containing EXITPLAN reports a switch to the default mode mid-turn
//    (`system/status` with `permissionMode`), as the CLI does when a plan is approved;
//  - `remote_control` {enabled} → success with a pairing link; once on, a prompt typed on the
//    phone (`PHONE` in $FAKE_PHONE) starts a turn that no window sent, as a plain user event;
//  - `FAKE_RC_FLAKY=<path>` makes the first `remote_control` enable after a good one fail once;
//  - an allow answer carrying a `setMode` update reports that mode (`system/status`);
//  - a text containing CRASH ends the process with code 3, mid-turn;
//  - `FAKE_EXIT_IF=<path>`: exits with code 3 at start while that file exists (a CLI that keeps crashing).
// Every line it receives is appended to $FAKE_LOG (argv first), so tests can check what
// actually reached the CLI.
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const logFile = process.env.FAKE_LOG;
const record = (obj) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(obj) + '\n');
};
record({ argv: process.argv.slice(2), cwd: process.cwd(), env: { FAKE_FLAG: process.env.FAKE_FLAG, DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT } });

if (process.env.FAKE_EXIT_IF && fs.existsSync(process.env.FAKE_EXIT_IF)) process.exit(3);

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const resumeAt = process.argv.indexOf('--resume');
const sessionId = resumeAt >= 0 ? process.argv[resumeAt + 1] : `sess-${process.pid}`;
const replay = process.argv.includes('--replay-user-messages');
let initSent = false;
let waitingPerm = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queue = [];
let running = false;
let interrupted = false;

function reply(text) {
  out({ type: 'assistant', message: { id: `m-${Date.now()}`, role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0 });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record(msg);
  if (msg.type === 'control_request') {
    const sub = msg.request?.subtype;
    if (sub === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [{ name: 'help' }] } } });
    } else if (sub === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: queue.map((m) => m.uuid) } } });
      if (running) interrupted = true;
      else out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted' });
    } else if (sub === 'get_context_usage') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { used: 42 } } });
    } else if (sub === 'set_permission_mode') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode: msg.request.mode } } });
      out({ type: 'system', subtype: 'status', status: null, permissionMode: msg.request.mode });
    } else if (sub === 'remote_control') {
      const on = msg.request.enabled === true;
      // $FAKE_RC_FLAKY=<path>: the first enable after a successful one fails (a CLI not ready yet).
      const flaky = process.env.FAKE_RC_FLAKY;
      if (on && flaky) {
        if (fs.existsSync(`${flaky}.ok`) && !fs.existsSync(`${flaky}.failed`)) {
          fs.writeFileSync(`${flaky}.failed`, '1');
          out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'bridge not ready' } });
          return;
        }
        fs.writeFileSync(`${flaky}.ok`, '1');
      }
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: on ? { session_url: `https://claude.ai/code/${sessionId}`, environment_id: 'env-1' } : {},
        },
      });
      if (on && process.env.FAKE_PHONE) {
        await sleep(100);
        out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: process.env.FAKE_PHONE }] } });
        await sleep(100);
        reply('from the phone');
      }
    } else if (sub === 'set_model' || sub === 'apply_flag_settings') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    }
    return;
  }
  if (msg.type === 'control_response') {
    if (waitingPerm && msg.response?.request_id === waitingPerm.id) {
      const done = waitingPerm.done;
      waitingPerm = null;
      for (const u of msg.response.response?.updatedPermissions ?? []) {
        if (u.type === 'setMode') out({ type: 'system', subtype: 'status', status: null, permissionMode: u.mode });
      }
      done(msg.response.response);
    }
    return;
  }
  if (msg.type === 'user') {
    queue.push(msg);
    if (!running) void drain();
  }
});

async function drain() {
  running = true;
  while (queue.length) await turn(queue.shift());
  running = false;
}

async function turn(msg) {
  if (replay) out({ type: 'user', uuid: msg.uuid, isReplay: true, message: msg.message });
  if (!initSent) {
    initSent = true;
    out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', slash_commands: ['help'] });
  }
  const text = msg.message?.content?.find?.((b) => b.type === 'text')?.text ?? '';
  if (text.includes('CRASH')) process.exit(3);
  if (text.includes('EXITPLAN')) {
    out({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
    await sleep(150);
    reply('executing the plan');
    return;
  }
  if (text.includes('ASK')) {
    const id = `perm-${Date.now()}`;
    const decision = await new Promise((done) => {
      waitingPerm = { id, done };
      out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    });
    reply(`decided ${decision?.behavior}`);
    return;
  }
  if (text.includes('SLOW')) {
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm-slow' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'half' } } });
    for (let i = 0; i < 8 && !interrupted; i++) await sleep(50);
    if (interrupted) {
      interrupted = false;
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted' });
      return;
    }
    reply('slow done');
    return;
  }
  reply(`echo ${text}`);
}
rl.on('close', () => process.exit(0));
