#!/usr/bin/env node
// Generates the Cockpit Daemon icons into mac/CockpitDaemon/Assets/:
//   AppIcon.svg / AppIcon.icns          the app icon (a cockpit gauge)
//   MenuBar-<state>.svg / .png          monochrome template glyphs for the menu bar
// and the VS Code extension's media/icon.svg (sidebar) and media/icon-color.svg (editor tab).
// media/icon.png (marketplace) comes from scripts/gen-icon.mjs, which renders AppIcon.svg.
//
// The results are committed, so building the app needs none of this. Run it only to change
// the design (needs rsvg-convert, `brew install librsvg`, and iconutil from macOS):
//   node mac/CockpitDaemon/scripts/make-icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'Assets');
mkdirSync(out, { recursive: true });

const f = (n) => +n.toFixed(2);
const rad = (deg) => (deg * Math.PI) / 180;
// Angles run clockwise from 12 o'clock; the gauge sweeps -135° to +135°.
const pt = (cx, cy, r, deg) => [cx + r * Math.sin(rad(deg)), cy - r * Math.cos(rad(deg))];
const arc = (cx, cy, r, from, to) => {
  const [x1, y1] = pt(cx, cy, r, from);
  const [x2, y2] = pt(cx, cy, r, to);
  return `M${f(x1)} ${f(y1)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${f(x2)} ${f(y2)}`;
};

// A four-point sparkle: the generic "AI" cue (no brand mark).
const sparkle = (cx, cy, r, pinch = 0.16) => {
  const k = r * pinch;
  return `M${f(cx)} ${f(cy - r)}Q${f(cx + k)} ${f(cy - k)} ${f(cx + r)} ${f(cy)}Q${f(cx + k)} ${f(cy + k)} ${f(cx)} ${f(cy + r)}Q${f(cx - k)} ${f(cy + k)} ${f(cx - r)} ${f(cy)}Q${f(cx - k)} ${f(cy - k)} ${f(cx)} ${f(cy - r)}Z`;
};

// ---------------------------------------------------------------- app icon (1024 canvas)

