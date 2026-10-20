// The frame of the question and plan cards. Modal (an overlay over the chat) by default; docked,
// it sits in the layout above the prompt box, so the chat stays readable while the user answers,
// and a chevron folds it to its head line (down while open: it folds down; up once folded).
import { useState, type ReactNode } from 'react';
import type { Translator } from '../i18n';
import { Portal } from './Portal';

interface Props {
  t: Translator;
  className: string;
  docked?: boolean;
  children: ReactNode;
}

export function CardShell({ t, className, docked, children }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (!docked) {
    // No onClick on the overlay on purpose: a stray click outside must not answer for the user.
    return (
      <Portal>
        <div className="modal-overlay">
          <div className={className} onClick={(e) => e.stopPropagation()}>
            {children}
          </div>
        </div>
      </Portal>
    );
  }
  const label = collapsed ? t('dock.expand') : t('dock.collapse');
  return (
    <div className={`${className} docked${collapsed ? ' collapsed' : ''}`}>
      <button type="button" className="dock-toggle" title={label} aria-label={label} aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}>
        <svg className={`chevron${collapsed ? ' open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6l5 5 5-5" />
        </svg>
      </button>
      {children}
    </div>
  );
}
