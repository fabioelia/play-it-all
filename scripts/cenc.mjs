// Common Encryption ('cenc', AES-128-CTR, whole samples) of a fragmented MP4
// audio file, for the listening demo's DRM case: a ClearKey-protected stream
// that Chrome plays through EME, the way a Widevine service's would. (ffmpeg's
// own -encryption_scheme writes fragments Chrome rejects: saio without saiz.)
//
//   encryptFragmentedMp4(clear: Buffer, { kid, key }) → Buffer
// kid and key are 32 hex digits. Only what the demo needs: one audio track,
// trun data offsets, 8-byte per-sample IVs.
import { createCipheriv } from 'node:crypto';

const u32 = (b, o) => b.readUInt32BE(o);
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const full = (type, version, flags, ...parts) => {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
};
function children(b, from, to) {
  const out = [];
  for (let o = from; o + 8 <= to;) {
    const size = u32(b, o);
    if (size < 8 || o + size > to) break;
    out.push({ type: b.toString('latin1', o + 4, o + 8), start: o, end: o + size, body: o + 8 });
    o += size;
  }
  return out;
}
/** Rebuild a box from its header and new children (sizes fixed up). */
const rebuild = (b, bx, head, kids) => {
  const out = Buffer.concat([b.subarray(bx.start, bx.body + head), ...kids]);
  out.writeUInt32BE(out.length, 0);
  return out;
};

const CLEARKEY_SYSTEM = Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex');

function encryptInit(b, kid) {
  const moov = children(b, 0, b.length).find((x) => x.type === 'moov');
  const walk = (bx, path) => {
    const [want, ...rest] = path;
    const headLen = bx.type === 'stsd' ? 8 : 0; // stsd: version/flags + entry count before its children
    const kids = children(b, bx.body + headLen, bx.end).map((k) => {
      if (k.type !== want) return b.subarray(k.start, k.end);
      if (rest.length) return walk(k, rest);
      // The sample entry: mp4a → enca, with sinf (frma, schm, schi/tenc) added at the end.
      const entry = Buffer.from(b.subarray(k.start, k.end));
      entry.write('enca', 4, 'latin1');
      const tenc = full('tenc', 0, 0, Buffer.from([0, 0, 1, 8]), kid); // isProtected, 8-byte IVs, default KID
      const sinf = box('sinf', box('frma', Buffer.from('mp4a', 'latin1')), full('schm', 0, 0, Buffer.from('cenc', 'latin1'), Buffer.from([0, 1, 0, 0])), box('schi', tenc));
      const out = Buffer.concat([entry, sinf]);
      out.writeUInt32BE(out.length, 0);
      return out;
    });
    return rebuild(b, bx, headLen, kids);
  };
  const kidCount = Buffer.alloc(4);
  kidCount.writeUInt32BE(1, 0);
  const pssh = full('pssh', 1, 0, CLEARKEY_SYSTEM, kidCount, kid, Buffer.alloc(4));
  const kids = children(b, moov.body, moov.end).map((k) => (k.type === 'trak' ? walk(k, ['mdia', 'minf', 'stbl', 'stsd', 'mp4a']) : b.subarray(k.start, k.end)));
  const newMoov = rebuild(b, moov, 0, [...kids, pssh]);
  return Buffer.concat([b.subarray(0, moov.start), newMoov, b.subarray(moov.end)]);
}

