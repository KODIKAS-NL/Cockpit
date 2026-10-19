// A plain text box that understands inline code references: the plan notes. A textarea over a
// highlight mirror (the pills), the same technique as the prompt box.
import type { KeyboardEvent } from 'react';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { Translator } from '../i18n';
import { richHighlight } from '../util/highlight';
import { useInlineRefs } from '../util/useInlineRefs';

interface Props {
  t: Translator;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  lastCopy?: { text: string; ref: string };
  className?: string;
  /** Image files pasted into the box. */
  onImages?: (files: File[]) => void;
  /** Keys the inline references did not take (Enter to send, for instance). */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export interface RefTextareaHandle {
  insert: (s: string) => void;
  /** The code behind each reference that was pasted here. */
  pasted: () => ReadonlyMap<string, string>;
}

export const RefTextarea = forwardRef<RefTextareaHandle, Props>(function RefTextarea(
  { t, value, onChange, placeholder, lastCopy, className, onImages, onKeyDown },
  handle,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const setText = (fn: string | ((p: string) => string)) => onChange(typeof fn === 'function' ? fn(value) : fn);
  const inl = useInlineRefs({ t, ref, hlRef, text: value, setText, lastCopy });
  useImperativeHandle(handle, () => ({ insert: inl.insertAtCaret, pasted: () => inl.pastedCode.current }));

  useLayoutEffect(() => {
    const el = ref.current;
    const hl = hlRef.current;
    if (!el || !hl) return;
    hl.innerHTML = `${richHighlight(value)}\n`;
    // The textarea's scrollbar takes room from its text; the mirror gives the same.
    el.parentElement?.style.setProperty('--sb', `${el.offsetWidth - el.clientWidth}px`);
    hl.scrollTop = el.scrollTop;
  }, [value]);

  return (
    <div className={`ref-ta ${className ?? ''}`}>
      <pre className="composer-highlight hljs" ref={hlRef} aria-hidden="true" />
      {inl.badgeEl}
      <textarea
        ref={ref}
        className="composer-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!inl.onKeyDown(e)) onKeyDown?.(e);
        }}
        onPaste={(e) => {
          if (onImages) {
            const files = Array.from(e.clipboardData?.items ?? [])
              .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (files.length) {
              e.preventDefault();
              onImages(files);
              return;
            }
          }
          inl.onPaste(e);
        }}
        onMouseMove={inl.onMouseMove}
        onMouseLeave={inl.onMouseLeave}
        onMouseUp={inl.onMouseUp}
        onSelect={inl.onSelect}
        onScroll={(e) => {
          if (hlRef.current) hlRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
});
