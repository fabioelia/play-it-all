#!/usr/bin/env node
// Catalog maintenance, used by contributors and by the GitHub Actions.
//
//   node scripts/catalog.mjs validate [--dir catalog]
//   node scripts/catalog.mjs index    [--dir catalog] [--check]
//   node scripts/catalog.mjs ingest   <issue-body.md | submission.json | -> [--author login] [--dir catalog] [--summary out.md]
//
// ingest accepts the text of a "Submit to the catalog" issue (or a bare
// submission JSON), merges it into the right episode / movie / list file,
// rebuilds the index and writes a Markdown summary for the pull request.
// It only ever writes inside the catalog directory, to paths derived from
// validated keys.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildIndex, formatCatalogJson, lookup, mergeSubmission, normalizeList, parseSubmission, pathForKey, submissionKey,
  validateEpisode, validateList, validateShow,
} from '../shared/catalog.js';
import { formatTime } from '../shared/identity.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: 'catalog' },
    author: { type: 'string' },
    summary: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});
const DIR = resolve(opt.dir);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, doc) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, formatCatalogJson(doc));
};

/** Load every catalog file. Returns parsed docs and per-file errors. */
export function loadCatalog(dir = DIR) {
  const shows = {};
  const episodes = [];
  const lists = [];
  const errors = [];
  const tryRead = (file, fn) => {
    try {
      fn(read(file));
    } catch (e) {
      errors.push(`${relative(process.cwd(), file)}: ${e.message}`);
    }
  };
  const showsDir = join(dir, 'shows');
  for (const show of existsSync(showsDir) ? readdirSync(showsDir) : []) {
    const sdir = join(showsDir, show);
    for (const f of readdirSync(sdir)) {
      const file = join(sdir, f);
      if (f === 'show.json') {
        tryRead(file, (doc) => {
          for (const e of validateShow(doc)) errors.push(`${relative(process.cwd(), file)}: ${e}`);
          shows[show] = doc;
        });
      } else if (/^s\d{2,}e\d{2,}\.json$/.test(f)) {
        tryRead(file, (doc) => {
          for (const e of validateEpisode(doc, file)) errors.push(`${relative(process.cwd(), file)}: ${e}`);
          episodes.push(doc);
        });
      } else errors.push(`${relative(process.cwd(), file)}: unexpected file (episodes are named s01e01.json)`);
    }
    if (!existsSync(join(sdir, 'show.json'))) errors.push(`${relative(process.cwd(), sdir)}: missing show.json`);
  }
  const moviesDir = join(dir, 'movies');
  for (const f of existsSync(moviesDir) ? readdirSync(moviesDir) : []) {
    const file = join(moviesDir, f);
    tryRead(file, (doc) => {
      for (const e of validateEpisode(doc, file)) errors.push(`${relative(process.cwd(), file)}: ${e}`);
      episodes.push(doc);
    });
  }
  const listsDir = join(dir, 'lists');
  for (const f of existsSync(listsDir) ? readdirSync(listsDir) : []) {
    const file = join(listsDir, f);
    tryRead(file, (doc) => {
      for (const e of validateList(doc, file)) errors.push(`${relative(process.cwd(), file)}: ${e}`);
      lists.push(doc);
    });
  }
  // The same platform video id must not appear in two files.
  const seen = new Map();
  for (const ep of episodes) {
    for (const [name, p] of Object.entries(ep.platforms || {})) {
      const k = `${name}:${p.id}`;
      if (seen.has(k)) errors.push(`${k} is listed in both ${seen.get(k)} and ${ep.key}`);
      seen.set(k, ep.key);
    }
  }
  return { shows, episodes, lists, errors };
}

function writeIndex(catalog) {
  const file = join(DIR, 'index.json');
  const index = buildIndex(catalog);
  if (opt.check) {
    const current = existsSync(file) ? read(file) : null;
    const same = current && JSON.stringify({ ...current, generated: 0 }) === JSON.stringify({ ...index, generated: 0 });
    if (!same) throw new Error('catalog/index.json is out of date: run `node scripts/catalog.mjs index`');
    return index;
  }
  write(file, index);
  return index;
}

