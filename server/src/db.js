// SQLite storage via Node's built-in node:sqlite (no native deps).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS titles (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  canonical_key TEXT,
  series TEXT,
  season INTEGER,
  episode INTEGER,
  name TEXT,
  duration REAL,
  created_at INTEGER NOT NULL,
  UNIQUE (platform, platform_id)
);
CREATE INDEX IF NOT EXISTS titles_canonical ON titles (canonical_key);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  title_id INTEGER NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  category TEXT NOT NULL,
  severity INTEGER NOT NULL,
  action TEXT,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'community',
  confidence REAL NOT NULL DEFAULT 1,
  score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_title ON segments (title_id, start_s);

CREATE TABLE IF NOT EXISTS votes (
  segment_id INTEGER NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  value INTEGER NOT NULL,
  PRIMARY KEY (segment_id, user_id)
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL,          -- JSON: { preset, thresholds, actions, ai }
  title_id INTEGER REFERENCES titles (id) ON DELETE CASCADE,
  canonical_key TEXT,
  include_ids TEXT NOT NULL DEFAULT '[]',
  exclude_ids TEXT NOT NULL DEFAULT '[]',
  subscribers INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_title ON profiles (title_id);
CREATE INDEX IF NOT EXISTS profiles_canonical ON profiles (canonical_key);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}
