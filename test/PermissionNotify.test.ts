// A permission card is also offered to the host (which may raise a native notification when the
// chat is not in view). The host answers through decideFromHost, which closes the chat card too.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CliOptions } from '../src/cli/CliProcessManager';

const { spawns, MockCli } = vi.hoisted(() => {
  const spawns: any[] = [];
  class MockCli {
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    control: { requestId: string; response: any }[] = [];
    constructor(public opts: CliOptions) {
      spawns.push(this);
    }
    on(ev: string, cb: (...a: any[]) => void) {
      const arr = this.handlers.get(ev) ?? [];
      arr.push(cb);
      this.handlers.set(ev, arr);
      return this;
    }
    start() {}
    sendUserMessage() {}
    setResumeId() {}
    interrupt() {}
    stop() {}
    sendControlResponse(requestId: string, response: any) {
      this.control.push({ requestId, response });
    }
    emit(ev: string, ...a: any[]) {
      for (const cb of this.handlers.get(ev) ?? []) cb(...a);
    }
    firePermission(requestId: string, tool: string, input: unknown = {}, suggestions?: unknown[]) {
      this.emit('event', {
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: tool,
          input,
          permission_suggestions: suggestions,
        },
      });
    }
  }
  return { spawns, MockCli };
});

vi.mock('../src/cli/RemoteCliProcess', () => ({ RemoteCliProcess: MockCli }));
vi.mock('../src/stats/StatsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/stats/StatsStore')>()),
  loadStats: () => undefined,
  saveStats: () => {},
}));

import { Session, type SessionHooks } from '../src/session/Session';

let emitted: any[] = [];
let prompts: any[] = [];
let closed: string[] = [];

function makeSession(): Session {
  const hooks: SessionHooks = {
    emit: (m: any) => {
      emitted.push(m);
    },
    onBusy: () => {},
    onResult: () => {},
    onInteraction: () => {},
    onInit: () => {},
    onAuthRequired: () => {},
    onPermissionPrompt: (p) => prompts.push(p),
    onPromptClosed: (id) => closed.push(id),
    fileText: () => undefined,
    claudePath: () => 'claude',
    cwd: () => '/tmp/proj',
    settings: () => ({ model: 'default', effort: 'default', permission: 'default', allowAgents: true }),
    askLanguage: () => 'en',
    extraSystemPrompt: () => undefined,
    quietPrompt: () => undefined,
    daemon: () => ({}) as never,
  };
  return new Session(hooks);
}

describe('Permission prompts offered to the host', () => {
  beforeEach(() => {
    spawns.length = 0;
    emitted = [];
    prompts = [];
    closed = [];
  });

  it('offers a command with its first line, and says whether "always" exists', () => {
    const s = makeSession();
    s.send('go');
    spawns[0].firePermission('r1', 'Bash', { command: 'ls -la\nrm -rf build' }, [{ type: 'addRules' }]);

    expect(prompts).toEqual([{ requestId: 'r1', title: 'Bash', detail: 'ls -la', canAlways: true }]);
    expect(s.hasPendingPermission('r1')).toBe(true);
  });

  it('shows the file for a file tool, and no "always" without a suggestion', () => {
    const s = makeSession();
    s.send('go');
    spawns[0].firePermission('r1', 'Write', { file_path: '/tmp/proj/a.txt', content: 'x' });

    expect(prompts[0]).toMatchObject({ detail: '/tmp/proj/a.txt', canAlways: false });
  });

  it('does not offer a question (AskUserQuestion), only permissions', () => {
    const s = makeSession();
    s.send('go');
    spawns[0].firePermission('r1', 'AskUserQuestion', { questions: [] });

    expect(prompts).toHaveLength(0);
  });

  it('answering from the host answers the CLI and closes the chat card', () => {
    const s = makeSession();
    s.send('go');
    spawns[0].firePermission('r1', 'Bash', { command: 'ls' });
    s.decideFromHost('r1', 'allow');

    expect(spawns[0].control[0]).toMatchObject({ requestId: 'r1', response: { behavior: 'allow' } });
    expect(emitted.some((m) => m.kind === 'promptSettled' && m.requestId === 'r1')).toBe(true);
    expect(s.hasPendingPermission('r1')).toBe(false);
    expect(closed).toContain('r1');
  });

  it('tells the host when the chat answers first', () => {
    const s = makeSession();
    s.send('go');
    spawns[0].firePermission('r1', 'Bash', { command: 'ls' });
    s.decide('r1', 'deny');

    expect(closed).toEqual(['r1']);
  });

  it('knows when any prompt, a permission or a question, is waiting', () => {
    const s = makeSession();
    s.send('go');
    expect(s.hasPendingPrompt()).toBe(false);

    spawns[0].firePermission('r1', 'AskUserQuestion', { questions: [] });
    expect(s.hasPendingPrompt()).toBe(true);

    spawns[0].firePermission('r2', 'Bash', { command: 'ls' });
    s.decide('r2', 'allow');
    expect(s.hasPendingPrompt()).toBe(true); // the question is still waiting
  });
});
