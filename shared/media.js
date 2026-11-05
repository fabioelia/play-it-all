// Audio out of the bytes a player appends to a MediaSource SourceBuffer:
// fragmented MP4 (DASH, HLS fMP4, Vimeo) and WebM (YouTube's Opus).
//
// A SourceBuffer receives a byte stream: an initialization segment (MP4
// ftyp+moov; WebM EBML header, Segment, Info, Tracks), then media segments
// (MP4 moof+mdat; WebM Clusters), cut into appends wherever the player likes.
// createDemuxer() takes those appends in order and returns, for each, what it
// could complete:
//
//   { config }     the audio track: codec string and decoder description for
//                  WebCodecs, sample rate, channels; or { encrypted: true }
//   { frames }     coded audio frames, each { time, duration, data } with time
//                  in seconds on the stream's own clock (MP4 tfdt and sample
//                  durations over the track's mdhd timescale; WebM Cluster
//                  Timecode plus the block's offset, times TimecodeScale)
//
// The SourceBuffer's timestampOffset is added by the caller (MSE adds it to
// every coded frame in 'segments' mode). Parsing never throws: bytes that do
// not parse are dropped and the demuxer waits for the next initialization
// segment.

const td = new TextDecoder();
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const s32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

/** What kind of container a chunk of bytes starts with: 'mp4', 'webm' or null. */
export function sniff(b) {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.length >= 8 && /^(ftyp|styp|moov|moof|sidx|emsg|prft|free|mdat)$/.test(fourcc(b, 4))) return 'mp4';
  return null;
}

/** Whether a chunk begins an initialization segment (cheap enough for the page hook). */
export function isInitSegment(b) {
  if (sniff(b) === 'webm') return true;
  if (b.length >= 8) {
    const t = fourcc(b, 4);
    return t === 'ftyp' || t === 'moov';
  }
  return false;
}

/** Container from a SourceBuffer MIME type ('audio/webm; codecs="opus"'). */
export const containerOf = (mime) => (/webm/i.test(mime) ? 'webm' : /mp4|m4a|iso/i.test(mime) ? 'mp4' : null);

