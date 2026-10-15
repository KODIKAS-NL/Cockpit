// Generates the Marketplace icon (media/icon.png) from the app icon tile
// (mac/CockpitDaemon/Assets/AppIcon.svg). The Marketplace needs a PNG of at least 128x128;
// an SVG does not work in package.json's "icon" field. Rasterizes with @resvg/resvg-js
// (no system dependencies).
//
// Usage: node scripts/gen-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 256;

const svg = readFileSync(join(root, 'mac', 'CockpitDaemon', 'Assets', 'AppIcon.svg'), 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: SIZE },
  background: 'rgba(0,0,0,0)',
});
const png = resvg.render().asPng();

const out = join(root, 'media', 'icon.png');
writeFileSync(out, png);
console.log(`OK -> media/icon.png (${png.length} bytes)`);
