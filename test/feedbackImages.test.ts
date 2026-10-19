import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeFeedbackImages, saveFeedbackImages, sweepFeedbackImages, withImagePaths } from '../src/session/FeedbackImages';

describe('feedback images', () => {
  it('names the saved files after the text', () => {
    expect(withImagePaths('fix it', ['Planing/.attachment-temp/1-1.png'])).toBe(
      'fix it\n\nAttached images (read them with the Read tool):\n- Planing/.attachment-temp/1-1.png',
    );
    expect(withImagePaths('fix it', [])).toBe('fix it');
    expect(withImagePaths('', ['a.png'])).toMatch(/^Attached images/);
  });

  it('saves, then removes the files and the empty folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbimg-'));
    const saved = saveFeedbackImages(root, [{ mediaType: 'image/png', data: Buffer.from('x').toString('base64') }]);
    expect(saved.rel[0]).toMatch(/^Planing\/\.attachment-temp\/\d+-1\.png$/);
    expect(fs.existsSync(saved.abs[0])).toBe(true);
    removeFeedbackImages(saved.abs);
    expect(fs.existsSync(path.join(root, 'Planing', '.attachment-temp'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sweeps files older than a day', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbimg-'));
    const saved = saveFeedbackImages(root, [{ mediaType: 'image/png', data: 'eA==' }]);
    sweepFeedbackImages(root, Date.now());
    expect(fs.existsSync(saved.abs[0])).toBe(true); // fresh: kept
    sweepFeedbackImages(root, Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(fs.existsSync(saved.abs[0])).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
