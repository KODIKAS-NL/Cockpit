// Model, effort and permission mode in the prompt box, like the official panel, plus a cog with
// the rarer per-conversation options (agents, engine, auto-compact, a custom model id). The
// choices are for the conversation being typed in (the one the chat shows), not global dashboard
// settings. The lists and the host messages are the ones the dashboard controls used before.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Translator } from '../i18n';
import type { SessionConfig } from '../../../shared/protocol';
import { Icon } from './Icon';
import { useDismiss } from '../util/useDismiss';
import { effortLabel, modelLabel, permLabel } from './Controls';

interface Props {
  t: Translator;
  config?: SessionConfig;
  activeModel?: string;
  onModel: (model: string) => void;
  onRemoveModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onPermission: (mode: string) => void;
  onAllowAgents: (value: boolean) => void;
  onEngine: (engine: string) => void;
  onAutoCompact: (value: string) => void;
  /** Pin the current model/effort to a permission mode, for every conversation. */
  onPin: (mode: string, model: string, effort: string) => void;
  onUnpin: (mode: string) => void;
}

/** Auto-compact windows offered (tokens); the CLI accepts 100K to 1M. */
const COMPACT_WINDOWS = [100_000, 200_000, 300_000, 500_000, 1_000_000];

function windowLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1000}K`;
}

export function ComposerPicks({
  t,
  config,
  activeModel,
  onModel,
  onRemoveModel,
  onEffort,
  onPermission,
  onAllowAgents,
  onEngine,
  onAutoCompact,
  onPin,
  onUnpin,
}: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  // The free-form size, in thousands of tokens; follows the value the conversation really has.
  const [compactDraft, setCompactDraft] = useState('');
  const currentCompact = config?.autoCompact ?? 'auto';
  useEffect(() => {
    setCompactDraft(/^\d+$/.test(currentCompact) ? String(Number(currentCompact) / 1000) : '');
  }, [currentCompact]);

  useDismiss(open, ref, () => setOpen(false));

  // The popup is anchored to the toolbar row; lift it by the prompt box above that row so it opens
  // over the conversation instead of covering what is being typed.
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const side = ref.current?.closest('.composer-side');
      const box = side?.closest('.composer');
      if (side && box) setLift(Math.max(0, Math.round(side.getBoundingClientRect().top - box.getBoundingClientRect().top)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  if (!config) return null;

  // Windows larger than the model's context make no sense; unknown context offers all of them.
  const ctx =
    config.modelMeta?.[config.model]?.contextTokens ??
    (config.model === 'default' && (config.defaultModel ?? activeModel)
      ? config.modelMeta?.[(config.defaultModel ?? activeModel) as string]?.contextTokens
      : undefined);
  const windows = COMPACT_WINDOWS.filter((w) => !ctx || w <= ctx);
  const current = currentCompact;
  const chips = ['auto', ...windows.map(String), 'off'];
  const maxK = Math.floor(Math.min(ctx ?? 1_000_000, 1_000_000) / 1000);
  const draftK = Number(compactDraft);
  const draftBad = compactDraft.trim() !== '' && !(Number.isFinite(draftK) && draftK >= 100 && draftK <= maxK);
  const applyDraft = (): void => {
    if (!compactDraft.trim()) return;
    if (draftBad) {
      setCompactDraft(/^\d+$/.test(current) ? String(Number(current) / 1000) : '');
      return;
    }
    const v = String(Math.round(draftK * 1000));
    if (v !== current) onAutoCompact(v);
  };

  const compactLabel = (v: string): string =>
    v === 'auto' ? t('compact.auto') : v === 'off' ? t('compact.off') : windowLabel(Number(v));
  const compactStatus =
    current === 'auto'
      ? t('compact.statusAuto')
      : current === 'off'
        ? t('compact.statusOff')
        : ctx && Number(current) > ctx
          ? t('compact.statusOver', windowLabel(Number(current)), windowLabel(ctx))
          : t('compact.statusAt', windowLabel(Number(current)));

  const applyCustom = (): void => {
    const v = custom.trim();
    if (!v) return;
    onModel(v);
    setCustom('');
    setOpen(false);
  };

  return (
    <div className="composer-picks" ref={ref}>
      <ModelEffortPick
        t={t}
        config={config}
        activeModel={activeModel}
        onModel={onModel}
        onRemoveModel={onRemoveModel}
        onEffort={onEffort}
        onPin={onPin}
        onUnpin={onUnpin}
      />
      <select
        className="composer-pick-mode"
        title={t('controls.permission')}
        aria-label={t('controls.permission')}
        value={config.permissionMode}
        onChange={(e) => onPermission(e.target.value)}
      >
        {config.permissionModes.map((pm) => (
          <option key={pm} value={pm}>
            {permLabel(pm, t)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`composer-pick-cog${open ? ' on' : ''}`}
        title={t('chatSettings.title')}
        aria-label={t('chatSettings.title')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="settings" />
      </button>
      {open && (
        <div
          className="composer-cog-pop"
          role="dialog"
          aria-label={t('chatSettings.title')}
          style={{ bottom: `calc(100% + ${lift + 4}px)` }}
        >
          <div className="cog-title">{t('chatSettings.title')}</div>

          {(config.engines?.length ?? 1) > 1 && (
            <label className="cog-row">
              <span>{t('controls.engine')}</span>
              <select value={config.engine ?? 'claude'} onChange={(e) => onEngine(e.target.value)}>
                {(config.engines ?? ['claude']).map((en) => (
                  <option key={en} value={en}>
                    {t(`engine.${en}` as Parameters<Translator>[0]) === `engine.${en}` ? en : t(`engine.${en}` as Parameters<Translator>[0])}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="cog-row" title={t('tip.ctrl.agents')}>
            <span>{t('controls.agents')}</span>
            <input type="checkbox" checked={config.allowAgents} onChange={(e) => onAllowAgents(e.target.checked)} />
          </label>

          <div className="cog-compact" title={t('compact.tip')}>
            <div className="cog-compact-head">{t('compact.label')}</div>
            <div className="cog-chips" role="radiogroup" aria-label={t('compact.label')}>
              {chips.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={current === v}
                  className={`cog-chip${current === v ? ' on' : ''}`}
                  onClick={() => current !== v && onAutoCompact(v)}
                >
                  {compactLabel(v)}
                </button>
              ))}
            </div>
            <label className="cog-compact-custom">
              <span>{t('compact.custom')}</span>
              <input
                type="number"
                inputMode="numeric"
                min={100}
                max={maxK}
                step={50}
                className={draftBad ? 'bad' : undefined}
                value={compactDraft}
                placeholder="350"
                onChange={(e) => setCompactDraft(e.target.value)}
                onBlur={applyDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyDraft();
                }}
              />
              <span className="cog-compact-unit">K</span>
            </label>
            <div className={`cog-compact-status${ctx && /^\d+$/.test(current) && Number(current) > ctx ? ' warn' : ''}`}>
              {compactStatus}
            </div>
          </div>

          <div className="cog-row cog-custom" title={t('chatSettings.customModel.tip')}>
            <span>{t('chatSettings.customModel')}</span>
            <input
              value={custom}
              placeholder="claude-…"
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCustom();
              }}
            />
            <button type="button" onClick={applyCustom} disabled={!custom.trim()}>
              {t('chatSettings.apply')}
            </button>
          </div>
          <div className="cog-hint">{t('chatSettings.restartHint')}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Model and effort in one chip ("Opus 5.5 Medium"), like the official panel. Its popup lists
 * the models by name only, with a stepped effort slider underneath: a click on a stop applies
 * at once; arrow keys apply after a short pause, since a new effort restarts the CLI process.
 */
function ModelEffortPick({
  t,
  config,
  activeModel,
  onModel,
  onRemoveModel,
  onEffort,
  onPin,
  onUnpin,
}: {
  t: Translator;
  config: SessionConfig;
  activeModel?: string;
  onModel: (model: string) => void;
  onRemoveModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onPin: (mode: string, model: string, effort: string) => void;
  onUnpin: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const keyTimer = useRef<number | undefined>(undefined);
  const defaultFor = config.defaultModel ?? activeModel;
  const meta = config.modelMeta;

  // The stops are the real levels; 'default' sits on the level it resolves to.
  const levels = config.efforts.filter((e) => e !== 'default');
  const resolved = config.effort === 'default' ? (config.defaultEffort ?? '') : config.effort;
  const [pending, setPending] = useState<number | null>(null);
  const index = pending ?? Math.max(0, levels.indexOf(resolved));
  const effortText = pending == null ? effortLabel(config.effort, t, config.defaultEffort) : effortLabel(levels[pending], t);

  useDismiss(open, ref, () => setOpen(false));
  useEffect(() => () => window.clearTimeout(keyTimer.current), []);

  const apply = (i: number): void => {
    window.clearTimeout(keyTimer.current);
    setPending(null);
    const next = levels[i];
    if (next && next !== config.effort) onEffort(next);
  };
  const onSliderKey = (e: KeyboardEvent): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = Math.min(levels.length - 1, Math.max(0, index + step));
    setPending(i);
    window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => apply(i), 600);
  };
  const at = (i: number): string => `${levels.length > 1 ? (i / (levels.length - 1)) * 100 : 0}%`;

  // A model set elsewhere (custom id) is listed too, on top.
  const rows = config.models.includes(config.model) ? config.models : [config.model, ...config.models];
  // The chip is short, like the official one: "Opus 5.5 High" (no "Claude", the resolved level).
  const name = modelLabel(config.model === 'default' && defaultFor ? defaultFor : config.model, t, undefined, meta).replace(
    /^Claude /,
    '',
  );
  const chipEffort = effortLabel(resolved || config.effort, t);

  // The pin of the current permission mode, and whether the picks are the pinned ones. Pin/unpin
  // show at once (optimistic, like a sent message): the real value comes back from the host
  // over a postMessage round trip (write the setting, re-send the config), which the user
  // would otherwise see as a lag — or, clicked twice quickly, as the first click doing nothing.
  const mode = config.permissionMode;
  const modeName = permLabel(mode, t);
  const [optimisticPin, setOptimisticPin] = useState<{ mode: string; pin: { model?: string; effort?: string } | null } | null>(
    null,
  );
  useEffect(() => {
    // Stop overriding once this mode's real pin matches what we asked for, or the mode moved on.
    if (!optimisticPin || optimisticPin.mode !== mode) {
      if (optimisticPin) setOptimisticPin(null);
      return;
    }
    const real = config.modePins?.[mode] ?? null;
    const same =
      (real === null && optimisticPin.pin === null) ||
      (real !== null && optimisticPin.pin !== null && real.model === optimisticPin.pin.model && real.effort === optimisticPin.pin.effort);
    if (same) setOptimisticPin(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.modePins, mode]);
  const pin = optimisticPin?.mode === mode ? optimisticPin.pin : (config.modePins?.[mode] ?? null);
  const pinned =
    !!pin && (pin.model === undefined || pin.model === config.model) && (pin.effort === undefined || pin.effort === config.effort);

  return (
    <div className="mep" ref={ref}>
      <button
        type="button"
        className="mep-btn"
        title={`${t('controls.model')} · ${t('controls.effort')}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {pinned && (
          <span className="mep-pin-mark" title={t('pin.pinnedTo', modeName)}>
            <Icon name="pin" size={11} />
          </span>
        )}
        <span className="mep-model">{name}</span>
        <span className="mep-effort">{chipEffort}</span>
      </button>
      {open && (
        <div className="mep-pop" role="dialog" aria-label={t('controls.selectModel')}>
          <div className="mep-head">{t('controls.selectModel')}</div>
          <div className="mep-list" role="listbox" aria-label={t('controls.model')}>
            {rows.map((m) => {
              const sel = m === config.model;
              const removable = m !== 'default' && !meta?.[m]?.label;
              return (
                <div key={m} className={`mep-row${sel ? ' sel' : ''}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={sel}
                    className="mep-row-pick"
                    onClick={() => {
                      setOpen(false);
                      if (!sel) onModel(m);
                    }}
                  >
                    <span className="mep-row-name">{modelLabel(m, t, defaultFor, meta)}</span>
                    {sel && <span className="mep-check">✓</span>}
                  </button>
                  {removable && (
                    <button
                      type="button"
                      className="mep-remove"
                      title={t('controls.model.remove')}
                      aria-label={t('controls.model.remove')}
                      onClick={() => onRemoveModel(m)}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {levels.length > 1 && (
            <div className="mep-effort-row">
              <span className="mep-effort-label">
                {t('controls.effort')} ({effortText})
              </span>
              <div
                className="mep-slider"
                role="slider"
                tabIndex={0}
                aria-label={t('controls.effort')}
                aria-valuemin={0}
                aria-valuemax={levels.length - 1}
                aria-valuenow={index}
                aria-valuetext={effortText}
                onKeyDown={onSliderKey}
              >
                <span className="mep-track" />
                <span className="mep-fill" style={{ width: at(index) }} />
                {levels.map((l, i) => (
                  <button
                    key={l}
                    type="button"
                    tabIndex={-1}
                    className={`mep-stop${i <= index ? ' on' : ''}`}
                    style={{ left: at(i) }}
                    title={effortLabel(l, t)}
                    aria-label={effortLabel(l, t)}
                    onClick={() => apply(i)}
                  />
                ))}
                <span className="mep-thumb" style={{ left: at(index) }} />
              </div>
            </div>
          )}
          <div className="mep-pin-row">
            <Icon name="pin" size={12} />
            {pinned ? (
              <>
                <span className="mep-pin-text">{t('pin.pinnedTo', modeName)}</span>
                <button
                  type="button"
                  className="mep-pin-btn"
                  onClick={() => {
                    setOptimisticPin({ mode, pin: null });
                    onUnpin(mode);
                  }}
                >
                  {t('pin.unpin')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mep-pin-btn"
                title={t('pin.hint', modeName)}
                onClick={() => {
                  setOptimisticPin({ mode, pin: { model: config.model, effort: config.effort } });
                  onPin(mode, config.model, config.effort);
                }}
              >
                {t('pin.pinTo', modeName)}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
