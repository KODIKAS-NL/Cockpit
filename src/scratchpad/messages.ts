// Messages between the extension host and a scratchpad panel (the Excalidraw board).
import type { ImageAttachment } from '../../shared/protocol';

export interface PadInit {
  /** The saved board (Excalidraw JSON text), when there is one. */
  json?: string;
  /** An image to place on the board (annotate flow). */
  image?: ImageAttachment;
  /** `en` | `pt-BR`, as the rest of the UI. */
  lang: string;
  /** Webview URI of the folder that holds `fonts/`. */
  assetPath: string;
}

export type HostToPad =
  | ({ kind: 'init' } & PadInit)
  | { kind: 'addImage'; image: ImageAttachment }
  /** Another window saved the board: show its version. */
  | { kind: 'reload'; json: string }
  /** The conversation has no image to start from. */
  | { kind: 'noImage' };

export type PadToHost =
  | { kind: 'ready' }
  /** The user asked for the latest image of the conversation. */
  | { kind: 'latestImage' }
  /** The board changed (debounced by the pad). */
  | { kind: 'save'; json: string }
  /** The board as a PNG, to attach to the conversation's composer. */
  | { kind: 'send'; image: ImageAttachment }
  /** The board as a PNG, to save on disk. */
  | { kind: 'export'; image: ImageAttachment };
