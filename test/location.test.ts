import { describe, it, expect } from 'vitest';
import { chooseLocation } from '../src/core/location';

describe('chooseLocation', () => {
  it('sends a conversation with no place to the preferred surface', () => {
    expect(chooseLocation({ preferred: 'sidebar', inEditor: false, inSidebar: false })).toBe('sidebar');
    expect(chooseLocation({ preferred: 'editor', inEditor: false, inSidebar: false })).toBe('editor');
  });

  it('keeps a conversation where it already is, whatever the preference', () => {
    expect(chooseLocation({ preferred: 'sidebar', inEditor: true, inSidebar: false })).toBe('editor');
    expect(chooseLocation({ preferred: 'editor', inEditor: false, inSidebar: true })).toBe('sidebar');
  });

  it('moves it only on an explicit request', () => {
    expect(chooseLocation({ preferred: 'sidebar', explicit: 'editor', inEditor: false, inSidebar: true })).toBe('editor');
    expect(chooseLocation({ preferred: 'editor', explicit: 'sidebar', inEditor: true, inSidebar: false })).toBe('sidebar');
  });
});
