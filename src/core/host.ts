// What the editor-neutral core needs from its host. VS Code implements these in src/vscode/;
// another editor (Rider) would implement the same shapes. The core never imports 'vscode'.

export type SettingScope = 'global' | 'workspace' | 'folder';

/** The `cockpitDaemon.*` settings. Keys are relative: `get('engine', 'claude')`. */
export interface Settings {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown, scope?: SettingScope): PromiseLike<void>;
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
