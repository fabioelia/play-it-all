#!/usr/bin/env node
// Local development server (static files only; CleanCut has no backend).
//
//   http://localhost:8787/            the landing page (docs/index.html)
//   http://localhost:8787/demo        a demo "episode" to try the extension on
//   http://localhost:8787/demo/listen the same without captions, through MediaSource (listening ahead)
//   http://localhost:8787/catalog/…   this checkout's catalog, so the extension
//                                     can be pointed at local changes
//
// Point the extension at the local catalog in its Options:
//   Catalog source → http://localhost:8787/catalog/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';
const catalogDir = resolve(process.env.CATALOG_DIR || join(root, 'catalog'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.mp4': 'video/mp4',
};
const ROUTES = [
  ['/demo', join(root, 'demo/demo.html')],
  ['/demo.webm', join(root, 'demo/demo.webm')],
  ['/demo.vtt', join(root, 'demo/demo.vtt')],
  ['/demo-playback.json', join(root, 'demo/demo-playback.json')],
  ['/demo/listen', join(root, 'demo/listen.html')],
];
// The listening demo's media (generated: `npm run demo:listen`, kept outside the repo).
const LISTEN_FILES = new Set(['index.json', 'speech.json', 'audio.webm', 'audio.mp4', 'audio-enc.mp4', 'video.webm', 'video-720.webm']);
function listenMediaDir() {
  if (process.env.LISTEN_MEDIA_DIR) return process.env.LISTEN_MEDIA_DIR;
  const base = join(process.env.CLEANCUT_CACHE || join(homedir(), '.cache', 'cleancut'), 'listen-demo');
  try {
    // The newest generated version.
    return readdirSync(base).map((d) => join(base, d)).filter((d) => existsSync(join(d, 'index.json')))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

/** Resolve a URL path under a directory, refusing anything that escapes it. */
function under(dir, rel) {
  const p = normalize(join(dir, decodeURIComponent(rel)));
  return p === dir || p.startsWith(dir + sep) ? p : null;
}

export function createDevServer() {
  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    let file = ROUTES.find(([p]) => p === pathname)?.[1];
    if (!file && pathname.startsWith('/listen-media/') && LISTEN_FILES.has(pathname.slice('/listen-media/'.length))) {
      const dir = listenMediaDir();
      file = dir ? join(dir, pathname.slice('/listen-media/'.length)) : null;
    }
    if (!file && pathname.startsWith('/catalog/')) file = under(catalogDir, pathname.slice('/catalog/'.length));
    if (!file) file = under(join(root, 'docs'), pathname === '/' ? 'index.html' : pathname.slice(1));
    try {
      if (!file || !(await stat(file)).isFile()) throw new Error('not found');
      const data = await readFile(file);
      const type = TYPES[extname(file)] || 'application/octet-stream';
      // Media elements need byte ranges to seek.
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, data.length - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
          return res.end();
        }
        res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
        return res.end(data.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      const hint = pathname === '/demo.webm' ? ' — run `npm run demo:video`' : pathname.startsWith('/listen-media/') ? ' — run `npm run demo:listen`' : '';
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`not found${hint}\n`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createDevServer().listen(port, host, () => {
    console.log(`CleanCut dev server on http://${host}:${port}`);
    console.log(`  landing page  http://${host}:${port}/`);
    console.log(`  demo episode  http://${host}:${port}/demo`);
    console.log(`  catalog       http://${host}:${port}/catalog/index.json  (${catalogDir})`);
  });
}
