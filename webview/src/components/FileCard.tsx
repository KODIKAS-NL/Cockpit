// SendUserFile: the agent hands the reader a file (a diagram, a report, a screenshot).
// It is a delivery, not a step of the work, so it does not become a tool card with raw JSON:
// the caption is shown, an image is shown, and anything else is a line that opens in the editor.
//
// The bytes come from the host: a webview cannot read the disk, and these files usually live
// outside every root it is allowed to load from (/tmp, another project).
import { useEffect, useState } from 'react';
import type { ToolItem } from '../types';
import type { Translator } from '../i18n';
import type { HostToWebview } from '../../../shared/protocol';
import { send } from '../vscodeApi';
import { fmtBytes } from '../util/format';
import { useImageViewer } from './ImageViewer';

type FileInfo = {
  path: string;
  abs: string;
  name: string;
  exists: boolean;
  size?: number;
  dataUri?: string;
};

// One answer per path for the whole conversation: a card remounts on every re-render of its
// turn, and a screenshot sent twice is the same file.
const cache = new Map<string, FileInfo>();
const asked = new Set<string>();

function useFileInfo(paths: string[]): Record<string, FileInfo> {
  const [infos, setInfos] = useState<Record<string, FileInfo>>(() => {
    const seed: Record<string, FileInfo> = {};
    for (const p of paths) {
      const hit = cache.get(p);
      if (hit) seed[p] = hit;
    }
    return seed;
  });
  const key = paths.join('\n');

  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data as HostToWebview;
      if (m?.kind !== 'fileCardInfo' || !paths.includes(m.path)) return;
      const info: FileInfo = {
        path: m.path,
        abs: m.abs,
        name: m.name,
        exists: m.exists,
        size: m.size,
        dataUri: m.dataUri,
      };
      cache.set(m.path, info);
      setInfos((prev) => ({ ...prev, [m.path]: info }));
    };
    window.addEventListener('message', h);
    for (const p of paths) {
      if (cache.has(p) || asked.has(p)) continue;
      asked.add(p);
      send({ kind: 'fileCard', path: p });
    }
    return () => window.removeEventListener('message', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return infos;
}

/** The error the engine gave back, when the delivery failed. */
function errorText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('');
  }
  return '';
}

export function FileCard({ item, t }: { item: ToolItem; t: Translator }) {
  const input = (item.input ?? {}) as Record<string, unknown>;
  const paths = Array.isArray(input.files)
    ? (input.files.filter((f) => typeof f === 'string' && f) as string[])
    : [];
  const caption = typeof input.caption === 'string' ? input.caption.trim() : '';
  const infos = useFileInfo(paths);
  const openViewer = useImageViewer();

  if (paths.length === 0) return null;

  return (
    <div className="file-card">
      <div className="file-card-head">
        <span className="file-card-icon">📎</span>
        <span className="file-card-title">{t('file.sent')}</span>
        {!item.done && <span className="tool-status">{t('tool.running')}</span>}
      </div>
      {caption && <div className="file-card-caption">{caption}</div>}
      {item.isError && <div className="file-card-missing">{errorText(item.result)}</div>}
      {paths.map((p) => {
        const info = infos[p];
        const name = info?.name ?? p.split(/[\\/]/).pop() ?? p;
        const href = info?.abs ?? p;
        const open = () => send({ kind: 'openLink', href, preview: true });
        return (
          <div className="file-card-file" key={p}>
            {info?.dataUri && (
              <button
                type="button"
                className="file-card-thumb"
                onClick={() => openViewer(info.dataUri as string)}
                title={t('file.zoom')}
              >
                <img src={info.dataUri} alt={name} />
              </button>
            )}
            <div className="file-card-line">
              <span className="file-card-name" role="link" title={p} onClick={open}>
                {name}
              </span>
              {info?.exists === false ? (
                <span className="file-card-missing">{t('file.missing')}</span>
              ) : (
                info?.size != null && <span className="file-card-size">{fmtBytes(info.size)}</span>
              )}
              {info?.exists !== false && (
                <span className="file-card-open" role="link" onClick={open}>
                  {t('tool.view')}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
