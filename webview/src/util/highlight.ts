// Syntax highlighting via highlight.js with a curated set of languages.
import { isMisspelled, isIgnored } from '../spell/spell';
import { findRefs, parseRef, refLines } from '../../../shared/codeRef';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import csharp from 'highlight.js/lib/languages/csharp';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import powershell from 'highlight.js/lib/languages/powershell';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import ini from 'highlight.js/lib/languages/ini';

const LANGS: Record<string, (hljs: typeof import('highlight.js/lib/core').default) => unknown> = {
  javascript,
  typescript,
  python,
  csharp,
  java,
  go,
  rust,
  json,
  xml,
  css,
  bash,
  shell,
  powershell,
  sql,
  yaml,
  markdown,
  php,
  ruby,
  cpp,
  c,
  ini,
};
for (const [name, lang] of Object.entries(LANGS)) {
  hljs.registerLanguage(name, lang as never);
}

// Extension -> hljs language.
const EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  cs: 'csharp', java: 'java', go: 'go', rs: 'rust',
  json: 'json', jsonc: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', xaml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'css', less: 'css',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
  sql: 'sql', yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  php: 'php', rb: 'ruby',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', h: 'cpp', c: 'c',
  ini: 'ini', toml: 'ini', conf: 'ini', cfg: 'ini', env: 'ini',
};

const MAX = 200_000; // don't highlight huge blobs

export function languageFromPath(p?: string): string | undefined {
  if (!p) return undefined;
  const clean = p.replace(/["']/g, '').trim();
  const ext = clean.split('.').pop()?.toLowerCase();
  return ext ? EXT[ext] : undefined;
}

export interface Highlighted {
  html: string;
  language?: string;
}

export function highlightCode(code: string, language?: string): Highlighted {
  if (!code) return { html: '' };
  if (code.length > MAX || language === 'plaintext') return { html: escapeHtml(code) };
  try {
    if (language && hljs.getLanguage(language)) {
      return {
        html: hljs.highlight(code, { language, ignoreIllegals: true }).value,
        language,
      };
    }
    const auto = hljs.highlightAuto(code);
    return { html: auto.value, language: auto.language };
  } catch {
    return { html: escapeHtml(code) };
  }
}

/**
 * Detects the `cat -n` format (the CLI's Read: "  12<TAB>content" or "  12→ content")
 * and splits the line numbers from the content, to highlight the clean code in a gutter.
 * Returns null when most lines have no numbering.
 */
export function stripLineNumbers(text: string): { code: string; numbers: (number | null)[] } | null {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const numbers: (number | null)[] = [];
  const out: string[] = [];
  let matched = 0;
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)(?:\t|→ ?)(.*)$/);
    if (m) {
      numbers.push(parseInt(m[1], 10));
      out.push(m[2]);
      matched++;
    } else {
      numbers.push(null);
      out.push(line);
    }
  }
  // discards the common trailing empty line (the file ends in \n)
  const effective = lines[lines.length - 1].trim() === '' ? lines.length - 1 : lines.length;
  if (matched < effective * 0.6) return null;
  return { code: out.join('\n'), numbers };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Markdown-aware highlighting for the user's input and message: it highlights only
 * fenced ``` ``` blocks (by language, or auto) and inline `code`; prose
 * stays plain text. The HTML's TEXT CONTENT is identical to the original text
 * (the ``` and ` markers remain as text), guaranteeing alignment in the overlay.
 */

// `spell`: marks misspelled words in the PROSE (never in code). Each snippet's
// global offset is passed on to the spans' data-ss (the composer
// usa p/ ancorar o dropdown e localizar a palavra no texto).
export function richHighlight(text: string, spell = false, refChips = false): string {
  if (!text) return '';
  // No fences: decided by relevance — code is colored, prose stays plain.
  if (!text.includes('```')) return autoOrPlain(text, spell, 0, refChips);

  const fence = /```([\w+#.-]*)([ \t]*\n)([\s\S]*?)```/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    out += autoOrPlain(text.slice(last, m.index), spell, last, refChips);
    const lang = m[1];
    const sep = m[2]; // spaces + \n after the language
    const code = m[3];
    const hl = highlightCode(code, lang || undefined).html; // hljs resolve aliases (ts, js…)
    out +=
      `<span class="rt-fence">\`\`\`${escapeHtml(lang)}</span>${escapeHtml(sep)}` +
      `<span class="rt-code">${hl}</span>` +
      `<span class="rt-fence">\`\`\`</span>`;
    last = fence.lastIndex;
  }
  out += autoOrPlain(text.slice(last), spell, last, refChips);
  return out;
}

