// The conversations living in the side bar chat: a slim strip above the chat to switch between
// them, start a new one, close one, or move the shown one to an editor tab.
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
}

export function TabStrip({ t, tabs, activeId, onSwitch, onNew, onClose, onOpenEditor }: Props) {
  return (
    <div className="tabstrip" role="tablist">
      <div className="tabstrip-tabs">
        {tabs.map((tb) => {
          const title = tb.title || t('session.untitled');
          const busy = tb.status === 'busy' || tb.bgBusy === true;
          return (
            <div key={tb.id} className={`tabstrip-tab${tb.id === activeId ? ' active' : ''}`} role="tab" aria-selected={tb.id === activeId}>
              <button type="button" className="tabstrip-name" title={title} onClick={() => onSwitch(tb.id)}>
                {busy && <span className="tabstrip-busy" aria-hidden="true" />}
                <span className="tabstrip-title">{title}</span>
              </button>
              <button type="button" className="tabstrip-close" title={t('tabs.close')} aria-label={t('tabs.close')} onClick={() => onClose(tb.id)}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="tabstrip-btn" title={t('tabs.new')} aria-label={t('tabs.new')} onClick={onNew}>
        +
      </button>
      <button type="button" className="tabstrip-btn" title={t('tabs.openEditor')} aria-label={t('tabs.openEditor')} onClick={onOpenEditor}>
        ⧉
      </button>
    </div>
  );
}
