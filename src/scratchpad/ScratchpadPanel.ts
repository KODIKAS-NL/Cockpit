// The scratchpad panels: one Excalidraw board per conversation, in its own editor tab.
// The board lives in a separate webview bundle (dist/scratchpad) because Excalidraw is
// large; nothing of it loads until a pad is opened.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ImageAttachment } from '../../shared/protocol';
import type { HostToPad, PadToHost } from './messages';
import { loadPad, padFile, savePad } from './store';

const VIEW_TYPE = 'cockpitDaemon.scratchpad';

export class ScratchpadManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** What the board on disk last was, as far as this window knows (its own saves included). */
  private readonly known = new Map<string, string | undefined>();
  private readonly watchers = new Map<string, fs.FSWatcher>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Folder that holds `scratchpads/`: shared by every VS Code server of this user. */
    private readonly storageDir: string | undefined,
    private readonly locale: () => string,
    /** The user sent the board to the conversation `key`. */
    private readonly onSend: (key: string, image: ImageAttachment) => void,
  ) {}

  /** Opens (or reveals) the board of `key`; `image` is placed on it. */
  open(key: string, title: string, image?: ImageAttachment): void {
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      if (image) this.post(existing, { kind: 'addImage', image });
      return;
    }
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'scratchpad');
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-color.svg');
    panel.webview.html = this.html(panel.webview, root);
    this.panels.set(key, panel);

    const sub = panel.webview.onDidReceiveMessage((m: PadToHost) => {
      switch (m.kind) {
        case 'ready': {
          const json = this.storageDir ? loadPad(this.storageDir, key) : undefined;
          this.known.set(key, json);
          this.watch(key, panel);
          this.post(panel, {
            kind: 'init',
            json,
            image,
            lang: this.locale(),
            assetPath: panel.webview.asWebviewUri(root).toString() + '/',
          });
          break;
        }
        case 'save':
          if (this.storageDir) {
            try {
              this.known.set(key, m.json); // before writing: the watcher must not echo it back
              savePad(this.storageDir, key, m.json);
            } catch {
              /* the next change saves again */
            }
          }
          break;
        case 'send':
          this.onSend(key, m.image);
          break;
        case 'export':
          void this.exportImage(m.image);
          break;
      }
    });
    panel.onDidDispose(() => {
      sub.dispose();
      if (this.panels.get(key) === panel) this.panels.delete(key);
      this.watchers.get(key)?.close();
      this.watchers.delete(key);
      this.known.delete(key);
    });
  }

  /**
   * The same board can be open in another window (another VS Code server on this machine
   * shares the folder). When its file changes and it is not what this window wrote, the open
   * pad shows the new version.
   */
  private watch(key: string, panel: vscode.WebviewPanel): void {
    if (!this.storageDir || this.watchers.has(key)) return;
    const file = padFile(this.storageDir, key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const w = fs.watch(path.dirname(file), { persistent: false }, (_ev, name) => {
        if (name !== path.basename(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const json = loadPad(this.storageDir!, key);
          if (json === undefined || json === this.known.get(key)) return;
          this.known.set(key, json);
          this.post(panel, { kind: 'reload', json });
        }, 300);
      });
      this.watchers.set(key, w);
    } catch {
      /* no live reload: the board still loads when the pad opens */
    }
  }

  /** The conversation `from` got its session id: its open board now belongs to `to`. */
  rekey(from: string, to: string): void {
    const p = this.panels.get(from);
    if (!p || this.panels.has(to)) return;
    this.panels.delete(from);
    this.panels.set(to, p);
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) p.dispose();
    this.panels.clear();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private post(panel: vscode.WebviewPanel, msg: HostToPad): void {
    void panel.webview.postMessage(msg);
  }

  private async exportImage(image: ImageAttachment): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `scratchpad-${Date.now()}.png`)),
      filters: { [vscode.l10n.t('Images')]: ['png'] },
    });
    if (!uri) return;
    try {
      fs.writeFileSync(uri.fsPath, Buffer.from(image.data, 'base64'));
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Failed to save image: {0}', String(e)));
    }
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.css'));
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource} data: blob:`,
      `worker-src blob:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${style}" rel="stylesheet" />
  <title>Scratchpad</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
