// Regression: session continuity vs. context duplication.
// The CLI creates a NEW .jsonl whenever it starts WITHOUT --resume. So, after a stop()
// (a setting the CLI only reads at start) the respawn must resume the SAME session.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CliOptions } from '../src/cli/CliProcessManager';

// Each mocked CLI instance records the options it was created with (in particular
// resumeSessionId) and exposes the handlers so we can simulate the `init`/`exit` event.
// vi.hoisted: the vi.mock factory is hoisted above the module definitions.
const { spawns, MockCli } = vi.hoisted(() => {
  const spawns: any[] = [];
  class MockCli {
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    sent: string[] = [];
    controls: { subtype: string; payload?: Record<string, unknown> }[] = [];
    started = false;
    stopped = false;
    persistent = true;
    autoCompact?: string;
    constructor(public opts: CliOptions) {
      spawns.push(this);
    }
    on(ev: string, cb: (...a: any[]) => void) {
      const arr = this.handlers.get(ev) ?? [];
      arr.push(cb);
      this.handlers.set(ev, arr);
      return this;
    }
    start() {
      this.started = true;
    }
    hasPendingCompact() {
      return false;
    }
    setAutoCompact(v: string) {
      this.autoCompact = v;
    }
    setRemote() {
      return Promise.resolve({ ok: true });
    }
    whenAttached() {
      return Promise.resolve();
    }
    detach() {
      this.stopped = true;
    }
    sendUserMessage(text: string) {
      this.sent.push(text);
    }
    setResumeId(id: string) {
      if (id) this.opts.resumeSessionId = id;
    }
    isRunning() {
      return this.started && !this.stopped;
    }
    requestControl(subtype: string, _timeout?: number, payload?: Record<string, unknown>) {
      this.controls.push({ subtype, payload });
      return Promise.resolve({});
    }
    interrupt() {}
    stop() {
      this.stopped = true;
    }
    emit(ev: string, ...a: any[]) {
      for (const cb of this.handlers.get(ev) ?? []) cb(...a);
    }
    /** Simulates the `system/init` the CLI emits with the resolved session_id. */
    fireInit(sessionId: string) {
      this.emit('event', { type: 'system', subtype: 'init', session_id: sessionId, slash_commands: [] });
    }
  }
  return { spawns, MockCli };
});

// Claude runs through RemoteCliProcess (the daemon's client): the mock stands in for it.
vi.mock('../src/cli/RemoteCliProcess', () => ({ RemoteCliProcess: MockCli }));
// No disk side effects in the test (keeps the other exports real).
vi.mock('../src/stats/StatsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/stats/StatsStore')>()),
  loadStats: () => undefined,
  saveStats: () => {},
}));

import { Session, type SessionHooks } from '../src/session/Session';

function makeSession(emit: SessionHooks['emit'] = () => {}): Session {
  const hooks: SessionHooks = {
    emit,
    onBusy: () => {},
    onResult: () => {},
    onInteraction: () => {},
    onInit: () => {},
    onAuthRequired: () => {},
    fileText: () => undefined,
    claudePath: () => 'claude',
    cwd: () => '/tmp/proj',
    settings: () => ({ model: 'default', effort: 'default', permission: 'default', allowAgents: true }),
    askLanguage: () => 'en',
    extraSystemPrompt: () => extraPrompt,
    quietPrompt: () => quietPrompt,
    daemon: () => ({}) as never,
  };
  return new Session(hooks);
}

// Texto de system prompt devolvido pelo hook (as settings, no host real).
let extraPrompt: string | undefined;
// Diretiva quiet devolvida pelo hook (campo próprio nas settings).
let quietPrompt: string | undefined;

