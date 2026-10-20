// CockpitCore for an IDE whose plugin shows the chat in a browser view: every conversation lives
// in the side bar chat, so the window plumbing for editor panels is empty. Surfaces are the
// WebSocket connections of those browser views (registered by WebServer).
import { CockpitCore } from '../core/CockpitCore';
import { SIDEBAR_ID, type Surfaces } from '../core/surfaces';
import { t } from '../core/services';
import type { ImageAttachment } from '../../shared/protocol';
import type { RpcPeer } from './rpc';
import type { ScratchpadHub } from './ScratchpadHub';

export class SidecarCore extends CockpitCore {
  sidebarShown = true;
  private rpc!: RpcPeer;
  pads?: ScratchpadHub;

  /** For the scratchpad hub: what the core knows about a conversation's images and sends. */
  readonly padLinks = {
    onSend: (key: string, image: ImageAttachment): void => this.onPadSend(key, image),
    latestImage: (key: string): ImageAttachment | undefined => this.latestChatImage(key),
  };

  get webSurfaces(): Surfaces {
    return this.surfaces;
  }

  bind(rpc: RpcPeer): void {
    this.rpc = rpc;
  }

  /** A browser view sent a message; `from` is its surface id. */
  receive(m: Parameters<CockpitCore['onWebviewMessage']>[0], from: string): void {
    this.onWebviewMessage(m, from);
  }

  protected hasPanel = (): boolean => false;
  protected panelVisible = (): boolean => false;
  protected anyPanelVisible = (): boolean => false;
  protected revealPanel = (): boolean => false;
  protected revealPanelQuietly = (): void => undefined;
  /** No editor tabs here: a conversation that would get one is shown in the side bar chat. */
  protected createPanel(tab: string): void {
    this.showInSidebar(tab);
  }
  protected disposePanel = (): boolean => false;
  protected setPanelTitle = (): void => undefined;
  protected reloadPanel = (): void => undefined;
  protected sidebarOpen(): boolean {
    return this.surfaces.has(SIDEBAR_ID);
  }
  protected sidebarVisible(): boolean {
    return this.sidebarOpen() && this.sidebarShown;
  }
  protected focusSidebar(): void {
    this.rpc?.notify('focusToolWindow');
  }
  protected updateStatusBar(busy: boolean): void {
    this.rpc?.notify('status', { busy });
  }
  protected startWatchdog = (): void => undefined;
  protected onSurfaceAlive = (): void => undefined;
  protected openPad(key: string, title: string, image?: ImageAttachment): void {
    if (this.pads) this.pads.open(key, title, image);
    else void this.host.notify('info', t('The scratchpad is not available in this editor yet.'));
  }
  protected disposePads = (): void => this.pads?.dispose();
}