function ingest(text, author) {
  const sub = parseSubmission(text);
  const catalog = loadCatalog();
  if (catalog.errors.length) throw new Error(`the catalog has errors already:\n${catalog.errors.join('\n')}`);
  const index = buildIndex(catalog);
  const lines = [];

  if (sub.list) {
    const list = normalizeList({ ...sub.list, author: author || sub.list.author || null });
    const errors = validateList(list);
    if (errors.length) throw new Error(errors.join('; '));
    const file = join(DIR, 'lists', `${list.id}.json`);
    if (existsSync(file)) {
      const current = read(file);
      if (current.author && author && current.author !== author) throw new Error(`a list called "${list.id}" already exists (by ${current.author}); pick another id`);
    }
    write(file, list);
    writeIndex(loadCatalog());
    lines.push(`Skip list **${list.name}** (\`${list.id}\`), ${list.settings.preset}, scope \`${list.scope}\`${author ? `, by @${author}` : ''}.`);
    return { summary: lines.join('\n'), title: `Skip list: ${list.name}` };
  }

  // Find the file: by this platform's video id, then by title (handles names
  // that differ between services), then create one.
  const t = sub.title || {};
  const found = lookup(index, { platform: t.platform, platformId: t.platformId, canonicalKey: safeKey(t) });
  const key = found?.key || submissionKey(t);
  const file = join(DIR, pathForKey(key));
  const existing = existsSync(file) ? read(file) : null;
  const r = mergeSubmission(existing, sub, { author });
  const errors = validateEpisode(r.episode, file);
  if (errors.length) throw new Error(errors.join('; '));
  write(file, r.episode);
  const showSlug = key.includes('/') ? key.split('/')[0] : null;
  if (showSlug && !existsSync(join(DIR, 'shows', showSlug, 'show.json'))) {
    write(join(DIR, 'shows', showSlug, 'show.json'), { name: r.episode.series, ...(t.year ? { year: Number(t.year) } : {}), aliases: [] });
  }
  writeIndex(loadCatalog());

  const label = r.episode.type === 'episode' ? `${r.episode.series} S${r.episode.season}:E${r.episode.episode}${r.episode.name ? ` · ${r.episode.name}` : ''}` : r.episode.name;
  const a = r.alignment;
  const status = {
    reference: () => `new title, timed on **${r.platform}** (the reference timeline)`,
    known: () => `**${r.platform}** was already synced`,
    aligned: () => `**${r.platform}** synced automatically from subtitle timing: offset ${a.offset}s${a.speed !== 1 ? `, speed ×${a.speed.toFixed(4)}` : ''} (${a.matches} matching cues)`,
    unsynced: () => `**${r.platform}** added but **not synced** (no subtitle timing to compare); its tags work on ${r.platform} only until someone adds an offset`,
  }[r.platformStatus]();
  lines.push(`**${label}** (\`${key}\`)`, '', `- ${r.created ? 'Created' : 'Updated'} \`catalog/${pathForKey(key)}\``, `- ${status}`,
    `- ${r.added} tag${r.added === 1 ? '' : 's'} added${r.duplicates ? `, ${r.duplicates} already in the catalog` : ''}${author ? `, by @${author}` : ''}`);
  if (found && found.via !== 'platform') lines.push(`- Matched an existing title by ${found.via === 'alias' ? 'an alternative name' : 'name'}: please check it is the same episode`);
  const added = r.addedSegments;
  if (added.length) {
    lines.push('', '| When | What | Note |', '| --- | --- | --- |');
    for (const s of added) lines.push(`| ${formatTime(s.start)}–${formatTime(s.end)} | ${s.category} (${['', 'mild', 'moderate', 'strong'][s.severity]}) | ${(s.note || '').replace(/\|/g, '\\|')} |`);
  }
  return { summary: lines.join('\n'), title: `Tags: ${label}` };
}

function safeKey(t) {
  try {
    return submissionKey(t);
  } catch {
    return null;
  }
}

function main() {
  const [cmd, input] = positionals;
  if (cmd === 'validate') {
    const c = loadCatalog();
    if (!c.errors.length) {
      try {
        opt.check = true;
        writeIndex(c);
      } catch (e) {
        c.errors.push(e.message);
      }
    }
    if (c.errors.length) {
      console.error(c.errors.map((e) => `✗ ${e}`).join('\n'));
      process.exit(1);
    }
    console.log(`✓ catalog OK: ${c.episodes.length} episodes/films, ${Object.keys(c.shows).length} shows, ${c.lists.length} lists`);
  } else if (cmd === 'index') {
    const c = loadCatalog();
    if (c.errors.length) {
      console.error(c.errors.map((e) => `✗ ${e}`).join('\n'));
      process.exit(1);
    }
    const index = writeIndex(c);
    console.log(`${opt.check ? '✓ index up to date' : 'wrote catalog/index.json'}: ${JSON.stringify(index.counts)}`);
  } else if (cmd === 'ingest') {
    if (!input) throw new Error('ingest needs a file (or - for stdin)');
    const text = readFileSync(input === '-' ? 0 : input, 'utf8');
    const { summary, title } = ingest(text, opt.author);
    if (opt.summary) writeFileSync(opt.summary, `${summary}\n`);
    writeFileSync(1, `${title}\n\n${summary}\n`);
  } else {
    console.error('usage: node scripts/catalog.mjs validate | index [--check] | ingest <file> [--author login] [--summary out.md]');
    process.exit(1);
  }
}

try {
  main();
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