describe('Session — continuidade de contexto (anti-duplicação)', () => {
  beforeEach(() => {
    spawns.length = 0;
  });

  it('respawn após uma troca que reinicia retoma a MESMA sessão (não duplica)', () => {
    const s = makeSession();
    s.send('primeiro prompt');
    expect(spawns).toHaveLength(1);
    expect(spawns[0].opts.resumeSessionId).toBeUndefined(); // first spawn: new session

    spawns[0].fireInit('sess-A'); // CLI revela o id

    s.setAllowAgents(false); // stop() descarta o CLI
    s.send('segundo prompt'); // respawn

    expect(spawns).toHaveLength(2);
    expect(spawns[1].opts.resumeSessionId).toBe('sess-A'); // CONTINUA sess-A
  });

  it('model, effort and permission mode switch in the running process, without a respawn', () => {
    const s = makeSession();
    s.send('p');
    spawns[0].fireInit('sess-A');

    s.setModel('claude-opus-4-8');
    s.setEffort('high');
    s.setPermission('plan');
    s.send('p2');

    expect(spawns).toHaveLength(1);
    expect(spawns[0].controls).toEqual([
      { subtype: 'set_model', payload: { model: 'claude-opus-4-8' } },
      { subtype: 'apply_flag_settings', payload: { settings: { effortLevel: 'high' } } },
      { subtype: 'set_permission_mode', payload: { mode: 'plan' } },
    ]);
  });

  it('a refused live switch while idle falls back to a respawn with the new model', async () => {
    const s = makeSession();
    s.send('p', undefined, 'u1');
    spawns[0].fireInit('sess-A');
    spawns[0].emit('event', { type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: 'p' } }); // taken in
    spawns[0].emit('event', { type: 'result', subtype: 'success', usage: {} }); // the turn is over
    spawns[0].requestControl = () => Promise.resolve(undefined);

    s.setModel('claude-opus-4-8');
    await new Promise((r) => setTimeout(r, 0));
    s.send('p2');

    expect(spawns).toHaveLength(2);
    expect(spawns[1].opts.model).toBe('claude-opus-4-8');
    expect(spawns[1].opts.resumeSessionId).toBe('sess-A');
  });

  it('a refused live switch mid-turn leaves the turn alone and restarts after it', async () => {
    const s = makeSession();
    s.send('p', undefined, 'u1');
    spawns[0].fireInit('sess-A');
    spawns[0].emit('event', { type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: 'p' } }); // taken in
    spawns[0].requestControl = () => Promise.resolve(undefined);

    s.setModel('claude-opus-4-8');
    await new Promise((r) => setTimeout(r, 0));
    expect(spawns[0].stopped).toBe(false); // the turn keeps running

    spawns[0].emit('event', { type: 'result', subtype: 'success', usage: {} });
    expect(spawns[0].stopped).toBe(true);
    s.send('p2');
    expect(spawns).toHaveLength(2);
    expect(spawns[1].opts.model).toBe('claude-opus-4-8');
    expect(spawns[1].opts.resumeSessionId).toBe('sess-A');
  });

  it('stopping mid-message closes the message, so no caret is left blinking', () => {
    const emitted: any[] = [];
    const s = makeSession((m) => emitted.push(m));
    s.send('p');
    spawns[0].fireInit('sess-A');
    spawns[0].emit('event', {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm-1', role: 'assistant' } },
    });
    s.stop();
    expect(emitted.some((m) => m.kind === 'assistantDone' && m.id === 'm-1')).toBe(true);
  });

  it('a mode the CLI switched to reaches the process options kept for a restart', () => {
    const s = makeSession();
    s.send('p');
    spawns[0].fireInit('sess-A');
    spawns[0].updated = [];
    spawns[0].updateOptions = (patch: any) => spawns[0].updated.push(patch);
    spawns[0].emit('event', { type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' });
    expect(spawns[0].updated.at(-1)).toMatchObject({ permissionMode: 'acceptEdits' });
  });

  it('a conversation deleted elsewhere is let go: the next message starts a new one', () => {
    const s = makeSession();
    s.send('p');
    spawns[0].fireInit('sess-A');
    spawns[0].emit('gone');
    s.send('again');
    expect(spawns).toHaveLength(2);
    expect(spawns[1].opts.resumeSessionId).toBeUndefined();
  });

  it('a prompt still open when the process exits is closed', () => {
    const emitted: any[] = [];
    const s = makeSession((m) => emitted.push(m));
    s.send('p');
    spawns[0].fireInit('sess-A');
    spawns[0].emit('event', {
      type: 'control_request',
      request_id: 'perm-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' },
    });
    expect(s.hasPendingPermission('perm-1')).toBe(true);

    spawns[0].emit('exit', 1);

    expect(s.hasPendingPermission('perm-1')).toBe(false);
    expect(emitted).toContainEqual({ kind: 'promptSettled', requestId: 'perm-1' });
  });

  it('clearConversation começa uma sessão realmente nova (sem --resume)', () => {
    const s = makeSession();
    s.send('prompt');
    spawns[0].fireInit('sess-A');

    s.clearConversation();
    s.send('nova conversa');

    expect(spawns[1].opts.resumeSessionId).toBeUndefined(); // doesn't resume the old one
  });
});