function concat(a, b) {
  if (!a || !a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ============================== MP4 ====================================================

/** Child boxes of a container box body: [{ type, start, end, body }]. */
function boxes(b, from = 0, to = b.length) {
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = fourcc(b, o + 4);
    let head = 8;
    if (size === 1) {
      if (o + 16 > to) break;
      size = u64(b, o + 8);
      head = 16;
    } else if (size === 0) size = to - o;
    if (size < head || o + size > to) break;
    out.push({ type, start: o, end: o + size, body: o + head });
    o += size;
  }
  return out;
}
const child = (b, box, type) => boxes(b, box.body, box.end).find((x) => x.type === type);
const children = (b, box, type) => boxes(b, box.body, box.end).filter((x) => x.type === type);

/** MPEG-4 descriptor length (1–4 bytes, 7 bits each). */
function descLen(b, o) {
  let len = 0;
  let i = 0;
  for (; i < 4; i++) {
    const c = b[o + i];
    len = (len << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return { len, size: i + 1 };
}

/** AudioSpecificConfig out of an esds box body. */
function esdsConfig(b, box) {
  let o = box.body + 4; // version + flags
  if (b[o] !== 0x03) return null; // ES_Descriptor
  let d = descLen(b, o + 1);
  o += 1 + d.size;
  const flags = b[o + 2];
  o += 3;
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + b[o];
  if (flags & 0x20) o += 2;
  if (b[o] !== 0x04) return null; // DecoderConfigDescriptor
  d = descLen(b, o + 1);
  const oti = b[o + 1 + d.size];
  o += 1 + d.size + 13;
  if (b[o] !== 0x05) return { oti, asc: null }; // DecoderSpecificInfo
  d = descLen(b, o + 1);
  return { oti, asc: b.slice(o + 1 + d.size, o + 1 + d.size + d.len) };
}

/** OpusHead (what WebCodecs and WebM carry) from an MP4 dOps box (big-endian fields). */
function opusHeadFromDops(b, box) {
  const o = box.body;
  const channels = b[o + 1];
  const preSkip = u16(b, o + 2);
  const rate = u32(b, o + 4);
  const gain = u16(b, o + 8);
  const family = b[o + 10];
  const table = family ? b.slice(o + 11, box.end) : new Uint8Array(0);
  const head = new Uint8Array(19 + table.length);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  head[10] = preSkip & 0xff; head[11] = preSkip >> 8;
  head[12] = rate & 0xff; head[13] = (rate >> 8) & 0xff; head[14] = (rate >> 16) & 0xff; head[15] = rate >>> 24;
  head[16] = gain & 0xff; head[17] = gain >> 8;
  head[18] = family;
  head.set(table, 19);
  return head;
}

/** The audio track of an MP4 initialization segment. */
export function parseMp4Init(b) {
  const top = boxes(b);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return null;
  const pssh = boxes(b, moov.body, moov.end).some((x) => x.type === 'pssh');
  const trex = new Map();
  const mvex = child(b, moov, 'mvex');
  if (mvex) {
    for (const t of children(b, mvex, 'trex')) {
      trex.set(u32(b, t.body + 4), { duration: u32(b, t.body + 12), size: u32(b, t.body + 16) });
    }
  }
  for (const trak of children(b, moov, 'trak')) {
    const tkhd = child(b, trak, 'tkhd');
    const mdia = child(b, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const hdlr = child(b, mdia, 'hdlr');
    if (!hdlr || fourcc(b, hdlr.body + 8) !== 'soun') continue;
    const trackId = u32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
    const mdhd = child(b, mdia, 'mdhd');
    const timescale = mdhd ? u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12)) : 0;
    const stsd = child(b, child(b, child(b, mdia, 'minf') || mdia, 'stbl') || mdia, 'stsd');
    if (!stsd) continue;
    const entries = boxes(b, stsd.body + 8, stsd.end);
    const entry = entries[0];
    if (!entry) continue;
    let format = entry.type;
    // AudioSampleEntry: 8 bytes of SampleEntry, 8 reserved/version, channels, sample size, 4, rate (16.16).
    const version = u16(b, entry.body + 8);
    const channels = u16(b, entry.body + 16);
    const sampleRate = u32(b, entry.body + 24) >>> 16;
    const kids = boxes(b, entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), entry.end);
    let encrypted = pssh || format === 'enca';
    if (format === 'enca') {
      const sinf = kids.find((x) => x.type === 'sinf');
      const frma = sinf && child(b, sinf, 'frma');
      if (frma) format = fourcc(b, frma.body);
    }
    const base = { container: 'mp4', trackId, timescale, sampleRate, channels, encrypted, defaults: trex.get(trackId) || null };
    if (format === 'mp4a') {
      const esds = kids.find((x) => x.type === 'esds');
      const cfg = esds && esdsConfig(b, esds);
      if (cfg?.oti === 0x40 || cfg?.oti === 0x66 || cfg?.oti === 0x67) {
        const aot = cfg.asc && cfg.asc.length ? cfg.asc[0] >> 3 : 2;
        return { ...base, codec: `mp4a.40.${aot === 31 ? 2 : aot}`, description: cfg.asc };
      }
      if (cfg?.oti === 0x6b || cfg?.oti === 0x69) return { ...base, codec: 'mp3', description: null };
      return { ...base, codec: null, unsupported: `mp4a (object type ${cfg?.oti ?? '?'})` };
    }
    if (format === 'Opus') {
      const dops = kids.find((x) => x.type === 'dOps');
      return { ...base, codec: 'opus', sampleRate: 48000, description: dops ? opusHeadFromDops(b, dops) : null };
    }
    if (format === 'fLaC') {
      const dfla = kids.find((x) => x.type === 'dfLa');
      return { ...base, codec: 'flac', description: dfla ? concat(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), b.slice(dfla.body + 4, dfla.end)) : null };
    }
    return { ...base, codec: null, unsupported: format };
  }
  return null;
}

