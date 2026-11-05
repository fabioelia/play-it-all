// A plain <video src="file.webm"> (no MediaSource): there are no appends to
// read, so the speech worker reads the file itself, ahead of the playhead,
// with Range requests from the extension (never from the page). It reads
// only as far ahead as is worth transcribing, and jumps by the file's Cues
// after a seek.
//
// WebM only. A progressive MP4 keeps its sample tables in the moov box and
// would need a second reader; it is reported as not supported yet.
import { sniff, webmCues, webmInitLength } from '../../../shared/media.js';
import { HORIZON } from '../../../shared/listening.js';

const CHUNK = 512 * 1024;
const WAIT_MS = 1000;

/**
 * @param {string} url
 * @param {object} o
 * @param {() => number} o.playhead           media time now
 * @param {() => number} o.reach              media time the decoded audio reaches (−1 if none)
 * @param {(bytes: ArrayBuffer) => void} o.onBytes   the next bytes, in file order since the last onSeek
 * @param {() => void} o.onSeek               the next bytes start at another place (a cluster)
 * @param {() => void} o.onEnd
 * @param {(why: string) => void} o.onError
 */
export function progressiveReader(url, { playhead, reach, onBytes, onSeek, onEnd, onError }) {
  let stopped = false;
  let pos = 0;
  let size = Infinity;
  let cues = [];

  async function range(start, end) {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: 'include', cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = /\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1];
    if (total) size = Number(total);
    else if (res.status === 200) size = Number(res.headers.get('content-length')) || size;
    return new Uint8Array(await res.arrayBuffer());
  }

  async function run() {
    const head = await range(0, CHUNK);
    if (sniff(head) !== 'webm') return onError(sniff(head) === 'mp4' ? 'can’t listen to a plain MP4 file yet' : 'not an audio or video file CleanCut can read');
    cues = webmCues(head);
    const initLen = webmInitLength(head);
    if (initLen < 0) return onError('could not read the start of the file');
    onBytes(head.slice(0, initLen).buffer);
    pos = initLen;
    let carry = head.slice(initLen);
    while (!stopped) {
      const t = playhead();
      const got = reach();
      // Seek: the playhead left the stretch being read. Jump by the Cues if the file has them.
      if (cues.length && (t > got + 20 || t < got - HORIZON - 30)) {
        const cue = [...cues].reverse().find((c) => c.time <= t) || cues[0];
        if (cue.offset !== pos) {
          onSeek();
          pos = cue.offset;
          carry = null;
        }
      }
      if (got >= 0 && got > t + HORIZON + 10) {
        await new Promise((r) => setTimeout(r, WAIT_MS));
        continue;
      }
      if (carry?.length) {
        onBytes(carry.buffer);
        carry = null;
        continue;
      }
      if (pos >= size) {
        onEnd();
        return;
      }
      const end = Math.min(size, pos + CHUNK);
      const bytes = await range(pos, end);
      pos += bytes.length;
      if (!bytes.length) {
        onEnd();
        return;
      }
      onBytes(bytes.buffer);
    }
  }

  run().catch((e) => !stopped && onError(String(e?.message || e)));
  return {
    stop() {
      stopped = true;
    },
  };
}
