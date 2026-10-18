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
const vscode = acquireVsCodeApi();
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
  }, [addImage]);

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
            <button type="button" className={`pad-btn${confirmNew ? ' warn' : ''}`} onClick={newBoard}>
              {confirmNew ? t('newConfirm') : t('newBoard')}
            </button>
            <button type="button" className="pad-btn" onClick={() => void render('export')}>
              {t('export')}
            </button>
            <button type="button" className="pad-btn primary" title={t('sendTip')} onClick={() => void render('send')}>
              {t('send')}
            </button>
          </div>
        )}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
