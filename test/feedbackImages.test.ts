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

  it('follows the plan folder, and goes under .cockpit when the plan file is off', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbimg-'));
    const mine = saveFeedbackImages(root, [{ mediaType: 'image/png', data: 'eA==' }], new Date(), 'docs/Plans');
    expect(mine.rel[0]).toMatch(/^docs\/Plans\/\.attachment-temp\/\d+-1\.png$/);
    const off = saveFeedbackImages(root, [{ mediaType: 'image/png', data: 'eA==' }], new Date(), '  ');
    expect(off.rel[0]).toMatch(/^\.cockpit\/\.attachment-temp\/\d+-1\.png$/);
    sweepFeedbackImages(root, Date.now() + 2 * 24 * 60 * 60 * 1000, 'docs/Plans');
    expect(fs.existsSync(mine.abs[0])).toBe(false);
    expect(fs.existsSync(off.abs[0])).toBe(true); // another folder: untouched
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