function encryptFragment(b, moof, mdat, key, ivSeed) {
  const traf = children(b, moof.body, moof.end).find((x) => x.type === 'traf');
  const trun = children(b, traf.body, traf.end).find((x) => x.type === 'trun');
  const tfhd = children(b, traf.body, traf.end).find((x) => x.type === 'tfhd');
  const tfFlags = u32(b, tfhd.body) & 0xffffff;
  let p = tfhd.body + 8;
  if (tfFlags & 0x1) p += 8;
  if (tfFlags & 0x2) p += 4;
  if (tfFlags & 0x8) p += 4;
  const defSize = tfFlags & 0x10 ? u32(b, p) : 0;
  const flags = u32(b, trun.body) & 0xffffff;
  const count = u32(b, trun.body + 4);
  let q = trun.body + 8;
  const offsetAt = flags & 0x1 ? q : -1;
  const dataOffset = flags & 0x1 ? b.readInt32BE(q) : 0;
  if (flags & 0x1) q += 4;
  if (flags & 0x4) q += 4;
  const sizes = [];
  for (let i = 0; i < count; i++) {
    if (flags & 0x100) q += 4;
    sizes.push(flags & 0x200 ? u32(b, q) : defSize);
    if (flags & 0x200) q += 4;
    if (flags & 0x400) q += 4;
    if (flags & 0x800) q += 4;
  }
  // Encrypt each sample in place (a copy of the mdat), each with its own IV.
  const data = Buffer.from(b.subarray(mdat.start, mdat.end));
  let at = moof.start + dataOffset - mdat.start;
  const ivs = [];
  for (let i = 0; i < count; i++) {
    const iv = Buffer.alloc(8);
    iv.writeUInt32BE(ivSeed, 0);
    iv.writeUInt32BE(i, 4);
    ivs.push(iv);
    const c = createCipheriv('aes-128-ctr', key, Buffer.concat([iv, Buffer.alloc(8)]));
    const enc = Buffer.concat([c.update(data.subarray(at, at + sizes[i])), c.final()]);
    enc.copy(data, at);
    at += sizes[i];
  }
  // The IVs are the samples' auxiliary information, stored at the start of the
  // mdat (saiz gives their size, saio where they are), as in Chromium's own
  // CENC test streams; Chrome's MSE parser rejected the same IVs in a senc box.
  const sampleCount = Buffer.alloc(4);
  sampleCount.writeUInt32BE(count, 0);
  const saiz = full('saiz', 0, 0, Buffer.from([8]), sampleCount); // default size 8 (no subsamples)
  const saio = full('saio', 0, 0, Buffer.alloc(8)); // entry count 1, offset filled in below
  const kids = children(b, traf.body, traf.end).map((k) => b.subarray(k.start, k.end));
  const newTraf = rebuild(b, traf, 0, [...kids, saiz, saio]);
  const moofKids = children(b, moof.body, moof.end).map((k) => (k.type === 'traf' ? newTraf : b.subarray(k.start, k.end)));
  const newMoof = rebuild(b, moof, 0, moofKids);
  const auxBytes = Buffer.concat(ivs);
  const mdatOut = Buffer.concat([data.subarray(0, 8), auxBytes, data.subarray(8)]);
  mdatOut.writeUInt32BE(mdatOut.length, 0);
  // Offsets count from the start of the moof: the IVs right after the mdat header, the samples after them.
  const t = children(newMoof, 8, newMoof.length).find((x) => x.type === 'traf');
  const inTraf = children(newMoof, t.body, t.end);
  const newTrun = inTraf.find((x) => x.type === 'trun');
  const newSaio = inTraf.find((x) => x.type === 'saio');
  const auxAt = newMoof.length + 8;
  if (offsetAt >= 0) newMoof.writeInt32BE(auxAt + auxBytes.length + (dataOffset - (mdat.start + 8)), newTrun.start + (offsetAt - trun.start));
  newMoof.writeUInt32BE(1, newSaio.start + 12);
  newMoof.writeUInt32BE(auxAt, newSaio.start + 16);
  return Buffer.concat([newMoof, mdatOut]);
}

export function encryptFragmentedMp4(clear, { kid, key }) {
  const k = Buffer.from(key, 'hex');
  const id = Buffer.from(kid, 'hex');
  const top = children(clear, 0, clear.length);
  const out = [];
  let seed = 1;
  for (let i = 0; i < top.length; i++) {
    const bx = top[i];
    if (bx.type === 'moov') out.push(encryptInit(clear.subarray(bx.start, bx.end), id));
    else if (bx.type === 'moof' && top[i + 1]?.type === 'mdat') {
      const pair = clear.subarray(bx.start, top[i + 1].end);
      out.push(encryptFragment(pair, { ...bx, start: 0, body: 8, end: bx.end - bx.start }, { ...top[i + 1], start: top[i + 1].start - bx.start, end: top[i + 1].end - bx.start }, k, seed++));
      i++;
    } else out.push(clear.subarray(bx.start, bx.end));
  }
  return Buffer.concat(out);
}
