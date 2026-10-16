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
//    `get_context_usage` → a small answer.
// Every line it receives is appended to $FAKE_LOG (argv first), so tests can check what
// actually reached the CLI.
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const logFile = process.env.FAKE_LOG;
const record = (obj) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(obj) + '\n');
};
record({ argv: process.argv.slice(2), cwd: process.cwd(), env: { FAKE_FLAG: process.env.FAKE_FLAG } });

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
    }
    return;
  }
  if (msg.type === 'control_response') {
    if (waitingPerm && msg.response?.request_id === waitingPerm.id) {
      const done = waitingPerm.done;
      waitingPerm = null;
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
