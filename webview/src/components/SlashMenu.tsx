import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Translator } from '../i18n';
import type { SlashCmdMeta } from '../../../shared/protocol';
import { Tooltip } from './Tooltip';
import { SLASH_CATALOG, OTHER_CAT } from '../slashCatalog';

interface Props {
  t: Translator;
  commands: string[];
  meta: Record<string, SlashCmdMeta>; // metadados pesquisados por IA (categoria/hint/detalhe)
  busy: boolean; // AI research in progress → button disabled + spinner
  onPick: (cmd: string) => void;
}

// Cockpit icon (flame) spinning — indicator of research in progress.
function CockpitSpinner() {
  return (
    <svg className="slash-spin" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="#ff7a18">
        <path id="sp-flame" d="M12 0.4C14.1 3.4 13.9 4.9 12 6.3C10.1 4.9 9.9 3.4 12 0.4Z" />
        <use href="#sp-flame" transform="rotate(45 12 12)" />
        <use href="#sp-flame" transform="rotate(90 12 12)" />
        <use href="#sp-flame" transform="rotate(135 12 12)" />
        <use href="#sp-flame" transform="rotate(180 12 12)" />
        <use href="#sp-flame" transform="rotate(225 12 12)" />
        <use href="#sp-flame" transform="rotate(270 12 12)" />
        <use href="#sp-flame" transform="rotate(315 12 12)" />
      </g>
    </svg>
  );
}

// Valid categories coming from the AI → i18n key cmdcat.<x>.
const AI_CATS = new Set(['session', 'context', 'config', 'tools', 'account', 'info', 'plugin', 'other']);

// Slash command combobox: grouped by category, each item with a rich hint.
export function SlashMenu({ t, commands, meta, busy, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // t only accepts known keys; catalog keys are dynamic → cast.
  const tk = (k: string) => t(k as Parameters<Translator>[0]);

  const groups = useMemo(() => {
    const uniqueSort = (a: string[]) => [...new Set(a)].sort();
    const byCat = new Map<string, string[]>();
    for (const raw of commands) {
      const name = raw.replace(/^\//, '').trim();
      if (!name) continue;
      // Priority: curated catalog > plugin (its own group) > AI category >
      // namespace (":") > Outros.
      let cat: string;
      const ai = meta[name];
      if (SLASH_CATALOG[name]) cat = SLASH_CATALOG[name].cat;
      else if (ai?.group) cat = `grp:${ai.group}`;
      else if (ai && AI_CATS.has(ai.category)) cat = `cmdcat.${ai.category}`;
      else if (name.includes(':')) cat = `ns:${name.split(':')[0]}`;
      else cat = OTHER_CAT;
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(name);
    }
    const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
    const labelOf = (cat: string): string =>
      cat.startsWith('grp:') ? cap(cat.slice(4)) : cat.startsWith('ns:') ? cap(cat.slice(3)) : tk(cat);
    // All groups in ALPHABETICAL order by visible label; "Other" always last.
    const entries = [...byCat.entries()].map(([cat, items]) => ({
      cat,
      label: labelOf(cat),
      items: uniqueSort(items),
    }));
    entries.sort((a, b) => {
      if (a.cat === OTHER_CAT) return 1;
      if (b.cat === OTHER_CAT) return -1;
      return a.label.localeCompare(b.label);
    });
    return entries;
  }, [commands, meta, t]);

  // Closes on an outside click or Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The menu is fixed, placed above the button and kept inside the panel (the button sits at the
  // left of the toolbar, so anchoring the menu's right edge to it ran off the panel).
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const btn = wrapRef.current;
      const menu = menuRef.current;
      if (!btn || !menu) return;
      const r = btn.getBoundingClientRect();
      const w = menu.offsetWidth;
      menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
      menu.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - w - 6))}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, groups]);

  return (
    <span className="slash-cmd-wrap" ref={wrapRef}>
      <Tooltip className="tt-block" text={busy ? t('slash.menu.loading') : t('slash.menu.tip')}>
        <button
          type="button"
          className={`composer-side-btn ${open ? 'on' : ''}`}
          onClick={() => setOpen((o) => !o)}
          disabled={busy}
          aria-label={busy ? t('slash.menu.loading') : t('slash.menu.tip')}
        >
          {busy ? <CockpitSpinner /> : <span className="slash-glyph">/</span>}
        </button>
      </Tooltip>
      {open && (
        <div className="slash-cmd-menu" role="listbox" ref={menuRef}>
          {groups.length === 0 ? (
            <div className="slash-cmd-empty">{t('slash.menu.empty')}</div>
          ) : (
            groups.map((g) => (
              <div className="slash-cmd-group" key={g.cat}>
                <div className="slash-cmd-cat">{g.label}</div>
                {g.items.map((name) => {
                  const builtin = SLASH_CATALOG[name];
                  const ai = meta[name];
                  const desc = builtin
                    ? tk(builtin.desc)
                    : ai
                      ? ai.detail || ai.hint
                      : t('cmd.generic');
                  return (
                    <Tooltip key={name} className="tt-block" title={`/${name}`} text={desc}>
                      <button
                        type="button"
                        className="slash-cmd-item"
                        onClick={() => {
                          onPick(name);
                          setOpen(false);
                        }}
                      >
                        /{name}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </span>
  );
}
