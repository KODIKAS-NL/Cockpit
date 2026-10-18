// Where a conversation's scratchpad (an Excalidraw board) is kept: one JSON file per
// conversation in the extension's global storage, on the machine that runs the extension host.
// No VS Code imports, so it can be unit-tested.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HistoryItem, ImageAttachment } from '../../shared/protocol';

const SUBDIR = 'scratchpads';
const EXT = '.excalidraw.json';

/** The key for a conversation: its CLI session id, or a stand-in until it has one. */
export function padKey(sessionId: string | undefined, tabId: string): string {
  return sessionId ? clean(sessionId) : `tab-${clean(tabId)}`;
}

function clean(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function padFile(storageDir: string, key: string): string {
  return path.join(storageDir, SUBDIR, clean(key) + EXT);
}

/** The saved board as JSON text, or undefined when there is none (or it is unreadable). */
export function loadPad(storageDir: string, key: string): string | undefined {
  try {
    const text = fs.readFileSync(padFile(storageDir, key), 'utf8');
    JSON.parse(text);
    return text;
  } catch {
    return undefined;
  }
}

export function savePad(storageDir: string, key: string, json: string): void {
  const file = padFile(storageDir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, file);
}

export function deletePad(storageDir: string, key: string): boolean {
  try {
    fs.unlinkSync(padFile(storageDir, key));
    return true;
  } catch {
    return false;
  }
}

/** Copies a board kept by an older version (in `from`) to `to`, unless `to` already has one. */
export function migratePad(from: string, to: string, key: string): void {
  const src = padFile(from, key);
  const dst = padFile(to, key);
  if (from === to || !fs.existsSync(src) || fs.existsSync(dst)) return;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  } catch {
    /* the old copy stays where it is */
  }
}

/**
 * A board drawn before the conversation had a session id lives under the tab's stand-in
 * key: move it to the session's key (kept as is when the session already has a board).
 */
export function adoptPad(storageDir: string, tabId: string, sessionId: string): void {
  const from = padFile(storageDir, padKey(undefined, tabId));
  const to = padFile(storageDir, sessionId);
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

/** The newest image the user sent in a transcript, or undefined when there is none. */
export function latestTranscriptImage(items: HistoryItem[]): ImageAttachment | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'user' || !it.images) continue;
    for (let j = it.images.length - 1; j >= 0; j--) {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(it.images[j]);
      if (m) return { mediaType: m[1], data: m[2] };
    }
  }
  return undefined;
}
