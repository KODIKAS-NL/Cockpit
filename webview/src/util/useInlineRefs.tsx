// Inline code references (`@file#La-b`) in a text box made of a textarea over a highlight mirror:
// pasting copied editor lines inserts one, Backspace / Delete remove it as a unit, the caret steps
// over it, and a ✕ badge shows on the one under the mouse or next to the caret. Shared by the
// prompt box and the plan notes.
import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  type SyntheticEvent,
} from 'react';
import type { Translator } from '../i18n';
import { findRefs, refAt, sameCopy, type InlineRef } from '../../../shared/codeRef';
import { Icon } from '../components/Icon';

interface Opts {
  t: Translator;
  ref: RefObject<HTMLTextAreaElement>;
  hlRef: RefObject<HTMLPreElement>;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  lastCopy?: { text: string; ref: string };
}

export function useInlineRefs({ t, ref, hlRef, text, setText, lastCopy }: Opts) {
  const [hoverRef, setHoverRef] = useState<number | null>(null);
  const [caretRef, setCaretRef] = useState<number | null>(null);
  const [badge, setBadge] = useState<{ r: InlineRef; left: number; top: number } | null>(null);
  // The code of each reference that came from a paste, so "paste as text" can give it back.
  const pastedCode = useRef(new Map<string, string>());
  const prevCaret = useRef(0);

  const replaceRange = (start: number, end: number, insert: string, caret: number) => {
    const el = ref.current;
    setText((prev) => prev.slice(0, start) + insert + prev.slice(end));
    setHoverRef(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = caret;
      setCaretRef(null);
    });
  };
  // The token and one space next to it (the one pasting added), so no double space is left.
  const removeToken = (r: InlineRef) => {
    const before = text[r.start - 1];
    const after = text[r.end];
    const from = after !== ' ' && before === ' ' ? r.start - 1 : r.start;
    const to = after === ' ' ? r.end + 1 : r.end;
    replaceRange(from, to, '', from);
  };
  const insertAtCaret = (s: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const sep = before && !before.endsWith(' ') ? ' ' : '';
    replaceRange(start, end, `${sep}${s}`, before.length + sep.length + s.length);
  };

  const syncCaretRef = (el: HTMLTextAreaElement) => {
    if (el.selectionStart !== el.selectionEnd) return setCaretRef(null);
    const pos = el.selectionStart ?? 0;
    const hit = refAt(el.value, pos, 'back') ?? refAt(el.value, pos, 'fwd');
    setCaretRef(hit ? hit.start : null);
  };

  useLayoutEffect(() => {
    const start = hoverRef ?? caretRef;
    const hl = hlRef.current;
    const wrap = ref.current?.parentElement;
    const r = start === null ? undefined : findRefs(text).find((x) => x.start === start);
    const sp = r && hl ? hl.querySelector<HTMLElement>(`.rt-ref[data-rs="${r.start}"]`) : null;
    if (!r || !sp || !wrap) return setBadge(null);
    const rects = sp.getClientRects();
    const last = rects[rects.length - 1];
    const w = wrap.getBoundingClientRect();
    setBadge({ r, left: last.right - w.left, top: rects[0].top - w.top });
  }, [text, hoverRef, caretRef]);

  return {
    pastedCode,
    insertAtCaret,
    /** Backspace / Delete next to (or inside) a reference. True when it handled the key. */
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.ctrlKey || e.metaKey || e.altKey) return false;
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return false;
      const hit = refAt(el.value, el.selectionStart ?? 0, e.key === 'Backspace' ? 'back' : 'fwd');
      if (!hit) return false;
      e.preventDefault();
      removeToken(hit);
      return true;
    },
    /** Lines copied in an editor become a reference at the caret. True when it handled the paste. */
    onPaste(e: ClipboardEvent<HTMLTextAreaElement>): boolean {
      const pasted = e.clipboardData?.getData('text/plain') ?? '';
      if (!lastCopy || !sameCopy(pasted, lastCopy.text)) return false;
      e.preventDefault();
      pastedCode.current.set(lastCopy.ref, lastCopy.text);
      insertAtCaret(`${lastCopy.ref} `);
      return true;
    },
    onMouseMove(e: MouseEvent<HTMLTextAreaElement>) {
      const hl = hlRef.current;
      if (!hl) return;
      let hit: number | null = null;
      for (const sp of Array.from(hl.querySelectorAll<HTMLElement>('.rt-ref'))) {
        for (const rc of Array.from(sp.getClientRects())) {
          if (e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom) hit = Number(sp.dataset.rs);
        }
      }
      setHoverRef((cur) => (cur === hit ? cur : hit));
    },
    onMouseLeave() {
      setHoverRef(null);
    },
    /** A click inside a reference puts the caret on its nearer edge. */
    onMouseUp(e: MouseEvent<HTMLTextAreaElement>) {
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return;
      const pos = el.selectionStart ?? 0;
      const hit = refAt(el.value, pos, 'in');
      if (hit) el.selectionStart = el.selectionEnd = pos - hit.start < hit.end - pos ? hit.start : hit.end;
    },
    /** Arrow keys step over a reference instead of into it. */
    onSelect(e: SyntheticEvent<HTMLTextAreaElement>) {
      const el = e.currentTarget;
      const pos = el.selectionStart ?? 0;
      if (el.selectionStart === el.selectionEnd) {
        const hit = refAt(el.value, pos, 'in');
        if (hit && document.activeElement === el && !(e.nativeEvent as Event & { buttons?: number }).buttons) {
          const to = pos >= prevCaret.current ? hit.end : hit.start;
          el.selectionStart = el.selectionEnd = to;
          prevCaret.current = to;
          return;
        }
      }
      prevCaret.current = pos;
      syncCaretRef(el);
    },
    /** The ✕ (and paste as text) badge; render it inside the box's wrapper. */
    badgeEl: badge ? (
      <span
        className="composer-ref-x"
        style={{ left: badge.left, top: badge.top }}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setHoverRef(badge.r.start)}
      >
        {pastedCode.current.has(badge.r.ref) && (
          <button
            type="button"
            title={t('refs.pasteAsText')}
            aria-label={t('refs.pasteAsText')}
            onClick={() => {
              const code = pastedCode.current.get(badge.r.ref) ?? '';
              replaceRange(badge.r.start, badge.r.end, code, badge.r.start + code.length);
            }}
          >
            <Icon name="edit" />
          </button>
        )}
        <button type="button" title={t('refs.remove')} aria-label={t('refs.remove')} onClick={() => removeToken(badge.r)}>
          ✕
        </button>
      </span>
    ) : (null as ReactNode),
  };
}
