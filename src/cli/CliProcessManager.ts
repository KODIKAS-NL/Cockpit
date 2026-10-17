// Gerencia o processo do Claude Code CLI em modo headless/streaming.
// Spawns `claude` with bidirectional stream-json and emits parsed events.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { StreamParser } from './StreamParser';
import { log, dlog } from '../util/logger';
import type { EngineId } from './Engine';
import type { ClaudeEvent } from '../../shared/events';
import type { CliProcess } from './CliProcess';
import { killGroup } from '../util/killTree';
import { managedBinaryPath } from './ManagedCli';

export interface CliOptions {
  claudePath: string;
  cwd: string;
  /** Which engine the binary is. Decides the argument list. Default: claude. */
  engine?: EngineId;
  /** `host:port` of the tootega engine server (tootega engine only). */
  server?: string;
  model?: string;
  effort?: string;
  /** `auto` (the CLI's own), `off`, or the auto-compact window in tokens (100000 to 1000000). */
  autoCompact?: string;
  permissionMode?: string;
  // Ferramentas a desabilitar no CLI (--disallowedTools). Ex.: ['Task','Workflow']
  // to block subagents/workflows (which spend a lot of tokens). Empty = nothing.
  disallowedTools?: string[];
  resumeSessionId?: string;
  // Short language code (pt, en…) for the AskUserQuestion questions. When
  // set, it injects an append-system-prompt that forces the language of the QUESTIONS only.
  askLanguage?: string;
  // Texto do usuário (settings) para o system prompt, já expandido. Vai no MESMO
  // --append-system-prompt do askLanguage: a flag não soma, o último vence (medido).
  extraSystemPrompt?: string;
  // Diretiva "quiet" (settings): vai no INÍCIO do texto injetado, antes de tudo.
  // Vazio = não injeta nada (o agente volta a narrar/relatar como de costume).
  quietPrompt?: string;
  // Overrides de listing de skills (--settings JSON). Vale só para ESTE processo:
  // o ~/.claude/settings.json do usuário fica intocado.
  skillOverrides?: Record<string, string>;
  // Encaminha o texto dos subagentes no stream (--forward-subagent-text, 2.1.211). Só
  // faz sentido quando os agentes estão liberados. Cada evento chega marcado com
  // `parent_tool_use_id`, roteado para o card do Task que o lançou (não polui a bolha principal).
  forwardSubagentText?: boolean;
  // Liga TodoWrite/Task* nos modelos em que o CLI os tirou (2.1.268) — ver engineEnv().
  enableTodoTools?: boolean;
  // Forces extended thinking off (MAX_THINKING_TOKENS=0 + alwaysThinkingEnabled:false).
  // Off by default: thinking then follows the user's own Claude Code configuration.
  // Setting `cockpitDaemon.thinking` = "off" turns it on.
  forceThinkingOff?: boolean;
}

// Short BCP47 code -> language name for the prompt instruction.
const LANG_NAME: Record<string, string> = {
  pt: 'Brazilian Portuguese (pt-BR)',
  en: 'international English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
};

function askLanguagePrompt(code: string): string {
  const name = LANG_NAME[code] ?? code;
  return (
    `When you use the AskUserQuestion tool, write every question, header text, and ` +
    `option label/description in ${name}. This language rule applies ONLY to ` +
    `AskUserQuestion content, not to your other replies.`
  );
}

export interface CliEvents {
  event: (e: ClaudeEvent) => void;
  exit: (code: number | null) => void;
  stderr: (text: string) => void;
}

export class CliProcessManager extends EventEmitter implements CliProcess {
  readonly persistent = false;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private parser = new StreamParser();
  private reqSeq = 0;
  private lastStderr: string[] = [];
  private startedAt = 0;
  private eventsSeen = 0;
  private stopping = false;
  // control_requests NOSSOS aguardando resposta (request_id → resolve).
  private pendingControl = new Map<string, (payload: unknown) => void>();
  // Arquivos temporários do processo atual (settings, system prompt) — apagados no stop().
  private tempFiles: string[] = [];

  constructor(private opts: CliOptions) {
    super();
  }

