// Scratchpad: an Excalidraw board in its own webview panel (own bundle, loaded on demand).
// The host keeps the board per conversation; "Send to chat" exports a PNG for the composer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  restore,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type { ImageAttachment } from '../../shared/protocol';
import type { HostToPad, PadToHost } from '../../src/scratchpad/messages';
import { padT, type PadKey } from './i18n';
import './scratchpad.css';

declare function acquireVsCodeApi(): { postMessage(m: PadToHost): void };
// VS Code injects acquireVsCodeApi; another editor injects window.cockpitHost (same postMessage).
const vscode =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : (window as unknown as { cockpitHost: { postMessage(m: PadToHost): void } }).cockpitHost;
const post = (m: PadToHost): void => vscode.postMessage(m);

const SAVE_DEBOUNCE_MS = 600;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function naturalSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
    img.onerror = () => resolve({ w: 800, h: 600 });
    img.src = url;
  });
}

const svg = (d: string) => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
// Icons for the narrow layout, where only the primary button keeps its text.
const ICONS = {
  clipboard: svg('M5.5 3h5v2h-5zM4 4h-.5A1.5 1.5 0 0 0 2 5.5v8A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 12.5 4H12'),
  chatImage: svg('M2 3.5h12v8H8l-3 2.5v-2.5H2zM5 9l2-2.5 1.5 1.5L10 6.5 11.5 9'),
  newBoard: svg('M8 3v10M3 8h10'),
  save: svg('M8 2v8M4.5 7 8 10.5 11.5 7M3 13.5h10'),
  send: svg('M2 8 14 2.5 10.5 14 8 9z'),
};

function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [initial, setInitial] = useState<{ data: unknown; image?: ImageAttachment } | null>(null);
  const [lang, setLang] = useState('en');
  const [note, setNote] = useState('');
  const saveTimer = useRef<number>();
  // A scene we set ourselves (another window's version) must not be saved back as a change.
  const applying = useRef(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const t = padT(lang);

  const addImage = useCallback(async (img: ImageAttachment) => {
    const api = apiRef.current;
    if (!api) return;
    const dataURL = `data:${img.mediaType};base64,${img.data}`;
    const { w, h } = await naturalSize(dataURL);
    const scale = Math.min(1, 900 / w, 700 / h);
    const fileId = `img-${Date.now()}` as never;
    api.addFiles([{ id: fileId, dataURL: dataURL as never, mimeType: img.mediaType as never, created: Date.now() }]);
    const added = convertToExcalidrawElements([
      { type: 'image', fileId, x: 0, y: 0, width: w * scale, height: h * scale, status: 'saved' } as never,
    ]);
    api.updateScene({ elements: [...api.getSceneElements(), ...added] });
    api.scrollToContent(added, { fitToViewport: true, viewportZoomFactor: 0.9 });
  }, []);

  const flash = useCallback(
    (k: PadKey) => {
      setNote(padT(lang)(k));
      window.setTimeout(() => setNote(''), 3000);
    },
    [lang],
  );

  useEffect(() => {
    const onMsg = (e: MessageEvent<HostToPad>) => {
      const m = e.data;
      if (m.kind === 'init') {
        (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = m.assetPath;
        setLang(m.lang);
        let data: unknown = null;
        if (m.json) {
          try {
            data = restore(JSON.parse(m.json), null, null);
          } catch {
            data = null;
          }
        }
        setInitial({ data, image: m.image });
      } else if (m.kind === 'addImage') {
        void addImage(m.image);
      } else if (m.kind === 'noImage') {
        flash('noImage');
      } else if (m.kind === 'reload') {
        const api = apiRef.current;
        if (!api) return;
        try {
          const data = restore(JSON.parse(m.json), null, null);
          applying.current = true;
          const files = Object.values((JSON.parse(m.json) as { files?: Record<string, never> }).files ?? {});
          if (files.length) api.addFiles(files as never);
          api.updateScene({ elements: data.elements });
        } catch {
          /* a half-written file: the next change brings a whole one */
        } finally {
          window.setTimeout(() => (applying.current = false), 200);
        }
      }
    };
    window.addEventListener('message', onMsg);
    post({ kind: 'ready' });
    return () => {
      window.removeEventListener('message', onMsg);
    };
  }, [addImage, flash]);

  const onApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      if (initial?.image) void addImage(initial.image);
    },
    [initial, addImage],
  );

  const saveNow = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const api = apiRef.current;
    if (!api) return;
    post({
      kind: 'save',
      json: serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local'),
    });
  }, []);

  const onChange = useCallback(() => {
    if (applying.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }, [saveNow]);

  // The tab may be closed or hidden right after a stroke: save what is pending at once.
  useEffect(() => {
    const flush = (): void => {
      if (document.visibilityState === 'hidden' && saveTimer.current) saveNow();
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [saveNow]);

  const newBoard = (): void => {
    if (!confirmNew) {
      setConfirmNew(true);
      window.setTimeout(() => setConfirmNew(false), 3000);
      return;
    }
    setConfirmNew(false);
    apiRef.current?.resetScene();
    saveNow();
  };

  const fromClipboard = async (): Promise<void> => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((x) => x.startsWith('image/'));
        if (!type) continue;
        await addImage({ mediaType: type, data: await blobToBase64(await item.getType(type)) });
        return;
      }
    } catch {
      /* denied or unavailable: say so below */
    }
    flash('noClipboard');
  };

  const render = async (kind: 'send' | 'export'): Promise<void> => {
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElements().filter((el) => !el.isDeleted);
    if (elements.length === 0) {
      setNote(t('empty' as PadKey));
      window.setTimeout(() => setNote(''), 3000);
      return;
    }
    saveNow();
    const blob = await exportToBlob({
      elements,
      appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
      files: api.getFiles(),
      mimeType: 'image/png',
    });
    post({ kind, image: { mediaType: 'image/png', data: await blobToBase64(blob) } });
  };

  if (!initial) return null;
  return (
    <div className="pad-root">
      <Excalidraw
        initialData={initial.data as never}
        excalidrawAPI={onApi}
        onChange={onChange}
        // Always light: the board is exported as a PNG on white, so what you draw on must be white too.
        theme="light"
        langCode={lang.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'}
        renderTopRightUI={() => (
          <div className="pad-actions">
            {note && <span className="pad-note">{note}</span>}
            <button type="button" className="pad-btn" data-tip={t('fromClipboardTip')} aria-label={t('fromClipboardTip')} onClick={() => void fromClipboard()}>
              {ICONS.clipboard}
              <span className="pad-label">{t('fromClipboard')}</span>
            </button>
            <button type="button" className="pad-btn" data-tip={t('latestImageTip')} aria-label={t('latestImageTip')} onClick={() => post({ kind: 'latestImage' })}>
              {ICONS.chatImage}
              <span className="pad-label">{t('latestImage')}</span>
            </button>
            <button type="button" className={`pad-btn${confirmNew ? ' warn keep' : ''}`} data-tip={t('newBoard')} aria-label={t('newBoard')} onClick={newBoard}>
              {ICONS.newBoard}
              <span className="pad-label">{confirmNew ? t('newConfirm') : t('newBoard')}</span>
            </button>
            <button type="button" className="pad-btn" data-tip={t('export')} aria-label={t('export')} onClick={() => void render('export')}>
              {ICONS.save}
              <span className="pad-label">{t('export')}</span>
            </button>
            <button type="button" className="pad-btn primary keep" data-tip={t('sendTip')} aria-label={t('sendTip')} onClick={() => void render('send')}>
              {ICONS.send}
              <span className="pad-label">{t('send')}</span>
            </button>
          </div>
        )}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
