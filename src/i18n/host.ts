// Locale resolution on the host side (notifications via the host's localizer).
import { localizer, settings } from '../core/services';

export type LocaleId = 'pt-BR' | 'en';

export function resolveLocale(): LocaleId {
  const cfg = settings().get<string>('language', 'auto');
  const raw = cfg && cfg !== 'auto' ? cfg : localizer().language();
  return raw?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}
