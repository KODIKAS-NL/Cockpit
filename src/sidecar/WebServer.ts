// Serves the chat UI (dist/webview) to the IDE's browser view and carries its messages over a
// WebSocket. The page talks to the sidecar directly, so only the page has to reach the browser
// view, also when the IDE UI runs on another machine.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WebviewToHost } from '../../shared/protocol';
import { HUB_ID, SIDEBAR_ID, panelId, type Surfaces } from '../core/surfaces';
import { resolveLocale } from '../i18n/host';
import { log } from '../util/logger';
import type { ScratchpadHub } from './ScratchpadHub';
import type { PadToHost } from '../scratchpad/messages';
import { makeNonce, viewRegionLocale } from '../core/CockpitCore';

const FILES: Record<string, { file: string; type: string }> = {
  '/main.js': { file: 'dist/webview/main.js', type: 'text/javascript; charset=utf-8' },
  '/main.css': { file: 'dist/webview/main.css', type: 'text/css; charset=utf-8' },
  '/icon.png': { file: 'media/icon.png', type: 'image/png' },
  '/pad/main.js': { file: 'dist/scratchpad/main.js', type: 'text/javascript; charset=utf-8' },
  '/pad/main.css': { file: 'dist/scratchpad/main.css', type: 'text/css; charset=utf-8' },
};

/** The browser side of `window.cockpitHost`: postMessage over the WebSocket, state in localStorage. */
const SHIM = `(function(){
var key='cockpit.state.'+location.search;var queue=[];var ws;var opened=false;
function apply(css){var el=document.getElementById('ide-theme');if(!el){el=document.createElement('style');el.id='ide-theme';document.head.appendChild(el);}el.textContent=css;}
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'+location.search);
  ws.onopen=function(){if(opened){location.reload();return;}opened=true;queue.splice(0).forEach(function(m){ws.send(m);});};
  ws.onmessage=function(e){var m=JSON.parse(e.data);if(m&&m.__cockpit==='theme'){apply(m.css);return;}window.dispatchEvent(new MessageEvent('message',{data:m}));};
  ws.onclose=function(){setTimeout(connect,1000);};
}
window.cockpitHost={
  postMessage:function(m){var s=JSON.stringify(m);if(ws&&ws.readyState===1)ws.send(s);else queue.push(s);},
  getState:function(){try{return JSON.parse(localStorage.getItem(key));}catch(e){return undefined;}},
  setState:function(s){try{localStorage.setItem(key,JSON.stringify(s));}catch(e){}}
};
connect();
})();`;

export interface WebServerOptions {
  extensionPath: string;
  surfaces: Surfaces;
  /** A message arrived from a browser view. */
  onMessage(m: WebviewToHost, from: string): void;
  /** The CSS that maps the IDE's colours to `--vscode-*` variables. */
  theme(): string;
  /** The scratchpad boards. */
  pads: ScratchpadHub;
}

export class WebServer {
  readonly token = randomBytes(16).toString('hex');
  private readonly http: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<WebSocket>();
  port = 0;

  constructor(private readonly o: WebServerOptions) {
    this.http = http.createServer((req, res) => this.handle(req, res));
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws' || url.searchParams.get('t') !== this.token) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, url));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(0, '127.0.0.1', () => {
        this.port = (this.http.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  close(): void {
    for (const s of this.sockets) s.close();
    this.wss.close();
    this.http.close();
  }

  /** Sends the IDE theme to every open view. */
  pushTheme(): void {
    const msg = JSON.stringify({ __cockpit: 'theme', css: this.o.theme() });
    for (const s of this.sockets) if (s.readyState === 1) s.send(msg);
  }

  private surfaceId(url: URL): string {
    const view = url.searchParams.get('view');
    const tab = url.searchParams.get('tab');
    if (view === 'hub') return HUB_ID;
    if (view === 'chat' && tab) return panelId(tab);
    return SIDEBAR_ID;
  }

  private attachPad(ws: WebSocket, key: string): void {
    log(`web socket open: pad ${key}`);
    this.sockets.add(ws);
    const conn = this.o.pads.attach(key, (m) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(m));
    });
    ws.on('message', (data) => {
      try {
        conn.message(JSON.parse(String(data)) as PadToHost);
      } catch {
        /* not JSON: ignore */
      }
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      conn.close();
    });
  }

