// The editor-neutral core must not import 'vscode'. Only the adapter (src/vscode/) and the
// extension entry may. The allowlist holds the files that still do; it only shrinks.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '../src');

const ALLOWED = new Set<string>([
  'extension.ts',
  'panel/ChatViewProvider.ts',
  'scratchpad/ScratchpadPanel.ts',
]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const importsVscode = (file: string): boolean =>
  /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/.test(fs.readFileSync(file, 'utf8'));

describe('core boundary', () => {
  const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), abs: f }));

  it('only the allowlisted files import vscode', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('vscode/') && importsVscode(f.abs) && !ALLOWED.has(f.rel))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const stale = [...ALLOWED].filter((rel) => {
      const f = files.find((x) => x.rel === rel);
      return !f || !importsVscode(f.abs);
    });
    expect(stale).toEqual([]);
  });
});
