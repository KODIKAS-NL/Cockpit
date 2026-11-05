// Regression: encodeCwd must match the folder names the Claude Code CLI actually
// creates under ~/.claude/projects. The original bug: a cwd with a SPACE
// (`F:\Estudo Cobol`) encoded to a path that never existed, so listSessions
// returned [] and every live tab showed "0 msgs".
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  encodeCwd,
  listSessions,
  loadTranscript,
  readSessionTitle,
  writeSessionTitle,
} from '../src/session/SessionStore';

describe('encodeCwd — matches the CLI folder format', () => {
  it('replaces every non-alphanumeric char with a single "-"', () => {
    // Two specials in a row -> two dashes (not merged), matching real folders
    // like `D--Tootega-Source-TootegaERP--run-...`.
    expect(encodeCwd('D:\\Tootega\\Source\\Cockpit')).toBe('D--Tootega-Source-Cockpit');
  });

  it('encodes spaces in the path (the reported bug)', () => {
    // Real folder on disk: f--Estudo-Cobol (casing of the rest is preserved).
    expect(encodeCwd('f:\\Estudo Cobol')).toBe('f--Estudo-Cobol');
    expect(encodeCwd('F:\\Estudo Cobol')).toBe('F--Estudo-Cobol');
  });

  it('preserves the casing of the path (does not lowercase CrediSIS/Cockpit)', () => {
    expect(encodeCwd('d:\\CrediSIS\\Source\\ERP')).toBe('d--CrediSIS-Source-ERP');
  });

  it('collapses accents/parentheses/dots too (anything Windows allows)', () => {
    expect(encodeCwd('C:\\Proj (v2)\\São Paulo.bak')).toBe('C--Proj--v2--S-o-Paulo-bak');
  });

  it('keeps digits', () => {
    expect(encodeCwd('d:\\Tootega\\Source\\DASE50')).toBe('d--Tootega-Source-DASE50');
  });
});

// Regression: a long transcript used to be read with readFileSync(file, 'utf8'), and Node cannot
// build a string longer than 512 MB. A real 540 MB transcript (83% of it the CLI's own
// `api-request` debug records) threw ERR_STRING_TOO_LONG, which both readers caught and turned
// into an empty result: the conversation showed no history and no title, as if it were lost.
describe('transcripts bigger than a chunk', () => {
  const cwd = path.join(os.tmpdir(), `cockpit-transcript-${process.pid}`);
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Lines summing to well over the 1 MB read chunk, with multi-byte text on every one. */
  const write = (lines: unknown[]): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };

  it('reads every message across the chunk boundaries, multi-byte text intact', () => {
    const filler = 'ação ✓ ' .repeat(20_000); // ~140 KB per line, multi-byte
    const lines: unknown[] = [{ type: 'user', message: { role: 'user', content: 'primeira — ação' } }];
    for (let i = 0; i < 20; i++) {
      lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }] } });
    }
    lines.push({ type: 'user', message: { role: 'user', content: 'última — ação ✓' } });
    write(lines);

    const items = loadTranscript(cwd, id);
    const users = items.filter((i) => i.kind === 'user') as { text: string }[];
    expect(users.map((u) => u.text)).toEqual(['primeira — ação', 'última — ação ✓']);
    expect(items.filter((i) => i.kind === 'assistant')).toHaveLength(20);

    const info = listSessions(cwd).find((s) => s.id === id);
    expect(info?.title).toBe('primeira — ação');
    expect(info?.messageCount).toBe(22);
  });

  // The real condition, reproduced without writing half a gigabyte: the records, then a sparse
  // hole that pushes the file past Node's 512 MB string limit. readFileSync(file, 'utf8') throws
  // ERR_STRING_TOO_LONG here, which is what silently emptied the conversation.
  it('reads a transcript larger than the maximum string length', () => {
    const MAX_STRING = require('node:buffer').constants.MAX_STRING_LENGTH;
    write([
      { type: 'user', message: { role: 'user', content: 'recupere esta conversa' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const f = path.join(dir, `${id}.jsonl`);
    const real = fs.statSync(f).size;
    fs.truncateSync(f, MAX_STRING + 4 * 1024 * 1024); // a hole: no disk space, no newlines
    expect(fs.statSync(f).size).toBeGreaterThan(MAX_STRING);
    expect(() => fs.readFileSync(f, 'utf8')).toThrow(/string longer/i);
    expect(real).toBeLessThan(1024);

    const items = loadTranscript(cwd, id);
    expect((items.find((i) => i.kind === 'user') as { text: string }).text).toBe('recupere esta conversa');
    expect(items.filter((i) => i.kind === 'assistant')).toHaveLength(1);
    expect(listSessions(cwd).find((s) => s.id === id)?.title).toBe('recupere esta conversa');
  });

  // The weight of a real transcript is in a few enormous lines, not in many small ones.
  it('reads a single line bigger than the chunk', () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    write([
      { type: 'user', message: { role: 'user', content: 'pergunta' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: huge }] } },
    ]);

    const items = loadTranscript(cwd, id);
    const assistant = items.find((i) => i.kind === 'assistant') as { text: string };
    expect(assistant.text).toHaveLength(huge.length);
    expect(listSessions(cwd).find((s) => s.id === id)?.messageCount).toBe(2);
  });
});

