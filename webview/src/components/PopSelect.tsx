// A dropdown drawn by the page, for places where the native <select> popup is not reliable
// (an IDE's embedded browser clips it to the view, so a select at the bottom of the panel loses its options).
import { useRef, useState } from 'react';
import { useDismiss } from '../util/useDismiss';

interface Props {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  title?: string;
  /** Class of the button (the look comes from the caller's CSS). */
  className?: string;
  /** Open the list above the button (the prompt toolbar sits at the bottom of the view). */
  up?: boolean;
}

export function PopSelect({ value, options, onChange, title, className, up }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const cur = options.find((o) => o.value === value);
  return (
    <div className={`ctrl-modelsel pop-select${up ? ' up' : ''}`} ref={ref}>
      <button
        type="button"
        className={`${className ?? ''} ctrl-modelsel-btn`}
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ctrl-modelsel-cur">{cur?.label ?? value}</span>
        <span className="ctrl-modelsel-arrow">▾</span>
      </button>
      {open && (
        <div className="ctrl-modelsel-pop pop-select-list" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`ctrl-modelsel-row${o.value === value ? ' sel' : ''}`}
              onClick={() => {
                setOpen(false);
                onChange(o.value);
              }}
            >
              <span className="c-model">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
