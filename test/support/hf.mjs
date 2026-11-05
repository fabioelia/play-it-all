// Files from Hugging Face for the listening tests and benchmarks: speech
// models (the extension's own registry, extension/src/listen/models.js), the
// TTS model that makes the test speech, and a few LibriSpeech utterances.
//
// Everything is downloaded once, at a pinned commit, into a cache outside the
// repository (CLEANCUT_CACHE, default ~/.cache/cleancut), each repository in
// its own directory. Downloads go through curl, which uses HTTPS_PROXY when it
// is set. Files are untrusted data: they are checked against the sizes and
// SHA-256 digests in the registry and only ever read as data.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CACHE = process.env.CLEANCUT_CACHE || join(homedir(), '.cache', 'cleancut');

function curl(url, out) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.part`;
  rmSync(tmp, { force: true });
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', tmp, url], { stdio: ['ignore', 'ignore', 'inherit'] });
  renameSync(tmp, out);
}

/**
 * Digest of a file as the registry writes it: 'sha256:<hex>' or 'git:<sha1>'
 * (a git blob id: SHA-1 over "blob <size>\0" + content).
 */
export function fileDigest(file, kind) {
  return new Promise((resolve, reject) => {
    const h = createHash(kind === 'git' ? 'sha1' : 'sha256');
    if (kind === 'git') h.update(`blob ${statSync(file).size}\0`);
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(`${kind}:${h.digest('hex')}`)).on('error', reject);
  });
}

/** Local directory holding repo@revision (files at their repository paths). */
export const repoDir = (repo, revision) => join(CACHE, 'hf', ...repo.split('/'), revision);

/**
 * Download [path, bytes, digest] files of repo@revision unless already cached and intact.
 * @returns {Promise<string>} the local directory
 */
export async function ensureRepoFiles(repo, revision, files, { log = console.log, type = '' } = {}) {
  const dir = repoDir(repo, revision);
  for (const [path, bytes, digest] of files) {
    const out = join(dir, path);
    const ok = existsSync(out) && (!bytes || statSync(out).size === bytes) && (!digest || readMark(out) === digest);
    if (ok) continue;
    const url = `https://huggingface.co/${type}${repo}/resolve/${revision}/${path}`;
    log(`  downloading ${repo}/${path}${bytes ? ` (${(bytes / 1e6).toFixed(1)} MB)` : ''}`);
    curl(url, out);
    if (bytes && statSync(out).size !== bytes) throw new Error(`${repo}/${path}: expected ${bytes} bytes, got ${statSync(out).size}`);
    if (digest) {
      const got = await fileDigest(out, digest.split(':')[0]);
      if (got !== digest) {
        rmSync(out, { force: true });
        throw new Error(`${repo}/${path}: digest mismatch (${got})`);
      }
      writeFileSync(`${out}.ok`, got);
    }
  }
  return dir;
}

function readMark(file) {
  try {
    return readFileSync(`${file}.ok`, 'utf8');
  } catch {
    return null;
  }
}

/** A speech model from the extension's registry. */
export function ensureModel(model, o) {
  return ensureRepoFiles(model.repo, model.revision, model.files, o);
}

// ---- LibriSpeech (CC BY 4.0): the first utterances of the small test split that
// hf-internal-testing publishes, as 16 kHz mono float32 ---------------------------
const LIBRI = { repo: 'hf-internal-testing/librispeech_asr_dummy', revision: '5be91486e11a2d616f4ec5db8d3fd248585ac07a' };

/** @returns {Promise<Array<{ id: string, text: string, pcm: string, seconds: number }>>} */
export async function ensureLibriSpeech(n = 30, { log = console.log } = {}) {
  const dir = join(CACHE, 'librispeech-dummy', LIBRI.revision);
  const index = join(dir, `index-${n}.json`);
  if (existsSync(index)) return JSON.parse(readFileSync(index, 'utf8'));
  mkdirSync(dir, { recursive: true });
  log(`  downloading ${n} LibriSpeech utterances (CC BY 4.0) …`);
  const rows = [];
  for (let offset = 0; offset < n; offset += 50) {
    const api = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(LIBRI.repo)}&config=clean&split=validation&offset=${offset}&length=${Math.min(50, n - offset)}`;
    const tmp = join(dir, `rows-${offset}.json`);
    curl(api, tmp);
    rows.push(...JSON.parse(readFileSync(tmp, 'utf8')).rows);
  }
  const out = [];
  for (const { row } of rows) {
    const flac = join(dir, `${row.id}.flac`);
    const pcm = join(dir, `${row.id}.f32`);
    if (!existsSync(pcm)) {
      curl(row.audio[0].src, flac);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', flac, '-ac', '1', '-ar', '16000', '-f', 'f32le', pcm]);
      rmSync(flac, { force: true });
    }
    out.push({ id: row.id, text: row.text, pcm, seconds: statSync(pcm).size / 4 / 16000 });
  }
  writeFileSync(index, JSON.stringify(out, null, 1));
  return out;
}
