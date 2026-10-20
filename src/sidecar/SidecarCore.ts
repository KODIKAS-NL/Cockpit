// CockpitCore for an IDE whose plugin shows the chat in a browser view: every conversation lives
// in the side bar chat, so the window plumbing for editor panels is empty. Surfaces are the
// WebSocket connections of those browser views (registered by WebServer).
import { CockpitCore } from '../core/CockpitCore';
import { SIDEBAR_ID, type Surfaces } from '../core/surfaces';
import { t } from '../core/services';
import type { ImageAttachment } from '../../shared/protocol';
import type { RpcPeer } from './rpc';

export class SidecarCore extends CockpitCore {
  sidebarShown = true;
  private rpc!: RpcPeer;

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
  protected openPad(_key: string, _title: string, _image?: ImageAttachment): void {
    void this.host.notify('info', t('The scratchpad is not available in this editor yet.'));
  }
  protected disposePads = (): void => undefined;
}
