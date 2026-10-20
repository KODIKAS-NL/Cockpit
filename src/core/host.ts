// What the editor-neutral core needs from its host. VS Code implements these in src/vscode/;
// another editor (Rider) would implement the same shapes. The core never imports 'vscode'.

export type SettingScope = 'global' | 'workspace' | 'folder';

/** The `cockpitDaemon.*` settings. Keys are relative: `get('engine', 'claude')`. */
export interface Settings {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown, scope?: SettingScope): PromiseLike<void>;
  /** The default and the explicit value per scope (for migrations that rewrite stale values). */
  inspect<T>(key: string): { defaultValue?: T; global?: T; workspace?: T; folder?: T } | undefined;
}

/** Translates host strings (English source text is the key; `{0}` placeholders). */
export interface Localizer {
  t(message: string, ...args: Array<string | number | boolean>): string;
  /** The editor's UI language, e.g. `en` or `pt-br`. */
  language(): string;
}

/** Small persistent key/value store (VS Code's globalState). */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Encrypted store for secrets (the OS keychain behind VS Code's SecretStorage). */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface Disposable {
  dispose(): void;
}

export type NotifyLevel = 'info' | 'warning' | 'error';

/** The editor selection, as the composer's `@file#a-b` reference needs it. */
export interface SelectionInfo {
  /** Workspace-relative path. */
  path: string;
  startLine: number; // 1-based
  endLine: number; // 1-based
  endChar: number;
  /** Identifies the document, to notice when it is closed. */
  docKey: string;
}

/** One side of a diff: a file on disk, or text held in memory. */
export type DiffSide = { path: string } | { text: string };

/**
 * The editor operations the core asks for. The VS Code implementation is src/vscode/VsCodeHost.ts;
 * another editor implements the same shape. Paths are absolute unless noted.
 */
export interface EditorHost {
  // --- Messages ---
  /** Shows a message with optional action buttons; resolves with the chosen action. */
  notify(level: NotifyLevel, message: string, ...actions: string[]): PromiseLike<string | undefined>;
  /** Takes down transient notifications (a permission prompt answered elsewhere). */
  hideNotifications(): void;
  inputBox(opts: {
    title?: string;
    prompt?: string;
    placeholder?: string;
    value?: string;
    password?: boolean;
  }): PromiseLike<string | undefined>;
  /** Resolves with the chosen path, or undefined when cancelled. `filters`: label -> extensions. */
  saveDialog(opts: { defaultPath: string; filters?: Record<string, string[]> }): PromiseLike<string | undefined>;
  /** A progress notification. `report` adds to the bar; `onCancel` registers a cancel callback. */
  withProgress<T>(
    title: string,
    task: (progress: { report(increment: number, message: string): void; onCancel(fn: () => void): void }) => Promise<T>,
    opts?: { cancellable?: boolean },
  ): PromiseLike<T>;

  // --- Workspace ---
  /** First workspace folder, if any. */
  workspaceRoot(): string | undefined;
  relativePath(absPath: string): string;
  findFiles(glob: string, exclude: string, max: number): PromiseLike<string[]>;
  /** Saves the open buffer for this file when it has unsaved changes. */
  saveIfDirty(absPath: string): void;

  // --- Editor ---
  /** Opens a file in the editor, at a 1-based line. Rejects when it cannot be opened. */
  openFile(absPath: string, opts?: { line?: number; preview?: boolean }): Promise<void>;
  /** Opens a file without taking focus, in the editor the user chose for Markdown (else text). */
  openQuietly(absPath: string): void;
  /** Opens the rendered preview for Markdown (honouring the user's editor choice), else the file. */
  previewFile(absPath: string): Promise<void>;
  /** A native diff. `name` titles the in-memory sides. */
  showDiff(left: DiffSide, right: DiffSide, name: string, title: string): Promise<void>;
  /** Selection changes in the editor (undefined: nothing worth referencing is selected). */
  onSelection(listener: (sel: SelectionInfo | undefined) => void): Disposable;
  /** Fires when editor tabs open or close. */
  onTabsChanged(listener: () => void): Disposable;
  isDocumentOpen(docKey: string): boolean;
  /** Code copied in an editor, as a reference (`@path#a-b`) ready to paste into the prompt. */
  onCopySource(listener: (text: string, ref: string) => void): Disposable;

  // --- Shell and environment ---
  runInTerminal(name: string, command: string): void;
  openExternal(url: string): void;
  /** Opens a folder or file with the operating system. */
  openPath(absPath: string): void;
  /** The UI runs on this machine (no Remote-SSH, not a browser). */
  isLocalUi(): boolean;
  /** The UI is a browser (code-server). */
  isWebUi(): boolean;

  /** A modal question; true when the user picked the `action` button. */
  confirm(message: string, detail: string, action: string): PromiseLike<boolean>;
  /** A short message in the status area that fades by itself. */
  statusMessage(text: string, ms: number): void;

  // --- Things the core asks the host to do, by name ---
  openSettings(): void;
  installDaemon(): void;
}
