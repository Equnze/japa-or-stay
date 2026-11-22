// A D1-compatible wrapper around Node's built-in SQLite (node:sqlite), for local development and tests.
// Implements the parts of the D1 API the Arena uses: prepare().bind().first() / .all() / .run(), and batch() as one transaction.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function openD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const norm = a => a.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, norm(a)),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    _exec: () => { const s = db.prepare(sql); return /^\s*(SELECT|WITH)|RETURNING/i.test(sql) ? { results: s.all(...args) } : { meta: { changes: Number(s.run(...args).changes) } }; }
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => {
      db.exec('BEGIN IMMEDIATE');
      try { const out = list.map(s => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    exec: sql => db.exec(sql),
    close: () => db.close(),
    raw: db
  };
}
function migrate(d1, root = path.join(__dirname, '..', '..')) {
  const dir = path.join(root, 'migrations');
  d1.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (d1.raw.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(f)) continue;
    d1.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    d1.raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
  }
  return d1;
}
module.exports = { openD1, migrate };
