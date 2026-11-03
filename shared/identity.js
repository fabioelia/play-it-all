// Title identity. Tags are timed against one platform's encode of a title
// (`titleKey`, e.g. "netflix:70248288"). The `canonicalKey` ("game-of-thrones/s01e01")
// links the same episode across platforms so tags can be offered elsewhere
// with a sync offset.

export const PLATFORMS = ['netflix', 'prime', 'web'];

export function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function titleKey(platform, platformId) {
  return `${platform}:${platformId}`;
}

/**
 * @param {{series?:string, season?:number, episode?:number, name?:string, year?:number}} meta
 */
export function canonicalKey(meta = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  if (meta.series && Number.isFinite(Number(meta.season)) && Number.isFinite(Number(meta.episode))) {
    return `${slug(meta.series)}/s${pad(Number(meta.season))}e${pad(Number(meta.episode))}`;
  }
  if (meta.name) return meta.year ? `${slug(meta.name)}-${meta.year}` : slug(meta.name);
  return null;
}

/** "Game of Thrones S1:E1 Winter Is Coming" style label. */
export function displayTitle(meta = {}) {
  if (meta.series && meta.season != null && meta.episode != null) {
    return `${meta.series} S${meta.season}:E${meta.episode}${meta.name ? ` · ${meta.name}` : ''}`;
  }
  return meta.name || meta.series || 'Unknown title';
}

/** Parse "S1:E3", "Season 1, Ep. 3", "S1 E3", "Episode 3" etc. */
export function parseEpisodeLabel(text) {
  const s = String(text || '');
  let m = /S(?:eason)?\s*(\d+)\s*[:,.]?\s*E(?:p(?:isode)?\.?)?\s*(\d+)/i.exec(s);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), rest: s.slice(m.index + m[0].length).trim() };
  m = /Season\s*(\d+)\s*,?\s*Ep(?:isode)?\.?\s*(\d+)/i.exec(s);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), rest: s.slice(m.index + m[0].length).trim() };
  return null;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
