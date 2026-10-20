// The EditorHost of the sidecar: every editor operation is a request to the IDE plugin. What the
// core reads synchronously (the workspace folder, the open documents) is kept here from the
// plugin's events.
import * as path from 'node:path';
import type { DiffSide, Disposable, EditorHost, NotifyLevel, SelectionInfo, SecretStore } from '../core/host';
import type { RpcPeer } from './rpc';

class Listeners<T extends unknown[]> {
  private readonly all = new Set<(...a: T) => void>();
  add(fn: (...a: T) => void): Disposable {
    this.all.add(fn);
    return { dispose: () => void this.all.delete(fn) };
  }
  fire(...a: T): void {
    for (const fn of [...this.all]) fn(...a);
  }
}

export class RpcHost implements EditorHost {
  root: string | undefined;
  localUi = true;
  private readonly openDocs = new Set<string>();
  private readonly selection = new Listeners<[SelectionInfo | undefined]>();
  private readonly tabs = new Listeners<[]>();
  private readonly copy = new Listeners<[string, string]>();
  private readonly cancels = new Map<number, () => void>();
  private progressSeq = 0;
  /** Set by the entry point once the command layer exists. */
  installDaemonHandler: () => void = () => undefined;
  settingsFile: () => string = () => '';

  constructor(private readonly rpc: RpcPeer) {
    rpc.on('selection', (sel: SelectionInfo | null) => this.selection.fire(sel ?? undefined));
    rpc.on('docs', (p: { open: string[] }) => {
      this.openDocs.clear();
      for (const d of p.open) this.openDocs.add(d);
      this.tabs.fire();
    });
    rpc.on('copySource', (p: { text: string; ref: string }) => this.copy.fire(p.text, p.ref));
    rpc.on('progress.cancel', (p: { id: number }) => this.cancels.get(p.id)?.());
  }

  // --- Messages ---
  notify(level: NotifyLevel, message: string, ...actions: string[]): Promise<string | undefined> {
    return this.rpc.request<string | null>('notify', { level, message, actions }).then((a) => a ?? undefined);
  }
  hideNotifications(): void {
    this.rpc.notify('hideNotifications');
  }
  inputBox(opts: { title?: string; prompt?: string; placeholder?: string; value?: string; password?: boolean }): Promise<string | undefined> {
    return this.rpc.request<string | null>('inputBox', opts).then((v) => v ?? undefined);
  }
  saveDialog(opts: { defaultPath: string; filters?: Record<string, string[]> }): Promise<string | undefined> {
    return this.rpc.request<string | null>('saveDialog', opts).then((v) => v ?? undefined);
  }
  async withProgress<T>(
    title: string,
    task: (p: { report(increment: number, message: string): void; onCancel(fn: () => void): void }) => Promise<T>,
    opts?: { cancellable?: boolean },
  ): Promise<T> {
    const id = ++this.progressSeq;
    this.rpc.notify('progress.begin', { id, title, cancellable: !!opts?.cancellable });
    try {
      return await task({
        report: (increment, message) => this.rpc.notify('progress.report', { id, increment, message }),
        onCancel: (fn) => void this.cancels.set(id, fn),
      });
    } finally {
      this.cancels.delete(id);
      this.rpc.notify('progress.end', { id });
    }
  }
  confirm(message: string, detail: string, action: string): Promise<boolean> {
    return this.rpc.request<boolean>('confirm', { message, detail, action });
  }
  statusMessage(text: string, ms: number): void {
    this.rpc.notify('statusMessage', { text, ms });
  }

  // --- Workspace ---
  workspaceRoot(): string | undefined {
    return this.root;
  }
  relativePath(absPath: string): string {
    if (!this.root) return absPath;
    const rel = path.relative(this.root, absPath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : absPath;
  }
  findFiles(glob: string, exclude: string, max: number): Promise<string[]> {
    return this.rpc.request<string[]>('findFiles', { glob, exclude, max });
  }
  saveIfDirty(absPath: string): void {
    this.rpc.notify('saveIfDirty', { path: absPath });
  }

  // --- Editor ---
  async openFile(absPath: string, opts?: { line?: number; preview?: boolean }): Promise<void> {
    await this.rpc.request('openFile', { path: absPath, ...opts });
  }
  openQuietly(absPath: string): void {
    this.rpc.notify('openQuietly', { path: absPath });
  }
  async previewFile(absPath: string): Promise<void> {
    await this.rpc.request('previewFile', { path: absPath });
  }
  async showDiff(left: DiffSide, right: DiffSide, name: string, title: string): Promise<void> {
    await this.rpc.request('showDiff', { left, right, name, title });
  }
  onSelection(listener: (sel: SelectionInfo | undefined) => void): Disposable {
    return this.selection.add(listener);
  }
  onTabsChanged(listener: () => void): Disposable {
    return this.tabs.add(listener);
  }
  isDocumentOpen(docKey: string): boolean {
    return this.openDocs.has(docKey);
  }
  onCopySource(listener: (text: string, ref: string) => void): Disposable {
    return this.copy.add(listener);
  }

  // --- Shell and environment ---
  runInTerminal(name: string, command: string): void {
    this.rpc.notify('runInTerminal', { name, command });
  }
  openExternal(url: string): void {
    this.rpc.notify('openExternal', { url });
  }
  openPath(absPath: string): void {
    this.rpc.notify('openPath', { path: absPath });
  }
  isLocalUi(): boolean {
    return this.localUi;
  }
  isWebUi(): boolean {
    return false;
  }

  // --- Asked for by name ---
  openSettings(): void {
    const file = this.settingsFile();
    if (file) void this.openFile(file).catch(() => undefined);
  }
  installDaemon(): void {
    this.installDaemonHandler();
  }
}

/** The plugin keeps secrets in the IDE's password safe. */
export class RpcSecrets implements SecretStore {
  constructor(private readonly rpc: RpcPeer) {}
  get(key: string): Promise<string | undefined> {
    return this.rpc.request<string | null>('secrets.get', { key }).then((v) => v ?? undefined);
  }
  async store(key: string, value: string): Promise<void> {
    await this.rpc.request('secrets.store', { key, value });
  }
  async delete(key: string): Promise<void> {
    await this.rpc.request('secrets.delete', { key });
  }
}
