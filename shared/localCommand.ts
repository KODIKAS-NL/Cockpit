// The CLI wraps the output of local slash commands (/model, /cost, ...) in tags and records
// them as user messages. They are not prompts: the output is shown as a notice, the rest hidden.

export type LocalCommand =
  | { kind: 'command'; name: string; args: string }
  | { kind: 'output'; text: string; error: boolean }
  | { kind: 'caveat' };

function inner(text: string, tag: string): string | undefined {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

export function parseLocalCommand(raw: string): LocalCommand | undefined {
  const text = raw.trim();
  if (text.startsWith('<local-command-caveat')) return { kind: 'caveat' };
  if (text.startsWith('<local-command-stdout') || text.startsWith('<local-command-stderr')) {
    const err = text.startsWith('<local-command-stderr');
    return { kind: 'output', text: inner(text, err ? 'local-command-stderr' : 'local-command-stdout') ?? '', error: err };
  }
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
    const name = inner(text, 'command-name') ?? inner(text, 'command-message') ?? '';
    const args = inner(text, 'command-args') ?? '';
    return { kind: 'command', name: name.startsWith('/') ? name : `/${name}`, args };
  }
  return undefined;
}
