// Frame sampling via ffmpeg: decodes a video file at a low frame rate into
// small RGB frames, streamed so a two-hour film never sits in memory.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function probeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`could not read duration of ${file}`);
  return d;
}

/**
 * Yields { time, rgb } where rgb is a Buffer of size*size*3 bytes (RGB24).
 * @param {string} file
 * @param {{ fps?: number, size?: number, start?: number, end?: number }} opts
 */
export async function* sampleFrames(file, { fps = 1, size = 224, start = 0, end } = {}) {
  const frameBytes = size * size * 3;
  const args = ['-v', 'error'];
  if (start) args.push('-ss', String(start));
  args.push('-i', file);
  if (end) args.push('-t', String(end - start));
  // Squash to a square: classifiers resize anyway, and letterboxing would add
  // black borders that change what the model sees.
  args.push('-an', '-vf', `fps=${fps},scale=${size}:${size}:flags=bilinear`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => ff.on('close', resolve));

  let pending = Buffer.alloc(0);
  let index = 0;
  for await (const chunk of ff.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      yield { time: start + index / fps, rgb: pending.subarray(0, frameBytes) };
      pending = pending.subarray(frameBytes);
      index++;
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.trim().slice(0, 500)}`);
}
