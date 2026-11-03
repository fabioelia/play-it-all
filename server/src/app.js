// CleanCut community API.
//
//   POST   /v1/users                     create an account → { apiKey }
//   GET    /v1/me                        who am I (auth)
//   GET    /v1/lookup?platform&id&canonical
//                                        segments + skip lists for what is playing
//   POST   /v1/segments                  add tags for a title (auth)
//   POST   /v1/segments/:id/vote         { value: 1 | -1 | 0 } (auth)
//   DELETE /v1/segments/:id              remove your own tag (auth)
//   GET    /v1/titles?q=                 browse/search tagged titles
//   GET    /v1/profiles?titleKey&canonical&q
//   GET    /v1/profiles/:id
//   POST   /v1/profiles                  publish a skip list (auth)
//   POST   /v1/profiles/:id/subscribe    count a subscriber
//   DELETE /v1/profiles/:id              remove your own skip list (auth)

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSegment } from '../../shared/validate.js';
import { canonicalKey as makeCanonical, PLATFORMS, titleKey } from '../../shared/identity.js';
import { resolveProfile } from '../../shared/ratings.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 1_000_000;
const MAX_SEGMENTS_PER_REQUEST = 500;
const HIDE_BELOW_SCORE = -3;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => Date.now();
const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export function createApp(db, { rateLimit = { windowMs: 60_000, max: 120 } } = {}) {
  const q = {
    insertUser: db.prepare('INSERT INTO users (name, key_hash, created_at) VALUES (?, ?, ?)'),
    userByKey: db.prepare('SELECT id, name FROM users WHERE key_hash = ?'),
    titleByPlatform: db.prepare('SELECT * FROM titles WHERE platform = ? AND platform_id = ?'),
    titleById: db.prepare('SELECT * FROM titles WHERE id = ?'),
    insertTitle: db.prepare(`INSERT INTO titles (platform, platform_id, canonical_key, series, season, episode, name, duration, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateTitle: db.prepare(`UPDATE titles SET canonical_key = COALESCE(?, canonical_key), series = COALESCE(?, series),
                             season = COALESCE(?, season), episode = COALESCE(?, episode), name = COALESCE(?, name),
                             duration = COALESCE(?, duration) WHERE id = ?`),
    relatedTitles: db.prepare(`SELECT t.*, COUNT(s.id) AS segment_count FROM titles t JOIN segments s ON s.title_id = t.id
                               WHERE t.canonical_key = ? AND t.id != ? AND s.score > ${HIDE_BELOW_SCORE}
                               GROUP BY t.id ORDER BY segment_count DESC`),
    segmentsForTitle: db.prepare(`SELECT s.*, u.name AS author FROM segments s LEFT JOIN users u ON u.id = s.user_id
                                  WHERE s.title_id = ? AND s.score > ${HIDE_BELOW_SCORE} ORDER BY s.start_s`),
    insertSegment: db.prepare(`INSERT INTO segments (title_id, user_id, start_s, end_s, category, severity, action, note, source, confidence, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    segmentById: db.prepare('SELECT * FROM segments WHERE id = ?'),
    deleteSegment: db.prepare('DELETE FROM segments WHERE id = ?'),
    upsertVote: db.prepare(`INSERT INTO votes (segment_id, user_id, value) VALUES (?, ?, ?)
                            ON CONFLICT (segment_id, user_id) DO UPDATE SET value = excluded.value`),
    deleteVote: db.prepare('DELETE FROM votes WHERE segment_id = ? AND user_id = ?'),
    rescore: db.prepare('UPDATE segments SET score = (SELECT COALESCE(SUM(value), 0) FROM votes WHERE segment_id = ?) WHERE id = ?'),
    searchTitles: db.prepare(`SELECT t.*, COUNT(s.id) AS segment_count,
                                (SELECT COUNT(*) FROM profiles p WHERE p.title_id = t.id) AS profile_count
                              FROM titles t LEFT JOIN segments s ON s.title_id = t.id AND s.score > ${HIDE_BELOW_SCORE}
                              WHERE (? = '' OR t.series LIKE ? OR t.name LIKE ? OR t.canonical_key LIKE ?)
                              GROUP BY t.id ORDER BY segment_count DESC, t.created_at DESC LIMIT ?`),
    insertProfile: db.prepare(`INSERT INTO profiles (user_id, name, description, settings, title_id, canonical_key, include_ids, exclude_ids, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    profileById: db.prepare('SELECT p.*, u.name AS author FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.id = ?'),
    profilesFor: db.prepare(`SELECT p.*, u.name AS author FROM profiles p JOIN users u ON u.id = p.user_id
                             WHERE (p.title_id IS NOT NULL AND p.title_id = ?)
                                OR (p.canonical_key IS NOT NULL AND p.canonical_key = ?)
                                OR (p.title_id IS NULL AND p.canonical_key IS NULL)
                             ORDER BY (p.title_id IS NOT NULL OR p.canonical_key IS NOT NULL) DESC, p.subscribers DESC, p.id DESC LIMIT 25`),
    searchProfiles: db.prepare(`SELECT p.*, u.name AS author FROM profiles p JOIN users u ON u.id = p.user_id
                                WHERE (? = '' OR p.name LIKE ? OR p.description LIKE ?)
                                ORDER BY p.subscribers DESC, p.id DESC LIMIT ?`),
    subscribe: db.prepare('UPDATE profiles SET subscribers = subscribers + 1 WHERE id = ?'),
    deleteProfile: db.prepare('DELETE FROM profiles WHERE id = ?'),
  };

  // ---- helpers -----------------------------------------------------------

  function auth(req, required = true) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const user = m ? q.userByKey.get(hashKey(m[1])) : null;
    if (!user && required) throw new HttpError(401, 'missing or invalid API key');
    return user || null;
  }

  function parseTitleInput(t) {
    if (!t || typeof t !== 'object') throw new HttpError(400, 'title is required');
    const platform = String(t.platform || '');
    const platformId = String(t.platformId || '').slice(0, 300);
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, `title.platform must be one of ${PLATFORMS.join(', ')}`);
    if (!platformId) throw new HttpError(400, 'title.platformId is required');
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const str = (v) => (v == null || v === '' ? null : String(v).slice(0, 200));
    const meta = { series: str(t.series), season: num(t.season), episode: num(t.episode), name: str(t.name), year: num(t.year) };
    return {
      platform, platformId, ...meta,
      duration: num(t.duration),
      canonicalKey: str(t.canonicalKey) || makeCanonical(meta),
    };
  }

  function upsertTitle(t) {
    const existing = q.titleByPlatform.get(t.platform, t.platformId);
    if (existing) {
      q.updateTitle.run(t.canonicalKey, t.series, t.season, t.episode, t.name, t.duration, existing.id);
      return q.titleById.get(existing.id);
    }
    const r = q.insertTitle.run(t.platform, t.platformId, t.canonicalKey, t.series, t.season, t.episode, t.name, t.duration, now());
    return q.titleById.get(r.lastInsertRowid);
  }

  const titleOut = (t) => t && ({
    titleKey: titleKey(t.platform, t.platform_id),
    platform: t.platform,
    platformId: t.platform_id,
    canonicalKey: t.canonical_key,
    series: t.series,
    season: t.season,
    episode: t.episode,
    name: t.name,
    duration: t.duration,
    ...(t.segment_count != null ? { segmentCount: t.segment_count } : {}),
    ...(t.profile_count != null ? { profileCount: t.profile_count } : {}),
  });

  const segmentOut = (s) => ({
    id: String(s.id),
    start: s.start_s,
    end: s.end_s,
    category: s.category,
    severity: s.severity,
    action: s.action,
    note: s.note,
    source: s.source,
    confidence: s.confidence,
    score: s.score,
    author: s.author ?? null,
  });

  const profileOut = (p) => {
    const t = p.title_id ? q.titleById.get(p.title_id) : null;
    return {
      id: String(p.id),
      name: p.name,
      description: p.description,
      author: p.author,
      settings: JSON.parse(p.settings),
      titleKey: t ? titleKey(t.platform, t.platform_id) : null,
      canonicalKey: p.canonical_key,
      overrides: { include: JSON.parse(p.include_ids), exclude: JSON.parse(p.exclude_ids) },
      subscribers: p.subscribers,
      createdAt: p.created_at,
    };
  };

  const idList = (v) => (Array.isArray(v) ? v.slice(0, 2000).map(String).filter((s) => s.length <= 64) : []);

  // ---- routes ------------------------------------------------------------

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/health', () => ({ ok: true }));

  route('POST', '/v1/users', ({ body }) => {
    const name = String(body?.name || '').trim().slice(0, 40);
    if (!/^[\w .-]{2,40}$/.test(name)) throw new HttpError(400, 'name must be 2–40 letters, digits, spaces, dots or dashes');
    const apiKey = `cc_${randomBytes(24).toString('base64url')}`;
    const r = q.insertUser.run(name, hashKey(apiKey), now());
    return { status: 201, body: { id: String(r.lastInsertRowid), name, apiKey } };
  });

  route('GET', '/v1/me', ({ req }) => {
    const u = auth(req);
    return { id: String(u.id), name: u.name };
  });

  route('GET', '/v1/lookup', ({ query }) => {
    const platform = query.get('platform') || '';
    const id = query.get('id') || '';
    const canonical = query.get('canonical') || null;
    const title = q.titleByPlatform.get(platform, id);
    let segments = title ? q.segmentsForTitle.all(title.id).map(segmentOut) : [];
    let borrowedFrom = null;
    const key = canonical || title?.canonical_key || null;
    if (!segments.length && key) {
      // Nothing tagged on this platform yet — offer the same episode's tags
      // from another platform; the client applies a sync offset.
      const related = q.relatedTitles.all(key, title?.id ?? -1);
      if (related.length) {
        borrowedFrom = titleOut(related[0]);
        segments = q.segmentsForTitle.all(related[0].id).map(segmentOut);
      }
    }
    const profiles = q.profilesFor.all(title?.id ?? -1, key).map(profileOut);
    return { title: titleOut(title), canonicalKey: key, segments, borrowedFrom, profiles };
  });

  route('POST', '/v1/segments', ({ req, body }) => {
    const user = auth(req);
    const t = parseTitleInput(body?.title);
    const list = Array.isArray(body?.segments) ? body.segments : [];
    if (!list.length) throw new HttpError(400, 'segments must be a non-empty array');
    if (list.length > MAX_SEGMENTS_PER_REQUEST) throw new HttpError(413, `at most ${MAX_SEGMENTS_PER_REQUEST} segments per request`);
    const valid = list.map((s, i) => {
      const v = validateSegment(s);
      if (!v.ok) throw new HttpError(400, `segments[${i}]: ${v.error}`);
      return v.segment;
    });
    db.exec('BEGIN');
    try {
      const title = upsertTitle(t);
      const ids = valid.map((s) => {
        const source = s.source === 'local' ? 'community' : s.source;
        const r = q.insertSegment.run(title.id, user.id, s.start, s.end, s.category, s.severity, s.action, s.note, source, s.confidence, now());
        return String(r.lastInsertRowid);
      });
      db.exec('COMMIT');
      return { status: 201, body: { title: titleOut(title), ids } };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  route('POST', '/v1/segments/:id/vote', ({ req, body, params }) => {
    const user = auth(req);
    const seg = q.segmentById.get(Number(params.id));
    if (!seg) throw new HttpError(404, 'segment not found');
    const value = Number(body?.value);
    if (![1, -1, 0].includes(value)) throw new HttpError(400, 'value must be 1, -1 or 0');
    if (value === 0) q.deleteVote.run(seg.id, user.id);
    else q.upsertVote.run(seg.id, user.id, value);
    q.rescore.run(seg.id, seg.id);
    return { id: String(seg.id), score: q.segmentById.get(seg.id).score };
  });

  route('DELETE', '/v1/segments/:id', ({ req, params }) => {
    const user = auth(req);
    const seg = q.segmentById.get(Number(params.id));
    if (!seg) throw new HttpError(404, 'segment not found');
    if (seg.user_id !== user.id) throw new HttpError(403, 'you can only delete your own tags');
    q.deleteSegment.run(seg.id);
    return { deleted: String(seg.id) };
  });

  route('GET', '/v1/titles', ({ query }) => {
    const term = (query.get('q') || '').trim();
    const like = `%${term}%`;
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50));
    return { titles: q.searchTitles.all(term, like, like, like, limit).map(titleOut) };
  });

  route('GET', '/v1/profiles', ({ query }) => {
    const tk = query.get('titleKey');
    const canonical = query.get('canonical');
    if (tk || canonical) {
      const [platform, ...rest] = (tk || '').split(':');
      const title = tk ? q.titleByPlatform.get(platform, rest.join(':')) : null;
      return { profiles: q.profilesFor.all(title?.id ?? -1, canonical || title?.canonical_key || null).map(profileOut) };
    }
    const term = (query.get('q') || '').trim();
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50));
    return { profiles: q.searchProfiles.all(term, `%${term}%`, `%${term}%`, limit).map(profileOut) };
  });

  route('GET', '/v1/profiles/:id', ({ params }) => {
    const p = q.profileById.get(Number(params.id));
    if (!p) throw new HttpError(404, 'profile not found');
    return profileOut(p);
  });

  route('POST', '/v1/profiles', ({ req, body }) => {
    const user = auth(req);
    const name = String(body?.name || '').trim().slice(0, 80);
    if (name.length < 3) throw new HttpError(400, 'name must be at least 3 characters');
    const description = String(body?.description || '').slice(0, 1000);
    const r = resolveProfile(body?.settings || {});
    const settings = { preset: r.preset, thresholds: r.thresholds, actions: r.actions, ai: r.ai, languageMode: r.languageMode };
    let titleId = null;
    let canonical = body?.canonicalKey ? String(body.canonicalKey).slice(0, 200) : null;
    if (body?.title) {
      const title = upsertTitle(parseTitleInput(body.title));
      titleId = title.id;
      canonical = canonical || title.canonical_key;
    }
    const res = q.insertProfile.run(user.id, name, description, JSON.stringify(settings), titleId, canonical,
      JSON.stringify(idList(body?.overrides?.include)), JSON.stringify(idList(body?.overrides?.exclude)), now());
    return { status: 201, body: profileOut(q.profileById.get(res.lastInsertRowid)) };
  });

  route('POST', '/v1/profiles/:id/subscribe', ({ params }) => {
    const p = q.profileById.get(Number(params.id));
    if (!p) throw new HttpError(404, 'profile not found');
    q.subscribe.run(p.id);
    return { id: String(p.id), subscribers: p.subscribers + 1 };
  });

  route('DELETE', '/v1/profiles/:id', ({ req, params }) => {
    const user = auth(req);
    const p = q.profileById.get(Number(params.id));
    if (!p) throw new HttpError(404, 'profile not found');
    if (p.user_id !== user.id) throw new HttpError(403, 'you can only delete your own skip lists');
    q.deleteProfile.run(p.id);
    return { deleted: String(p.id) };
  });

  // ---- static pages ------------------------------------------------------

  const STATIC = { '/': 'index.html', '/demo': 'demo.html', '/demo.webm': 'demo.webm', '/demo.vtt': 'demo.vtt', '/demo-playback.json': 'demo-playback.json' };
  const TYPES = { '.html': 'text/html; charset=utf-8', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8', '.json': 'application/json' };

  // ---- rate limiting (per IP, write requests only) -------------------------

  const hits = new Map();
  function limited(req) {
    if (!rateLimit || req.method === 'GET' || req.method === 'OPTIONS') return false;
    const ip = req.socket.remoteAddress || 'unknown';
    const t = now();
    const entry = hits.get(ip);
    if (!entry || t - entry.start > rateLimit.windowMs) {
      hits.set(ip, { start: t, count: 1 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start > rateLimit.windowMs) hits.delete(k);
      return false;
    }
    return ++entry.count > rateLimit.max;
  }

  // ---- request handler ---------------------------------------------------

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204);

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = join(PUBLIC_DIR, STATIC[url.pathname]);
      try {
        const data = await readFile(file);
        const type = TYPES[extname(file)] || 'application/octet-stream';
        // Media elements need byte ranges to seek.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && (range[1] || range[2])) {
          let start = range[1] ? Number(range[1]) : data.length - Number(range[2]);
          let end = range[1] && range[2] ? Number(range[2]) : data.length - 1;
          start = Math.max(0, start);
          end = Math.min(end, data.length - 1);
          if (start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
            return res.end();
          }
          res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
          return res.end(data.subarray(start, end + 1));
        }
        res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': data.length });
        return res.end(data);
      } catch {
        return send(res, 404, { error: `${STATIC[url.pathname]} not found${url.pathname === '/demo.webm' ? ' — run `npm run demo:video`' : ''}` });
      }
    }

    try {
      if (limited(req)) throw new HttpError(429, 'too many requests, slow down');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'POST' ? await readJson(req) : null;
        const out = await r.handler({ req, query: url.searchParams, params, body });
        if (out && out.status && out.body) return send(res, out.status, out.body);
        return send(res, 200, out);
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'internal error' });
    }
  };
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}