  private attach(ws: WebSocket, url: URL): void {
    if (url.searchParams.get('view') === 'pad') return this.attachPad(ws, url.searchParams.get('key') ?? '');
    const id = this.surfaceId(url);
    log(`web socket open: ${id}`);
    const kind = id === HUB_ID ? 'hub' : id === SIDEBAR_ID ? 'sidebar' : 'panel';
    this.sockets.add(ws);
    this.o.surfaces.set(id, { kind, tab: url.searchParams.get('tab') ?? undefined, post: (m) => ws.send(JSON.stringify(m)) });
    ws.on('message', (data) => {
      try {
        this.o.onMessage(JSON.parse(String(data)) as WebviewToHost, id);
      } catch {
        /* not JSON: ignore */
      }
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      // A newer connection for the same surface (a reload) has already replaced this one.
      if (!this.replaced(id, ws)) this.o.surfaces.remove(id);
    });
    this.latest.set(id, ws);
  }

  private readonly latest = new Map<string, WebSocket>();
  private replaced(id: string, ws: WebSocket): boolean {
    const cur = this.latest.get(id);
    if (cur && cur !== ws) return true;
    this.latest.delete(id);
    return false;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    log(`web ${req.method} ${url.pathname}`);
    if (url.pathname === '/') {
      if (url.searchParams.get('t') !== this.token) return void this.reply(res, 403, 'text/plain', 'forbidden');
      return void this.reply(res, 200, 'text/html; charset=utf-8', this.page(url));
    }
    if (url.pathname === '/pad') {
      if (url.searchParams.get('t') !== this.token) return void this.reply(res, 403, 'text/plain', 'forbidden');
      return void this.reply(res, 200, 'text/html; charset=utf-8', this.padPage());
    }
    if (url.pathname.startsWith('/pad/fonts/')) return this.padAsset(res, url.pathname.slice('/pad/'.length));
    const f = FILES[url.pathname];
    if (!f) return void this.reply(res, 404, 'text/plain', 'not found');
    try {
      this.reply(res, 200, f.type, fs.readFileSync(path.join(this.o.extensionPath, f.file)));
    } catch {
      this.reply(res, 404, 'text/plain', 'not found');
    }
  }

  /** Excalidraw's fonts, from dist/scratchpad (the name may not climb out of it). */
  private padAsset(res: http.ServerResponse, rel: string): void {
    const root = path.join(this.o.extensionPath, 'dist', 'scratchpad');
    const file = path.normalize(path.join(root, decodeURIComponent(rel)));
    if (!file.startsWith(root + path.sep)) return void this.reply(res, 404, 'text/plain', 'not found');
    try {
      const type = file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
      this.reply(res, 200, type, fs.readFileSync(file));
    } catch {
      this.reply(res, 404, 'text/plain', 'not found');
    }
  }

  private reply(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  padPage(): string {
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="/pad/main.css" rel="stylesheet" />
  <style id="ide-theme">${this.o.theme()}</style>
  <title>Scratchpad</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">${SHIM}</script>
  <script nonce="${nonce}" src="/pad/main.js"></script>
</body>
</html>`;
  }

  page(url: URL): string {
    const view = url.searchParams.get('view') === 'hub' ? 'hub' : url.searchParams.get('view') === 'chat' ? 'chat' : 'sidebar';
    const tab = url.searchParams.get('tab') ?? '';
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="${resolveLocale()}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="/main.css" rel="stylesheet" />
  <style id="ide-theme">${this.o.theme()}</style>
  <title>Cockpit for Claude Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__TOOTEGA_VIEW__ = ${JSON.stringify(view)}; window.__TOOTEGA_SESSION__ = ${JSON.stringify(tab)}; window.__TOOTEGA_REGION__ = ${JSON.stringify(viewRegionLocale(false))}; window.__TOOTEGA_ICON__ = "/icon.png";</script>
  <script nonce="${nonce}">${SHIM}</script>
  <script nonce="${nonce}" src="/main.js"></script>
</body>
</html>`;
  }
}
