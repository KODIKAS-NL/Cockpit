import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLocalCommand } from '../shared/localCommand';
import { encodeCwd, loadTranscript } from '../src/session/SessionStore';

describe('parseLocalCommand', () => {
  it('reads stdout and stderr', () => {
    expect(parseLocalCommand('<local-command-stdout>Set model to `sonnet`</local-command-stdout>')).toEqual({
      kind: 'output',
      text: 'Set model to `sonnet`',
      error: false,
    });
    expect(parseLocalCommand('<local-command-stderr> boom </local-command-stderr>')).toEqual({
      kind: 'output',
      text: 'boom',
      error: true,
    });
    expect(parseLocalCommand('<local-command-stdout></local-command-stdout>')).toEqual({ kind: 'output', text: '', error: false });
  });

  it('reads the command wrapper, with and without args', () => {
    const w = '<command-name>/model</command-name>\n   <command-message>model</command-message>\n  <command-args>sonnet</command-args>';
    expect(parseLocalCommand(w)).toEqual({ kind: 'command', name: '/model', args: 'sonnet' });
    expect(parseLocalCommand('<command-name>/cost</command-name><command-message>cost</command-message>')).toEqual({
      kind: 'command',
      name: '/cost',
      args: '',
    });
  });

  it('recognises the caveat and ignores plain text', () => {
    expect(parseLocalCommand('<local-command-caveat>x</local-command-caveat>')).toEqual({ kind: 'caveat' });
    expect(parseLocalCommand('hello <b>')).toBeUndefined();
  });
});

describe('transcript with a local command', () => {
  it('loads the command as a user item and its output as a notice', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-lc-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const cwd = '/tmp/lc-proj';
      const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const u = (uuid: string, content: string, extra: object = {}) =>
        JSON.stringify({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
      fs.writeFileSync(
        path.join(dir, 's1.jsonl'),
        [
          u('a', '<local-command-caveat>c</local-command-caveat>', { isMeta: true }),
          u('b', '<command-name>/model</command-name><command-message>model</command-message><command-args>sonnet</command-args>'),
          u('c', '<local-command-stdout>Set model to `sonnet`</local-command-stdout>'),
        ].join('\n'),
      );
      const items = loadTranscript(cwd, 's1');
      expect(items).toMatchObject([
        { kind: 'user', text: '/model sonnet' },
        { kind: 'notice', text: 'Set model to `sonnet`', topic: 'local_command' },
      ]);
    } finally {
      process.env.HOME = prev;
    }
  });
});
