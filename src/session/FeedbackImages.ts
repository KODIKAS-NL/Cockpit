// Images pasted into the plan feedback and question answers. Those replies carry only text back to
// the CLI, so the images are saved as files under `Planing/.attachment-temp/` and the text names
// them: Claude reads them with its Read tool. They are removed once the turn that used them ends.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageAttachment } from '../../shared/protocol';

const DIR = path.join('Planing', '.attachment-temp');
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SavedImages {
  /** Workspace-relative, forward slashes: what the text names. */
  rel: string[];
  abs: string[];
}

export function saveFeedbackImages(root: string, images: ImageAttachment[], now = new Date()): SavedImages {
  const out: SavedImages = { rel: [], abs: [] };
  if (!root || images.length === 0) return out;
  try {
    const dir = path.join(root, DIR);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.getTime();
    images.forEach((img, i) => {
      const ext = (img.mediaType.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg');
      const abs = path.join(dir, `${stamp}-${i + 1}.${ext}`);
      fs.writeFileSync(abs, Buffer.from(img.data, 'base64'));
      out.abs.push(abs);
      out.rel.push(path.relative(root, abs).split(path.sep).join('/'));
    });
  } catch {
    /* a read-only workspace: the reply goes without the images */
  }
  return out;
}

/** The reply text with the image files named after it. */
export function withImagePaths(text: string, rel: string[]): string {
  if (rel.length === 0) return text;
  const list = `Attached images (read them with the Read tool):\n${rel.map((r) => `- ${r}`).join('\n')}`;
  return text.trim() ? `${text.trim()}\n\n${list}` : list;
}

/** Removes the files, and the folder when nothing else is left in it. */
export function removeFeedbackImages(abs: string[]): void {
  const dirs = new Set<string>();
  for (const f of abs) {
    try {
      fs.rmSync(f, { force: true });
      dirs.add(path.dirname(f));
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs) {
    try {
      fs.rmdirSync(d); // only when empty
    } catch {
      /* not empty */
    }
  }
}

/** On startup: files left by a window that closed before the turn ended. */
export function sweepFeedbackImages(root: string, now = Date.now()): void {
  try {
    const dir = path.join(root, DIR);
    const old = fs
      .readdirSync(dir)
      .map((n) => path.join(dir, n))
      .filter((f) => now - fs.statSync(f).mtimeMs > DAY_MS);
    removeFeedbackImages(old);
    fs.rmdirSync(dir); // only when empty
  } catch {
    /* no folder, or not empty */
  }
}
