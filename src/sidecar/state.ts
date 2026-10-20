// What the VS Code host gets from the editor, the sidecar keeps in files: the settings (with the
// defaults declared in package.json) and the small key/value store.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KeyValueStore, Settings } from '../core/host';

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** The `cockpitDaemon.*` defaults declared in the extension manifest. */
export function manifestDefaults(extensionPath: string): Record<string, unknown> {
  const props = (readJson(path.join(extensionPath, 'package.json')) as any)?.contributes?.configuration?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [full, def] of Object.entries<any>(props)) {
    if (full.startsWith('cockpitDaemon.') && def && 'default' in def) out[full.slice('cockpitDaemon.'.length)] = def.default;
  }
  return out;
}

/** Settings kept in one JSON file (user scope only). `onChange` fires with the changed key. */
export class FileSettings implements Settings {
  private values: Record<string, unknown>;

  constructor(
    readonly file: string,
    private readonly defaults: Record<string, unknown>,
    private readonly onChange: (key: string) => void = () => undefined,
  ) {
    this.values = readJson(file);
  }

  /** Re-reads the file (it was edited by hand) and reports the keys that changed. */
  reload(): string[] {
    const next = readJson(this.file);
    const keys = new Set([...Object.keys(this.values), ...Object.keys(next)]);
    const changed = [...keys].filter((k) => JSON.stringify(this.values[k]) !== JSON.stringify(next[k]));
    this.values = next;
    for (const k of changed) this.onChange(k);
    return changed;
  }

  get<T>(key: string, fallback: T): T {
    if (key in this.values) return this.values[key] as T;
    if (key in this.defaults) return this.defaults[key] as T;
    return fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    writeJson(this.file, this.values);
    this.onChange(key);
  }

  inspect<T>(key: string): { defaultValue?: T; global?: T } | undefined {
    return { defaultValue: this.defaults[key] as T | undefined, global: this.values[key] as T | undefined };
  }
}

/** The core's small persistent store (VS Code's globalState), in one JSON file. */
export class FileStore implements KeyValueStore {
  private data: Record<string, unknown>;

  constructor(private readonly file: string) {
    this.data = readJson(file);
  }

  get<T>(key: string, fallback?: T): T | undefined {
    return (key in this.data ? this.data[key] : fallback) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    writeJson(this.file, this.data);
  }
}