function appIcon() {
  const C = 512;
  const VALUE = 68; // needle angle
  const ticks = [];
  for (let i = 0; i <= 40; i++) {
    const deg = -135 + (270 * i) / 40;
    const major = i % 4 === 0;
    const [x1, y1] = pt(C, C, major ? 196 : 210, deg);
    const [x2, y2] = pt(C, C, 228, deg);
    const lit = deg <= VALUE;
    ticks.push(
      `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${
        lit ? '#ffe2c4' : '#ffffff'
      }" stroke-opacity="${lit ? 0.9 : 0.28}" stroke-width="${major ? 9 : 5}" stroke-linecap="round"/>`,
    );
  }

  const d = [Math.sin(rad(VALUE)), -Math.cos(rad(VALUE))];
  const p = [Math.cos(rad(VALUE)), Math.sin(rad(VALUE))];
  const at = (len, side) => [C + d[0] * len + p[0] * side, C + d[1] * len + p[1] * side];
  const needle = [at(238, 0), at(0, 15), at(-24, 8), at(-24, -8), at(0, -15)]
    .map(([x, y]) => `${f(x)},${f(y)}`)
    .join(' ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#232c52"/>
      <stop offset="1" stop-color="#0a0e1d"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.52" r="0.55">
      <stop offset="0" stop-color="#3a5bd0" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#3a5bd0" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="dial" x1="0.1" y1="0.9" x2="0.9" y2="0.1" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#4da3ff"/>
      <stop offset="0.55" stop-color="#ff9a3c"/>
      <stop offset="1" stop-color="#ff5a1f"/>
    </linearGradient>
    <linearGradient id="needle" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#ffd2a3"/>
      <stop offset="1" stop-color="#ffffff"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.42"/>
    </filter>
    <filter id="blur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
    <clipPath id="clip"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
  </defs>

  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#tile)" filter="url(#shadow)"/>
  <g clip-path="url(#clip)">
    <rect x="100" y="100" width="824" height="824" fill="url(#glow)"/>
    <rect x="100" y="100" width="824" height="412" fill="url(#sheen)"/>
  </g>
  <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="3"/>

  <!-- bezel -->
  <circle cx="${C}" cy="${C}" r="340" fill="#070a16" fill-opacity="0.55" stroke="#ffffff" stroke-opacity="0.1" stroke-width="4"/>

  <!-- track and value arc -->
  <path d="${arc(C, C, 276, -135, 135)}" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="42" stroke-linecap="round"/>
  <path d="${arc(C, C, 276, -135, VALUE)}" fill="none" stroke="url(#dial)" stroke-width="42" stroke-linecap="round" filter="url(#blur)" opacity="0.75"/>
  <path d="${arc(C, C, 276, -135, VALUE)}" fill="none" stroke="url(#dial)" stroke-width="42" stroke-linecap="round"/>

  ${ticks.join('\n  ')}

  <!-- needle -->
  <polygon points="${needle}" fill="#ff8a2a" filter="url(#blur)" opacity="0.8"/>
  <polygon points="${needle}" fill="url(#needle)" stroke-linejoin="round"/>

  <!-- hub -->
  <circle cx="${C}" cy="${C}" r="50" fill="#0a0e1d" stroke="#ff9a3c" stroke-width="12"/>
  <path d="${sparkle(C, C, 34)}" fill="#ffe9d2"/>

  <!-- "AI" in the gap at the bottom of the dial -->
  <g transform="translate(${f(C - 11.85 * 8.6)} ${f(716 - 12.4 * 8.6)}) scale(8.6)" fill="none" stroke="#8ec2ff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8.1 16.4L10.6 8.4L13.1 16.4"/><path d="M8.9 13.9H12.3"/><path d="M15.6 8.4V16.4"/>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------- menu bar glyphs (18pt)

function glyph(state) {
  const C = 9;
  const ink = '#000';
  const base = (opacity, dash = '') =>
    `<path d="${arc(C, C, 7.3, -135, 135)}" fill="none" stroke="${ink}" stroke-opacity="${opacity}" stroke-width="1.7" stroke-linecap="round"${dash}/>`;
  const needle = (deg, len = 5.4) => {
    const [x0, y0] = pt(C, C, 4.1, deg);
    const [x, y] = pt(C, C, len, deg);
    return `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x)}" y2="${f(y)}" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`;
  };
  const hub = `<path d="${sparkle(C, C, 3.3, 0.2)}" fill="${ink}"/>`;
  const body = {
    running: base(1) + needle(55, 5.7) + hub,
    stopped: base(0.5) + needle(-135, 5.7) + `<path d="${sparkle(C, C, 3.3, 0.2)}" fill="${ink}" fill-opacity="0.5"/>`,
    busy: base(0.75) + needle(0, 5.7) + hub,
    failed:
      base(1) +
      `<line x1="${C}" y1="5.2" x2="${C}" y2="9.4" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>` +
      `<circle cx="${C}" cy="12.3" r="1.1" fill="${ink}"/>`,
  }[state];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">${body}</svg>\n`;
}

// ---------------------------------------------------------------- render

const render = (svg, png, size) =>
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', png]);

const appSvg = join(out, 'AppIcon.svg');
writeFileSync(appSvg, appIcon());

const iconset = join(out, 'AppIcon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  render(appSvg, join(iconset, `icon_${s}x${s}.png`), s);
  render(appSvg, join(iconset, `icon_${s}x${s}@2x.png`), s * 2);
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(out, 'AppIcon.icns')]);
rmSync(iconset, { recursive: true, force: true });

for (const state of ['running', 'stopped', 'busy', 'failed']) {
  const svg = join(out, `MenuBar-${state}.svg`);
  writeFileSync(svg, glyph(state));
  render(svg, join(out, `MenuBar-${state}.png`), 36); // 18pt @2x
}
// ---------------------------------------------------------------- VS Code (24 box)

function vscodeGlyph(ink, gradient) {
  const C = 12;
  const [x1, y1] = pt(C, C, 4.6, 55);
  const [x2, y2] = pt(C, C, 7.4, 55);
  const defs = gradient
    ? `<defs><linearGradient id="g" x1="0.1" y1="0.9" x2="0.9" y2="0.1"><stop offset="0" stop-color="#4da3ff"/><stop offset="0.55" stop-color="#ff9a3c"/><stop offset="1" stop-color="#ff5a1f"/></linearGradient></defs>`
    : '';
  const arcInk = gradient ? 'url(#g)' : ink;
  const hubInk = gradient ? '#ffb066' : ink;
  const tickInk = gradient ? '#ff7a18' : ink;
  return `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${defs}
  <path d="${arc(C, C, 8.6, -135, 135)}" fill="none" stroke="${arcInk}" stroke-width="2" stroke-linecap="round"/>
  <line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${tickInk}" stroke-width="2" stroke-linecap="round"/>
  <path d="${sparkle(C, C, 3.9, 0.2)}" fill="${hubInk}"/>
</svg>
`;
}

const media = join(out, '..', '..', '..', 'media');
writeFileSync(join(media, 'icon.svg'), vscodeGlyph('currentColor', false));
writeFileSync(join(media, 'icon-color.svg'), vscodeGlyph('', true));

console.log(`icons written to ${out} and ${media}`);
