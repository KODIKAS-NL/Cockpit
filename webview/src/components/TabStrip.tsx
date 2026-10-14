// The conversations living in the side bar chat: a slim strip above the chat to switch between
// them, start a new one, close one, or move the shown one to an editor tab.
import { useState, type ReactNode } from 'react';
import type { Translator } from '../i18n';
import type { TabState } from '../store';

interface Props {
  t: Translator;
  tabs: TabState[];
  activeId?: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onOpenEditor: () => void;
  /** Renames the conversation (needs its transcript id, so not before the first message). */
  onRename: (sessionId: string, name: string) => void;
  /** Extra controls (the export button) shown before the new / move buttons. */
  trailing?: ReactNode;
}

export function TabStrip({ t, tabs, activeId, onSwitch, onNew, onClose, onOpenEditor, onRename, trailing }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const commit = (tb: TabState): void => {
    const name = draft.trim();
    setEditing(null);
    if (name && tb.sessionId && name !== tb.title) onRename(tb.sessionId, name);
  };
  return (
    <div className="tabstrip" role="tablist">
      <div className="tabstrip-tabs">
        {tabs.map((tb) => {
          const title = tb.title || t('session.untitled');
          const busy = tb.status === 'busy' || tb.bgBusy === true;
          return (
            <div key={tb.id} className={`tabstrip-tab${tb.id === activeId ? ' active' : ''}`} role="tab" aria-selected={tb.id === activeId}>
              {editing === tb.id ? (
                <input
                  className="tabstrip-edit"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(tb)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(tb);
                    else if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="tabstrip-name"
                  title={tb.sessionId ? `${title} — ${t('tabs.renameHint')}` : title}
                  onClick={() => onSwitch(tb.id)}
                  onDoubleClick={() => {
                    if (!tb.sessionId) return;
                    setDraft(tb.title);
                    setEditing(tb.id);
                  }}
                >
                  {busy && <span className="tabstrip-busy" aria-hidden="true" />}
                  <span className="tabstrip-title">{title}</span>
                </button>
              )}
              <button type="button" className="tabstrip-close" title={t('tabs.close')} aria-label={t('tabs.close')} onClick={() => onClose(tb.id)}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      {trailing}
      <button type="button" className="tabstrip-btn" title={t('tabs.new')} aria-label={t('tabs.new')} onClick={onNew}>
        +
      </button>
      <button type="button" className="tabstrip-btn" title={t('tabs.openEditor')} aria-label={t('tabs.openEditor')} onClick={onOpenEditor}>
        ⧉
      </button>
    </div>
  );
}
