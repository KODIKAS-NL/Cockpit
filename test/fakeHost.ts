// In-memory stand-ins for the core's host interfaces, so the core runs without an editor.
import type { Disposable, EditorHost, KeyValueStore, Settings, SecretStore } from '../src/core/host';

export class FakeSettings implements Settings {
  readonly values = new Map<string, unknown>();
  readonly updates: Array<{ key: string; value: unknown; scope?: string }> = [];
  get<T>(key: string, fallback: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown, scope?: 'global' | 'workspace' | 'folder'): Promise<void> {
    this.values.set(key, value);
    this.updates.push({ key, value, scope });
  }
  inspect<T>(key: string): { defaultValue?: T; global?: T; workspace?: T; folder?: T } | undefined {
    return { global: this.values.get(key) as T | undefined };
  }
}

export class FakeStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.data.has(key) ? this.data.get(key) : fallback) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

export class FakeSecrets implements SecretStore {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const none: Disposable = { dispose() {} };

export class FakeHost implements EditorHost {
  root: string | undefined = process.cwd();
  readonly opened: Array<{ path: string; line?: number; preview?: boolean }> = [];
  readonly external: string[] = [];
  readonly notices: Array<{ level: string; message: string }> = [];
  async notify(level: 'info' | 'warning' | 'error', message: string): Promise<undefined> {
    this.notices.push({ level, message });
    return undefined;
  }
  hideNotifications(): void {}
  async confirm(): Promise<boolean> {
    return false;
  }
  statusMessage(): void {}
  async inputBox(): Promise<undefined> {
    return undefined;
  }
  async saveDialog(): Promise<undefined> {
    return undefined;
  }
  async withProgress<T>(_t: string, task: (p: { report(i: number, m: string): void; onCancel(f: () => void): void }) => Promise<T>): Promise<T> {
    return task({ report() {}, onCancel() {} });
  }
  workspaceRoot(): string | undefined {
    return this.root;
  }
  relativePath(abs: string): string {
    return abs;
  }
  async findFiles(): Promise<string[]> {
    return [];
  }
  saveIfDirty(): void {}
  async openFile(p: string, opts?: { line?: number; preview?: boolean }): Promise<void> {
    this.opened.push({ path: p, ...opts });
  }
  openQuietly(): void {}
  async previewFile(): Promise<void> {}
  async showDiff(): Promise<void> {}
  onSelection(): Disposable {
    return none;
  }
  onTabsChanged(): Disposable {
    return none;
  }
  isDocumentOpen(): boolean {
    return false;
  }
  onCopySource(): Disposable {
    return none;
  }
  runInTerminal(): void {}
  openExternal(url: string): void {
    this.external.push(url);
  }
  openPath(): void {}
  isLocalUi(): boolean {
    return true;
  }
  isWebUi(): boolean {
    return false;
  }
  openSettings(): void {}
  installDaemon(): void {}
}
