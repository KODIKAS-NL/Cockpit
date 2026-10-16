import { useState, useRef, useEffect } from 'react';
import type { Translator } from '../i18n';
import { Icon, type IconName } from './Icon';
import type { StatsSnapshot, SessionInfo, UsageBucket, ScopedBucket } from '../../../shared/protocol';
import { fmtInt, fmtPct, fmtCompact, fmtBytes, fmtDuration, fmtUsdShort } from '../util/format';
import type { TooltipRow } from './Tooltip';
import { Tooltip, type TooltipMeta } from './Tooltip';
import { send } from '../vscodeApi';
import { LimitBars } from './LimitBars';

// Provenance of a piece of data: source + confidence level, already localized, for the
// hint footer (colored chips). It keeps the i18n descriptions clean.
type Origin = 'server' | 'local' | 'computed' | 'estimate' | 'cli';
function meta(t: Translator, origin: Origin, confidence: 'high' | 'medium' | 'low'): TooltipMeta {
  return {
    originLabel: t('meta.origin.label'),
    origin: t(`meta.origin.${origin}`),
    confidenceLabel: t('meta.conf.label'),
    confidence,
    confidenceText: t(`meta.conf.${confidence}`),
  };
}

interface Props {
  t: Translator;
  locale: string;
  cliMissing: boolean;
  cockpitVersion?: string;
  cliVersion?: string;
  daemon?: { enabled: boolean; connected: boolean; pid?: number };
  onDaemonInstall: () => void;
  cliLatest?: string;
  stats?: StatsSnapshot;
  limits?: { live: boolean; fiveHour?: UsageBucket; sevenDay?: UsageBucket; weeklyScoped?: ScopedBucket[] };
  busy?: boolean; // contexto ativo processando um turno → spinner no card
  loggedIn: boolean;
  sessions: SessionInfo[];
  activeSessionId?: string;
  busySessions?: Set<string>; // sessionIds with a turn in progress → spinner on the card
  onNewSession: () => void;
  onSettings: () => void;
  onUsage: () => void;
  onPlugins: () => void;
  onMcp: () => void;
  onSkills: () => void;
  onCredentials: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onUpdate: () => void;
  onInstall: () => void;
  onOpenLink: (href: string) => void;
  onResume: (id: string) => void;
  onReload: (id: string) => void;
  onRemote: (id: string) => void;
  onDelete: (session: SessionInfo) => void;
  onRename: (session: SessionInfo, name: string) => void;
  onDeleteAll: () => void;
}

