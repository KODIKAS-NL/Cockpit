import { memo, useMemo, useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Translator } from '../i18n';
import { send } from '../vscodeApi';
import type {
  TimelineItem,
  AssistantItem,
  ToolItem,
  UserItem,
  HookItem,
  NoticeItem,
  TodoItem,
  AskQuestion,
} from '../types';
import { isTodoToolName } from '../store';
import { splitAnswerNote, parseChoices } from '../askAnswer';
import { decodeFlattenedUnicode as dec } from '../util/decodeText';
import { Markdown } from './Markdown';
import { CodeBlock } from './CodeBlock';
import { DiffView } from './DiffView';
import { TodoCard } from './Todos';
import { useImageViewer } from './ImageViewer';
import { Tooltip, type TooltipRow } from './Tooltip';
import { Icon } from './Icon';
import { languageFromPath, stripLineNumbers, richHighlight, highlightCode } from '../util/highlight';
import {
  fmtCompact,
  fmtTk,
  fmtBytes,
  fmtMs,
  fmtUsdShort,
  fmtClock,
  byteLen,
  countWords,
  countLines,
} from '../util/format';

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Write: '📝',
  Edit: '✏️',
  MultiEdit: '✏️',
  NotebookEdit: '📓',
  Bash: '❯',
  Grep: '🔍',
  Glob: '🗂️',
  Task: '🤖',
  Agent: '🤖',
  WebFetch: '🌐',
  WebSearch: '🔎',
  TodoWrite: '☑️',
  // The agent ends the session on its own (abusive user / jailbreak) — CLI 2.1.214.
  EndConversation: '🛑',
};
const toolIcon = (name: string): string => TOOL_ICONS[name] ?? '⚙';
const basename = (p: string): string => p.replace(/["']/g, '').split(/[\\/]/).pop() || p;
// Files with a native preview in VSCode ("View" link).
const hasPreview = (p: string): boolean => /\.(md|markdown|svg|png|jpe?g|gif|webp|ipynb)$/i.test(p);

interface Props {
  items: TimelineItem[];
  t: Translator;
  emptyHint: boolean;
  showThinking?: boolean;
  expandTools?: boolean;
  userName?: string;
  todos: TodoItem[];
  answers?: Record<string, string>;
  onRewind?: (userIndex: number) => void; // rewind to this prompt (removing it)
  verbosity?: string; // verbose|necessary|dialogo|quiet — filters the display
}

// Groups items into turns: each user message and, after it, the contiguous
// run of Claude items (text + tools) under a single "Claude" header.
type Group =
  | { kind: 'user'; item: UserItem }
  | { kind: 'claude'; items: (AssistantItem | ToolItem)[] }
  // Injeção de hook: faixa própria. Não pertence a nenhum turno — o SessionStart acontece
  // antes do primeiro prompt e agrupá-lo criaria uma bolha do Claude vazia.
  | { kind: 'hook'; item: HookItem }
  // Aviso do engine: faixa própria, pelo mesmo motivo do hook — pode chegar fora de turno.
  | { kind: 'notice'; item: NoticeItem };

function groupItems(items: TimelineItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    if (it.kind === 'user') {
      out.push({ kind: 'user', item: it });
      continue;
    }
    if (it.kind === 'hook') {
      out.push({ kind: 'hook', item: it });
      continue;
    }
    if (it.kind === 'notice') {
      out.push({ kind: 'notice', item: it });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === 'claude') last.items.push(it);
    else out.push({ kind: 'claude', items: [it] });
  }
  return out;
}

function CopyButton({ text, t }: { text: string; t: Translator }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="msg-copy"
      title={t('common.copy')}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}

const WINDOW_STEP = 40; // groups (a prompt, or one Claude turn) in the DOM at first and per step

// Memoised: every stream-json delta dispatches into the reducer and re-renders App. Without
// this, each delta re-ran groupItems() plus a Markdown parse and a highlight.js pass for the
// WHOLE transcript — the work that made typing stall while the agent was running. The props
// are primitives or reducer-preserved references, so a delta that only touches `items`
// (or nothing at all) now stops here.
export const Timeline = memo(function Timeline({
  items,
  t,
  emptyHint,
  showThinking,
  expandTools,
  userName,
  todos,
  answers,
  onRewind,
  verbosity = 'verbose',
}: Props) {
  // Only the newest groups are in the DOM: a long conversation is slow to lay out and scroll
  // on a tablet. Older ones come back in steps, or all at once for search.
  const [shown, setShown] = useState(WINDOW_STEP);
  const topRef = useRef<HTMLDivElement>(null);
  const grow = useRef<{ height: number; top: number } | null>(null);
  const revealMore = (): void => {
    const sc = topRef.current?.closest('.scroll') as HTMLElement | null;
    if (sc) grow.current = { height: sc.scrollHeight, top: sc.scrollTop };
    setShown((n) => n + WINDOW_STEP);
  };
  // Keeps what the reader was looking at in place when older groups appear above it.
  useLayoutEffect(() => {
    const g = grow.current;
    if (!g) return;
    grow.current = null;
    const sc = topRef.current?.closest('.scroll') as HTMLElement | null;
    if (sc) sc.scrollTop = g.top + (sc.scrollHeight - g.height);
  }, [shown]);
  useEffect(() => {
    const all = () => setShown(Number.MAX_SAFE_INTEGER);
    window.addEventListener('cockpit:reveal-all', all);
    return () => window.removeEventListener('cockpit:reveal-all', all);
  }, []);
  const hasHidden = items.length > 0 && shown < Number.MAX_SAFE_INTEGER;
  useEffect(() => {
    const el = topRef.current;
    if (!el || !hasHidden || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && revealMore(), {
      root: el.closest('.scroll'),
      rootMargin: '200px 0px 0px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  });
  if (items.length === 0 && emptyHint) {
    return (
      <div className="timeline empty">
        <p className="welcome">{t('empty.welcome')}</p>
        <p className="hint">{t('empty.cliHint')}</p>
      </div>
    );
  }
  const allGroups = groupItems(items);
  const hidden = Math.max(0, allGroups.length - shown);
  const groups = hidden ? allGroups.slice(hidden) : allGroups;
  // The task checklist is unique and lives aggregated: it is rendered only in the last
  // turn that touched tasks, avoiding repeating the group on every add/tick.
  let lastTodoGroup = -1;
  let lastUserGroup = -1;
  groups.forEach((g, i) => {
    if (g.kind === 'claude' && g.items.some((it) => it.kind === 'tool' && isTodoToolName(it.name))) {
      lastTodoGroup = i;
    }
    if (g.kind === 'user') lastUserGroup = i;
  });
  // Ordinal of each user prompt (matching the order in the host's transcript),
  // p/ o rewind referenciar o prompt certo independentemente do id local/uuid.
  let userOrdinal = allGroups.slice(0, hidden).filter((g) => g.kind === 'user').length - 1;
  return (
    <div className="timeline">
      {hidden > 0 && (
        <div className="timeline-earlier" ref={topRef}>
          <button type="button" className="link-btn" onClick={revealMore}>
            {t('timeline.showEarlier', hidden)}
          </button>
        </div>
      )}
      {groups.map((g, gi) =>
        g.kind === 'notice' ? (
          <NoticeBanner key={g.item.id} item={g.item} t={t} />
        ) : g.kind === 'hook' ? (
          <HookBanner key={g.item.id} item={g.item} t={t} />
        ) : g.kind === 'user' ? (
          ((userOrdinal += 1),
          (
            <UserBubble
              key={g.item.id}
              item={g.item}
              t={t}
              userName={userName}
              pinned={gi === lastUserGroup}
              ordinal={userOrdinal}
              onRewind={onRewind}
            />
          ))
        ) : (
          <ClaudeTurn
            key={g.items[0].id}
            items={g.items}
            t={t}
            defaultShowThinking={!!showThinking}
            defaultOpenTools={expandTools !== false}
            todos={todos}
            showTodos={gi === lastTodoGroup}
            answers={answers}
            verbosity={verbosity}
          />
        ),
      )}
    </div>
  );
});

/** Formats ms as min:sec (e.g. 75000 -> "1:15"). */
function fmtMinSec(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// One Claude turn: a single header + text/tools in order. Runs of task tools
// are merged into a single inline checklist (TodoCard).
// Edit family: they group together (Edit/Write/MultiEdit) on the same file.
const MERGE_EDIT = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

/**
 * Merge key: consecutive tools with the SAME key become one card.
 *  - edit on the same file → `edit:<file>` (merges Edit/Write/MultiEdit together)
 *  - another file tool → `<name>:<file>` (Read of the same file, etc.)
 *  - the rest (Bash/Grep/…) → `<name>` (sequence of the same command)
 */
function mergeKey(it: ToolItem): string {
  const input = (it.input ?? {}) as Record<string, unknown>;
  const file = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (MERGE_EDIT.test(it.name) && file) return `edit:${file}`;
  if (file) return `${it.name}:${file}`;
  return it.name;
}

/**
 * Lines of a Bash result that report an access the sandbox refused. The CLI only started
 * annotating the tool result with them in 2.1.224 (`annotateStderrWithSandboxFailures`) — before
 * that the command just failed with no stated reason, and the user was left guessing.
 *
 * Recognised by SHAPE, like every other stream reading here: a line that names the sandbox and a
 * refusal verb. The wording differs per platform and per release (`[sandbox] Blocked network
 * request to <host>`, `denied by sandbox policy`, the filesystem denials the macOS/Linux monitors
 * annotate), so pinning any single sentence would break on the next version — and a line we
 * don't recognise simply stays in the output below, where it always was.
 */
function sandboxDenials(out: string): string[] {
  const hits: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || !/sandbox/i.test(line)) continue;
    if (!/\b(blocked|denied|denies|refused|not permitted)\b/i.test(line)) continue;
    const clean = line.replace(/^\[sandbox\]\s*/i, '');
    if (!hits.includes(clean)) hits.push(clean);
    if (hits.length === 8) break; // a wall of identical denials helps nobody
  }
  return hits;
}

/**
 * A turn that produced NO output — `/clear` and the other output-less commands, or a message
 * whose blocks were all tool calls — still opens an assistant item on `message_start`. Finished
 * with no text and no thinking, it has nothing to render: showing it paints the same blank
 * "(no content)" bubble the CLI stopped sending its own remote/SDK clients in 2.1.224. While it
 * is still streaming (`!done`) the empty item is the legitimate placeholder, and a cancelled one
 * carries the "interrupted" mark — both stay.
 */
function isEmptyAssistant(it: TimelineItem): boolean {
  return (
    it.kind === 'assistant' && !!it.done && !it.canceled && !it.text?.trim() && !it.thinking?.trim()
  );
}

/**
 * An item is DISPLAYED in the timeline according to the verbosity (display only):
 *   verbose=everything; dialogo=edits+all text; necessary=edits+final text;
 *   quiet=final text only. Ask/checklist always; user always.
 */
function visibleInTimeline(it: TimelineItem, verbosity: string, lastAssistId?: string): boolean {
  if (isEmptyAssistant(it)) return false; // nada a dizer: não vira bolha vazia
  if (verbosity === 'verbose') return true;
  if (it.kind === 'user') return true;
  if (it.kind === 'assistant') {
    if (verbosity === 'dialogo') return true; // all the text
    return it.id === lastAssistId; // necessary/quiet: only the final one
  }
  // Injeção de hook: custo real no contexto, some junto com as ferramentas no modo quiet.
  if (it.kind === 'hook') return verbosity !== 'quiet';
  // Aviso do engine aparece em qualquer verbosidade: é a causa de algo que o usuário vai notar.
  if (it.kind === 'notice') return true;
  // tool
  if (it.name === 'AskUserQuestion' || isTodoToolName(it.name)) return true;
  if (verbosity === 'quiet') return false;
  return MERGE_EDIT.test(it.name); // necessary/dialogo: edits only
}

function ClaudeTurnView({
  items,
  t,
  defaultShowThinking,
  defaultOpenTools,
  todos,
  showTodos,
  answers,
  verbosity,
}: {
  items: (AssistantItem | ToolItem)[];
  t: Translator;
  defaultShowThinking: boolean;
  defaultOpenTools: boolean;
  todos: TodoItem[];
  showTodos: boolean;
  answers?: Record<string, string>;
  verbosity: string;
}) {
  const active = items.some((i) => i.kind === 'assistant' && !i.done);
  const canceled = items.some((i) => i.kind === 'assistant' && i.canceled);
  const turnEnd = turnEndTs(items);
  const turnStart = turnStartTs(items);
  const nodes: ReactNode[] = [];
  let todoShown = false;
  // Verbosity filters the DISPLAY (it changes nothing in the agent):
  //   verbose   = everything (as today)
  //   necessary = edits + final explanation
  //   dialogo   = edits + text of what it is doing (all the text)
  //   quiet     = only the final explanation
  const lastAssistId = [...items].reverse().find((i) => i.kind === 'assistant' && !isEmptyAssistant(i))?.id;
  const visible = items.filter((it) => visibleInTimeline(it, verbosity, lastAssistId));
  // Buffer to merge ADJACENT tools with the same key (same file/command).
  let group: ToolItem[] = [];
  let groupKey = '';
  const flushGroup = () => {
    if (group.length === 0) return;
    const grp = group;
    group = [];
    nodes.push(
      <div key={grp[0].id} className={`tl-step tool ${toolStatus(grp)}`}>
        <ToolCard items={grp} t={t} defaultOpen={defaultOpenTools} />
      </div>,
    );
  };
  for (const it of visible) {
    // ToolSearch is internal CLI plumbing (it loads deferred tool schemas): hidden.
    if (it.kind === 'tool' && it.name === 'ToolSearch') continue;
    // Task tools don't become cards: they feed the turn's single checklist.
    if (it.kind === 'tool' && isTodoToolName(it.name)) {
      flushGroup();
      if (showTodos && !todoShown && todos.length > 0) {
        nodes.push(
          <div key={`todo-${it.id}`} className="tl-step text">
            <TodoCard t={t} todos={todos} />
          </div>,
        );
        todoShown = true;
      }
      continue;
    }
    // AskUserQuestion: its own card (not merged).
    if (it.kind === 'tool' && it.name === 'AskUserQuestion') {
      flushGroup();
      nodes.push(
        <div key={it.id} className={`tl-step tool ${toolStatus([it])}`}>
          <AskCard item={it} t={t} answers={answers} />
        </div>,
      );
      continue;
    }
    // Other tools: accumulated in the group while the merge key holds.
    if (it.kind === 'tool') {
      const key = mergeKey(it);
      if (group.length && groupKey === key) group.push(it);
      else {
        flushGroup();
        group = [it];
        groupKey = key;
      }
      continue;
    }
    // Assistente (texto/thinking): quebra o grupo.
    flushGroup();
    // Nothing to show yet (AssistantContent renders nothing): no step, so no dot of its own.
    if (!it.text && !it.thinking) continue;
    nodes.push(
      <div key={it.id} className="tl-step text">
        <AssistantContent item={it} t={t} defaultShowThinking={defaultShowThinking} />
      </div>,
    );
  }
  flushGroup();
  return (
    <div className="bubble assistant turn">
      <div className="role role-assistant">
        <span className="role-name">{t('role.assistant')}</span>
        {canceled && <span className="canceled-tag">{t('turn.canceled')}</span>}
      </div>
      {nodes}
      {active && <div className="caret-row"><span className="caret">▋</span></div>}
      {!active && turnEnd != null && (
        <div className="turn-end">
          {fmtStamp(turnEnd)}
          {turnStart != null && turnEnd > turnStart && (
            <span className="turn-elapsed">{fmtMinSec(turnEnd - turnStart)}</span>
          )}
          <InfoTip t={t} title={t('role.assistant')} rows={turnRows(items, t)} />
        </div>
      )}
    </div>
  );
}

// A turn re-renders only when something it shows changed. `groupItems` builds a new `items`
// array on every render, so the default shallow compare would never hold; the items
// themselves keep their identity in the reducer unless they were patched.
const ClaudeTurn = memo(ClaudeTurnView, (a, b) => {
  if (
    a.t !== b.t ||
    a.defaultShowThinking !== b.defaultShowThinking ||
    a.defaultOpenTools !== b.defaultOpenTools ||
    a.showTodos !== b.showTodos ||
    a.verbosity !== b.verbosity ||
    a.answers !== b.answers ||
    a.items.length !== b.items.length
  ) {
    return false;
  }
  if (a.showTodos && a.todos !== b.todos) return false;
  return a.items.every((it, i) => it === b.items[i]);
});

/**
 * Faixa do contexto que um hook injetou. Mostra o hook, a skill reconhecida (quando o corpo
 * casa com um SKILL.md em disco) e o tamanho estimado — o mesmo custo que o card do `Skill`
 * exibe quando a carga vem pelo caminho normal.
 */
const HookBanner = memo(function HookBanner({ item, t }: { item: HookItem; t: Translator }) {
  return (
    <div className="hook-banner" id={`msg-${item.id}`}>
      <span className="hook-banner-mark">⚡</span>
      <span className="hook-banner-label">
        {item.skill ? t('timeline.hookSkill', item.skill) : t('timeline.hookContext')}
      </span>
      <span className="hook-banner-hook">{item.hook}</span>
      {item.tokens != null && (
        <span className="hook-banner-tk">{t('skills.activeTokens', fmtTk(item.tokens))}</span>
      )}
      {item.ts && <span className="hook-banner-time">{fmtStamp(item.ts)}</span>}
    </div>
  );
});

/**
 * Aviso do engine no meio da sessão: créditos do modo rápido esgotados, modelo de subagente
 * restrito rodando no modelo do pai. Sem esta faixa, o usuário só veria o efeito.
 */
const NoticeBanner = memo(function NoticeBanner({ item, t }: { item: NoticeItem; t: Translator }) {
  // Fronteira de compactação: não é aviso, é a MEDIDA do que saiu do contexto.
  const c = item.compaction;
  if (c) {
    const dropped = c.pre !== undefined && c.post !== undefined ? c.pre - c.post : undefined;
    return (
      <div className="notice-banner compact-banner" id={`msg-${item.id}`}>
        <span className="notice-banner-mark">⇲</span>
        <span className="notice-banner-label">
          {t(c.trigger === 'manual' ? 'timeline.compactManual' : 'timeline.compactAuto')}
        </span>
        <span className="notice-banner-text">
          {c.pre !== undefined && c.post !== undefined
            ? `${fmtTk(c.pre)} → ${fmtTk(c.post)}`
            : c.pre !== undefined
              ? fmtTk(c.pre)
              : ''}
          {dropped !== undefined && dropped > 0 && ` · −${fmtTk(dropped)}`}
          {c.durationMs !== undefined && ` · ${fmtMs(c.durationMs)}`}
        </span>
        {item.ts && <span className="notice-banner-time">{fmtStamp(item.ts)}</span>}
      </div>
    );
  }
  if (item.topic === 'compacting') {
    return (
      <div className="notice-banner compact-banner" id={`msg-${item.id}`}>
        <span className="notice-banner-spinner" aria-hidden="true" />
        <span className="notice-banner-label">{t('activity.compacting')}</span>
        {item.ts && <span className="notice-banner-time">{fmtStamp(item.ts)}</span>}
      </div>
    );
  }
  if (item.topic === 'stopped_elsewhere' || item.topic === 'daemon_restarted') {
    return (
      <div className="notice-banner" id={`msg-${item.id}`}>
        <span className="notice-banner-mark">⚠</span>
        <span className="notice-banner-text">
          {t(item.topic === 'stopped_elsewhere' ? 'timeline.stoppedElsewhere' : 'timeline.daemonRestarted')}
        </span>
      </div>
    );
  }
  if (item.topic === 'session_gone') {
    return (
      <div className="notice-banner" id={`msg-${item.id}`}>
        <span className="notice-banner-mark">⚠</span>
        <span className="notice-banner-text">{t('timeline.sessionGone')}</span>
      </div>
    );
  }
  if (item.topic === 'local_command' || item.topic === 'local_command_error') {
    const err = item.topic === 'local_command_error';
    return (
      <div className={`notice-banner local-command${err ? ' error' : ''}`} id={`msg-${item.id}`}>
        <span className="notice-banner-mark">›</span>
        <span className="notice-banner-label">{t('timeline.commandOutput')}</span>
        <span className="notice-banner-text">
          {item.text.split(/(`[^`]+`)/g).map((part, i) =>
            part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
              <code key={i}>{part.slice(1, -1)}</code>
            ) : (
              <span key={i}>{part}</span>
            ),
          )}
        </span>
        {item.ts && <span className="notice-banner-time">{fmtStamp(item.ts)}</span>}
      </div>
    );
  }
  return (
    <div className="notice-banner" id={`msg-${item.id}`}>
      <span className="notice-banner-mark">⚠</span>
      <span className="notice-banner-label">{t('timeline.engineNotice')}</span>
      <span className="notice-banner-text">{item.text}</span>
      {item.ts && <span className="notice-banner-time">{fmtStamp(item.ts)}</span>}
    </div>
  );
});

/**
 * The details of a message, tool call or turn. They used to pop up on hovering anywhere over
 * it; now only on this small (i). Not focusable inside a tool card's header (a button).
 */
function InfoTip({ t, title, rows, focusable = true }: { t: Translator; title: string; rows: TooltipRow[]; focusable?: boolean }) {
  return (
    <Tooltip className="info-tip" focusable={focusable} title={title} rows={rows}>
      <span className="info-tip-icon" role="img" aria-label={t('tip.details')} onClick={(e) => e.stopPropagation()}>
        <Icon name="info" size={12} />
      </span>
    </Tooltip>
  );
}

const UserBubble = memo(function UserBubble({
  item,
  t,
  userName,
  pinned,
  ordinal,
  onRewind,
}: {
  item: UserItem;
  t: Translator;
  userName?: string;
  pinned?: boolean;
  ordinal: number;
  onRewind?: (userIndex: number) => void;
}) {
  const openImage = useImageViewer();
  const [collapsed, setCollapsed] = useState(true);
  // It only makes sense to offer expanding when the text has more than one line.
  const collapsible = !!item.text && item.text.includes('\n');
  return (
    <div className={pinned ? 'pinned-wrap' : undefined}>
      <div className={`bubble user ${pinned ? 'pinned' : ''}`} id={`msg-${item.id}`}>
        <div className="role role-user">
          <span className="role-name">{userName || t('role.user')}</span>
          {item.ts && <span className="bubble-time">{fmtStamp(item.ts)}</span>}
          <InfoTip t={t} title={t('role.user')} rows={userRows(item, t)} />
          {item.queued && (
            <span className="bubble-queued" title={t('bubble.queuedHint')}>
              {t('bubble.queued')}
            </span>
          )}
          {item.text && <CopyButton text={item.text} t={t} />}
          {collapsible && (
            <button
              type="button"
              className="bubble-toggle"
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? t('bubble.showMore') : t('bubble.showLess')}
            </button>
          )}
          {onRewind && (
            <button
              type="button"
              className="msg-rewind"
              title={t('rewind.title')}
              onClick={() => onRewind(ordinal)}
            >
              ↶
            </button>
          )}
        </div>
        {item.images && item.images.length > 0 && (
          <div className="bubble-images">
            {item.images.map((src, i) => (
              <button
                type="button"
                className="bubble-image-btn"
                key={i}
                title={t('attach.view')}
                onClick={() => openImage(src)}
              >
                <img className="bubble-image" src={src} alt="" />
              </button>
            ))}
          </div>
        )}
        {item.text && (
          <pre
            className={`content hljs user-hl ${collapsible && collapsed ? 'user-hl--clamp' : ''}`}
            dangerouslySetInnerHTML={{ __html: richHighlight(item.text) }}
          />
        )}
      </div>
    </div>
  );
});


// Content of an assistant message, WITHOUT a role header (the turn already
// shows "Claude" once). Empty (no text and no thinking) renders nothing.
function AssistantContent({
  item,
  t,
  defaultShowThinking,
}: {
  item: AssistantItem;
  t: Translator;
  defaultShowThinking: boolean;
}) {
  const [showThinking, setShowThinking] = useState(defaultShowThinking);
  // The global default (setting) changed: re-syncs the already mounted blocks.
  useEffect(() => setShowThinking(defaultShowThinking), [defaultShowThinking]);
  if (!item.text && !item.thinking) return null;
  return (
    <div className="assistant-msg">
      {item.thinking && (
        <div className="thinking">
          <button type="button" className="link-btn" onClick={() => setShowThinking((s) => !s)}>
            {showThinking ? t('thinking.hide') : t('thinking.show')}
          </button>
          {showThinking && <pre className="thinking-body">{item.thinking}</pre>}
        </div>
      )}
      {item.text && (
        <div className="content">
          <Markdown text={item.text} />
          {item.done && <CopyButton text={item.text} t={t} />}
        </div>
      )}
    </div>
  );
}

const PEEK_LINES = 3;

/**
 * What a collapsed Bash card shows: the command itself, at most PEEK_LINES lines. A single call
 * shows its first lines; a merged card shows one line per command. `cut` says something is
 * hidden, so the last line fades out only then.
 */
function bashPeek(items: ToolItem[]): { text: string; cut: boolean } | undefined {
  const cmds = items
    .map((it) => (it.input as Record<string, unknown> | undefined)?.command)
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.replace(/\s+$/, '').split('\n'));
  if (cmds.length === 0) return undefined;
  if (cmds.length === 1) {
    const lines = cmds[0];
    return { text: lines.slice(0, PEEK_LINES).join('\n'), cut: lines.length > PEEK_LINES };
  }
  const shown = cmds.slice(0, PEEK_LINES);
  const text = shown.map((l) => (l.length > 1 ? `${l[0]} …` : l[0])).join('\n');
  const last = shown[shown.length - 1];
  return { text, cut: cmds.length > PEEK_LINES || last.length > 1 };
}

/** Aggregated status of a (merged) tool card: error when any failed, busy while any runs. */
function toolStatus(items: ToolItem[]): 'ok' | 'busy' | 'err' {
  if (items.some((i) => i.isError)) return 'err';
  return items.some((i) => !i.done) ? 'busy' : 'ok';
}

function ToolCard({ items, t, defaultOpen }: { items: ToolItem[]; t: Translator; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // The global default (setting) changed: re-syncs the already mounted cards.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const item = items[0]; // primary (header)
  const last = items[items.length - 1];
  const peek = !open && item.name === 'Bash' ? bashPeek(items) : undefined;
  const peekHtml = useMemo(() => (peek ? highlightCode(peek.text, 'bash').html : ''), [peek?.text]);
  const merged = items.length > 1;
  const statusCls = toolStatus(items);
  const input = (item.input ?? {}) as Record<string, unknown>;
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const name = item.name;
  // EndConversation: the agent closed the session itself. Surface the reason it gave.
  const endReason =
    name === 'EndConversation'
      ? (typeof input.reason === 'string' && input.reason) ||
        (typeof input.message === 'string' && input.message) ||
        undefined
      : undefined;

  return (
    <div className={`tool-card ${statusCls}${name === 'EndConversation' ? ' end-conversation' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-icon">{toolIcon(name)}</span>
        <span className="tool-name">{name}{merged && <span className="tool-count">×{items.length}</span>}</span>
        {filePath && (
          <span
            className="tool-file"
            title={filePath}
            role="link"
            onClick={(e) => {
              e.stopPropagation();
              send({ kind: 'openLink', href: filePath });
            }}
          >
            {basename(filePath)}
          </span>
        )}
        {/* Skill cujo corpo entrou no contexto: o custo fica visível no momento em que
            acontece, não só no painel. Sem tamanho informado, mostra só o selo. */}
        {item.skillLoaded && (
          <span className="tool-skill-load" title={t('skills.legend.active')}>
            ⚡ <span className="tool-skill-name">{item.skillLoaded}</span>
            {' · '}
            {item.skillTokens != null ? t('skills.activeTokens', fmtTk(item.skillTokens)) : t('skills.obs.active')}
          </span>
        )}
        {last.ts && <span className="tool-time">{fmtStamp(last.ts)}</span>}
        <InfoTip t={t} title={name} rows={toolRows(item, t)} focusable={false} />
        {filePath && hasPreview(filePath) && (
          <span
            className="tool-view"
            title={t('tool.view')}
            role="link"
            onClick={(e) => {
              e.stopPropagation();
              send({ kind: 'openLink', href: filePath, preview: true });
            }}
          >
            {t('tool.view')}
          </span>
        )}
        <span className="tool-status">
          {statusCls === 'err' ? t('tool.error') : statusCls === 'busy' ? t('tool.running') : ''}
        </span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {name === 'EndConversation' && (
        <div className="tool-end-banner">
          {t('tool.endConversation')}
          {endReason && <span className="tool-end-reason"> — {endReason}</span>}
        </div>
      )}
      {peek && (
        <div className={`tool-peek${peek.cut ? ' cut' : ''}`} onClick={() => setOpen(true)}>
          <pre className="tool-peek-code">
            <code className="hljs" dangerouslySetInnerHTML={{ __html: peekHtml }} />
          </pre>
        </div>
      )}
      {open && (
        <div className="tool-body">
          {item.subagentText && (
            <div className="tool-subagent">
              <div className="tool-subagent-label">{t('tool.subagent')}</div>
              <Markdown text={item.subagentText} />
            </div>
          )}
          {items.map((it, i) => (
            <div key={it.id} className={i > 0 ? 'tool-merge-part' : undefined}>
              {renderBody(it)}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  function renderBody(item: ToolItem) {
    const input = (item.input ?? {}) as Record<string, unknown>;
    const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
    // A file whose type we do not know is plain text, not whatever highlight.js guesses from it.
    const lang = languageFromPath(filePath) ?? (filePath ? 'plaintext' : undefined);
    const name = item.name;
    const command = typeof input.command === 'string' ? input.command : undefined;
    const description = typeof input.description === 'string' ? input.description : undefined;
    const writeContent =
      typeof input.content === 'string'
        ? input.content
        : typeof input.new_string === 'string'
          ? input.new_string
          : undefined;
    // Bash: highlighted shell command + output (stdout) as text.
    if (name === 'Bash' && command !== undefined) {
      const out = item.result !== undefined ? toText(item.result) : undefined;
      const denials = out ? sandboxDenials(out) : [];
      return (
        <>
          {description && <div className="tool-desc">{description}</div>}
          <div className="tool-section-label">{t('tool.command')}</div>
          <CodeBlock code={command} language="bash" />
          {denials.length > 0 && (
            <div className="tool-sandbox">
              <div className="tool-sandbox-head">⛨ {t('tool.sandboxDenied')}</div>
              <ul className="tool-sandbox-list">
                {denials.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {out !== undefined && (
            <>
              <div className="tool-section-label">{t('tool.output')}</div>
              <pre className="tool-pre">{out}</pre>
            </>
          )}
        </>
      );
    }
    // Read: splits the numbering (cat -n) into a gutter and highlights the clean content.
    if (name === 'Read' && item.result !== undefined) {
      const raw = toText(item.result);
      const parsed = stripLineNumbers(raw);
      return (
        <CodeBlock
          code={parsed ? parsed.code : raw}
          language={lang}
          lineNumbers={parsed?.numbers}
        />
      );
    }
    // Edit: diff lado-a-lado de old_string -> new_string.
    if (name === 'Edit' && typeof input.old_string === 'string') {
      return (
        <DiffView
          oldText={input.old_string}
          newText={typeof input.new_string === 'string' ? input.new_string : ''}
        />
      );
    }
    // MultiEdit: one diff per edit.
    if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      return (
        <>
          {(input.edits as Record<string, unknown>[]).map((e, i) => (
            <DiffView
              key={i}
              oldText={typeof e.old_string === 'string' ? e.old_string : ''}
              newText={typeof e.new_string === 'string' ? e.new_string : ''}
            />
          ))}
        </>
      );
    }
    // Write: highlighted new content.
    if (name === 'Write' && writeContent !== undefined) {
      return <CodeBlock code={writeContent} language={lang} />;
    }
    // Generic: raw input and output (safe for any tool).
    return (
      <>
        <div className="tool-section-label">{t('tool.input')}</div>
        <pre className="tool-pre">{stringify(item.input)}</pre>
        {item.result !== undefined && (
          <>
            <div className="tool-section-label">{t('tool.output')}</div>
            <pre className="tool-pre">{toText(item.result)}</pre>
          </>
        )}
      </>
    );
  }
}

// AskUserQuestion: inline modal-like view — questions + options with the choice
// marked. Always open. Answers come from the tab's live state; in a resumed
// retomada, caem no parse do tool_result.
function AskCard({
  item,
  t,
  answers,
}: {
  item: ToolItem;
  t: Translator;
  answers?: Record<string, string>;
}) {
  const input = (item.input ?? {}) as { questions?: AskQuestion[] };
  const questions = input.questions ?? [];
  if (questions.length === 0) {
    return (
      <div className="tool-card ok">
        <div className="tool-body">
          <pre className="tool-pre">{stringify(item.input)}</pre>
        </div>
      </div>
    );
  }

  const parsed = parseAnswersFromResult(toText(item.result), questions);
  const answerOf = (q: string): string => (answers?.[q] ?? parsed[q] ?? '').trim();
  const anyAnswered = questions.some((q) => answerOf(q.question).length > 0);

  return (
    <div className="ask-card">
      <div className="ask-card-head">
        <span className="ask-icon">?</span>
        <span className="ask-card-title">{t(anyAnswered ? 'ask.answered' : 'ask.title')}</span>
      </div>

      {questions.map((q, i) => {
        const known = new Set(q.options.map((o) => o.label));
        const { core, note } = splitAnswerNote(answerOf(q.question), known);
        const choices = parseChoices(core, known);
        const picked = new Set(choices.picked);
        const other = choices.other;
        return (
          <div className="ask-card-q" key={i}>
            <div className="ask-card-qhead">
              {q.header && <span className="ask-card-chip">{dec(q.header)}</span>}
              {q.multiSelect && <span className="ask-card-multi">{t('ask.multiHint')}</span>}
            </div>
            <div className="ask-question">{dec(q.question)}</div>
            <div className="ask-options ask-options-static">
              {q.options.map((opt, oi) => {
                const active = picked.has(opt.label);
                return (
                  <div key={oi} className={`ask-option ${active ? 'active' : 'dim'}`}>
                    <span className={`ask-ctrl ${q.multiSelect ? 'check' : 'radio'} ${active ? 'on' : ''}`} />
                    <span className="ask-opt-text">
                      <span className="ask-opt-label">{dec(opt.label)}</span>
                      {opt.description && <span className="ask-opt-desc">{dec(opt.description)}</span>}
                    </span>
                  </div>
                );
              })}
              {other && (
                <div className="ask-option active">
                  <span className={`ask-ctrl ${q.multiSelect ? 'check' : 'radio'} on`} />
                  <span className="ask-opt-text">
                    <span className="ask-opt-label">{t('ask.other')}</span>
                    <span className="ask-opt-desc">{other}</span>
                  </span>
                </div>
              )}
            </div>
            {/* Texto que o usuário acrescentou à escolha (editor por aba do modal). */}
            {note && (
              <div className="ask-card-note">
                <span className="ask-card-note-label">{t('ask.notesCard')}</span>
                <span className="ask-card-note-text">{note}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Extrai pares pergunta->resposta do tool_result. Formato do CLI:
//   User has answered your questions: "Q1"="A1". "Q2"="A2". You can now continue…
// Anchored on the exact question texts (the answer may contain quotes).
function parseAnswersFromResult(text: string, questions: AskQuestion[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (let i = 0; i < questions.length; i++) {
    const key = `"${questions[i].question}"="`;
    const at = text.indexOf(key);
    if (at < 0) continue;
    const start = at + key.length;
    let end = text.length;
    for (let j = 0; j < questions.length; j++) {
      if (j === i) continue;
      const p = text.indexOf(`"${questions[j].question}"="`, start);
      if (p >= 0 && p < end) end = p;
    }
    let seg = text.slice(start, end);
    seg = seg.replace(/\s*You can now continue with the user's answers in mind\.?\s*$/, '');
    seg = seg.trim().replace(/"\.?\s*$/, '');
    out[questions[i].question] = seg;
  }
  return out;
}

// Extrai texto de um tool_result (string ou array de blocos {type:'text'}).
function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        b && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : typeof b === 'string'
            ? b
            : JSON.stringify(b),
      )
      .join('');
  }
  if (v && typeof (v as { text?: unknown }).text === 'string') return (v as { text: string }).text;
  return stringify(v);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Latest timestamp of the turn (end of the interaction): the turnComplete endTs or,
// in a resumed session, the largest ts among the items (assistant/tool).
function turnEndTs(items: (AssistantItem | ToolItem)[]): number | undefined {
  let m = 0;
  for (const it of items) {
    if (it.endTs) m = Math.max(m, it.endTs);
    if (it.ts) m = Math.max(m, it.ts);
  }
  return m || undefined;
}

// First stamp of the turn (start of the prompt's execution).
function turnStartTs(items: (AssistantItem | ToolItem)[]): number | undefined {
  let m = Infinity;
  for (const it of items) if (it.ts) m = Math.min(m, it.ts);
  return Number.isFinite(m) ? m : undefined;
}

// Full date + time (HH:MM:SS) in the PC's region format.
function fmtStamp(ts: number): string {
  const region = window.__TOOTEGA_REGION__ || navigator.language || undefined;
  try {
    return new Intl.DateTimeFormat(region, { dateStyle: 'short', timeStyle: 'medium' }).format(
      new Date(ts),
    );
  } catch {
    return '';
  }
}

// ---- Hint lines (communication data that doesn't show up in the timeline) ----

function userRows(item: UserItem, t: Translator): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (item.ts) rows.push({ label: t('tip.time'), value: fmtClock(item.ts) });
  rows.push({ label: t('tip.chars'), value: fmtCompact(item.text.length) });
  rows.push({ label: t('tip.words'), value: fmtCompact(countWords(item.text)) });
  if (item.images?.length) rows.push({ label: t('tip.images'), value: String(item.images.length) });
  return rows;
}

function toolRows(item: ToolItem, t: Translator): TooltipRow[] {
  const inp = (item.input ?? {}) as Record<string, unknown>;
  const rows: TooltipRow[] = [];
  // Arquivo envolvido primeiro: distingue cards iguais ("Edit", "Read"…).
  if (typeof inp.file_path === 'string' && inp.file_path) {
    rows.push({ label: t('tip.file'), value: basename(inp.file_path), accent: true });
  }
  if (item.ts) rows.push({ label: t('tip.time'), value: fmtClock(item.ts) });
  rows.push({ label: t('tip.inputSize'), value: fmtBytes(byteLen(stringify(item.input))) });
  if (item.result !== undefined) {
    const out = toText(item.result);
    rows.push({ label: t('tip.outputSize'), value: fmtBytes(byteLen(out)) });
    rows.push({ label: t('tip.lines'), value: fmtCompact(countLines(out)) });
  }
  if (item.ts && item.endTs) {
    rows.push({ label: t('tip.duration'), value: fmtMs(item.endTs - item.ts) });
  }
  if (item.isError) rows.push({ label: t('tip.status'), value: t('tool.error'), accent: true });
  rows.push({ label: t('tip.id'), value: item.id.slice(0, 12) });
  return rows;
}

function turnRows(items: (AssistantItem | ToolItem)[], t: Translator): TooltipRow[] {
  const assistants = items.filter((i): i is AssistantItem => i.kind === 'assistant');
  const toolCount = items.filter((i) => i.kind === 'tool').length;
  const outChars = assistants.reduce((s, a) => s + a.text.length, 0);
  const thinkChars = assistants.reduce((s, a) => s + a.thinking.length, 0);
  const firstTs = assistants.find((a) => a.ts)?.ts;
  const withUsage = [...assistants].reverse().find((a) => a.usage || a.costUsd != null);
  const rows: TooltipRow[] = [];
  if (firstTs) rows.push({ label: t('tip.time'), value: fmtClock(firstTs) });
  rows.push({ label: t('tip.outChars'), value: fmtCompact(outChars) });
  rows.push({ label: t('tip.estTokens'), value: `~${fmtCompact(Math.round(outChars / 4))}` });
  if (thinkChars) rows.push({ label: t('tip.thinking'), value: fmtCompact(thinkChars) });
  if (toolCount) rows.push({ label: t('tip.tools'), value: String(toolCount) });
  const u = withUsage?.usage;
  if (u) {
    if (u.input != null) rows.push({ label: t('tip.tokensIn'), value: fmtCompact(u.input) });
    if (u.output != null) rows.push({ label: t('tip.tokensOut'), value: fmtCompact(u.output) });
    if (u.cacheRead != null) rows.push({ label: t('tip.cacheRead'), value: fmtCompact(u.cacheRead) });
    if (u.cacheCreate != null) {
      rows.push({ label: t('tip.cacheCreate'), value: fmtCompact(u.cacheCreate) });
    }
    const totalIn = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreate ?? 0);
    if (totalIn > 0 && u.cacheRead != null) {
      rows.push({ label: t('tip.cacheHit'), value: `${Math.round((u.cacheRead / totalIn) * 100)}%` });
    }
  }
  if (withUsage?.costUsd != null) {
    rows.push({ label: t('tip.cost'), value: fmtUsdShort(withUsage.costUsd), accent: true });
  }
  return rows;
}