// A rename made outside this window — `/title`, or on the phone through Remote Control — is
// recorded by the CLI as a `custom-title` line in the transcript. Cockpit used to read only
// `ai-title`, so the dashboard, the tab and the daemon all kept showing the old name.
describe('the name a person gave the conversation', () => {
  const cwd = path.join(os.tmpdir(), `cockpit-title-${process.pid}`);
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
  const id = '11111111-2222-3333-4444-555555555555';
  const file = path.join(dir, `${id}.jsonl`);

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (lines: unknown[]): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };

  it('is read from the end of the transcript, and wins over the generated one', () => {
    // Filler ahead of it: the reader only looks at the tail, which is where the CLI keeps
    // re-appending this record.
    const filler = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(50_000) }] } };
    write([
      { type: 'user', message: { role: 'user', content: 'the first thing I asked' } },
      { type: 'ai-title', aiTitle: 'A name the model made up' },
      filler,
      { type: 'custom-title', customTitle: 'Renamed on the phone', sessionId: id },
    ]);

    expect(readSessionTitle(cwd, id)).toBe('Renamed on the phone');
    const info = listSessions(cwd).find((s) => s.id === id);
    expect(info?.title).toBe('Renamed on the phone');
    expect(info?.titleIsCustom).toBe(true);
  });

  it('takes the last one: renaming twice keeps the newer name', () => {
    write([
      { type: 'user', message: { role: 'user', content: 'ask' } },
      { type: 'custom-title', customTitle: 'First name', sessionId: id },
      { type: 'custom-title', customTitle: 'Second name', sessionId: id },
    ]);
    expect(readSessionTitle(cwd, id)).toBe('Second name');
  });

  it('cleared on purpose: falls back to the generated name', () => {
    write([
      { type: 'user', message: { role: 'user', content: 'ask' } },
      { type: 'ai-title', aiTitle: 'A name the model made up' },
      { type: 'custom-title', customTitle: '', sessionId: id },
    ]);
    expect(readSessionTitle(cwd, id)).toBeUndefined();
    const info = listSessions(cwd).find((s) => s.id === id);
    expect(info?.title).toBe('A name the model made up');
    expect(info?.titleIsCustom).toBeFalsy();
  });

  it('a rename here is recorded the same way, so the CLI and the phone see it too', () => {
    write([{ type: 'user', message: { role: 'user', content: 'ask' } }]);
    expect(writeSessionTitle(cwd, id, '  Named here  ')).toBe(true);

    expect(readSessionTitle(cwd, id)).toBe('Named here');
    const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop() as string);
    expect(last).toEqual({ type: 'custom-title', customTitle: 'Named here', sessionId: id });
    // The transcript still parses: the rename appended a line, it did not rewrite the file.
    expect(loadTranscript(cwd, id).filter((i) => i.kind === 'user')).toHaveLength(1);
  });

  it('no transcript to name: says so instead of creating one', () => {
    expect(writeSessionTitle(cwd, id, 'Nowhere')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(readSessionTitle(cwd, id)).toBeUndefined();
  });
});
