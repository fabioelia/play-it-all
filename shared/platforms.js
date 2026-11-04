// Every streaming service CleanCut knows, one entry each. Used by:
//   extension/build.mjs        host_permissions and the content-script matches
//   content/adapters.js        which adapter runs on a page (detectAdapter)
//   content/network.js         which title an id-less manifest belongs to
//   shared/identity.js         platform names the catalog accepts
//   the popup                  display names (platformName)
//
// Adding a site: one entry here (id, name, hosts, matches, watchId). Without a
// dedicated adapter config the page gets the generic <video> adapter under
// this platform id; see content/adapters/streaming.js for the per-site parts
// (player, title, ads, seeking).
//
// Fields:
//   id        stable key used in title keys ("youtube:dQw4w9WgXcQ") and the catalog
//   name      what viewers see
//   hosts     registrable domains (or full hostnames) the site is served from;
//             a page on that host or any subdomain belongs to the platform
//   matches   top-level pages CleanCut runs on (also its host permissions)
//   frames    embedded players CleanCut also runs in when they are iframes on
//             other sites (registered with allFrames)
//   watchId   (URL) → the id of the title playing, from the address alone, or
//             null on browse/detail pages. Must be cheap: called once a second.

const AMAZON_TLDS = ['com', 'co.uk', 'de', 'ca', 'com.au', 'fr', 'it', 'es', 'co.jp', 'in'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOCALE = '(?:/[a-z]{2}(?:-[a-z]{2,4})?)?'; // optional /en, /en-gb, /pt-br, /zh-hant prefix

const fromPath = (re) => (u) => re.exec(u.pathname)?.[1] || null;
const YT_ID = /^[\w-]{11}$/;

export const PLATFORMS = [
  {
    id: 'netflix',
    name: 'Netflix',
    hosts: ['netflix.com'],
    matches: ['https://www.netflix.com/*'],
    watchId: fromPath(/^\/watch\/(\d+)/),
  },
  {
    id: 'prime',
    name: 'Prime Video',
    hosts: ['primevideo.com', ...AMAZON_TLDS.map((tld) => `amazon.${tld}`)],
    matches: [
      'https://*.primevideo.com/*',
      ...AMAZON_TLDS.flatMap((tld) => [`https://www.amazon.${tld}/gp/video/*`, `https://www.amazon.${tld}/*/dp/*`, `https://www.amazon.${tld}/dp/*`]),
    ],
    watchId: () => null, // the episode ASIN comes from the player's own data
  },
  {
    id: 'youtube',
    name: 'YouTube',
    hosts: ['youtube.com', 'youtube-nocookie.com'],
    matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
    frames: ['https://www.youtube.com/embed/*', 'https://www.youtube-nocookie.com/embed/*'],
    // Shorts are out of scope: looping clips in a swipe feed, rarely captioned,
    // never in the catalog; CleanCut leaves /shorts/ pages alone.
    watchId(u) {
      let id = null;
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else id = /^\/(?:embed|live|v)\/([\w-]{11})(?:[/?#]|$)/.exec(u.pathname)?.[1] || null;
      return id && YT_ID.test(id) ? id : null;
    },
  },
  {
    id: 'disney',
    name: 'Disney+',
    hosts: ['disneyplus.com'],
    matches: ['https://www.disneyplus.com/*'],
    // /play/<id> (current app), /video/<id> (older links), with or without a locale prefix.
    watchId: fromPath(new RegExp(`^${LOCALE}/(?:play|video)/(${UUID}|[A-Za-z0-9]{8,})(?:[/?]|$)`, 'i')),
  },
  {
    id: 'max',
    name: 'HBO Max',
    hosts: ['max.com', 'hbomax.com'],
    matches: ['https://play.max.com/*', 'https://play.hbomax.com/*'],
    // /video/watch/<video id>/<edit id>: the first names the episode or film.
    watchId: fromPath(new RegExp(`^${LOCALE}/video/watch/(${UUID})`, 'i')),
  },
  {
    id: 'hulu',
    name: 'Hulu',
    hosts: ['hulu.com'],
    matches: ['https://www.hulu.com/*'],
    watchId: fromPath(new RegExp(`^/watch/(${UUID})`, 'i')),
  },
  {
    id: 'appletv',
    name: 'Apple TV',
    hosts: ['tv.apple.com'],
    matches: ['https://tv.apple.com/*'],
    // /us/episode/<slug>/umc.cmc.<id>, /us/movie/<slug>/umc.cmc.<id>. Show
    // pages are not watch pages (their header video is a trailer).
    watchId: fromPath(/^(?:\/[a-z]{2})?\/(?:episode|movie)\/[^/]+\/(umc\.cmc\.[a-z0-9]+)/i),
  },
  {
    id: 'paramount',
    name: 'Paramount+',
    hosts: ['paramountplus.com'],
    matches: ['https://www.paramountplus.com/*'],
    // /shows/video/<id>/, /movies/video/<id>/, /shows/<show>/video/<id>/<slug>/
    watchId: fromPath(/^(?:\/[a-z]{2})?\/(?:shows|movies)\/(?:[^/]+\/)?video\/([A-Za-z0-9_-]{8,})/),
  },
  {
    id: 'peacock',
    name: 'Peacock',
    hosts: ['peacocktv.com'],
    matches: ['https://www.peacocktv.com/*'],
    // /watch/playback/vod/<content id>/<variant id>; live events and channels are not titles.
    watchId: fromPath(/^\/watch\/playback\/(?:vod|playlist)\/([A-Za-z0-9_.-]{6,})/),
  },
  {
    id: 'crunchyroll',
    name: 'Crunchyroll',
    hosts: ['crunchyroll.com'],
    matches: ['https://www.crunchyroll.com/*'],
    watchId: fromPath(new RegExp(`^${LOCALE}/watch/([A-Z0-9]{6,12})(?:[/?]|$)`)),
  },
  {
    id: 'tubi',
    name: 'Tubi',
    hosts: ['tubitv.com'],
    matches: ['https://tubitv.com/*', 'https://www.tubitv.com/*'],
    // /movies/<id>/<slug>, /tv-shows/<episode id>/<slug>; the player opens on these pages.
    watchId: fromPath(/^\/(?:movies|tv-shows|video)\/(\d{3,})(?:[/?]|$)/),
  },
  {
    id: 'pluto',
    name: 'Pluto TV',
    hosts: ['pluto.tv'],
    matches: ['https://pluto.tv/*'],
    // On demand only: /on-demand/movies/<movie>, /on-demand/series/<show>/season/<n>/episode/<episode>.
    // Live channels have no fixed timeline to tag.
    watchId(u) {
      const p = u.pathname;
      const ep = /\/on-demand\/series\/([^/]+)\/season\/(\d+)\/episode\/([^/?]+)/.exec(p);
      if (ep) return `${ep[1]}/${ep[2]}/${ep[3]}`;
      return /\/on-demand\/movies\/([^/?]+)/.exec(p)?.[1] || null;
    },
  },
  {
    id: 'roku',
    name: 'The Roku Channel',
    hosts: ['therokuchannel.roku.com'],
    matches: ['https://therokuchannel.roku.com/*'],
    watchId: fromPath(/^\/watch\/([0-9a-f]{32})(?:[/?]|$)/i),
  },
  {
    id: 'plex',
    name: 'Plex',
    hosts: ['app.plex.tv', 'watch.plex.tv'],
    matches: ['https://app.plex.tv/*', 'https://watch.plex.tv/*'],
    // The web app keeps its route in the hash: #!/server/<id>/details?key=%2Flibrary%2Fmetadata%2F123
    // (a library item on the viewer's server) or #!/media/<provider>/details?key=… (Plex's own catalog)
    // watch.plex.tv (free streaming): /watch/movie/<slug>, /watch/show/<show>/season/<n>/episode/<n>
    watchId(u) {
      const key = /[?&]key=(?:%2F|\/)library(?:%2F|\/)metadata(?:%2F|\/)([0-9a-z]+)(?=&|$)/i.exec(u.hash);
      if (key) {
        const server = /\/server\/([0-9a-f]{20,})/i.exec(u.hash)?.[1];
        return server ? `${server.slice(0, 12)}:${key[1]}` : key[1];
      }
      return /^\/(?:[a-z]{2}\/)?watch\/((?:movie|show)\/[^?#]+)/.exec(u.pathname)?.[1]?.replace(/\/$/, '') || null;
    },
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    hosts: ['vimeo.com'],
    matches: ['https://vimeo.com/*'],
    frames: ['https://player.vimeo.com/video/*'],
    // vimeo.com/<id>, /channels/<c>/<id>, /showcase/<s>/video/<id>, /groups/<g>/videos/<id>, player.vimeo.com/video/<id>
    watchId: fromPath(/^\/(?:(?:channels|groups|album|showcase)\/[^/]+\/(?:videos?\/)?|video\/)?(\d{5,})(?:[/?]|$)/),
  },
  {
    // Any other page with a <video>, after the viewer clicks "Enable on this page".
    id: 'web',
    name: 'Web',
    hosts: [],
    matches: [],
    watchId: () => null,
  },
];

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

/** Platform ids the catalog accepts. */
export const PLATFORM_IDS = PLATFORMS.map((p) => p.id);

/** Top-level pages CleanCut runs on. */
export const MATCHES = PLATFORMS.flatMap((p) => p.matches);

/** Embedded players CleanCut also runs in (all frames). */
export const FRAME_MATCHES = PLATFORMS.flatMap((p) => p.frames || []);

export function platformById(id) {
  return BY_ID.get(id) || null;
}

/** The platform a page belongs to, from its hostname; null for any other site. */
export function platformForHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return null;
  for (const p of PLATFORMS) {
    if (p.hosts.some((d) => h === d || h.endsWith(`.${d}`))) return p;
  }
  return null;
}

/**
 * What viewers call a platform: platformName('youtube') → 'YouTube'.
 * For 'web' (any other site) the page's host is the most useful name, when given.
 */
export function platformName(id, host) {
  if (id === 'web') return host || 'Web';
  return BY_ID.get(id)?.name || String(id || '');
}

/** The id of the title playing, from a page address alone (null on browse pages). */
export function watchIdFromUrl(url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(String(url));
  } catch {
    return null;
  }
  const p = platformForHost(u.hostname);
  try {
    return p ? p.watchId(u) : null;
  } catch {
    return null;
  }
}