  /** Checks whether the CLI exists and returns its version (or null). */
  static detect(claudePath: string): { ok: boolean; version?: string; error?: string } {
    try {
      // On Windows `claude` is a .cmd; Node 22+ refuses to run it without a shell
      // (EINVAL/ENOENT, CVE-2024-27980 protection). shell:true resolves it via PATHEXT.
      const useShell = process.platform === 'win32';
      const res = spawnSync(shellSafe(claudePath, useShell), ['--version'], {
        encoding: 'utf8',
        timeout: 8000,
        shell: useShell,
      });
      if (res.error) return { ok: false, error: res.error.message };
      if (res.status === 0) {
        return { ok: true, version: (res.stdout || res.stderr || '').trim() };
      }
      return { ok: false, error: (res.stderr || `exit ${res.status}`).trim() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Resolve um `claude` funcional: tenta o caminho configurado (PATH) e, se falhar,
   * probes the NATIVE installer locations (~/.local/bin), which don't enter the PATH
   * automatically on Windows. Returns the first that answers `--version`.
   */
  static resolve(
    configured: string,
    engine: EngineId = 'claude',
  ): { path: string; ok: boolean; version?: string; error?: string } {
    // `~/.local/bin` is where the Claude native installer puts things; probing
    // it for the tootega agent would only report the wrong binary as "found".
    // Order: a path the user set, then Cockpit's own downloaded copy, then PATH, then ~/.local/bin.
    const managed = engine === 'claude' ? managedBinaryPath() : undefined;
    const userSet = configured !== 'claude';
    const candidates =
      engine === 'tootega'
        ? [configured]
        : [...(userSet ? [configured] : []), ...(managed ? [managed] : []), ...(userSet ? [] : [configured]), ...nativeCandidates()];
    let last: { path: string; ok: boolean; version?: string; error?: string } = {
      path: configured,
      ok: false,
    };
    for (const c of candidates) {
      // Non-existent absolute path: skipped without spending a spawn.
      if (c !== configured && !safeExists(c)) continue;
      const d = CliProcessManager.detect(c);
      if (d.ok) return { path: c, ...d };
      last = { path: c, ...d };
    }
    return last;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Updates the session id to resume in case the process needs to respawn. The CLI only
   * reveals the `session_id` in the `init` event; without this, a silent restart
   * (writeLine after the process died) would start WITHOUT `--resume` and create a new
   * context on disk. Keeps the continuity of the SAME session.
   */
  setResumeId(id: string): void {
    if (id) this.opts.resumeSessionId = id;
  }

  /**
   * Arguments for the Tootega agent.
   *
   * The shared part is the process contract itself; everything else the Claude
   * CLI takes is either meaningless here (there is no account, no model
   * catalogue, no MCP) or already handled by the agent's own defaults. The
   * agent tolerates unknown flags on purpose, but sending flags it ignores
   * would only make the command line harder to read in a bug report.
   */
  private tootegaArgs(): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
      '--cwd', this.opts.cwd,
    ];
    if (this.opts.server) args.push('--server', this.opts.server);
    // The agent exits on its own after being idle — a process per tab that
    // never dies becomes a dozen of them. `--resume` is what makes that safe:
    // the conversation is on disk, and the next message brings it back.
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId);
    // Plan mode is the closest thing to "do not touch anything": the agent has
    // no plan mode, so it maps to read-only tools.
    if (this.opts.permissionMode === 'plan') args.push('--no-tools');
    // `bypassPermissions` is the CLI's name for "stop asking".
    if (this.opts.permissionMode === 'bypassPermissions') args.push('--yes');
    return args;
  }

  /** Starts the process. Idempotent: does nothing when already running. */
  start(): void {
    if (this.proc) return;
    this.spawnWith(this.opts.engine === 'tootega' ? this.tootegaArgs() : this.claudeArgs());
  }

  /**
   * Arguments for the Claude CLI. Writes the temp files (prompt, settings) it points at, so
   * it runs once per spawn.
   */
  private claudeArgs(): string[] {
    return buildClaudeArgs(this.opts, (kind, content) => this.writeTempFile(kind, content));
  }

  /** The engine's environment: the parent's, plus engineEnvOverrides(). */
  private engineEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...engineEnvOverrides(this.opts) };
  }

  /** Spawns the engine binary and wires the streams. Shared by both engines. */
  private spawnWith(args: string[]): void {
    const useShell = process.platform === 'win32';
    // The exact command line, always — not behind the debug flag.
    //
    // `CLI exited (1)` on its own says nothing: it does not say which binary,
    // with which arguments, from which directory, nor what the process printed
    // before dying. Reproducing the failure by hand needs all four, and this
    // line is the difference between "paste it in a terminal" and "guess".
    log(`spawn [${this.opts.engine ?? 'claude'}] ${this.opts.claudePath} ${args.join(' ')}`);
    log(`  cwd=${this.opts.cwd}`);
    this.lastStderr = [];
    const env = this.engineEnv();
    const proc = spawn(shellSafe(this.opts.claudePath, useShell), args, {
      cwd: this.opts.cwd,
      env,
      shell: useShell, // resolve 'claude.cmd' no Windows e evita EINVAL no Node 22+
      // Outside Windows, gives `claude` its own process GROUP (detached) so the
      // WHOLE TREE (claude + subagents) can be ended via kill(-pid) in stop().
      // Without this, a SIGTERM to the leader alone left orphan grandchildren. On Windows
      // shell:true makes `proc` the cmd.exe → there we use taskkill /T.
      detached: !useShell,
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => {
      for (const ev of this.parser.push(chunk)) {
        this.eventsSeen++;
        // Every event type except the token-by-token flood, which would bury
        // the log in a single turn.
        if (ev.type !== 'stream_event') dlog('cli', `<- ${describeEvent(ev)}`);
        this.settleControl(ev);
        this.emit('event', ev);
      }
    });
    proc.stderr.on('data', (text: string) => {
      // Kept for the post-mortem: an engine that dies at startup usually says
      // why on stderr, and that text is gone by the time anyone looks.
      this.lastStderr.push(text);
      if (this.lastStderr.length > 20) this.lastStderr.shift();
      this.emit('stderr', text);
    });
    proc.on('close', (code) => {
      for (const ev of this.parser.flush()) this.emit('event', ev);
      this.proc = null;
      // A process WE killed reports a non-zero code on Windows (taskkill /F),
      // and logging that as a failure sends whoever reads the log hunting a
      // crash that never happened — which is exactly what a switch of engine
      // used to look like.
      if (this.stopping) {
        log(`engine stopped on request (exit ${code})`);
      } else if (code) {
        log(`exit ${code} after ${Date.now() - this.startedAt} ms` +
            ` (${this.eventsSeen} events)`);
        const tail = this.lastStderr.join('').trim();
        log(tail ? `  stderr: ${tail}` : '  stderr: (nothing)');
      }
      this.stopping = false;
      this.emit('exit', code);
    });
    proc.on('error', (err) => {
      log(`spawn failed: ${err.message}`);
      this.emit('stderr', err.message);
    });
    this.startedAt = Date.now();
    this.eventsSeen = 0;

    this.proc = proc;
    // Handshake do protocolo de controle. Habilita o roteamento interativo
    // (can_use_tool / AskUserQuestion) e devolve a lista de slash commands.
    this.writeLine({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  }

  /** Sends a user message through stdin (text + optional images). */
  sendUserMessage(text: string, images?: { mediaType: string; data: string }[], uuid?: string): void {
    const content: unknown[] = [];
    if (text) content.push({ type: 'text', text });
    for (const img of images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });
    this.writeLine({ type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content } });
  }

  /**
   * Answers a `can_use_tool` control_request. `response` is the decision
   * payload: `{ behavior:'allow', updatedInput, updatedPermissions? }` or
   * `{ behavior:'deny', message }`. O `allow` exige `updatedInput` (o CLI valida
   * with Zod — returning only `{behavior:'allow'}` results in a union error).
   */
  sendControlResponse(requestId: string, response: Record<string, unknown>): void {
    this.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  /**
   * Grava um arquivo temporário deste processo (UTF-8) e devolve o caminho, ou
   * `undefined` se a escrita falhar — nesse caso o CLI sobe sem a flag correspondente.
   */
  private writeTempFile(kind: string, content: string): string | undefined {
    const ext = kind === 'settings' ? 'json' : 'txt';
    const file = path.join(os.tmpdir(), `cockpit-${kind}-${process.pid}-${++this.reqSeq}.${ext}`);
    try {
      fs.writeFileSync(file, content, 'utf8');
      this.tempFiles.push(file);
      return file;
    } catch {
      return undefined;
    }
  }

  /**
   * Envia um control_request nosso e espera a resposta correlacionada por `request_id`.
   * Usado pelo `get_context_usage` (cálculo local do engine: sem turno, sem tokens).
   * Resolve `undefined` no timeout ou quando o CLI responde erro — nunca rejeita, para
   * que uma versão de CLI sem esse subtype não derrube nada.
   */
  requestControl(subtype: string, timeoutMs = 5000, payload?: Record<string, unknown>): Promise<unknown> {
    const id = `${subtype}_${++this.reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(id);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.pendingControl.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      this.writeLine({ type: 'control_request', request_id: id, request: { ...payload, subtype } });
    });
  }

  /** Resolve o control_request nosso que estava esperando por este `request_id`. */
  private settleControl(ev: ClaudeEvent): void {
    if ((ev as any).type !== 'control_response') return;
    const resp = (ev as any).response;
    const id = resp?.request_id;
    if (typeof id !== 'string') return;
    const done = this.pendingControl.get(id);
    if (!done) return;
    this.pendingControl.delete(id);
    // Success without a payload (`set_model`) is still a success: {} vs. undefined = failed.
    done(resp?.subtype === 'success' ? (resp.response ?? {}) : undefined);
  }

  private writeLine(obj: unknown): void {
    if (!this.proc) this.start();
    const line = JSON.stringify(obj);
    dlog('cli', `-> ${line.length > 400 ? line.slice(0, 400) + '…' : line}`);
    this.proc?.stdin.write(line + '\n');
  }

  /**
   * Interrupts the current turn through the control protocol (`subtype: 'interrupt'`),
   * keeping the process and the SESSION alive. That way the next send (e.g. the prompt
   * fixed after cancelling) continues the SAME session, instead of respawning a new one
   * — which would create a duplicated context on disk. With no process, there is nothing to do.
   */
  interrupt(): void {
    if (!this.proc) return;
    this.writeLine({
      type: 'control_request',
      request_id: `interrupt_${++this.reqSeq}`,
      request: { subtype: 'interrupt' },
    });
  }

  /** A local process belongs to this window: letting go of it means ending it. */
  detach(): void {
    this.stop();
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.stopping = true;
    // Ninguém mais vai responder: libera quem espera em vez de deixar pendurado até o timeout.
    for (const done of this.pendingControl.values()) done(undefined);
    this.pendingControl.clear();
    for (const f of this.tempFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* arquivo temporário: some no boot seguinte */
      }
    }
    this.tempFiles = [];
    try {
      proc.stdin.end();
    } catch {
      /* noop */
    }
    try {
      // Windows + shell:true -> `proc` is the cmd.exe; killing only it leaves the child
      // `claude` (node) orphaned and still running. taskkill /T ends the whole tree.
      if (process.platform === 'win32' && proc.pid != null) {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else if (proc.pid != null) {
        // Non-Windows: `claude` leads its own group (detached). Ends the group
        // inteiro (negativo = grupo) — pega subagents/filhos junto.
        killGroup(proc.pid);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      /* noop */
    }
  }
}

/**
 * The Claude CLI's argument list for these options. Files the CLI reads (appended system
 * prompt, `--settings`) are handed to `writeFile`, which returns the path to put on the
 * command line, or undefined when it couldn't write (the flag is then left out).
 *
 * Shared by both process owners: the local one writes real temp files; the daemon client
 * collects the contents and lets the daemon write them on its side.
 */
export function buildClaudeArgs(
  opts: CliOptions,
  writeFile: (kind: string, content: string) => string | undefined,
): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    // Routes permission decisions through the control protocol (stdin/stdout):
    // with this sentinel the CLI emits a `can_use_tool` control_request instead of denying
    // silently in headless mode. AskUserQuestion also arrives through here.
    '--permission-prompt-tool', 'stdio',
    '--verbose',
    // Echoes each user message (with our uuid) when the CLI takes it in: a message sent
    // mid-turn is queued by the CLI, and this is how we learn when it starts.
    '--replay-user-messages',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.autoCompact && /^\d+$/.test(opts.autoCompact)) args.push('--autocompact', opts.autoCompact);
  // Always explicit, `default` included. Since CLI 2.1.285 a `-p` session with no mode
  // configured starts in AUTO on third-party providers or with telemetry off, so leaving
  // the flag out let the dropdown say "default" while the CLI ran its classifier. The CLI
  // now lists the mode as `manual`; `default` is still accepted and older CLIs only know it.
  if (opts.permissionMode) {
    args.push('--permission-mode', opts.permissionMode);
  }
  if (opts.disallowedTools?.length) {
    args.push('--disallowedTools', opts.disallowedTools.join(','));
  }
  if (opts.forwardSubagentText) args.push('--forward-subagent-text');
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  // Repetir --append-system-prompt NÃO soma: o último vence (medido no CLI 2.1.217 —
  // dois valores, só o segundo chegou ao modelo). Por isso vai tudo junto.
  //
  // A diretiva quiet vem PRIMEIRO de propósito: é uma regra sobre a forma de TODA
  // resposta, e uma regra de forma lida depois do conteúdo perde para ele.
  const appended = [
    opts.quietPrompt ?? '',
    opts.askLanguage ? askLanguagePrompt(opts.askLanguage) : '',
    opts.extraSystemPrompt ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (appended) {
    // Texto do usuário passa por ARQUIVO: com shell:true no Windows, um argumento
    // multi-linha com `|`, `$` ou crase é mastigado pelo cmd.exe e chega vazio ao
    // modelo (medido: o sentinel injetado inline sumiu; por arquivo, chegou).
    const userText = opts.extraSystemPrompt || opts.quietPrompt;
    const file = userText ? writeFile('prompt', appended) : undefined;
    if (file) args.push('--append-system-prompt-file', file);
    else args.push('--append-system-prompt', appended);
  }
  // `--settings` é MERGE (não substitui as settings do usuário) e aceita caminho OU
  // string JSON — mas JSON inline não sobrevive ao shell do Windows (aspas/chaves são
  // mastigadas por cmd.exe e o CLI sobe sem os overrides). Gravamos um arquivo temporário.
  const settings = settingsPayload(opts);
  if (settings) {
    const file = writeFile('settings', JSON.stringify(settings));
    if (file) args.push('--settings', file);
  }
  return args;
}

/**
 * Settings extras for this process: skill listing overrides and, when asked for, thinking
 * forced off. Undefined when there is nothing to add (no `--settings` flag at all).
 *
 * Thinking has two switches in the CLI: the `alwaysThinkingEnabled` setting and the
 * `MAX_THINKING_TOKENS` budget (env, see engineEnvOverrides). Forcing it off sets both.
 */
export function settingsPayload(opts: CliOptions): Record<string, unknown> | undefined {
  const payload: Record<string, unknown> = {};
  if (opts.forceThinkingOff) payload.alwaysThinkingEnabled = false;
  const overrides = opts.skillOverrides;
  if (overrides && Object.keys(overrides).length > 0) payload.skillOverrides = overrides;
  return Object.keys(payload).length ? payload : undefined;
}

/**
 * Environment variables the engine needs on top of the parent environment.
 *
 * Auto mode (the CLI classifier decides allow/deny) is opt-in on Bedrock/Vertex/
 * Foundry via env (2.1.158/159). Defensive: we turn the flag on when the mode is 'auto'
 * so it behaves uniformly across providers. It does NOT bypass permissions — it only enables the
 * CLI's native mode, which still routes what it must through control_request.
 *
 * MAX_THINKING_TOKENS=0 only when thinking is forced off (see settingsPayload).
 *
 * CLAUDE_CODE_ENABLE_TODO_TOOLS: since CLI 2.1.268 TodoWrite/Task* are only offered up to
 * Opus 4.7 / Sonnet 4.6, so on Opus 5.5 the Tasks panel has nothing to show. Opt-in
 * (`cockpitDaemon.enableTodoTools`): the CLI dropped them on purpose for the newer models.
 */
export function engineEnvOverrides(opts: CliOptions): Record<string, string> {
  const env: Record<string, string> = {};
  if (opts.forceThinkingOff) env.MAX_THINKING_TOKENS = '0';
  if (opts.permissionMode === 'auto') env.CLAUDE_CODE_ENABLE_AUTO_MODE = '1';
  if (opts.enableTodoTools) env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
  if (opts.autoCompact === 'off') env.DISABLE_AUTO_COMPACT = '1';
  return env;
}

/** One readable line per event, for the debug log. */
function describeEvent(ev: ClaudeEvent): string {
  const e = ev as unknown as Record<string, unknown>;
  const msg = e.message as { content?: { type?: string; name?: string }[] } | undefined;
  const parts: string[] = [String(e.type)];
  if (e.subtype) parts.push(String(e.subtype));
  if (Array.isArray(msg?.content)) {
    parts.push(
      msg.content
        .map((b) => (b?.type === 'tool_use' ? `tool_use:${b.name}` : String(b?.type)))
        .join(','),
    );
  }
  const req = e.request as { subtype?: string; tool_name?: string } | undefined;
  if (req?.subtype) parts.push(`${req.subtype}${req.tool_name ? `:${req.tool_name}` : ''}`);
  if (e.is_error) parts.push('IS_ERROR');
  return parts.join(' ');
}

/** On Windows with a shell, wraps the path in quotes when it has spaces. */
function shellSafe(p: string, useShell: boolean): string {
  if (useShell && /\s/.test(p) && !p.startsWith('"')) return `"${p}"`;
  return p;
}

/** Locais do installer nativo do Claude Code (~/.local/bin). */
function nativeCandidates(): string[] {
  const bin = path.join(os.homedir(), '.local', 'bin');
  return process.platform === 'win32'
    ? [path.join(bin, 'claude.exe'), path.join(bin, 'claude.cmd'), path.join(bin, 'claude')]
    : [path.join(bin, 'claude')];
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
