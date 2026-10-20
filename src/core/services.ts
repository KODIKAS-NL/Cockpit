// The services the host registers at startup. The defaults keep the core usable (and testable)
// before, or without, a host: settings return their fallbacks and strings come back unchanged.
import type { Localizer, Settings } from './host';

const defaultSettings: Settings = {
  get: (_key, fallback) => fallback,
  update: () => Promise.resolve(),
  inspect: () => undefined,
};

const format = (message: string, args: Array<string | number | boolean>): string =>
  message.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));

const defaultLocalizer: Localizer = {
  t: (message, ...args) => format(message, args),
  language: () => 'en',
};

let currentSettings: Settings = defaultSettings;
let currentLocalizer: Localizer = defaultLocalizer;

export function setSettings(s: Settings): void {
  currentSettings = s;
}
export function settings(): Settings {
  return currentSettings;
}

export function setLocalizer(l: Localizer): void {
  currentLocalizer = l;
}
export function localizer(): Localizer {
  return currentLocalizer;
}

/** Shorthand for the host's translator. */
export const t = (message: string, ...args: Array<string | number | boolean>): string =>
  currentLocalizer.t(message, ...args);