/** Coded audio frames of one moof and the mdat after it (both in `b`). */
function mp4Frames(b, moof, mdat, track) {
  const frames = [];
  let encrypted = false;
  for (const traf of children(b, moof, 'traf')) {
    const tfhd = child(b, traf, 'tfhd');
    if (!tfhd || u32(b, tfhd.body + 4) !== track.trackId) continue;
    const flags = u32(b, tfhd.body) & 0xffffff;
    let o = tfhd.body + 8;
    // Data offsets count from the moof (default-base-is-moof, which MSE byte
    // streams use). An explicit base-data-offset is a file position, which an
    // append does not have: the moof stands in for it too.
    const base = moof.start;
    if (flags & 0x1) o += 8;
    if (flags & 0x2) o += 4;
    const defDur = flags & 0x8 ? u32(b, o) : track.defaults?.duration || 0;
    if (flags & 0x8) o += 4;
    const defSize = flags & 0x10 ? u32(b, o) : track.defaults?.size || 0;
    const tfdt = child(b, traf, 'tfdt');
    let dts = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : track.nextDts || 0;
    if (child(b, traf, 'senc')) encrypted = true;
    let dataAt = mdat.body; // a first trun without a data offset starts at the mdat's data
    for (const trun of children(b, traf, 'trun')) {
      const tf = u32(b, trun.body) & 0xffffff;
      const count = u32(b, trun.body + 4);
      let p = trun.body + 8;
      if (tf & 0x1) {
        dataAt = base + s32(b, p);
        p += 4;
      }
      if (tf & 0x4) p += 4;
      for (let i = 0; i < count; i++) {
        let dur = defDur;
        let size = defSize;
        if (tf & 0x100) (dur = u32(b, p), (p += 4));
        if (tf & 0x200) (size = u32(b, p), (p += 4));
        if (tf & 0x400) p += 4;
        if (tf & 0x800) p += 4;
        if (dataAt + size > b.length || size <= 0) return { frames, encrypted, broken: true };
        frames.push({ time: dts / track.timescale, duration: dur / track.timescale, data: b.slice(dataAt, dataAt + size) });
        dataAt += size;
        dts += dur;
      }
    }
    track.nextDts = dts;
  }
  return { frames, encrypted };
}

function mp4Demuxer() {
  let buf = null;
  let track = null;
  return {
    push(bytes) {
      buf = concat(buf, bytes);
      const out = { frames: [] };
      const top = boxes(buf); // complete top-level boxes only
      let used = 0;
      for (let i = 0; i < top.length; i++) {
        const box = top[i];
        if (box.type === 'moof') {
          const mdat = top[i + 1];
          if (!mdat) break; // its mdat has not arrived yet: keep the moof
          if (track && !track.unsupported) {
            const r = mp4Frames(buf, box, mdat, track);
            out.frames.push(...r.frames);
            if (r.encrypted) out.encrypted = true;
          }
          used = mdat.end;
          i++;
          continue;
        }
        if (box.type === 'moov') {
          const t = parseMp4Init(buf.subarray(box.start, box.end));
          if (t) {
            track = t;
            out.config = t;
          }
        }
        used = box.end; // ftyp, styp, sidx, emsg, prft, free, a stray mdat …
      }
      buf = used >= buf.length ? null : buf.slice(used);
      if (buf && buf.length > 64 * 1024 * 1024) buf = null; // not a box stream after all
      return out;
    },
    reset() {
      buf = null;
    },
  };
}

