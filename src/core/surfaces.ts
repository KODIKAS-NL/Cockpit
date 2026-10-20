import type { HostToWebview } from '../../shared/protocol';

/** One place the UI is shown: the hub, the side bar chat, or a conversation's own panel. */
export interface Surface {
  kind: 'hub' | 'sidebar' | 'panel';
  /** The conversation a panel belongs to. */
  tab?: string;
  /** Delivers a message to the UI. Must not throw for a surface that is already gone. */
  post(msg: unknown): void;
}

/** Surface ids for the two long-lived views; panels use `panelId(tab)`. */
export const HUB_ID = 'hub';
export const SIDEBAR_ID = 'sidebar';
export const panelId = (tab: string): string => `panel:${tab}`;

/**
 * Routes host messages to the surfaces that are open. The hub and the side bar chat get everything
 * (they mirror the global state and keep every conversation's state). A message for one tab goes to
 * that tab's panel; a global message goes to every panel.
 */
export class Surfaces {
  private readonly all = new Map<string, Surface>();

  set(id: string, surface: Surface): void {
    this.all.set(id, surface);
  }

  has(id: string): boolean {
    return this.all.has(id);
  }

  remove(id: string): void {
    this.all.delete(id);
  }

  post(msg: HostToWebview, tab?: string): void {
    const payload = tab ? { ...msg, tab } : msg;
    this.send(this.all.get(HUB_ID), payload);
    this.send(this.all.get(SIDEBAR_ID), payload);
    if (tab) {
      this.send(this.all.get(panelId(tab)), payload);
    } else {
      for (const s of this.all.values()) if (s.kind === 'panel') this.send(s, payload);
    }
  }

  private send(s: Surface | undefined, payload: unknown): void {
    if (!s) return;
    try {
      s.post(payload);
    } catch {
      /* webview already discarded */
    }
  }
}
