import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../webview/src/components/Markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown lists', () => {
  it('nests an indented bullet list under its numbered item and keeps the numbering', () => {
    const out = html('1. one\n   - note a\n   - note b\n2. two\n   - note c\n3. three');
    expect(out.match(/<ol/g)?.length).toBe(1);
    expect(out.match(/<ul/g)?.length).toBe(2);
    expect(out).toContain('<li>one<ul class="md-list"><li>note a</li><li>note b</li></ul></li>');
    expect(out).toContain('<li>three</li>');
  });

  it('continues numbering when a list resumes at another number', () => {
    expect(html('3. three\n4. four')).toContain('<ol class="md-list" start="3">');
  });

  it('keeps a flat list flat', () => {
    expect(html('- a\n- b')).toContain('<ul class="md-list"><li>a</li><li>b</li></ul>');
  });

  it('starts a new list when the kind changes at the same level', () => {
    const out = html('- a\n1. b');
    expect(out).toContain('<ul');
    expect(out).toContain('<ol');
  });
});
