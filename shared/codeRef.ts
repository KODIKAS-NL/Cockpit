// Code references: "@src/a/b.ts#L12-30", the mention format the Claude Code CLI itself uses. Pure
// helpers shared by the host (building a ref from an editor range) and the webview (reading one
// back for a chip, matching a paste against the last copy).

/** `#L12` for one line, `#L12-30` for a range. A range ending at column 0 stops on the line before. */
export function buildRef(rel: string, startLine: number, endLine: number, endChar = 1): string {
  const end = endLine > startLine && endChar === 0 ? endLine - 1 : endLine;
  return `@${rel}#L${startLine}${end > startLine ? `-${end}` : ''}`;
}

export interface ParsedRef {
  path: string;
  name: string;
  dir: string;
  start?: number;
  end?: number;
}

/** Reads `@path#L12-30`, and the older `@path#12-30` the extension used to send. */
export function parseRef(ref: string): ParsedRef {
  const m = /^@?(.*?)(?:#L?(\d+)(?:-L?(\d+))?)?$/.exec(ref.trim());
  const path = m?.[1] ?? ref;
  const cut = path.lastIndexOf('/');
  const start = m?.[2] ? parseInt(m[2], 10) : undefined;
  const end = m?.[3] ? parseInt(m[3], 10) : undefined;
  return { path, name: cut >= 0 ? path.slice(cut + 1) : path, dir: cut >= 0 ? path.slice(0, cut) : '', start, end };
}

/** "12-30", or "12" for one line, or "" without lines. */
export function refLines(p: ParsedRef): string {
  if (p.start === undefined) return '';
  return p.end !== undefined && p.end !== p.start ? `${p.start}-${p.end}` : `${p.start}`;
}

/** The leading `@file#L..` lines of a message, and the rest of it. */
export function splitLeadingRefs(text: string): { refs: string[]; rest: string } {
  const lines = text.split('\n');
  const refs: string[] = [];
  while (lines.length && /^@\S+#L?\d+(-L?\d+)?$/.test(lines[0])) refs.push(lines.shift() as string);
  return { refs, rest: refs.length ? lines.join('\n') : text };
}

/** Same text for the purpose of "this paste is that copy": line endings and trailing newlines ignored. */
export function sameCopy(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return a.length > 0 && norm(a) === norm(b);
}

/** Any non-blank copy becomes a reference: a method name is as good a pointer as a block. */
export function isRefWorthy(text: string, _startLine: number, _endLine: number): boolean {
  return text.trim().length > 0;
}

export interface InlineRef {
  start: number;
  end: number;
  ref: string;
}

/** The `@file#La-b` tokens inside a text: after whitespace (or at the start), before whitespace, punctuation or the end. */
export function findRefs(text: string): InlineRef[] {
  const out: InlineRef[] = [];
  const re = /(^|\s)(@\S+?#L?\d+(?:-L?\d+)?)(?=$|[\s.,;:!?)\]])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    out.push({ start, end: start + m[2].length, ref: m[2] });
  }
  return out;
}

/**
 * The token a caret touches. `back`: the caret is at its end or inside it (Backspace); `fwd`: at its
 * start or inside it (Delete); `in`: strictly inside (snapping the caret to an edge).
 */
export function refAt(text: string, pos: number, dir: 'back' | 'fwd' | 'in'): InlineRef | undefined {
  return findRefs(text).find((r) =>
    dir === 'back' ? pos > r.start && pos <= r.end : dir === 'fwd' ? pos >= r.start && pos < r.end : pos > r.start && pos < r.end,
  );
}

const quote = (s: string): string => s.replace(/\n+$/, '').split('\n').map((l) => `> ${l}`).join('\n');

/**
 * Plan feedback goes back to the CLI as a tool result, and the CLI does not expand `@file` mentions
 * there. So each reference becomes the lines themselves: from the plan when it points at the plan
 * file, from the copied text when this box pasted it, and otherwise it stays a mention.
 */
export function expandRefsForFeedback(
  text: string,
  plan: string,
  planFile: string | undefined,
  pasted: ReadonlyMap<string, string>,
): string {
  let out = text;
  const planLines = plan.replace(/\n+$/, '').split('\n');
  for (const r of findRefs(text).reverse()) {
    const p = parseRef(r.ref);
    let rep: string | undefined;
    const isPlan = !!planFile && !!p.path && (planFile === p.path || planFile.endsWith(`/${p.path}`) || p.path.endsWith(`/${planFile}`));
    if (isPlan && p.start) {
      const end = p.end ?? p.start;
      rep = `The plan, lines ${p.start === end ? p.start : `${p.start}-${end}`}:\n${quote(planLines.slice(p.start - 1, end).join('\n'))}`;
    } else if (pasted.has(r.ref)) {
      rep = `${r.ref}:\n${quote(pasted.get(r.ref) as string)}`;
    }
    if (rep !== undefined) out = out.slice(0, r.start) + rep + out.slice(r.end);
  }
  return out;
}