describe('Session — texto extra no system prompt', () => {
  beforeEach(() => {
    spawns.length = 0;
    extraPrompt = undefined;
    quietPrompt = undefined;
  });

  it('não passa nada quando está desligado', () => {
    const s = makeSession();
    s.send('p');
    expect(spawns[0].opts.extraSystemPrompt).toBeUndefined();
  });

  // Vale em TODO spawn: se saísse no respawn, a diretiva sumiria no meio da conversa.
  it('acompanha o respawn da MESMA sessão', () => {
    extraPrompt = 'DIRETIVA DE SHELL';
    const s = makeSession();
    s.send('p');
    spawns[0].fireInit('sess-A');
    expect(spawns[0].opts.extraSystemPrompt).toBe('DIRETIVA DE SHELL');

    s.setAllowAgents(false); // respawn
    s.send('p2');
    expect(spawns[1].opts.extraSystemPrompt).toBe('DIRETIVA DE SHELL');
    expect(spawns[1].opts.resumeSessionId).toBe('sess-A');
  });

  // O campo quiet é independente do texto do usuário: vazio não injeta, preenchido
  // acompanha todo spawn (senão a regra sumiria no meio da conversa, como a de shell).
  it('quiet vazio não passa nada; preenchido acompanha o respawn', () => {
    const s1 = makeSession();
    s1.send('p');
    expect(spawns[0].opts.quietPrompt).toBeUndefined();

    quietPrompt = 'SEM NARRAÇÃO';
    const s2 = makeSession();
    s2.send('p');
    spawns[1].fireInit('sess-B');
    expect(spawns[1].opts.quietPrompt).toBe('SEM NARRAÇÃO');

    s2.setAllowAgents(false); // respawn
    s2.send('p2');
    expect(spawns[2].opts.quietPrompt).toBe('SEM NARRAÇÃO');
  });
});

describe('Session — background tasks', () => {
  beforeEach(() => {
    spawns.length = 0;
  });

  const setup = () => {
    const emitted: any[] = [];
    const s = makeSession((m) => emitted.push(m));
    s.send('p');
    const lists = () => emitted.filter((m) => m.kind === 'background').map((m) => m.tasks.map((t: any) => t.id));
    const toolUse = (id: string, input: Record<string, unknown>) =>
      spawns[0].emit('event', {
        type: 'assistant',
        message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] },
      });
    const started = (taskId: string, toolUseId: string) =>
      spawns[0].emit('event', { type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, task_type: 'local_bash', description: 'cmd' });
    const result = (toolUseId: string) =>
      spawns[0].emit('event', {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
      });
    spawns[0].fireInit('sess-A');
    return { emitted, lists, toolUse, started, result };
  };

  it('does not list the tool call that is running in the turn', () => {
    const { lists, toolUse, started } = setup();
    toolUse('t1', { command: 'ls' });
    started('task-1', 't1');
    expect(lists().every((l) => l.length === 0)).toBe(true);
  });

  it('lists it once its result is in and the task goes on', () => {
    const { lists, toolUse, started, result } = setup();
    toolUse('t1', { command: 'sleep 100' });
    started('task-1', 't1');
    result('t1');
    expect(lists().pop()).toEqual(['task-1']);
  });

  it('lists a run_in_background task right away', () => {
    const { lists, toolUse, started, result } = setup();
    toolUse('t2', { command: 'sleep 100', run_in_background: true });
    result('t2');
    started('task-2', 't2');
    expect(lists().pop()).toEqual(['task-2']);
  });
});

