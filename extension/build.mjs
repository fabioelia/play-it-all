// Builds the extension into extension/dist/chrome and extension/dist/firefox.
//   node extension/build.mjs            one-off build
//   node extension/build.mjs --watch    rebuild on change
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'src');
const dist = join(here, 'dist');
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(here, '..', 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

// Build stamp: which commit this build came from, so a recording or a bug
// report can be matched to the code that produced it.
let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--', 'extension', 'shared'], { cwd: here, encoding: 'utf8' }).trim()) commit += '+changes';
} catch { /* not a git checkout */ }
const BUILD = `${pkg.version} (${commit}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`;

const STREAMING = [
  'https://www.netflix.com/*',
  'https://*.primevideo.com/*',
  ...['com', 'co.uk', 'de', 'ca', 'com.au', 'fr', 'it', 'es', 'co.jp', 'in'].flatMap((tld) => [
    `https://www.amazon.${tld}/gp/video/*`,
    `https://www.amazon.${tld}/*/dp/*`,
    `https://www.amazon.${tld}/dp/*`,
  ]),
];
// The community catalog, read straight from GitHub.
const CATALOG = ['https://raw.githubusercontent.com/*'];
// Local development: the demo page and a local catalog (npm run dev).
const DEV = ['http://localhost/*', 'http://127.0.0.1/*'];

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'CleanCut — watch at your rating',
    short_name: 'CleanCut',
    version: pkg.version,
    description: 'Make any show PG-13, PG or G: skips, mutes or hides explicit scenes on Netflix and Prime Video using a community catalog on GitHub and scan-ahead subtitle analysis.',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: { default_popup: 'popup.html', default_title: 'CleanCut', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['storage', 'scripting', 'activeTab'],
    host_permissions: [...STREAMING, ...CATALOG, ...DEV],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_scripts: [
      { matches: [...STREAMING, ...DEV], js: ['page-hook.js'], run_at: 'document_start', world: 'MAIN' },
      { matches: [...STREAMING, ...DEV], js: ['content.js'], run_at: 'document_idle' },
    ],
  };
  if (target === 'firefox') {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = { gecko: { id: 'cleancut@cleancut.local', strict_min_version: '128.0' } };
  } else {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = '111';
    m.version_name = `${pkg.version} (${commit})`; // shown on chrome://extensions
  }
  return m;
}

// ---- icons: drawn in code so the repo carries no binaries -------------------

function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Rounded blue tile, white play triangle with a diagonal "cut" through it.
function iconPixel(px, py, size) {
  const SS = 4;
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / size;
      const y = (py + (sy + 0.5) / SS) / size;
      const rad = 0.22;
      const dx = Math.max(rad - x, 0, x - (1 - rad));
      const dy = Math.max(rad - y, 0, y - (1 - rad));
      if (dx * dx + dy * dy > rad * rad) continue;
      const inTri = x > 0.34 && x < 0.78 && Math.abs(y - 0.5) < (0.78 - x) * 0.62;
      const inCut = Math.abs((y - 0.5) - (x - 0.55) * -1.6) < 0.045;
      const white = inTri && !inCut;
      r += white ? 255 : 0x4f; g += white ? 255 : 0x7c; b += white ? 255 : 0xff; a += 255;
    }
  }
  const n = SS * SS;
  return a ? [Math.round(r / (a / 255)), Math.round(g / (a / 255)), Math.round(b / (a / 255)), Math.round(a / n)] : [0, 0, 0, 0];
}

// ---- build ---------------------------------------------------------------------

const entries = {
  background: join(src, 'background.js'),
  content: join(src, 'content/index.js'),
  'page-hook': join(src, 'page-hook.js'),
  popup: join(src, 'popup/popup.js'),
  options: join(src, 'options/options.js'),
};

const STATIC = {
  'popup.html': 'popup/popup.html',
  'popup.css': 'popup/popup.css',
  'options.html': 'options/options.html',
};

function writeStatic(outdir, target) {
  mkdirSync(join(outdir, 'icons'), { recursive: true });
  for (const [to, from] of Object.entries(STATIC)) copyFileSync(join(src, from), join(outdir, to));
  for (const size of [16, 32, 48, 128]) writeFileSync(join(outdir, 'icons', `icon-${size}.png`), png(size, iconPixel));
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
}

rmSync(dist, { recursive: true, force: true });
const contexts = [];
for (const target of ['chrome', 'firefox']) {
  const outdir = join(dist, target);
  writeStatic(outdir, target);
  const options = {
    entryPoints: entries,
    outdir,
    bundle: true,
    format: 'iife',
    target: target === 'chrome' ? ['chrome111'] : ['firefox128'],
    legalComments: 'none',
    define: { __CLEANCUT_BUILD__: JSON.stringify(BUILD) },
    logLevel: 'warning',
  };
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    contexts.push(ctx);
  } else {
    await esbuild.build(options);
  }
}
console.log(`Built CleanCut ${BUILD} → ${dist}/{chrome,firefox}${watch ? ' (watching)' : ''}`);
