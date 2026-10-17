import { useEffect, useState } from 'react';
import type { Translator } from '../i18n';
import type { UsageBucket, ScopedBucket } from '../../../shared/protocol';

/** "3m" / "5h" / "4d" until the ISO reset time. */
export function relReset(iso: string, _locale?: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return '0m';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

interface Props {
  t: Translator;
  locale: string;
  fiveHour?: UsageBucket;
  sevenDay?: UsageBucket;
  weeklyScoped?: ScopedBucket[];
  onClick: () => void;
}

function Bar({ t, locale, label, tone, b }: { t: Translator; locale: string; label: string; tone: 'warm' | 'cool'; b: UsageBucket }) {
  const pct = Math.max(0, Math.min(1, b.usedPct ?? 0)) * 100;
  const level = pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : '';
  return (
    <div className="limit-bar">
      <div className="limit-bar-head">
        <span className="limit-bar-label">{label}</span>
        <span className={`limit-bar-pct ${level}`}>{Math.round(pct)}%</span>
      </div>
      <div className="usage-bar">
        <span className={`usage-bar-fill ${tone} ${level}`} style={{ width: `${pct}%` }} />
      </div>
      {b.resetsAt && <div className="limit-bar-sub">{t('usage.resetsIn', relReset(b.resetsAt, locale))}</div>}
    </div>
  );
}

// The account's limit windows as small bars on the dashboard. Click opens the Usage modal.
// (Touched only to test redeploying the extension while Remote Control is on.)
export function LimitBars({ t, locale, fiveHour, sevenDay, weeklyScoped, onClick }: Props) {
  // Reset times are relative: re-render every minute so they keep counting down.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!fiveHour && !sevenDay && !weeklyScoped?.length) return null;
  return (
    <button type="button" className="limit-bars" title={t('limits.tip')} onClick={onClick}>
      {fiveHour && <Bar t={t} locale={locale} label={t('limits.session')} tone="warm" b={fiveHour} />}
      {sevenDay && <Bar t={t} locale={locale} label={t('limits.weekly')} tone="cool" b={sevenDay} />}
      {weeklyScoped?.map((b) => (
        <Bar key={b.label} t={t} locale={locale} label={t('limits.scoped', b.label)} tone="cool" b={b} />
      ))}
    </button>
  );
}