describe('Session — overrides de skills', () => {
  beforeEach(() => {
    spawns.length = 0;
  });

  it('override chega ao CLI no respawn, na MESMA sessão', () => {
    const s = makeSession();
    s.send('primeiro prompt');
    spawns[0].fireInit('sess-A');
    expect(spawns[0].opts.skillOverrides).toEqual({}); // sem override: nada para o CLI

    s.setSkillOverride('dataviz', 'off'); // stop() descarta o CLI
    s.send('segundo prompt'); // respawn

    expect(spawns[1].opts.skillOverrides).toEqual({ dataviz: 'off' });
    // O contexto (inclusive skill já carregada) segue: o override não é um /clear.
    expect(spawns[1].opts.resumeSessionId).toBe('sess-A');
  });

  it('voltar para "on" remove o override em vez de mandar o default', () => {
    const s = makeSession();
    s.send('p');
    s.setSkillOverride('dataviz', 'name-only');
    s.send('p2');
    expect(spawns[1].opts.skillOverrides).toEqual({ dataviz: 'name-only' });

    s.setSkillOverride('dataviz', 'on');
    s.send('p3');
    expect(spawns[2].opts.skillOverrides).toEqual({});
  });

  // /nome de skill conhecida = acionamento pelo usuário. O stream não emite nada nesse
  // caminho (medido no CLI 2.1.217); quem sabe é o Cockpit, que enviou o comando.
  it('/nome de skill conhecida marca como carregada, sem inventar tokens', () => {
    const s = makeSession();
    s.send('primeiro prompt');
    spawns[0].handlers.get('event')![0]({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-A',
      slash_commands: ['caveman', 'clear'],
      skills: ['caveman'],
    });

    s.send('/caveman full');
    const sk = s.snapshot().skills!.find((x) => x.name === 'caveman')!;
    expect(sk.active).toBe(true);
    expect(sk.invokedBy).toBe('user');
    expect(sk.activeTokens).toBeUndefined();

    // Slash que NÃO é skill não marca nada.
    s.send('/clear');
    expect(s.snapshot().skills!.some((x) => x.name === 'clear')).toBe(false);
  });

  // O init só chega DEPOIS da primeira mensagem: numa aba nova ainda não sabemos quais
  // nomes são skills. O /nome fica pendente e é confirmado quando a lista chega.
  it('/nome enviado ANTES do init é resolvido quando o init chega', () => {
    const s = makeSession();
    s.send('/caveman full'); // primeira mensagem da aba: lista ainda desconhecida
    expect(s.snapshot().skills).toBeUndefined();

    spawns[0].handlers.get('event')![0]({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-A',
      slash_commands: ['caveman'],
      skills: ['caveman'],
    });

    const sk = s.snapshot().skills!.find((x) => x.name === 'caveman')!;
    expect(sk.active).toBe(true);
    expect(sk.invokedBy).toBe('user');
  });

  it('/nome pendente que não era skill é descartado', () => {
    const s = makeSession();
    s.send('/naoehskill');
    spawns[0].handlers.get('event')![0]({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-A',
      slash_commands: ['naoehskill'],
      skills: ['caveman'],
    });
    expect(s.snapshot().skills).toBeUndefined();
  });
});