// Hub in the Activity Bar: the control center. Button bar + info of the active
// context (context window + session controls) + grid of saved contexts.
// Each context's chat lives in its own webview in the editor.
export function HubView({
  t,
  locale,
  cliMissing,
  cockpitVersion,
  cliVersion,
  daemon,
  onDaemonInstall,
  cliLatest,
  stats,
  limits,
  busy,
  loggedIn,
  sessions,
  activeSessionId,
  busySessions,
  onNewSession,
  onSettings,
  onUsage,
  onPlugins,
  onMcp,
  onSkills,
  onCredentials,
  onLogin,
  onLogout,
  onUpdate,
  onInstall,
  onOpenLink,
  onResume,
  onReload,
  onRemote,
  onDelete,
  onRename,
  onDeleteAll,
}: Props) {
  // The button bar's items grow to fill their row, except a single button left alone on the
  // last row, which keeps its natural width. Flexbox cannot tell how many items share a row, so
  // this marks that button (`lone`) whenever the layout changes.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const mark = () => {
      const items = Array.from(bar.children) as HTMLElement[];
      items.forEach((el) => el.classList.remove('lone'));
      if (items.length < 2) return;
      const last = items[items.length - 1];
      if (last.offsetTop > items[items.length - 2].offsetTop + 2) last.classList.add('lone');
    };
    mark();
    const ro = new ResizeObserver(mark);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [loggedIn, locale]);

  return (
    <div className="hub">
      <header className="hub-head">
        <div className="hub-title-row">
          <svg className="hub-logo" width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs><linearGradient id="hub-g" x1="0.1" y1="0.9" x2="0.9" y2="0.1"><stop offset="0" stopColor="#4da3ff"/><stop offset="0.55" stopColor="#ff9a3c"/><stop offset="1" stopColor="#ff5a1f"/></linearGradient></defs>
            <path d="M5.92 18.08A8.6 8.6 0 1 1 18.08 18.08" fill="none" stroke="url(#hub-g)" strokeWidth="2" strokeLinecap="round"/>
            <line x1="15.77" y1="9.36" x2="18.06" y2="7.76" stroke="#ff7a18" strokeWidth="2" strokeLinecap="round"/>
            <path d="M12 8.1Q12.78 11.22 15.9 12Q12.78 12.78 12 15.9Q11.22 12.78 8.1 12Q11.22 11.22 12 8.1Z" fill="#ffb066"/>
          </svg>
          <span className="hub-title">Cockpit for Claude Code</span>
        </div>
        {/* One line, never wrapping: daemon status first, then the versions. */}
        <div className="hub-status-row">
          {daemon?.enabled && (
            <>
              <Tooltip
                text={
                  daemon.connected
                    ? t('daemon.tip.connected', daemon.pid ?? '?')
                    : t('daemon.tip.disconnected')
                }
              >
                <span className={`hub-daemon ${daemon.connected ? 'on' : 'off'}`}>
                  <span className="hub-daemon-dot" aria-hidden="true" />
                  <span className="hub-daemon-label">{t('daemon.label')}: </span>
                  {daemon.connected ? t('daemon.connected') : t('daemon.disconnected')}
                </span>
              </Tooltip>
              {!daemon.connected && (
                <button type="button" className="hub-update install" onClick={onDaemonInstall}>
                  {t('daemon.install')}
                </button>
              )}
            </>
          )}
          {cockpitVersion && <span className="hub-ver">v{cockpitVersion}</span>}
          {cliVersion ? (
            <>
              <Tooltip
                text={
                  cliBelowMin(cliVersion)
                    ? t('about.cliBelowMin', MIN_CLI_VERSION)
                    : t('about.cliReleaseNotes')
                }
              >
                <button
                  type="button"
                  className={`hub-cli ${cliOutdated(cliVersion, cliLatest) || cliBelowMin(cliVersion) ? 'outdated' : ''}`}
                  onClick={() => onOpenLink(CLI_RELEASES_URL)}
                >
                  CLI {semver(cliVersion) ?? cliVersion}
                </button>
              </Tooltip>
              {(cliOutdated(cliVersion, cliLatest) || cliBelowMin(cliVersion)) && (
                <Tooltip
                  text={
                    cliBelowMin(cliVersion)
                      ? t('about.cliBelowMin', MIN_CLI_VERSION)
                      : t('about.cliOutdated', semver(cliLatest) ?? cliLatest ?? '')
                  }
                >
                  <button type="button" className="hub-update" onClick={onUpdate}>
                    ↑ {t('about.update')}
                  </button>
                </Tooltip>
              )}
            </>
          ) : (
            <Tooltip text={t('about.install.tip')}>
              <button type="button" className="hub-update install" onClick={onInstall}>
                ⤓ {t('about.install')}
              </button>
            </Tooltip>
          )}
        </div>
      </header>

      {/* Barra de botões */}
      <div className="ctx-panel-actions" ref={barRef}>
        <Tooltip title={t('usage.title')} text={t('tip.usage.desc')}>
          <button type="button" className="ctx-link" onClick={onUsage}>
            <Icon name="usage" /> {t('usage.button')}
          </button>
        </Tooltip>
        {loggedIn ? (
          <Tooltip title={t('tip.logout.title')} text={t('tip.logout.desc')}>
            <button type="button" className="ctx-link" onClick={onLogout}>
              <Icon name="signOut" /> {t('tip.logout.title')}
            </button>
          </Tooltip>
        ) : (
          <Tooltip title={t('tip.login.title')} text={t('tip.login.desc')}>
            <button type="button" className="ctx-link" onClick={onLogin}>
              <Icon name="signIn" /> {t('tip.login.title')}
            </button>
          </Tooltip>
        )}
        <Tooltip title={t('plugins.title')} text={t('plugins.desc')}>
          <button type="button" className="ctx-link" onClick={onPlugins}>
            <Icon name="plugins" /> {t('plugins.title')}
          </button>
        </Tooltip>
        <Tooltip title={t('mcp.title')} text={t('mcp.desc')}>
          <button type="button" className="ctx-link" onClick={onMcp}>
            <Icon name="mcp" /> {t('mcp.title')}
          </button>
        </Tooltip>
        <Tooltip title={t('skills.title')} text={t('skills.desc')}>
          <button type="button" className="ctx-link" onClick={onSkills}>
            <Icon name="skills" /> {t('skills.title')}
          </button>
        </Tooltip>
        <Tooltip title={t('creds.title')} text={t('creds.open')}>
          <button type="button" className="ctx-link" onClick={onCredentials}>
            <Icon name="vault" /> {t('creds.title')}
          </button>
        </Tooltip>
        <Tooltip
          className="hub-settings-wrap"
          title={t('tip.settings.title')}
          text={t('tip.settings.desc')}
        >
          <button type="button" className="ctx-link" onClick={onSettings}>
            <Icon name="settings" /> {t('tip.settings.title')}
          </button>
        </Tooltip>
      </div>

      {limits?.live && (
        <LimitBars t={t} locale={locale} fiveHour={limits.fiveHour} sevenDay={limits.sevenDay} weeklyScoped={limits.weeklyScoped} onClick={onUsage} />
      )}

      {/* Everything below the header and the buttons scrolls. */}
      <div className="ctx-panel-body">
        {/* Painel de informações do contexto ativo */}
        <section className="ctx-panel-info">
          {cliMissing ? (
            <div className="muted">{t('status.cliMissing')}</div>
          ) : stats ? (
            <ContextInfo t={t} locale={locale} stats={stats} busy={busy} />
          ) : (
            <div className="muted">{t('ctxPanel.noStats')}</div>
          )}
        </section>

        <div className="ctx-panel-sep" role="separator" />

        {/* Grade de contextos salvos (sessões) */}
        <section className="ctx-panel-grid-wrap">
          <div className="ctx-panel-grid-head">
            <span className="col-title">
              {t('ctxPanel.contexts')} {sessions.length}
            </span>
            <span className="ctx-panel-grid-tools">
              <Tooltip text={t('sessions.startNew')}>
                <button
                  type="button"
                  className="ctx-link ctx-icon-btn hub-new"
                  aria-label={t('sessions.startNew')}
                  onClick={onNewSession}
                >
                  <Icon name="plus" />
                </button>
              </Tooltip>
              {sessions.length > 0 && (
                <Tooltip text={t('tip.deleteAll.title')}>
                  <button
                    type="button"
                    className="ctx-link ctx-icon-btn hub-del-all"
                    aria-label={t('tip.deleteAll.title')}
                    onClick={onDeleteAll}
                  >
                    <Icon name="trash" />
                  </button>
                </Tooltip>
              )}
            </span>
          </div>
          {sessions.length === 0 ? (
            <div className="muted sessions-empty">{t('sessions.empty')}</div>
          ) : (
            <div className="ctx-groups">
              {groupSessions(sessions).map((g) => (
                <div className="ctx-group" key={g.key}>
                  <div className="ctx-group-head">{t(g.key as Parameters<typeof t>[0])}</div>
                  <div className="ctx-grid">
                    {g.items.map((s) => (
                      <SessionCard
                        key={s.id}
                        s={s}
                        t={t}
                        active={s.id === activeSessionId}
                        stats={s.id === activeSessionId ? stats : undefined}
                        locale={locale}
                        running={(busySessions?.has(s.id) ?? false) || s.live === 'busy'}
                        onResume={onResume}
                        onReload={onReload}
                        onRemote={onRemote}
                        onDelete={onDelete}
                        onRename={onRename}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// Card of a saved context. Click to open; ✏ enters inline name editing,
// 🗑 removes it. On save it fires onRename (the host persists it and updates the title of the
// webview aberta, se houver).
function SessionCard({
  s,
  t,
  active,
  stats,
  locale,
  running,
  onResume,
  onReload,
  onRemote,
  onDelete,
  onRename,
}: {
  s: SessionInfo;
  t: Translator;
  active: boolean;
  stats?: StatsSnapshot; // only given for the active session
  locale: string;
  running: boolean;
  onResume: (id: string) => void;
  onReload: (id: string) => void;
  onRemote: (id: string) => void;
  onDelete: (session: SessionInfo) => void;
  onRename: (session: SessionInfo, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [draft, setDraft] = useState(s.title || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEdit(): void {
    setDraft(s.title || '');
    setEditing(true);
  }
  function commit(): void {
    const name = draft.trim();
    if (name && name !== s.title) onRename(s, name);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className={`ctx-card editing ${active ? 'active' : ''}`}>
        <input
          ref={inputRef}
          className="ctx-card-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={commit}
          aria-label={t('sessions.rename')}
        />
        <span className="ctx-card-meta">
          {fmtDate(s.updatedAt)} · {s.messageCount} {t('sessions.messages')}
        </span>
      </div>
    );
  }

  const title = s.title || t('session.untitled');
  return (
    <div className="ctx-card-wrap">
      {/* A small tab on the card's top edge, outside the button: the title keeps the full width. */}
      <span className="ctx-card-tools">
        <CardAction icon="info" label={t('sessions.details')} pressed={infoOpen} keep onClick={() => setInfoOpen((o) => !o)} />
        <CardAction icon="remote" label={t('sessions.remote')} onClick={() => onRemote(s.id)} />
        <CardAction icon="reload" label={t('sessions.reload')} onClick={() => onReload(s.id)} />
        <CardAction icon="edit" label={t('sessions.rename')} onClick={startEdit} />
        <CardAction icon="trash" label={t('sessions.delete')} danger onClick={() => onDelete(s)} />
      </span>
      <button
        type="button"
        className={`ctx-card ${active ? 'active' : ''} ${running ? 'running' : ''}`}
        onClick={() => onResume(s.id)}
      >
        <Tooltip className="ctx-card-title-wrap" text={title}>
          <span className="ctx-card-title">
            {running && (
              <span
                className="voice-spinner ctx-card-spinner"
                role="status"
                title={t('status.busy')}
                aria-label={t('status.busy')}
              />
            )}
            {title}
          </span>
        </Tooltip>
        <span className="ctx-card-meta">
          {fmtDate(s.updatedAt)} · {s.messageCount} {t('sessions.messages')}
          {s.sizeBytes != null && <span className="muted"> · {fmtBytes(s.sizeBytes)}</span>}
          {s.live && (
            <span className="ctx-card-live" title={t('sessions.liveHint')}>
              {' '}· ● {t(s.live === 'busy' ? 'sessions.liveBusy' : 'sessions.live')}
            </span>
          )}
        </span>
      </button>
      {infoOpen && <SessionDetails t={t} locale={locale} session={s} stats={stats} />}
    </div>
  );
}

// One small icon button on a session card.
function CardAction({
  icon,
  label,
  pressed,
  danger,
  keep,
  onClick,
}: {
  icon: IconName;
  label: string;
  pressed?: boolean;
  danger?: boolean;
  keep?: boolean; // stays visible on the active card; the others show on hover
  onClick: () => void;
}) {
  return (
    <span
      className={`ctx-card-act ${pressed ? 'open' : ''} ${danger ? 'danger' : ''} ${keep ? 'keep' : ''}`}
      title={label}
      aria-label={label}
      role="button"
      aria-pressed={pressed}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} />
    </span>
  );
}

// Cache life (1h TTL): the keep-alive checkbox, and, only while it is unchecked, the time left.
// With keep-alive on the cache is refreshed before it expires, so the countdown says nothing.
// `now` comes from the parent's 1s tick (live countdown).
function CacheLife({ t, stats, now }: { t: Translator; stats: StatsSnapshot; now: number }) {
  const expiresAt = stats.cacheExpiresAt ?? 0;
  const lifeMs = stats.cacheLifeMs || 3_600_000;
  const remaining = Math.max(0, expiresAt - now);
  const alive = remaining > 0;
  const pct = Math.min(1, remaining / lifeMs); // fraction of REMAINING life
  const band = !alive ? 'crit' : pct > 0.25 ? 'ok' : pct > 0.08 ? 'warn' : 'crit';
  const keep = !!stats.keepCacheAlive;
  return (
    <div className="ctx-cache">
      {!keep && (
        <Tooltip className="tt-block" title={t('stats.cache.life')} text={t('tip.ctx.cacheLife')} meta={meta(t, 'computed', 'low')}>
          <div className="stat-row stat-row-session">
            <span className="stat-k">{t('stats.cache.life')}</span>
            <span className={`stat-v ${band}`}>
              {alive ? t('stats.cache.life.left', fmtDuration(remaining)) : t('stats.cache.life.expired')}
            </span>
          </div>
          <div className="meter">
            <div className={`meter-fill ${band}`} style={{ width: `${pct * 100}%` }} />
          </div>
        </Tooltip>
      )}
      <label className="ctx-keepalive">
        <input
          type="checkbox"
          checked={keep}
          onChange={(e) => send({ kind: 'setKeepCacheAlive', value: e.target.checked })}
        />
        <span>{t('stats.cache.keepAlive')}</span>
      </label>
    </div>
  );
}

// What stays on the dashboard: the context window and the cache keep-alive. The rest of the
// session's numbers live under the (i) on the active session card (SessionDetails).
function ContextInfo({
  t,
  locale,
  stats,
  busy,
}: {
  t: Translator;
  locale: string;
  stats: StatsSnapshot;
  busy?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  // The cache countdown is only shown without keep-alive: tick only then.
  const counting = stats.cacheExpiresAt != null && !stats.keepCacheAlive;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [counting]);

  const used = stats.contextUsed;
  const limit = stats.contextLimit || 1;
  const pct = Math.min(1, used / limit);
  const band = pct < 0.6 ? 'ok' : pct < 0.85 ? 'warn' : 'crit';

  return (
    <>
      <Tooltip className="tt-block" title={t('stats.context')} text={t('tip.ctx.context')} meta={meta(t, 'server', 'high')}>
        <div className="ctx-info-head">
          <span className="col-title">
            {t('stats.context')}
            {busy && (
              <span
                className="voice-spinner ctx-info-spinner"
                role="status"
                title={t('status.busy')}
                aria-label={t('status.busy')}
              />
            )}
          </span>
          <span className={`ctx-info-pct ${band}`}>{fmtPct(pct)}</span>
        </div>
        <div className="meter">
          <div className={`meter-fill ${band}`} style={{ width: `${pct * 100}%` }} />
        </div>
        <div className="ctx-info-nums">{t('stats.context.used', fmtInt(used, locale), fmtInt(limit, locale))}</div>
      </Tooltip>
      {pct >= 0.85 && <div className="alert">{t('alert.contextHigh')}</div>}

      {stats.cacheExpiresAt != null && <CacheLife t={t} stats={stats} now={now} />}
    </>
  );
}

// The numbers of the active session, in a compact two-column layout; opened with the (i) on its
// card. Tokens, cache, cost and activity, as they used to sit on the dashboard.
function SessionDetails({
  t,
  locale,
  session,
  stats,
}: {
  t: Translator;
  locale: string;
  session: SessionInfo;
  stats?: StatsSnapshot; // only for the active session
}) {
  const peak =
    stats && stats.peakContextUsed != null && stats.peakContextUsed > 0
      ? (() => {
          const peakPct = fmtPct(Math.min(1, stats.peakContextUsed / (stats.contextLimit || 1)));
          const peakStr = `${fmtCompact(stats.peakContextUsed)} (${peakPct})`;
          // Old sessions have no persisted peakCacheTokens: the current cache is the fallback.
          const peakCache = stats.peakCacheTokens ?? stats.cacheReadTokens + stats.cacheCreateTokens;
          return peakCache > 0 ? `${peakStr} · cache ${fmtCompact(peakCache)}` : peakStr;
        })()
      : undefined;
  return (
    <div className="ctx-details">
      <div className="ctx-details-grid">
        {sessionRows(session, t).map((r) => (
          <div
            className={`stat-row ${r.label === t('tip.sess.created') || r.label === t('tip.sess.updated') ? 'ctx-details-wide' : ''}`}
            key={r.label}
          >
            <span className="stat-k">{r.label}</span>
            <span className={`stat-v ${r.accent ? 'accent' : ''}`}>{r.value}</span>
          </div>
        ))}
      </div>
      {stats && <SessionStats t={t} locale={locale} stats={stats} peak={peak} />}
    </div>
  );
}

// Tokens, cache, cost and activity of the active session.
function SessionStats({
  t,
  locale,
  stats,
  peak,
}: {
  t: Translator;
  locale: string;
  stats: StatsSnapshot;
  peak?: string;
}) {
  return (
    <>
      <div className="ctx-details-title">{t('stats.tokens')}</div>
      <div className="ctx-details-grid">
        <Row k={t('stats.tokens.input')} v={fmtInt(stats.inputTokens, locale)} tip={t('tip.ctx.input')} tipMeta={meta(t, 'server', 'high')} />
        <Row k={t('stats.tokens.output')} v={fmtInt(stats.outputTokens, locale)} tip={t('tip.ctx.output')} tipMeta={meta(t, 'server', 'high')} />
      </div>

      <div className="ctx-details-title">{t('stats.cache')}</div>
      <div className="ctx-details-grid">
        <Row k={t('stats.cache.hitRate')} v={fmtPct(stats.cacheHitRate)} tip={t('tip.ctx.hit')} tipMeta={meta(t, 'computed', 'high')} />
        <Row k={t('stats.cache.read')} v={fmtCompact(stats.cacheReadTokens)} tip={t('tip.ctx.cacheRead')} tipMeta={meta(t, 'server', 'high')} />
        <Row k={t('stats.cache.write')} v={fmtCompact(stats.cacheCreateTokens)} tip={t('tip.ctx.cacheWrite')} tipMeta={meta(t, 'server', 'high')} />
        {stats.cacheSavingsUsd != null && stats.cacheSavingsUsd > 0 && (
          <Row
            k={t('stats.cache.savings')}
            v={fmtUsdShort(stats.cacheSavingsUsd)}
            tip={t('tip.ctx.savings')}
            tipMeta={meta(t, 'estimate', 'medium')}
          />
        )}
      </div>

      <div className="ctx-details-title">{t('stats.cost')}</div>
      <div className="ctx-details-grid">
        <div className="stat-row">
          <span className="stat-k">{t('stats.cost.session')}</span>
          <span className="stat-v">
            {fmtUsdShort(stats.sessionCostUsd)}
            {stats.costIsEstimate && (
              <span className="stat-badge est" title={t('tip.ctx.costEstimate')}>
                ~
              </span>
            )}
          </span>
        </div>
        {stats.lastTurnCostUsd > 0 && <Row k={t('stats.cost.lastTurn')} v={fmtUsdShort(stats.lastTurnCostUsd)} />}
      </div>

      {/* Persistent counters: only once at least one turn is consolidated. */}
      {(stats.turnCount ?? 0) > 0 && (
        <>
          <div className="ctx-details-title">{t('stats.activity')}</div>
          <div className="ctx-details-grid">
            <Row k={t('stats.activity.turns')} v={fmtInt(stats.turnCount ?? 0, locale)} />
            {(stats.compactionCount ?? 0) > 0 && (
              <Row
                k={t('stats.activity.compactions')}
                v={fmtInt(stats.compactionCount ?? 0, locale)}
                tip={t('tip.ctx.compactions')}
                tipMeta={meta(t, 'computed', 'medium')}
              />
            )}
            {(stats.cacheResetCount ?? 0) > 0 && (
              <Row
                k={t('stats.activity.resets')}
                v={
                  stats.cacheRecacheCostUsd != null && stats.cacheRecacheCostUsd > 0
                    ? `${stats.cacheResetCount} · ${fmtUsdShort(stats.cacheRecacheCostUsd)}`
                    : String(stats.cacheResetCount ?? 0)
                }
                tip={t('tip.ctx.resets')}
                tipMeta={meta(t, 'computed', 'medium')}
              />
            )}
            {peak && (
              <div className="ctx-details-wide">
                <Row k={t('stats.activity.peak')} v={peak} tip={t('tip.ctx.peak')} tipMeta={meta(t, 'computed', 'high')} />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Row({ k, v, tip, tipMeta }: { k: string; v: string; tip?: string; tipMeta?: TooltipMeta }) {
  const row = (
    <div className="stat-row">
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </div>
  );
  return tip ? (
    <Tooltip className="tt-block" title={k} text={tip} meta={tipMeta}>
      {row}
    </Tooltip>
  ) : (
    row
  );
}

function sessionRows(s: SessionInfo, t: Translator): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (s.createdAt) rows.push({ label: t('tip.sess.created'), value: fmtDate(s.createdAt) });
  rows.push({ label: t('tip.sess.updated'), value: fmtDate(s.updatedAt) });
  rows.push({ label: t('tip.sess.messages'), value: String(s.messageCount) });
  if (s.userCount != null) rows.push({ label: t('tip.sess.user'), value: String(s.userCount) });
  if (s.assistantCount != null) {
    rows.push({ label: t('tip.sess.assistant'), value: String(s.assistantCount) });
  }
  if (s.toolCount != null) rows.push({ label: t('tip.sess.tools'), value: String(s.toolCount) });
  if (s.model) rows.push({ label: t('tip.sess.model'), value: prettyChip(s.model), accent: true });
  if (s.sizeBytes != null) rows.push({ label: t('tip.sess.size'), value: fmtBytes(s.sizeBytes) });
  rows.push({ label: t('tip.id'), value: s.id.slice(0, 12) });
  return rows;
}

function semver(s?: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[0] : undefined;
}

// Lista de releases do Claude CLI no GitHub.
const CLI_RELEASES_URL = 'https://github.com/anthropics/claude-code/releases';

// Minimum CLI version for the Cockpit to work properly: 2.1.162 fixed
// Esc (interrupt) being dropped at the start of a turn in stream-json sessions,
// which is exactly the channel we use. Below that, the Stop button may not take effect.
const MIN_CLI_VERSION = '2.1.162';

/** a < b (3-part semver). false when either version isn't recognized. */
function semverLt(a?: string, b?: string): boolean {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return false;
  const pa = x.split('.').map(Number);
  const pb = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

function cliOutdated(installed?: string, latest?: string): boolean {
  return semverLt(installed, latest);
}

/** A CLI old enough to break Stop — a stronger warning than "outdated". */
function cliBelowMin(installed?: string): boolean {
  return semverLt(installed, MIN_CLI_VERSION);
}

function prettyChip(id: string): string {
  const oneM = /\[1m\]/i.test(id);
  const core = id.replace(/^claude-/i, '').replace(/\[1m\]/i, '');
  const m = core.match(/^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/i);
  let s = core;
  if (m) s = `${m[1]} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
  return oneM ? `${s} 1M` : s;
}

// Date/time in the PC's REGION format (injected by the host via Node Intl),
// independente do idioma da UI. Fallback: locale do webview.
// Groups the sessions by time range (updatedAt) for the hub grid. The list already
// arrives sorted by most recent; that order is preserved within each range.
function groupSessions(sessions: SessionInfo[]): { key: string; items: SessionInfo[] }[] {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  const buckets: Record<string, SessionInfo[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const s of sessions) {
    const ts = Date.parse(s.updatedAt) || 0;
    if (ts >= startToday) buckets.today.push(s);
    else if (ts >= startToday - dayMs) buckets.yesterday.push(s);
    else if (ts >= startToday - 7 * dayMs) buckets.week.push(s);
    else buckets.older.push(s);
  }
  return [
    { key: 'sessions.today', items: buckets.today },
    { key: 'sessions.yesterday', items: buckets.yesterday },
    { key: 'sessions.week', items: buckets.week },
    { key: 'sessions.older', items: buckets.older },
  ].filter((g) => g.items.length > 0);
}

function fmtDate(iso: string): string {
  const region = window.__TOOTEGA_REGION__ || navigator.language || undefined;
  try {
    return new Intl.DateTimeFormat(region, { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}
