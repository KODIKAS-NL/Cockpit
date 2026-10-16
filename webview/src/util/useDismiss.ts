// Closing a popup menu: a click outside it, or Escape. Escape stops there (it must not also
// reach the prompt box or a dialog behind), and gives focus back to the element that had it
// when the menu opened (its button), so the keyboard user is not left on <body>.
import { useEffect, type RefObject } from 'react';

export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
      if (opener && ref.current?.contains(opener)) opener.focus();
    };
    document.addEventListener('mousedown', onDown);
    // Capture phase: runs before handlers on the focused element (the prompt box).
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
    // `close` is usually an inline arrow; re-subscribing on every render is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref]);
}
