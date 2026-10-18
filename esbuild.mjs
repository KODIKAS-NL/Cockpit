// Build pipeline para a extensão (host Node) e o webview (React/browser).
// Uso: node esbuild.mjs [--watch] [--production]
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
  },
};

// 1) Host da extensão — roda no Node do VS Code; 'vscode' é externo.
const hostCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  // 'vscode' é provido pelo host. bufferutil/utf-8-validate são deps NATIVAS
  // OPCIONAIS do 'ws' (require em try/catch); externaliza p/ não quebrar o bundle.
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
});

// 2) cockpit-daemon — a standalone Node process (launchd); no 'vscode' anywhere in it.
const daemonCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/daemon/main.ts'],
  outfile: 'dist/daemon.js',
  platform: 'node',
  format: 'cjs',
});

// 3) Webview — React, roda no browser do webview.
const webCtx = await esbuild.context({
  ...common,
  entryPoints: ['webview/src/main.tsx'],
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'css' },
});

// 4) Scratchpad — Excalidraw in its own panel; kept out of the chat bundle (it is large).
const padCtx = await esbuild.context({
  ...common,
  entryPoints: ['webview/scratchpad/main.tsx'],
  outfile: 'dist/scratchpad/main.js',
  platform: 'browser',
  assetNames: '[name]',
  // Excalidraw's package exports pick the build by condition.
  conditions: [production ? 'production' : 'development'],
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'css', '.woff2': 'file' },
});

// Excalidraw loads its fonts at run time from <asset path>/fonts.
// Xiaolai (CJK handwriting, 12 MB) is left out; those characters fall back to a system font.
fs.cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'dist/scratchpad/fonts', {
  recursive: true,
  filter: (src) => !src.includes('/Xiaolai'),
});

if (watch) {
  await Promise.all([hostCtx.watch(), daemonCtx.watch(), webCtx.watch(), padCtx.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([hostCtx.rebuild(), daemonCtx.rebuild(), webCtx.rebuild(), padCtx.rebuild()]);
  await Promise.all([hostCtx.dispose(), daemonCtx.dispose(), webCtx.dispose(), padCtx.dispose()]);
  console.log('[esbuild] build complete');
}
