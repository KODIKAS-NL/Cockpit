import {
  Fragment,
  memo,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import type { ReactNode } from 'react';
import type { Translator } from '../i18n';
import type { ImageAttachment, SlashCmdMeta, MentionItem } from '../../../shared/protocol';
import { send, saveState, readState } from '../vscodeApi';
import { richHighlight } from '../util/highlight';
import {
  ensureSpell,
  spellReady,
  suggest,
  addUserWord,
  ignoreWord,
  onSpellUpdate,
  type Suggestions,
} from '../spell/spell';
import { useImageViewer } from './ImageViewer';
import { SpellDropdown } from './SpellDropdown';
import { Tooltip } from './Tooltip';
import { SlashMenu } from './SlashMenu';

interface Props {
  t: Translator;
  locale: string;
  correctEnabled: boolean;
  spellCheck: boolean; // spell-check while typing (marks words in the overlay)
  busy: boolean;
  compacting?: boolean; // the CLI is condensing the context (shown in the Stop button's title)
  disabled: boolean;
  slashCommands: string[];
  slashMeta: Record<string, SlashCmdMeta>;
  slashBusy: boolean;
  // Draft a restaurar no input (ex.: cancelou o gate de effort). Muda de ref p/ disparar.
  injectDraft?: { text: string; images: ImageAttachment[] } | null;
  onDraftInjected?: () => void;
  // Text to insert into the input without erasing what is already there (e.g. a credential value
  // released by the vault). Its ref changes to trigger the insertion.
  injectText?: { text: string } | null;
  onTextInjected?: () => void;
  /** `now`: "Send now": interrupt the running turn so this message runs right away. */
  onSend: (text: string, images: ImageAttachment[], selection?: string, now?: boolean) => void;
  selectionRef?: string; // @file#a-b of the editor's active selection
  onStop: () => void;
  onVoiceDict?: () => void; // opens the dictation dictionary modal
  onCredentials?: () => void; // abre o cofre de credenciais (TOTP 2FA)
  onRemoteControl?: () => void; // publishes this session for remote control (phone/app)
  canRemoteControl?: boolean; // there is a live session id to publish
  remoteActive?: boolean; // Remote Control is on for this conversation
  remotePhase?: 'connecting' | 'active' | 'failed'; // o que se SABE da conexão remota
  /** Model / effort / mode pickers, shown in the toolbar before Send (chat views only). */
  picks?: ReactNode;
}

interface PendingImage {
  id: string;
  mediaType: string;
  data: string; // base64 without the prefix
  url: string; // data URL for the preview
}

let seq = 0;
const rid = () => `c_${Date.now()}_${seq++}`;

// Memoised for the same reason as Timeline: the composer holds the draft in local state, so
// a stream delta has nothing new to tell it, yet every delta used to re-render it — and with
// it the highlight.js pass over the draft. Its handlers are useCallback-stable in App.
// The prompt box shows 2 rows at rest and grows with the text up to 10 rows, then scrolls.
const MIN_ROWS = 2;
const MAX_ROWS = 10;

export const Composer = memo(function Composer({
  t,
  locale,
  correctEnabled,
  spellCheck,
  busy,
  compacting,
  disabled,
  slashCommands,
  slashMeta,
  slashBusy,
  injectDraft,
  onDraftInjected,
  injectText,
  onTextInjected,
  onSend,
  onStop,
  onVoiceDict,
  onCredentials,
  onRemoteControl,
  canRemoteControl,
  remoteActive,
  remotePhase,
  picks,
  selectionRef,
}: Props) {
  const [includeSel, setIncludeSel] = useState(true);
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const openImage = useImageViewer();
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // @-mention: the token being typed + the host's results + the selected index.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionReq = useRef('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const hadFocus = useRef(false); // the textarea was focused when the window lost focus
  const hlRef = useRef<HTMLPreElement>(null); // syntax-highlight mirror behind the textarea
  const measureRef = useRef<HTMLPreElement>(null); // hidden copy of the text, sized by its content
  // Voice dictation: button state + the text base when it started. The mic capture
  // happens IN THE HOST (the VSCode webview blocks getUserMedia); here we only signal it.
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false); // mic clicked, waiting for WS+audio (spinner)
  const [correcting, setCorrecting] = useState(false); // corrigindo texto (input readonly)
  const recordingRef = useRef(false); // synchronous mirror for the listeners (no stale closure)
  const voiceBaseRef = useRef('');
  // Spell-checker: tick forces an overlay re-render when the dictionaries
  // finish loading; spellMenu controls the open correction dropdown.
  const [spellTick, setSpellTick] = useState(0);
  const [spellMenu, setSpellMenu] = useState<{
    word: string;
    start: number;
    left: number;
    top: number; // y below the word (preferred position)
    anchorTop: number; // y do topo da palavra (p/ inverter o menu pra cima)
    sug: Suggestions | null; // null = loading suggestions from the host
  } | null>(null);

  // Spell-checker client: hooks the listener and re-renders the overlay whenever
  // chega veredito novo do host (palavras marcadas/desmarcadas).
  useEffect(() => {
    void ensureSpell();
    const off = onSpellUpdate(() => setSpellTick((n) => n + 1));
    return off;
  }, []);

  // Auto-expands the textarea: 2 rows to start with, growing as the text needs more rows, up to 10.
  //
  // The height is counted in ROWS, not read back from the box: the highlight mirror is pinned
  // to the textarea's own box (inset:0), so its scrollHeight can never be smaller than the box
  // and says nothing about the text. A hidden <pre> that shares the mirror's typography and
  // width but has no fixed height gives the real content height. Reading it costs one layout of
  // that small element; the textarea itself is never reset to height:auto (which used to force
  // a full-document reflow on every keystroke, and grew with the transcript). The result is
  // memoised, so the common keystroke (same row count) writes no style at all.
  //
  // A layout effect, so the new height is in place before the browser paints. With a plain
  // effect the new line was first painted in the old height: the textarea scrolled its text up
  // to keep the caret in view, and that offset stayed after it grew (top line cut off, caret
  // too high).
  const lastH = useRef(-1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hl = hlRef.current;
    const meter = measureRef.current;
    // The trailing \n guarantees the last line (and trailing breaks) have height in the mirror.
    // spell=true marks wrong words (after the dictionaries load; spellTick).
    if (hl) hl.innerHTML = `${richHighlight(text, spellCheck && spellReady())}\n`;
    if (!meter) return;
    meter.textContent = `${text}\n`;
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const rows = Math.round((meter.offsetHeight - pad) / lineH);
    const shown = Math.min(Math.max(rows, MIN_ROWS), MAX_ROWS);
    const next = Math.ceil(shown * lineH + pad);
    if (next !== lastH.current) {
      // Same height: don't touch style, don't invalidate layout.
      lastH.current = next;
      el.style.height = `${next}px`;
      el.style.overflowY = rows > MAX_ROWS ? 'auto' : 'hidden';
    }
    // While the text fits, nothing may stay scrolled (the box shows all of it).
    if (rows <= MAX_ROWS && el.scrollTop !== 0) {
      el.scrollTop = 0;
      if (hl) hl.scrollTop = 0;
    }
  }, [text, spellTick, spellCheck]);

  // Focus lost when coming back from another app: when the VSCode window is reactivated, the
  // webview reconciles focus and BLURs the active element RIGHT AFTER the click — the
  // textarea, which the click had just focused, loses focus. Re-arm: if the textarea
  // was focused on the way out, restore it on return, unless the user has already
  // focado outro controle (activeElement !== body/null/textarea).
  useEffect(() => {
    const onWinBlur = () => {
      hadFocus.current = document.activeElement === ref.current;
    };
    const restore = () => {
      const el = ref.current;
      if (!el || disabled) return;
      const ae = document.activeElement;
      if (ae === null || ae === document.body || ae === el) {
        el.focus();
        return true;
      }
      return false;
    };
    const onWinFocus = () => {
      if (!hadFocus.current) return;
      // VSCode's blur is asynchronous; it retries for a few moments until it catches.
      requestAnimationFrame(() => restore());
      window.setTimeout(restore, 50);
      window.setTimeout(restore, 150);
    };
    window.addEventListener('blur', onWinBlur);
    window.addEventListener('focus', onWinFocus);
    return () => {
      window.removeEventListener('blur', onWinBlur);
      window.removeEventListener('focus', onWinFocus);
    };
  }, [disabled]);

  const syncScroll = () => {
    const el = ref.current;
    const hl = hlRef.current;
    if (el && hl) {
      hl.scrollTop = el.scrollTop;
      hl.scrollLeft = el.scrollLeft;
    }
  };

  // Slash menu: open when the text is a single "/..." token and there are matches.
  const slashQuery =
    !slashDismissed && /^\/[^\s]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const slashMatches =
    slashQuery !== null
      ? slashCommands.filter((c) => c.toLowerCase().includes(slashQuery)).slice(0, 8)
      : [];
  const slashOpen = slashMatches.length > 0;

  const pickSlash = (cmd: string) => {
    setText(`/${cmd} `);
    setSlashDismissed(true);
    requestAnimationFrame(() => ref.current?.focus());
  };
  // requestId -> paste context (bitmaps for a screenshot; directPaths for the non-Windows fallback).
  const pending = useRef<Map<string, { bitmaps: File[]; directPaths: string[] }>>(new Map());

  // Host response: has path(s) -> insert; empty -> fallback (bitmap or directPaths).
  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.kind === 'resolvedPath' && pending.current.has(m.requestId)) {
        const ctx = pending.current.get(m.requestId) ?? { bitmaps: [], directPaths: [] };
        pending.current.delete(m.requestId);
        if (m.text) insertAtCaret(m.text); // host autoritativo (Windows): acentos OK
        else if (ctx.directPaths.length) requestPaths(ctx.directPaths); // non-Windows
        else ctx.bitmaps.forEach(attachImage); // it was a screenshot
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);

  // Joins two snippets with a space when needed.
  const joinText = (a: string, b: string) => (a && !/\s$/.test(a) ? `${a} ${b}` : `${a}${b}`);

  // Transcriptions coming from the host (STT): a partial updates live; a final one pins it.
  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.kind === 'voiceReady') {
        setConnecting(false); // WS + audio flowing: drop the spinner, you may speak
      } else if (m?.kind === 'voiceTranscript') {
        if (!recordingRef.current) return; // ignores late transcriptions (stopped/typed)
        if (m.isFinal) {
          voiceBaseRef.current = joinText(voiceBaseRef.current, m.text);
          setText(voiceBaseRef.current);
        } else {
          setText(joinText(voiceBaseRef.current, m.text));
        }
      } else if (m?.kind === 'voiceClosed') {
        stopVoice();
      } else if (m?.kind === 'voiceError') {
        // eslint-disable-next-line no-console
        console.warn('[voice] error:', m.message);
        stopVoice();
      } else if (m?.kind === 'voiceCorrected') {
        voiceBaseRef.current = m.text;
        setText(m.text); // swaps in the corrected text
        setCorrecting(false); // libera o input p/ RW
        requestAnimationFrame(() => ref.current?.focus());
      } else if (m?.kind === 'voiceCorrectError') {
        setCorrecting(false); // keeps the original, unblocks
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopVoice = () => {
    if (recordingRef.current) send({ kind: 'voiceStop' });
    recordingRef.current = false;
    setRecording(false);
    setConnecting(false);
  };

  const toggleVoice = () => {
    if (recording) {
      stopVoice();
      // Correction enabled: locks the input (readonly) and asks Haiku to correct it.
      if (correctEnabled && text.trim()) {
        setCorrecting(true);
        send({ kind: 'voiceCorrect', text });
      }
    } else {
      if (disabled || correcting) return;
      voiceBaseRef.current = text;
      recordingRef.current = true;
      setRecording(true);
      setConnecting(true); // spinner until the host signals voiceReady (mic alive)
      send({ kind: 'voiceStart', language: locale }); // host abre o WS e captura o mic (ffmpeg)
      requestAnimationFrame(() => ref.current?.focus()); // focus the input when turning it on
    }
  };

  const insertAtCaret = (s: string) => {
    const el = ref.current;
    setText((prev) => {
      if (!el) return prev ? `${prev} ${s}` : s;
      const start = el.selectionStart ?? prev.length;
      const end = el.selectionEnd ?? prev.length;
      const before = prev.slice(0, start);
      const after = prev.slice(end);
      const sep = before && !before.endsWith(' ') ? ' ' : '';
      const next = `${before}${sep}${s}${after}`;
      const pos = before.length + sep.length + s.length;
      requestAnimationFrame(() => {
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
      });
      return next;
    });
  };

  const attachImage = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      const data = comma >= 0 ? url.slice(comma + 1) : '';
      setImages((prev) => [...prev, { id: rid(), mediaType: f.type || 'image/png', data, url }]);
    };
    reader.readAsDataURL(f);
  };

  const requestPaths = (absPaths: string[]) => {
    const requestId = rid();
    pending.current.set(requestId, { bitmaps: [], directPaths: [] });
    send({ kind: 'resolvePaths', requestId, absPaths });
  };

  // Drag-to-attach: solta arquivos no composer. Usa o path do arquivo (ou o
  // uri-list) to attach; images without a path come in as bitmaps.
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files || []);
    const directPaths: string[] = [];
    const bitmaps: File[] = [];
    for (const f of files) {
      const p = (f as unknown as { path?: string }).path;
      if (p) directPaths.push(p);
      else if (f.type.startsWith('image/')) bitmaps.push(f);
    }
    if (directPaths.length === 0) {
      const uri = dt.getData('text/uri-list');
      for (const line of uri.split('\n').map((s) => s.trim())) {
        if (line.startsWith('file:')) directPaths.push(fileUriToPath(line));
      }
    }
    if (!directPaths.length && !bitmaps.length) return; // nada de arquivo: deixa o default (texto)
    e.preventDefault();
    if (directPaths.length) requestPaths(directPaths);
    bitmaps.forEach(attachImage);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const fileItems = Array.from(cd.items || []).filter((it) => it.kind === 'file');
    if (fileItems.length === 0) return; // texto normal: cola direto

    e.preventDefault();

    // Webview fallbacks (used only when the host returns no files — e.g. non-Windows).
    const directPaths: string[] = [];
    const bitmaps: File[] = [];
    for (const it of fileItems) {
      const f = it.getAsFile();
      if (!f) continue;
      const p = (f as unknown as { path?: string }).path;
      if (p) directPaths.push(p);
      else if (f.type.startsWith('image/')) bitmaps.push(f);
    }
    if (directPaths.length === 0) {
      const uri = cd.getData('text/uri-list');
      for (const line of uri.split('\n').map((s) => s.trim())) {
        if (line.startsWith('file:')) directPaths.push(fileUriToPath(line));
      }
    }

    // Authoritative source: the host reads the OS FileDropList (exact Unicode path, accents OK).
    // When it comes back empty (it was a screenshot or a non-Windows OS) -> bitmap/directPaths.
    const requestId = rid();
    pending.current.set(requestId, { bitmaps, directPaths });
    send({ kind: 'readClipboardFiles', requestId });
  };

  // Anti-perda do rascunho/ditado: na montagem, restaura do estado local do
  // webview (survives a renderer reload/crash and a VSCode restart).
  useEffect(() => {
    const saved = readState<{ draft?: string }>()?.draft;
    if (saved && !text) {
      voiceBaseRef.current = saved;
      setText(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirrors the current text in the local state (setState) and in the HOST (survives the
  // renderer's death — blank screen). Debounced so it doesn't flood. Restored on reload.
  const draftTimer = useRef<number | undefined>(undefined);
  const mirroredOnce = useRef(false);
  useEffect(() => {
    // Doesn't erase the host's draft on mount with empty text (a race with the
    // restore still on its way). It only starts mirroring after the first content.
    if (!mirroredOnce.current && !text) return;
    mirroredOnce.current = true;
    window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      saveState({ draft: text });
      send({ kind: 'draftChanged', text });
    }, 350);
    return () => window.clearTimeout(draftTimer.current);
  }, [text]);

  // Restaura um draft (ex.: cancelou o gate de effort: o texto havia sido limpo;
  // or post-crash recovery coming from the host).
  useEffect(() => {
    if (!injectDraft) return;
    setText(injectDraft.text);
    setImages(
      injectDraft.images.map((i) => ({
        id: rid(),
        mediaType: i.mediaType,
        data: i.data,
        url: `data:${i.mediaType};base64,${i.data}`,
      })),
    );
    requestAnimationFrame(() => ref.current?.focus());
    onDraftInjected?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectDraft]);

  // Inserts text (a credential value) at the cursor position, without erasing the rest.
  useEffect(() => {
    if (!injectText) return;
    const ins = injectText.text;
    const el = ref.current;
    setText((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      return prev.slice(0, start) + ins + prev.slice(end);
    });
    requestAnimationFrame(() => ref.current?.focus());
    onTextInjected?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectText]);

  // While a turn runs, Enter queues the message (the CLI takes it in at its next step).
  const submit = (now?: boolean) => {
    // Sending during dictation: ends the capture NOW (without correction) and cancels a
    // pending correction — otherwise the button keeps recording and late transcriptions
    // repopulate the area after the clear. recordingRef=false BEFORE so the
    // voiceTranscript listener ignores whatever still arrives.
    if (recordingRef.current) {
      recordingRef.current = false;
      setRecording(false);
      setConnecting(false);
      send({ kind: 'voiceStop' });
    }
    if (correcting) setCorrecting(false); // cancels the correction in progress, sends what it has
    const v = text.trim();
    if ((!v && images.length === 0) || disabled) return;
    // Remote Control stays on: the phone shares this window's live process, it is not handed over.
    onSend(
      v,
      images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      includeSel && selectionRef ? selectionRef : undefined,
      now,
    );
    setText('');
    setImages([]);
    setMention(null);
    // Sent: clears the mirrored draft (local + host) so old text isn't restored.
    saveState({ draft: '' });
    send({ kind: 'draftChanged', text: '' });
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mentionItems[Math.min(mentionIdx, mentionItems.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSlash(slashMatches[Math.min(slashIdx, slashMatches.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(); // submit() already ends dictation/correction in progress and sends
    }
  };

  // Click on the textarea: when the caret lands on a marked word (.spell-error in the
  // overlay), abre o dropdown ancorado no span correspondente.
  const openSpellAt = (caret: number) => {
    const hl = hlRef.current;
    if (!hl) return setSpellMenu(null);
    for (const sp of Array.from(hl.querySelectorAll<HTMLElement>('.spell-error'))) {
      const start = Number(sp.dataset.ss);
      const word = sp.dataset.sw ?? sp.textContent ?? '';
      if (caret >= start && caret <= start + word.length) {
        const r = sp.getBoundingClientRect();
        setSpellMenu({ word, start, left: r.left, top: r.bottom + 2, anchorTop: r.top, sug: null });
        // Suggestions come from the host (asynchronous); filled in when they arrive.
        void suggest(word).then((s) =>
          setSpellMenu((cur) => (cur && cur.word === word && cur.start === start ? { ...cur, sug: s } : cur)),
        );
        return;
      }
    }
    setSpellMenu(null);
  };

  const applySpell = (replacement: string) => {
    if (!spellMenu) return;
    const { start, word } = spellMenu;
    setText((prev) => prev.slice(0, start) + replacement + prev.slice(start + word.length));
    setSpellMenu(null);
    const pos = start + replacement.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
      }
    });
  };

  const addSpell = () => {
    if (!spellMenu) return;
    addUserWord(spellMenu.word);
    setSpellMenu(null);
    setSpellTick((n) => n + 1);
  };
  const ignoreSpell = () => {
    if (!spellMenu) return;
    ignoreWord(spellMenu.word);
    setSpellMenu(null);
    setSpellTick((n) => n + 1);
  };

  // @-mention: detects an "@..." token immediately before the caret and asks for files.
  const mentionTimer = useRef<number | undefined>(undefined);
  const detectMention = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (!m) {
      if (mention) setMention(null);
      return;
    }
    const query = m[2];
    const start = caret - query.length - 1; // posição do '@'
    setMention({ start, query });
    setMentionIdx(0);
    window.clearTimeout(mentionTimer.current);
    const requestId = rid();
    mentionReq.current = requestId;
    mentionTimer.current = window.setTimeout(() => {
      send({ kind: 'mentionSearch', requestId, query });
    }, 150);
  };

  // Both files and sessions insert as `@label`: the CLI resolves an @name that matches a live
  // session (2.1.232) and fires SendMessage on submit; a file stays a plain @path reference.
  const pickMention = (item: MentionItem) => {
    if (!mention) return;
    const el = ref.current;
    const label = item.label;
    setText((prev) => {
      const end = mention.start + 1 + mention.query.length;
      const next = `${prev.slice(0, mention.start)}@${label} ${prev.slice(end)}`;
      const pos = mention.start + 1 + label.length + 1;
      requestAnimationFrame(() => {
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = pos;
        }
      });
      return next;
    });
    setMention(null);
    setMentionItems([]);
  };

  // Host results for the @-mention (only the most recent request is applied).
  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.kind === 'mentionResults' && m.requestId === mentionReq.current) {
        setMentionItems(m.items ?? []);
        setMentionIdx(0);
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);

  const mentionOpen = mention !== null && mentionItems.length > 0;

  const canSend = !disabled && !correcting && (!!text.trim() || images.length > 0);

  // How many tool icons fit beside the chips. The chips keep their natural width; the icons
  // take what is left, one by one, and the rest go behind the [›]. Only when not even the [›]
  // fits do the chips shrink ("tight"), and their natural width is remembered from before.
  const sideRef = useRef<HTMLDivElement>(null);
  const picksNatural = useRef(0);
  const [toolsShown, setToolsShown] = useState(99);
  const [toolsTight, setToolsTight] = useState(false);
  const toolCountRef = useRef(0);
  toolCountRef.current = (onVoiceDict ? 1 : 0) + (onCredentials ? 1 : 0) + (onRemoteControl ? 1 : 0) + 1;
  // Runs after every render (cheap; React drops a state update that changes nothing), so it also
  // catches the chips appearing once the config arrives; the observer covers resizes in between.
  const toolsObserver = useRef<{ ro: ResizeObserver; picks: Element | null } | null>(null);
  useLayoutEffect(() => {
    const side = sideRef.current;
    if (!side) return;
    const ICON = 24; // .composer-tools .composer-side-btn
    const measure = () => {
      const picks = side.querySelector<HTMLElement>('.composer-picks');
      if (picks && !side.classList.contains('tight')) picksNatural.current = picks.getBoundingClientRect().width;
      const cs = getComputedStyle(side);
      const inner = side.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const gap = picks ? parseFloat(getComputedStyle(picks).marginLeft) || 0 : 0;
      const free = inner - picksNatural.current - gap;
      const count = toolCountRef.current;
      const n = count * ICON <= free ? count : Math.max(0, Math.floor((free - ICON) / ICON));
      setToolsShown(n);
      setToolsTight(n === 0 && free < ICON);
    };
    measure();
    let obs = toolsObserver.current;
    if (!obs) {
      obs = { ro: new ResizeObserver(() => measure()), picks: null };
      obs.ro.observe(side);
      toolsObserver.current = obs;
    }
    const picks = side.querySelector('.composer-picks');
    if (picks !== obs.picks) {
      if (obs.picks) obs.ro.unobserve(obs.picks);
      if (picks) obs.ro.observe(picks);
      obs.picks = picks;
    }
  });
  useEffect(() => () => toolsObserver.current?.ro.disconnect(), []);

  // The toolbar's tool icons, in order. As many as fit sit inline at the start of the row;
  // the rest fold into a [›] that shows them on hover or focus (see the toolsShown effect).
  const toolItems: { key: string; node: ReactNode }[] = [];
  if (onVoiceDict) {
    toolItems.push({
      key: 'dict',
      node: (
        <Tooltip text={t('voicedict.open')}>
          <button
            type="button"
            className="composer-side-btn voicedict-btn"
            onClick={onVoiceDict}
            aria-label={t('voicedict.open')}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
              <line x1="9" y1="7" x2="15" y2="7" />
              <line x1="9" y1="11" x2="15" y2="11" />
            </svg>
          </button>
        </Tooltip>
      ),
    });
  }
  if (onCredentials) {
    toolItems.push({
      key: 'creds',
      node: (
        <Tooltip text={t('creds.open')}>
          <button
            type="button"
            className="composer-side-btn creds-btn"
            onClick={onCredentials}
            aria-label={t('creds.open')}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </button>
        </Tooltip>
      ),
    });
  }
  if (onRemoteControl) {
    // Falha não é "desligado": o indicador fica, e o clique é reconectar.
    const label = remoteLabel(t, remoteActive, remotePhase);
    toolItems.push({
      key: 'remote',
      node: (
        <Tooltip text={label}>
          <button
            type="button"
            className={`composer-side-btn remote-btn${remoteActive ? ' on' : ''}${
              remotePhase === 'connecting' ? ' connecting' : ''
            }${remotePhase === 'failed' ? ' failed' : ''}`}
            onClick={onRemoteControl}
            // Ligado, o botão continua clicável: é o desligar (toggle).
            disabled={!remoteActive && (disabled || !canRemoteControl)}
            aria-pressed={remoteActive}
            aria-label={label}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="7" y="2" width="10" height="20" rx="2" />
              <line x1="11" y1="18" x2="13" y2="18" />
            </svg>
          </button>
        </Tooltip>
      ),
    });
  }
  toolItems.push({
    key: 'slash',
    node: <SlashMenu t={t} commands={slashCommands} meta={slashMeta} busy={slashBusy} onPick={pickSlash} />,
  });
  const shownTools = Math.min(toolsShown, toolItems.length);

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="attachments">
          {images.map((img) => (
            <div className="attachment" key={img.id}>
              <button
                type="button"
                className="attachment-thumb"
                title={t('attach.view')}
                onClick={() => openImage(img.url)}
              >
                <img src={img.url} alt="" />
              </button>
              <button
                type="button"
                className="attachment-remove"
                title={t('attach.remove')}
                onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div className="slash-menu mention-menu">
          {mentionItems.map((it, i) => (
            <button
              type="button"
              key={`${it.kind}:${it.label}`}
              className={`slash-item ${i === mentionIdx ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(it);
              }}
            >
              <span className={`mention-kind mention-kind-${it.kind}`} aria-hidden>
                {it.kind === 'session' ? '◆' : '📄'}
              </span>
              @{it.label}
            </button>
          ))}
        </div>
      )}
      {slashOpen && (
        <div className="slash-menu">
          {slashMatches.map((c, i) => (
            <button
              type="button"
              key={c}
              className={`slash-item ${i === slashIdx ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(c);
              }}
            >
              /{c}
            </button>
          ))}
        </div>
      )}
      {selectionRef && (
        <button
          type="button"
          className={`composer-selchip ${includeSel ? 'on' : 'off'}`}
          title={includeSel ? t('selection.included') : t('selection.excluded')}
          onClick={() => setIncludeSel((v) => !v)}
        >
          <span className="composer-selchip-eye">{includeSel ? '◉' : '◌'}</span>
          ⧉ {selectionRef}
        </button>
      )}
      <div className="composer-row">
        <div
          className="composer-input-wrap"
          onMouseDown={(e) => {
            // Click on the empty area (below the text): keeps the focus in the textarea.
            if (e.target !== ref.current && !correcting) {
              e.preventDefault();
              const el = ref.current;
              if (el) {
                el.focus();
                const end = el.value.length;
                el.setSelectionRange(end, end);
              }
            }
          }}
        >
          <pre className="composer-highlight hljs" ref={hlRef} aria-hidden="true" />
          <pre className="composer-measure" ref={measureRef} aria-hidden="true" />
          {connecting && (
            <div className="voice-connecting" role="status">
              <span className="voice-spinner" aria-hidden="true" />
              <span>{t('voice.connecting')}</span>
            </div>
          )}
          <textarea
            ref={ref}
            className="composer-input"
            placeholder={
              correcting ? t('voice.correcting') : connecting ? t('voice.connecting') : t('composer.placeholder')
            }
            value={text}
            disabled={disabled}
            readOnly={correcting}
            rows={2}
            onChange={(e) => {
              if (recordingRef.current) stopVoice(); // digitou: encerra o ditado na hora
              const val = e.target.value;
              const caret = e.target.selectionStart ?? val.length;
              setText(val);
              setSlashDismissed(false);
              setSlashIdx(0);
              if (spellMenu) setSpellMenu(null);
              detectMention(val, caret);
            }}
            onClick={(e) => openSpellAt(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKey}
            onPaste={onPaste}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onScroll={() => {
              syncScroll();
              if (spellMenu) setSpellMenu(null);
            }}
          />
            <Tooltip
              text={
                correcting
                  ? t('voice.correcting')
                  : connecting
                    ? t('voice.connecting')
                    : recording
                      ? t('voice.stop')
                      : t('voice.start')
              }
            >
              <button
                type="button"
                className={`composer-side-btn voice ${recording ? 'recording' : ''} ${correcting ? 'correcting' : ''} ${connecting ? 'connecting' : ''}`}
                onClick={toggleVoice}
                disabled={disabled || correcting}
                aria-pressed={recording}
              >
                {correcting || connecting ? (
                  <span className="voice-spinner" aria-hidden="true" />
                ) : recording ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="2" width="6" height="11" rx="3" />
                    <path d="M5 10a7 7 0 0 0 14 0" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                  </svg>
                )}
              </button>
            </Tooltip>
        </div>
        <div className={`composer-side${toolsTight ? ' tight' : ''}`} ref={sideRef}>
          <div className="composer-tools">
            {toolItems.slice(0, shownTools).map((it) => (
              <Fragment key={it.key}>{it.node}</Fragment>
            ))}
            {shownTools < toolItems.length && (
              <div className="composer-tools-more">
                <button
                  type="button"
                  className="composer-side-btn composer-tools-toggle"
                  aria-label={t('composer.tools')}
                  title={t('composer.tools')}
                >
                  ›
                </button>
                <div className="composer-tools-pop">
                  {toolItems.slice(shownTools).map((it) => (
                    <Fragment key={it.key}>{it.node}</Fragment>
                  ))}
                </div>
              </div>
            )}
          </div>
          {picks}
          {busy && canSend && (
            <button type="button" className="btn send-now" onClick={() => submit(true)} title={t('composer.sendNowHint')}>
              {t('composer.sendNow')}
            </button>
          )}
          {busy ? (
            <button
              type="button"
              className="btn stop send-icon"
              onClick={onStop}
              title={compacting ? `${t('activity.compacting')} · ${t('composer.stop')}` : t('composer.stop')}
              aria-label={t('composer.stop')}
            >
              {/* A spinner while the turn runs; on hover/focus it turns into the square (= Stop). */}
              <span className="stop-spinner" aria-hidden="true" />
              <svg className="stop-square" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button type="button" className="btn send send-icon" onClick={() => submit()} disabled={!canSend} title={t('composer.send')} aria-label={t('composer.send')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {spellMenu && (
        <SpellDropdown
          t={t}
          word={spellMenu.word}
          sug={spellMenu.sug ?? { pt: [], en: [] }}
          loading={spellMenu.sug === null}
          left={spellMenu.left}
          top={spellMenu.top}
          anchorTop={spellMenu.anchorTop}
          onPick={applySpell}
          onAdd={addSpell}
          onIgnore={ignoreSpell}
          onClose={() => setSpellMenu(null)}
        />
      )}
    </div>
  );
});

/** O que o botão diz é o que se sabe da conexão — nunca "ligado" por otimismo. */
function remoteLabel(
  t: Translator,
  active?: boolean,
  phase?: 'connecting' | 'active' | 'failed',
): string {
  if (phase === 'failed') return t('remote.failed');
  if (phase === 'connecting') return t('remote.connecting');
  return active ? t('remote.active') : t('remote.publish');
}

function fileUriToPath(uri: string): string {
  try {
    let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\'); // /C:/x -> C:\x
    return p;
  } catch {
    return uri;
  }
}