// Unfenced text is prose: plain, with inline `code` and spell marks. It used to be auto-detected as
// code when hljs found it relevant enough, which painted ordinary words ("a", "to", "I") as keywords
// in a normal sentence, and every extra span is one more place where the mirror can drift from the
// textarea. Code is colored when it is fenced. It keeps the text identical.
function autoOrPlain(s: string, spell: boolean, base: number, refChips: boolean): string {
  if (!s) return '';
  return inlineRich(s, spell, base, refChips);
}

function inlineRich(s: string, spell: boolean, base: number, refChips: boolean): string {
  let out = '';
  let last = 0;
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += emitProse(s.slice(last, m.index), spell, base + last, refChips);
    out += `<span class="rt-inline">\`${escapeHtml(m[1])}\`</span>`;
    last = re.lastIndex;
  }
  out += emitProse(s.slice(last), spell, base + last, refChips);
  return out;
}

// Prosa pura: escapa e, se spell ligado, envolve palavras erradas em spans.
function emitProse(s: string, spell: boolean, base: number, refChips: boolean): string {
  const refs = findRefs(s);
  if (refs.length === 0) return emitWords(s, spell, base);
  // `@file#La-b` tokens: in the composer a marked span with the text untouched (the mirror must
  // keep the textarea's glyph widths); in the timeline a real chip.
  let out = '';
  let last = 0;
  for (const r of refs) {
    out += emitWords(s.slice(last, r.start), spell, base + last);
    out += refChips ? refChip(r.ref) : `<span class="rt-ref" data-rs="${base + r.start}">${escapeHtml(r.ref)}</span>`;
    last = r.end;
  }
  return out + emitWords(s.slice(last), spell, base + last);
}

function refChip(ref: string): string {
  const p = parseRef(ref);
  const lines = refLines(p);
  const href = p.start ? `${p.path}#L${p.start}` : p.path;
  return (
    `<span class="ref-chip" data-href="${escapeHtml(href)}" title="${escapeHtml(`${p.path}${lines ? `:${lines}` : ''}`)}">` +
    `<span class="composer-selchip-name">${escapeHtml(p.name)}</span>` +
    (lines ? `<span class="composer-selchip-lines">:${lines}</span>` : '') +
    (p.dir ? `<span class="composer-selchip-dir"><bdi>${escapeHtml(p.dir)}</bdi></span>` : '') +
    `</span>`
  );
}

function emitWords(s: string, spell: boolean, base: number): string {
  if (!spell || !s) return escapeHtml(s);
  return spellWrap(s, base);
}

// Word: letters (with accents) + internal apostrophe/hyphen. No digits.
const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*/g;

/**
 * Wraps misspelled words in `<span class="spell-error">`, keeping
 * the rest of the text escaped and identical (alignment in the overlay). `data-ss` = the word's
 * global offset in the composer text; `data-sw` = the word (for suggestions).
 */
function spellWrap(s: string, base: number): string {
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(s))) {
    const word = m[0];
    const start = m.index;
    out += escapeHtml(s.slice(last, start));
    if (spellable(word, s, start) && isMisspelled(word) && !isIgnored(word)) {
      out += `<span class="spell-error" data-sw="${escapeHtml(word)}" data-ss="${base + start}">${escapeHtml(word)}</span>`;
    } else {
      out += escapeHtml(word);
    }
    last = start + word.length;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

// Filters tokens that must NOT be checked: too short, code
// identifiers (camelCase), acronyms, and tokens inside a URL/path/@mention/command.
function spellable(word: string, ctx: string, start: number): boolean {
  if (word.length < 2) return false;
  if (/[a-zà-ÿ][A-ZÀ-Ö]/.test(word)) return false; // camelCase → identifier
  if (word.length <= 6 && word === word.toUpperCase()) return false; // sigla
  const prev = start > 0 ? ctx[start - 1] : ' ';
  const next = ctx[start + word.length] ?? ' ';
  // Glued to @ / backslash / : . → mention, path, url, namespace, code.
  if ('@/\\:.'.includes(prev)) return false;
  if ('@/\\:'.includes(next)) return false;
  if (next === '.' && /[A-Za-zÀ-ÿ]/.test(ctx[start + word.length + 1] ?? '')) return false; // foo.bar
  return true;
}
