import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { bundleLocalizer } from '../src/core/BundleLocalizer';

const dir = path.resolve(__dirname, '../l10n');

describe('bundleLocalizer', () => {
  it('translates with the pt-br bundle and fills placeholders', () => {
    const l = bundleLocalizer(dir, () => 'pt-br');
    expect(l.t('Started a new session.')).toBe('Nova sessão iniciada.');
    expect(l.t('File not found: {0}', 'a.ts')).toBe('Arquivo não encontrado: a.ts');
  });
  it('accepts pt-BR casing and a bare pt', () => {
    expect(bundleLocalizer(dir, () => 'pt-BR').t('Agent interrupted.')).toBe('Agente interrompido.');
    expect(bundleLocalizer(dir, () => 'pt').t('Agent interrupted.')).toBe('Agente interrompido.');
  });
  it('falls back to the English text, and follows a language change', () => {
    let lang = 'en';
    const l = bundleLocalizer(dir, () => lang);
    expect(l.t('File not found: {0}', 'x')).toBe('File not found: x');
    expect(l.t('Unknown text')).toBe('Unknown text');
    lang = 'pt-br';
    expect(l.t('Agent interrupted.')).toBe('Agente interrompido.');
  });
});
