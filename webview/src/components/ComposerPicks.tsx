// Model, effort and permission mode in the prompt box, like the official panel, plus a cog with
// the rarer per-conversation options (agents, engine, auto-compact, a custom model id). The
// choices are for the conversation being typed in (the one the chat shows), not global dashboard
// settings. The lists and the host messages are the ones the dashboard controls used before.
import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../i18n';
import type { SessionConfig } from '../../../shared/protocol';
import { Icon } from './Icon';
import { EffortSelect, ModelSelect, permLabel } from './Controls';

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
}

/** Auto-compact windows offered (tokens); the CLI accepts 100K to 1M. */
const COMPACT_WINDOWS = [100_000, 150_000, 200_000, 300_000, 500_000, 1_000_000];

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
}: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!config) return null;

  // Windows larger than the model's context make no sense; unknown context offers all of them.
  const ctx =
    config.modelMeta?.[config.model]?.contextTokens ??
    (config.model === 'default' && (config.defaultModel ?? activeModel)
      ? config.modelMeta?.[(config.defaultModel ?? activeModel) as string]?.contextTokens
      : undefined);
  const windows = COMPACT_WINDOWS.filter((w) => !ctx || w <= ctx);
  const current = config.autoCompact ?? 'auto';
  const values = [...windows.map(String), 'auto', 'off'];
  if (!values.includes(current)) values.unshift(current); // a window set elsewhere still shows

  const compactLabel = (v: string): string =>
    v === 'auto' ? t('compact.auto') : v === 'off' ? t('compact.off') : windowLabel(Number(v));

  const applyCustom = (): void => {
    const v = custom.trim();
    if (!v) return;
    onModel(v);
    setCustom('');
    setOpen(false);
  };

  return (
    <div className="composer-picks" ref={ref}>
      <ModelSelect
        t={t}
        compact
        value={config.model}
        models={config.models}
        meta={config.modelMeta}
        known={config.models.includes(config.model)}
        currentModel={config.model}
        defaultFor={config.defaultModel ?? activeModel}
        onSelect={onModel}
        onRemove={onRemoveModel}
      />
      <EffortSelect
        t={t}
        value={config.effort}
        efforts={config.efforts}
        defaultEffort={config.defaultEffort}
        onSelect={onEffort}
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
        <div className="composer-cog-pop" role="dialog" aria-label={t('chatSettings.title')}>
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

          <label className="cog-row" title={t('compact.tip')}>
            <span>{t('compact.label')}</span>
            <select value={current} onChange={(e) => onAutoCompact(e.target.value)}>
              {values.map((v) => (
                <option key={v} value={v}>
                  {compactLabel(v)}
                </option>
              ))}
            </select>
          </label>

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
