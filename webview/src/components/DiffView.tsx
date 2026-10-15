import { useMemo } from 'react';
import { sideBySideDiff } from '../util/diff';

interface Props {
  oldText: string;
  newText: string;
  label?: string;
}

// The last three segments of a long path, so it fits one line; the full path is the tooltip.
function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : p;
}

// Side-by-side diff (before | after) with line numbers and add/del/change highlighting.
export function DiffView({ oldText, newText, label }: Props) {
  const diff = useMemo(() => sideBySideDiff(oldText, newText), [oldText, newText]);

  // Only additions (a new file) or only removals: one column, not an empty half next to the text.
  const single = diff.rows.length > 0 && (diff.rows.every((r) => r.type === 'add') || diff.rows.every((r) => r.type === 'del'));

  return (
    <div className={`diff ${single ? 'diff-single' : ''}`}>
      <div className="diff-head">
        {label && (
          <span className="diff-file" title={label}>
            {shortPath(label)}
          </span>
        )}
        <span className="diff-stat">
          <span className="diff-plus">+{diff.added}</span>
          <span className="diff-minus">−{diff.removed}</span>
        </span>
      </div>
      <div className="diff-grid">
        {diff.rows.map((r, i) => (
          <div key={i} className={`diff-row ${r.type}`}>
            <span className="diff-ln">{r.left?.num ?? ''}</span>
            <span className="diff-sign left">{r.type === 'del' || r.type === 'change' ? '−' : ''}</span>
            <code className="diff-code left">{r.left?.text ?? ''}</code>
            <span className="diff-ln diff-mid">{r.right?.num ?? ''}</span>
            <span className="diff-sign right">{r.type === 'add' || r.type === 'change' ? '+' : ''}</span>
            <code className="diff-code right">{r.right?.text ?? ''}</code>
          </div>
        ))}
      </div>
      {diff.truncated && <div className="diff-trunc">…</div>}
    </div>
  );
}
