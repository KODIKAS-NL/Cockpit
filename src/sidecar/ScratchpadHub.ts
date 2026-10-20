// The scratchpad boards of the sidecar: the same Excalidraw page as in VS Code (dist/scratchpad),
// served over HTTP and carried over a WebSocket per open board. The plugin only shows the page.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageAttachment } from '../../shared/protocol';
import type { HostToPad, PadToHost } from '../scratchpad/messages';
import { loadPad, padFile, savePad } from '../scratchpad/store';

export interface PadConnection {
  message(m: PadToHost): void;
  close(): void;
}

export interface ScratchpadOptions {
  /** Folder that holds `scratchpads/`. */
  storageDir: string;
  locale(): string;
  /** The user sent the board to the conversation `key`. */
  onSend(key: string, image: ImageAttachment): void;
  latestImage(key: string): ImageAttachment | undefined;
  /** Ask the IDE to show the page of the board `key`. */
  show(key: string, title: string): void;
  exportImage(image: ImageAttachment): void;
}

export class ScratchpadHub {
  private readonly posts = new Map<string, (m: HostToPad) => void>();
  private readonly pending = new Map<string, ImageAttachment>();
  /** What the board on disk last was, as far as this process knows (its own saves included). */
  private readonly known = new Map<string, string | undefined>();
  private readonly watchers = new Map<string, fs.FSWatcher>();

  constructor(private readonly o: ScratchpadOptions) {}

  /** Opens (or reveals) the board of `key`; `image` is placed on it. */
  open(key: string, title: string, image?: ImageAttachment): void {
    const post = this.posts.get(key);
    if (image) {
      if (post) post({ kind: 'addImage', image });
      else this.pending.set(key, image);
    }
    this.o.show(key, title);
  }

  attach(key: string, post: (m: HostToPad) => void): PadConnection {
    this.posts.set(key, post);
    return {
      message: (m) => this.onMessage(key, post, m),
      close: () => {
        if (this.posts.get(key) !== post) return;
        this.posts.delete(key);
        this.watchers.get(key)?.close();
        this.watchers.delete(key);
        this.known.delete(key);
      },
    };
  }

  private onMessage(key: string, post: (m: HostToPad) => void, m: PadToHost): void {
    switch (m.kind) {
      case 'ready': {
        const json = loadPad(this.o.storageDir, key);
        this.known.set(key, json);
        this.watch(key, post);
        const image = this.pending.get(key);
        this.pending.delete(key);
        post({ kind: 'init', json, image, lang: this.o.locale(), assetPath: '/pad/' });
        break;
      }
      case 'save':
        try {
          this.known.set(key, m.json); // before writing: the watcher must not echo it back
          savePad(this.o.storageDir, key, m.json);
        } catch {
          /* the next change saves again */
        }
        break;
      case 'latestImage': {
        const image = this.o.latestImage(key);
        post(image ? { kind: 'addImage', image } : { kind: 'noImage' });
        break;
      }
      case 'send':
        this.o.onSend(key, m.image);
        break;
      case 'export':
        this.o.exportImage(m.image);
        break;
    }
  }

  /** The same board can be open elsewhere (another window shares the folder): show its newer version. */
  private watch(key: string, post: (m: HostToPad) => void): void {
    if (this.watchers.has(key)) return;
    const file = padFile(this.o.storageDir, key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const w = fs.watch(path.dirname(file), { persistent: false }, (_ev, name) => {
        if (name !== path.basename(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const json = loadPad(this.o.storageDir, key);
          if (json === undefined || json === this.known.get(key)) return;
          this.known.set(key, json);
          post({ kind: 'reload', json });
        }, 300);
      });
      this.watchers.set(key, w);
    } catch {
      /* no live reload: the board still loads when the pad opens */
    }
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.posts.clear();
  }
}
