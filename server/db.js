'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS orgs(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL, name TEXT, pw TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS environments(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT, require_approval INTEGER DEFAULT 0, sdk_key TEXT UNIQUE NOT NULL, rev INTEGER DEFAULT 1, UNIQUE(org_id,key));
CREATE TABLE IF NOT EXISTS flags(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT, description TEXT, created_by TEXT, created_at INTEGER, UNIQUE(org_id,key));
CREATE TABLE IF NOT EXISTS flag_configs(flag_id INTEGER REFERENCES flags(id) ON DELETE CASCADE, env_id INTEGER REFERENCES environments(id) ON DELETE CASCADE,
  config TEXT NOT NULL, version INTEGER DEFAULT 1, updated_at INTEGER, updated_by TEXT, PRIMARY KEY(flag_id,env_id));
CREATE TABLE IF NOT EXISTS flag_versions(id INTEGER PRIMARY KEY, flag_id INTEGER REFERENCES flags(id) ON DELETE CASCADE, env_id INTEGER REFERENCES environments(id) ON DELETE CASCADE,
  version INTEGER, config TEXT, summary TEXT, reason TEXT, user TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS change_requests(id INTEGER PRIMARY KEY, org_id INTEGER, flag_id INTEGER REFERENCES flags(id) ON DELETE CASCADE, env_id INTEGER REFERENCES environments(id) ON DELETE CASCADE,
  proposed TEXT, summary TEXT, reason TEXT, requested_by TEXT, status TEXT DEFAULT 'pending', decided_by TEXT, ts INTEGER, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS schedules(id INTEGER PRIMARY KEY, org_id INTEGER, flag_id INTEGER REFERENCES flags(id) ON DELETE CASCADE, env_id INTEGER REFERENCES environments(id) ON DELETE CASCADE,
  run_at INTEGER, patch TEXT, reason TEXT, created_by TEXT, status TEXT DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, org_id INTEGER, ts INTEGER, user TEXT, action TEXT, flag_key TEXT, env_key TEXT, summary TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS webhooks(id INTEGER PRIMARY KEY, org_id INTEGER, url TEXT, secret TEXT);
CREATE TABLE IF NOT EXISTS evaluations(env_id INTEGER, flag_key TEXT, variant TEXT, hour INTEGER, count INTEGER, PRIMARY KEY(env_id,flag_key,variant,hour));
CREATE TABLE IF NOT EXISTS exposures(env_id INTEGER, flag_key TEXT, user_id TEXT, variant TEXT, ts INTEGER, PRIMARY KEY(env_id,flag_key,user_id));
CREATE TABLE IF NOT EXISTS conversions(id INTEGER PRIMARY KEY, env_id INTEGER, user_id TEXT, metric TEXT, value REAL, ts INTEGER);
CREATE INDEX IF NOT EXISTS conv_idx ON conversions(env_id, metric, user_id);
CREATE INDEX IF NOT EXISTS audit_idx ON audit(org_id, ts);
`;

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  let depth = 0;
  return {
    raw: db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    tx(fn) { // nested-safe transaction
      if (depth++ > 0) { try { return fn(); } finally { depth--; } }
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
    },
    close: () => db.close(),
  };
}
module.exports = { open };