// Sequência REAL capturada com os argumentos que o Cockpit usa (--include-partial-messages
// + --permission-prompt-tool stdio), acionando uma skill de projeto.
describe('Session — carga de skill ponta a ponta (eventos reais)', () => {
  beforeEach(() => {
    spawns.length = 0;
    extraPrompt = undefined;
    quietPrompt = undefined;
  });

  it('marca loaded a partir do stream que o CLI realmente emite', () => {
    const s = makeSession();
    s.send('aciona a skill');
    const fire = (ev: unknown) => spawns[0].handlers.get('event')![0](ev);
    fire({ type: 'system', subtype: 'init', session_id: 'sess-A', slash_commands: [], skills: ['tootega-convencoes'] });
    fire({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Skill' } },
    });
    fire({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'tootega-convencoes' } }],
      },
    });
    fire({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: tootega-convencoes' }] },
    });
    fire({
      type: 'user',
      message: { content: [{ type: 'text', text: 'Base directory for this skill: C:\\x\n\n' + 'y'.repeat(800) }] },
    });

    const sk = s.snapshot().skills!.find((x) => x.name === 'tootega-convencoes')!;
    expect(sk.active).toBe(true);
    expect(sk.invokedBy).toBe('model');
    expect(sk.activeTokens).toBeGreaterThan(150);
  });
});

describe('local slash command output', () => {
  beforeEach(() => {
    spawns.length = 0;
  });

  const run = (content: string) => {
    const emitted: any[] = [];
    const s = makeSession((m) => emitted.push(m));
    s.send('p');
    spawns[0].fireInit('sess-L');
    emitted.length = 0;
    spawns[0].emit('event', { type: 'user', uuid: 'u1', message: { role: 'user', content } });
    return emitted;
  };

  it('shows the output as a notice, not as a prompt', () => {
    const e = run('<local-command-stdout>Set model to `sonnet`</local-command-stdout>');
    expect(e.some((m) => m.kind === 'remoteUser')).toBe(false);
    expect(e.find((m) => m.kind === 'engineNotice')).toMatchObject({ text: 'Set model to `sonnet`', topic: 'local_command' });
  });

  it('draws nothing for the command wrapper', () => {
    const e = run('<command-name>/model</command-name><command-message>model</command-message>');
    expect(e.filter((m) => m.kind === 'remoteUser' || m.kind === 'engineNotice')).toEqual([]);
  });
});

describe('model switched elsewhere', () => {
  beforeEach(() => {
    spawns.length = 0;
  });

  const answer = (model: string, id: string) =>
    spawns[0].emit('event', { type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'x' }] } });

  it('follows a model the picker does not show', () => {
    const s = makeSession(() => {});
    s.setModel('sonnet');
    s.send('p');
    spawns[0].fireInit('sess-M');
    answer('claude-sonnet-5-5', 'm1');
    expect(s.model()).toBe('sonnet');
    answer('claude-opus-5-5', 'm2'); // /model opus typed on the phone
    expect(s.model()).toBe('claude-opus-5-5');
  });

  it('does not replace "default" with whatever answered', () => {
    const s = makeSession(() => {});
    s.send('p');
    spawns[0].fireInit('sess-D');
    answer('claude-sonnet-5-5', 'm1');
    answer('claude-opus-5-5', 'm2');
    expect(s.model()).toBe('default');
  });

  it('keeps the picker when it already matches', () => {
    const s = makeSession(() => {});
    s.setModel('sonnet');
    s.send('p');
    spawns[0].fireInit('sess-N');
    answer('claude-opus-5-5', 'm1');
    s.setModel('sonnet');
    answer('claude-sonnet-5-5', 'm2');
    expect(s.model()).toBe('sonnet');
  });
});
