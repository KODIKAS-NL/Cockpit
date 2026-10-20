// A Localizer that reads the same `l10n/bundle.l10n*.json` files VS Code uses, for hosts that have
// no translation service of their own (the Rider sidecar). English is the source text and the key.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Localizer } from './host';

const format = (message: string, args: Array<string | number | boolean>): string =>
  message.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));

function load(dir: string, language: string): Record<string, string> {
  const lang = language.toLowerCase();
  // `pt-br` -> bundle.l10n.pt-br.json; `pt` -> the same bundle; English has no file.
  const candidates = [`bundle.l10n.${lang}.json`, `bundle.l10n.${lang.split('-')[0]}.json`];
  if (lang.startsWith('pt')) candidates.push('bundle.l10n.pt-br.json');
  for (const name of candidates) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, string>;
    } catch {
      /* try the next one */
    }
  }
  return {};
}

/** `getLanguage` is read on every call, so a language change in the IDE applies at once. */
export function bundleLocalizer(l10nDir: string, getLanguage: () => string): Localizer {
  const cache = new Map<string, Record<string, string>>();
  const bundleFor = (language: string): Record<string, string> => {
    let b = cache.get(language);
    if (!b) {
      b = load(l10nDir, language);
      cache.set(language, b);
    }
    return b;
  };
  return {
    t: (message, ...args) => format(bundleFor(getLanguage())[message] ?? message, args),
    language: getLanguage,
  };
}