// ============================== WebM ====================================================

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
  CodecPrivate: 0x63a2, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, CodecDelay: 0x56aa,
  ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentEncryption: 0x5035,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueClusterPosition: 0xf1,
  SeekHead: 0x114d9b74, Void: 0xec, Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469,
};
// Elements whose children are parsed in place (so an unknown size is fine).
const MASTER = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Info, ID.BlockGroup, ID.ContentEncodings, ID.ContentEncoding]);

/** EBML variable-length integer at o: { value, length } (value -1: unknown size). */
function vint(b, o, keepMarker = false) {
  const first = b[o];
  if (first === undefined) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || o + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[o + i];
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { value: !keepMarker && allOnes ? -1 : value, length: len };
}
const uint = (b, o, n) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return v;
};
const float = (b, o, n) => (n === 4 ? new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0) : n === 8 ? new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0) : 0);

/** Frames of a (Simple)Block: lacing (Xiph, fixed, EBML) included. */
function blockFrames(b, o, end) {
  const tn = vint(b, o);
  if (!tn) return null;
  let p = o + tn.length;
  const rel = (b[p] << 8) | b[p + 1];
  const timecode = rel & 0x8000 ? rel - 0x10000 : rel;
  const flags = b[p + 2];
  p += 3;
  const lacing = (flags >> 1) & 3;
  if (!lacing) return { track: tn.value, timecode, frames: [b.slice(p, end)] };
  const count = b[p] + 1;
  p++;
  const sizes = [];
  if (lacing === 1) { // Xiph
    for (let i = 0; i < count - 1; i++) {
      let s = 0;
      while (b[p] === 255) (s += 255, p++);
      s += b[p++];
      sizes.push(s);
    }
  } else if (lacing === 3) { // EBML
    const firstSize = vint(b, p);
    p += firstSize.length;
    sizes.push(firstSize.value);
    for (let i = 1; i < count - 1; i++) {
      const v = vint(b, p);
      p += v.length;
      const bias = 2 ** (7 * v.length - 1) - 1;
      sizes.push(sizes[i - 1] + (v.value - bias));
    }
  } else { // fixed
    const each = Math.floor((end - p) / count);
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  sizes.push(end - p - sizes.reduce((a, c) => a + c, 0));
  const frames = [];
  for (const s of sizes) {
    if (s < 0 || p + s > end) return null;
    frames.push(b.slice(p, p + s));
    p += s;
  }
  return { track: tn.value, timecode, frames };
}

function parseTrackEntry(b, from, to) {
  const t = { number: 0, type: 0, codecId: '', priv: null, rate: 0, channels: 1, encrypted: false, codecDelay: 0 };
  const walk = (s, e) => {
    let o = s;
    while (o < e) {
      const id = vint(b, o, true);
      if (!id) return;
      const size = vint(b, o + id.length);
      if (!size) return;
      const body = o + id.length + size.length;
      const end = size.value < 0 ? e : Math.min(e, body + size.value);
      switch (id.value) {
        case ID.TrackNumber: t.number = uint(b, body, end - body); break;
        case ID.TrackType: t.type = uint(b, body, end - body); break;
        case ID.CodecID: t.codecId = td.decode(b.subarray(body, end)).replace(/\0+$/, ''); break;
        case ID.CodecPrivate: t.priv = b.slice(body, end); break;
        case ID.CodecDelay: t.codecDelay = uint(b, body, end - body) / 1e9; break;
        case ID.SamplingFrequency: t.rate = float(b, body, end - body); break;
        case ID.Channels: t.channels = uint(b, body, end - body); break;
        case ID.ContentEncryption: t.encrypted = true; break;
        case ID.Audio: case ID.ContentEncodings: case ID.ContentEncoding: walk(body, end); break;
        default:
      }
      o = end;
    }
  };
  walk(from, to);
  return t;
}

const WEBM_CODECS = { A_OPUS: 'opus', A_VORBIS: 'vorbis', A_FLAC: 'flac', 'A_MPEG/L3': 'mp3' };

function webmTrackConfig(t, timecodeScale) {
  const base = { container: 'webm', trackNumber: t.number, sampleRate: Math.round(t.rate) || 48000, channels: t.channels || 1, encrypted: t.encrypted, timecodeScale };
  if (t.codecId === 'A_OPUS') return { ...base, codec: 'opus', sampleRate: 48000, description: t.priv };
  if (/^A_AAC/.test(t.codecId)) {
    const aot = t.priv?.length ? t.priv[0] >> 3 : 2;
    return { ...base, codec: `mp4a.40.${aot === 31 ? 2 : aot}`, description: t.priv };
  }
  if (WEBM_CODECS[t.codecId]) return { ...base, codec: WEBM_CODECS[t.codecId], description: t.priv };
  return { ...base, codec: null, unsupported: t.codecId || 'unknown' };
}

function webmDemuxer() {
  let buf = null;
  let scale = 1e6; // TimecodeScale, ns per tick
  let track = null;
  let cluster = null; // timecode (ticks) of the Cluster being read
  return {
    push(bytes) {
      buf = concat(buf, bytes);
      const out = { frames: [] };
      let o = 0;
      const b = buf;
      while (o < b.length) {
        const id = vint(b, o, true);
        if (!id) break;
        const size = vint(b, o + id.length);
        if (!size) break;
        const body = o + id.length + size.length;
        if (id.value === ID.EBML) {
          if (size.value < 0 || body + size.value > b.length) break;
          // A new initialization segment: forget the old track and clock.
          track = null;
          cluster = null;
          scale = 1e6;
          o = body + size.value;
          continue;
        }
        if (MASTER.has(id.value)) {
          if (id.value === ID.Tracks || id.value === ID.Info) {
            // Read whole (they are small), so a track is never half-known.
            if (size.value < 0 || body + size.value > b.length) break;
            const end = body + size.value;
            if (id.value === ID.Info) {
              let p = body;
              while (p < end) {
                const cid = vint(b, p, true);
                const cs = cid && vint(b, p + cid.length);
                if (!cs || cs.value < 0) break;
                const cb = p + cid.length + cs.length;
                if (cid.value === ID.TimecodeScale) scale = uint(b, cb, cs.value);
                p = cb + cs.value;
              }
            } else {
              let p = body;
              while (p < end) {
                const cid = vint(b, p, true);
                const cs = cid && vint(b, p + cid.length);
                if (!cs || cs.value < 0) break;
                const cb = p + cid.length + cs.length;
                if (cid.value === ID.TrackEntry) {
                  const t = parseTrackEntry(b, cb, cb + cs.value);
                  if (t.type === 2 && !track) {
                    track = webmTrackConfig(t, scale);
                    out.config = track;
                  }
                }
                p = cb + cs.value;
              }
            }
            o = end;
            continue;
          }
          if (id.value === ID.Cluster) cluster = null;
          o = body; // descend: Segment, Cluster, BlockGroup are read child by child
          continue;
        }
        if (size.value < 0) break; // unknown size on a non-master element: not a stream we can read
        if (body + size.value > b.length) break; // wait for the rest of this element
        const end = body + size.value;
        if (id.value === ID.Timecode) cluster = uint(b, body, size.value);
        else if ((id.value === ID.SimpleBlock || id.value === ID.Block) && track && !track.unsupported && cluster !== null) {
          const blk = blockFrames(b, body, end);
          if (blk && blk.track === track.trackNumber) {
            const t0 = ((cluster + blk.timecode) * scale) / 1e9;
            const each = blk.frames.length > 1 ? 0.02 : 0; // laced frames: Opus/Vorbis 20 ms is the usual
            blk.frames.forEach((data, i) => out.frames.push({ time: t0 + i * each, duration: 0, data }));
          }
        }
        o = end;
      }
      buf = o >= b.length ? null : b.slice(o);
      if (buf && buf.length > 64 * 1024 * 1024) buf = null;
      return out;
    },
    reset() {
      buf = null;
      cluster = null;
    },
  };
}

/**
 * A demuxer for one SourceBuffer's byte stream.
 * @param {'mp4'|'webm'|null} container  from the MIME type; sniffed from the first bytes when null
 */
export function createDemuxer(container = null) {
  let impl = container === 'mp4' ? mp4Demuxer() : container === 'webm' ? webmDemuxer() : null;
  return {
    /** @param {Uint8Array} bytes  the next append, in order */
    push(bytes) {
      try {
        if (!impl) {
          const kind = sniff(bytes);
          if (!kind) return { frames: [] };
          impl = kind === 'mp4' ? mp4Demuxer() : webmDemuxer();
        }
        return impl.push(bytes);
      } catch {
        impl?.reset();
        return { frames: [] };
      }
    },
    /** SourceBuffer.abort(), or a seek that restarts the stream. */
    reset: () => impl?.reset(),
  };
}

/**
 * Cues of a progressive WebM file (byte positions of Clusters by time), from
 * its first bytes: [{ time, offset }] with offset from the start of the file.
 * Used for plain <video src> WebM, where CleanCut reads the file itself.
 */
export function webmCues(b) {
  let o = 0;
  let segBody = -1;
  let scale = 1e6;
  const cues = [];
  while (o < b.length) {
    const id = vint(b, o, true);
    const size = id && vint(b, o + id.length);
    if (!size) break;
    const body = o + id.length + size.length;
    if (id.value === ID.Segment) {
      segBody = body;
      o = body;
      continue;
    }
    if (size.value < 0 || body + size.value > b.length) break;
    if (id.value === ID.Info) {
      let p = body;
      while (p < body + size.value) {
        const cid = vint(b, p, true);
        const cs = cid && vint(b, p + cid.length);
        if (!cs) break;
        if (cid.value === ID.TimecodeScale) scale = uint(b, p + cid.length + cs.length, cs.value);
        p += cid.length + cs.length + cs.value;
      }
    }
    if (id.value === ID.Cues) {
      let p = body;
      while (p < body + size.value) {
        const cid = vint(b, p, true);
        const cs = cid && vint(b, p + cid.length);
        if (!cs) break;
        const cb = p + cid.length + cs.length;
        if (cid.value === ID.CuePoint) {
          let time = null;
          let pos = null;
          let q = cb;
          while (q < cb + cs.value) {
            const qid = vint(b, q, true);
            const qs = qid && vint(b, q + qid.length);
            if (!qs) break;
            const qb = q + qid.length + qs.length;
            if (qid.value === ID.CueTime) time = uint(b, qb, qs.value);
            if (qid.value === ID.CueTrackPositions) {
              let r = qb;
              while (r < qb + qs.value) {
                const rid = vint(b, r, true);
                const rs = rid && vint(b, r + rid.length);
                if (!rs) break;
                if (rid.value === ID.CueClusterPosition) pos = uint(b, r + rid.length + rs.length, rs.value);
                r += rid.length + rs.length + rs.value;
              }
            }
            q = qb + qs.value;
          }
          if (time !== null && pos !== null && segBody >= 0) cues.push({ time: (time * scale) / 1e9, offset: segBody + pos });
        }
        p = cb + cs.value;
      }
      break;
    }
    o = body + size.value;
  }
  return cues;
}

/** Size in bytes of everything before the first Cluster (the init segment) of a WebM file. */
export function webmInitLength(b) {
  let o = 0;
  while (o < b.length) {
    const id = vint(b, o, true);
    const size = id && vint(b, o + id.length);
    if (!size) return -1;
    const body = o + id.length + size.length;
    if (id.value === ID.Cluster) return o;
    if (id.value === ID.Segment) {
      o = body;
      continue;
    }
    if (size.value < 0) return -1;
    o = body + size.value;
  }
  return -1;
}
