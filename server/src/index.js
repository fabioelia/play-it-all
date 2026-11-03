#!/usr/bin/env node
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';
const dbFile = process.env.CLEANCUT_DB || new URL('../../data/cleancut.db', import.meta.url).pathname;

const db = openDb(dbFile);
const server = createServer(createApp(db));
server.listen(port, host, () => {
  console.log(`CleanCut API listening on http://${host}:${port}  (db: ${dbFile})`);
  console.log(`  community hub  http://${host}:${port}/`);
  console.log(`  extension demo http://${host}:${port}/demo`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
