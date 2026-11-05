// A local copy of Hugging Face for the speech model, for the browser tests:
// serves /hf/<repo>/resolve/<revision>/<file> from the cache that
// test/support/hf.mjs downloads into. The extension downloads from it exactly
// as from huggingface.co (background.js accepts a localhost model host, set in
// chrome.storage.local 'listenModelHost'), and checks the same digests.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

import { ensureModel, repoDir } from './hf.mjs';
import { DEFAULT_MODEL, MODELS } from '../../extension/src/listen/models.js';

/** @returns {Promise<{ url: string, requests: string[], close(): void }>} */
export async function startModelMirror({ port = 8791, model = MODELS[DEFAULT_MODEL] } = {}) {
  await ensureModel(model);
  const requests = [];
  const server = createServer((req, res) => {
    const m = /^\/hf\/(.+?)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(new URL(req.url, 'http://x').pathname);
    if (m) {
      requests.push(m[3]);
      const dir = repoDir(m[1], m[2]);
      const file = normalize(join(dir, m[3]));
      if (file.startsWith(dir + sep) && existsSync(file) && statSync(file).isFile() && !file.endsWith('.ok')) {
        const body = readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*' });
        return res.end(body);
      }
    }
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}/hf/`, requests, close: () => server.close() };
}
