'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('./db');
const { evaluate, OPS } = require('../sdk/engine');

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const ROLES = ['admin', 'developer', 'release_manager', 'viewer'];
const now = () => Date.now();
const J = s => JSON.parse(s);

function createApp(opts = {}) {
  const db = open(opts.dbFile || ':memory:');
  const publicDir = opts.publicDir || path.join(__dirname, '..', 'dashboard');
  const rateMax = opts.rateLimit ?? Number(process.env.RATE_LIMIT || 600);

  // ---------- secrets, passwords, tokens ----------
  let secret = db.get("SELECT v FROM settings WHERE k='secret'")?.v;
  if (!secret) { secret = process.env.FLAGSHIP_SECRET || crypto.randomBytes(32).toString('hex'); db.run("INSERT INTO settings VALUES('secret',?)", secret); }
  const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
  const checkPw = (pw, stored) => { const [s, h] = stored.split(':'); const x = crypto.scryptSync(pw, s, 32); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); };
  const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', secret).update(b).digest('base64url'); };
  const verify = t => {
    const [b, s] = String(t || '').split('.'); if (!b || !s) return null;
    const ok = crypto.createHmac('sha256', secret).update(b).digest('base64url');
    if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
    const p = J(Buffer.from(b, 'base64url').toString()); return p.exp > now() ? p : null;
  };

  // ---------- metrics, rate limiting, live streams ----------
  const metrics = { req: new Map(), evals: 0 };
  const buckets = new Map();
  const limit = (key, max, windowMs = 60000) => {
    const t = now(); let b = buckets.get(key);
    if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
    if (++b.n > max) throw Object.assign(new HttpError(429, 'Too many requests. Try again shortly.'), { retry: Math.ceil((b.reset - t) / 1000) });
  };
  const sdkStreams = new Map(), adminStreams = new Map();
  const addStream = (map, id, res) => { if (!map.has(id)) map.set(id, new Set()); map.get(id).add(res); res.on('close', () => map.get(id)?.delete(res)); };
  const push = (set, event, data) => { for (const r of set || []) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const keepAlive = setInterval(() => { for (const m of [sdkStreams, adminStreams]) for (const s of m.values()) for (const r of s) r.write(': ping\n\n'); }, 25000);

  // ---------- config helpers ----------
  const cleanCond = c => {
    if (!c || typeof c.attr !== 'string' || !c.attr.trim() || !OPS.includes(c.op)) throw new HttpError(400, 'Each rule needs an attribute and a valid operator.');
    return { attr: c.attr.trim(), op: c.op, value: c.value ?? '' };
  };
  function cleanCfg(c) {
    if (!c || typeof c !== 'object') throw new HttpError(400, 'Missing config.');
    const rollout = Math.min(100, Math.max(0, Number(c.rollout ?? 100)));
    if (Number.isNaN(rollout)) throw new HttpError(400, 'Rollout must be a number from 0 to 100.');
    const variants = (c.variants || []).map(v => ({ key: String(v.key || '').trim(), weight: Math.max(0, Number(v.weight) || 0) }));
    if (variants.length && (variants.length < 2 || variants.some(v => !v.key || v.key === 'off') || new Set(variants.map(v => v.key)).size !== variants.length))
      throw new HttpError(400, 'Variants need at least two unique names, and "off" is reserved.');
    return { enabled: !!c.enabled, kill: !!c.kill, rollout, rules: (c.rules || []).map(cleanCond), excludes: (c.excludes || []).map(cleanCond), variants };
  }
  const defaultCfg = () => ({ enabled: false, kill: false, rollout: 100, rules: [], excludes: [], variants: [] });
  function diff(a, b) {
    const o = [], same = k => JSON.stringify(a[k]) === JSON.stringify(b[k]);
    if (a.enabled !== b.enabled) o.push(b.enabled ? 'turned on' : 'turned off');
    if (a.kill !== b.kill) o.push(b.kill ? 'kill switch activated' : 'kill switch released');
    if (a.rollout !== b.rollout) o.push(`rollout ${a.rollout}% to ${b.rollout}%`);
    if (!same('rules')) o.push('targeting rules updated');
    if (!same('excludes')) o.push('exclusions updated');
    if (!same('variants')) o.push('variants updated');
    return o.join(', ') || 'no visible change';
  }
  const audit = (orgId, user, action, flagKey, envKey, summary, reason) => {
    db.run('INSERT INTO audit(org_id,ts,user,action,flag_key,env_key,summary,reason) VALUES(?,?,?,?,?,?,?,?)', orgId, now(), user, action, flagKey ?? null, envKey ?? null, summary, reason || null);
    push(adminStreams.get(orgId), 'change', { user, action, flag: flagKey, env: envKey, summary });
    for (const w of db.all('SELECT * FROM webhooks WHERE org_id=?', orgId)) {
      const body = JSON.stringify({ ts: now(), user, action, flag: flagKey, environment: envKey, summary, reason });
      const sig = crypto.createHmac('sha256', w.secret).update(body).digest('hex');
      fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flagship-signature': 'sha256=' + sig }, body, signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
  };
  function applyConfig({ org, flag, env, cfg, user, reason, action = 'update', summary }) {
    const row = db.get('SELECT * FROM flag_configs WHERE flag_id=? AND env_id=?', flag.id, env.id);
    const before = J(row.config), version = row.version + 1, text = summary || diff(before, cfg), t = now();
    db.tx(() => {
      db.run('UPDATE flag_configs SET config=?,version=?,updated_at=?,updated_by=? WHERE flag_id=? AND env_id=?', JSON.stringify(cfg), version, t, user, flag.id, env.id);
      db.run('INSERT INTO flag_versions(flag_id,env_id,version,config,summary,reason,user,ts) VALUES(?,?,?,?,?,?,?,?)', flag.id, env.id, version, JSON.stringify(cfg), text, reason || null, user, t);
      db.run('UPDATE environments SET rev=rev+1 WHERE id=?', env.id);
      audit(org, user, action, flag.key, env.key, text, reason);
    });
    push(sdkStreams.get(env.id), 'update', { rev: db.get('SELECT rev FROM environments WHERE id=?', env.id).rev });
    return { version, summary: text };
  }
  function submit(c, flag, env, cfg, reason, action, summary) {
    const role = c.user.role;
    if (role === 'viewer') throw new HttpError(403, 'Viewers have read-only access.');
    const cur = J(db.get('SELECT config FROM flag_configs WHERE flag_id=? AND env_id=?', flag.id, env.id).config);
    const text = summary || diff(cur, cfg);
    if (env.require_approval && role === 'developer') {
      if (!reason) throw new HttpError(400, 'Add a reason so the release manager knows why you are changing production.');
      const r = db.run('INSERT INTO change_requests(org_id,flag_id,env_id,proposed,summary,reason,requested_by,ts) VALUES(?,?,?,?,?,?,?,?)', c.user.org_id, flag.id, env.id, JSON.stringify(cfg), text, reason, c.user.email, now());
      audit(c.user.org_id, c.user.email, 'request', flag.key, env.key, 'requested: ' + text, reason);
      return { status: 'pending_approval', requestId: Number(r.lastInsertRowid) };
    }
    return { status: 'applied', ...applyConfig({ org: c.user.org_id, flag, env, cfg, user: c.user.email, reason, action, summary: text }) };
  }

  // ---------- lookups ----------
  const getEnv = (c, key) => db.get('SELECT * FROM environments WHERE org_id=? AND key=?', c.user.org_id, key) || (() => { throw new HttpError(404, 'Environment not found.'); })();
  const getFlag = (c, key) => db.get('SELECT * FROM flags WHERE org_id=? AND key=?', c.user.org_id, key) || (() => { throw new HttpError(404, 'Flag not found.'); })();
  const need = (c, ...roles) => { if (!roles.includes(c.user.role)) throw new HttpError(403, 'Your role cannot do this.'); };
  const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role });
  const sdkFlags = envId => {
    const out = {};
    for (const r of db.all('SELECT f.key, c.config FROM flag_configs c JOIN flags f ON f.id=c.flag_id WHERE c.env_id=?', envId)) out[r.key] = { key: r.key, ...J(r.config) };
    return out;
  };
  const newSdkKey = k => `fs_${k}_${crypto.randomBytes(18).toString('hex')}`;
  function createEnv(orgId, key, name, approval) {
    const r = db.run('INSERT INTO environments(org_id,key,name,require_approval,sdk_key) VALUES(?,?,?,?,?)', orgId, key, name, approval ? 1 : 0, newSdkKey(key));
    for (const f of db.all('SELECT id FROM flags WHERE org_id=?', orgId)) db.run('INSERT INTO flag_configs VALUES(?,?,?,1,?,?)', f.id, r.lastInsertRowid, JSON.stringify(defaultCfg()), now(), 'system');
  }

  // ---------- router ----------
  const routes = [];
  const R = (method, p, o, fn) => routes.push({ method, p, o, fn, keys: [...p.matchAll(/:(\w+)/g)].map(m => m[1]), re: new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$') });
  const US = { auth: 'user' };

  R('POST', '/api/auth/register', { limit: 10 }, c => {
    const { orgName, email, password, name } = c.body;
    if (!orgName || !email || !password || password.length < 8) throw new HttpError(400, 'Enter an organization, an email and a password of at least 8 characters.');
    if (db.get('SELECT 1 FROM users WHERE email=?', email.toLowerCase())) throw new HttpError(409, 'That email is already registered.');
    let user;
    db.tx(() => {
      const o = db.run('INSERT INTO orgs(name,created_at) VALUES(?,?)', orgName, now()).lastInsertRowid;
      createEnv(o, 'development', 'Development', false); createEnv(o, 'staging', 'Staging', false); createEnv(o, 'production', 'Production', true);
      const id = db.run('INSERT INTO users(org_id,email,name,pw,role,created_at) VALUES(?,?,?,?,?,?)', o, email.toLowerCase(), name || email, hashPw(password), 'admin', now()).lastInsertRowid;
      user = db.get('SELECT * FROM users WHERE id=?', id);
    });
    c.code = 201; return { token: sign({ uid: user.id, exp: now() + 7 * 864e5 }), user: publicUser(user) };
  });
  R('POST', '/api/auth/login', { limit: 10 }, c => {
    const u = db.get('SELECT * FROM users WHERE email=?', String(c.body.email || '').toLowerCase());
    if (!u || !checkPw(String(c.body.password || ''), u.pw)) throw new HttpError(401, 'Email or password is incorrect.');
    return { token: sign({ uid: u.id, exp: now() + 7 * 864e5 }), user: publicUser(u) };
  });
  R('GET', '/api/me', US, c => ({ user: publicUser(c.user), org: db.get('SELECT id,name FROM orgs WHERE id=?', c.user.org_id) }));

  R('GET', '/api/environments', US, c => db.all('SELECT id,key,name,require_approval,rev,sdk_key FROM environments WHERE org_id=? ORDER BY id', c.user.org_id)
    .map(e => ({ ...e, require_approval: !!e.require_approval, sdk_key: c.user.role === 'viewer' ? null : e.sdk_key })));
  R('POST', '/api/environments', US, c => {
    need(c, 'admin'); const key = String(c.body.key || '').toLowerCase();
    if (!/^[a-z0-9_-]{2,30}$/.test(key)) throw new HttpError(400, 'Environment keys use 2 to 30 letters, numbers, dashes or underscores.');
    if (db.get('SELECT 1 FROM environments WHERE org_id=? AND key=?', c.user.org_id, key)) throw new HttpError(409, 'That environment already exists.');
    createEnv(c.user.org_id, key, c.body.name || key, c.body.require_approval); audit(c.user.org_id, c.user.email, 'env_create', null, key, 'created environment ' + key);
    c.code = 201; return { ok: true };
  });
  R('PATCH', '/api/environments/:env', US, c => {
    need(c, 'admin'); const e = getEnv(c, c.params.env);
    db.run('UPDATE environments SET require_approval=? WHERE id=?', c.body.require_approval ? 1 : 0, e.id);
    audit(c.user.org_id, c.user.email, 'env_update', null, e.key, 'approval ' + (c.body.require_approval ? 'required' : 'not required')); return { ok: true };
  });
  R('POST', '/api/environments/:env/rotate-key', US, c => {
    need(c, 'admin'); const e = getEnv(c, c.params.env); const k = newSdkKey(e.key);
    db.run('UPDATE environments SET sdk_key=? WHERE id=?', k, e.id); audit(c.user.org_id, c.user.email, 'rotate_key', null, e.key, 'rotated SDK key'); return { sdk_key: k };
  });

  R('GET', '/api/flags', US, c => {
    const envs = db.all('SELECT id,key FROM environments WHERE org_id=?', c.user.org_id);
    return db.all('SELECT * FROM flags WHERE org_id=? ORDER BY key', c.user.org_id).map(f => ({
      key: f.key, name: f.name, description: f.description, created_by: f.created_by, created_at: f.created_at,
      environments: Object.fromEntries(envs.map(e => { const r = db.get('SELECT * FROM flag_configs WHERE flag_id=? AND env_id=?', f.id, e.id); return [e.key, { ...J(r.config), version: r.version, updated_at: r.updated_at, updated_by: r.updated_by }]; })),
    }));
  });
  R('POST', '/api/flags', US, c => {
    need(c, 'admin', 'developer', 'release_manager');
    const key = String(c.body.key || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(key)) throw new HttpError(400, 'Flag keys use lowercase letters, numbers, underscores, dots or dashes.');
    if (db.get('SELECT 1 FROM flags WHERE org_id=? AND key=?', c.user.org_id, key)) throw new HttpError(409, 'A flag with that key already exists.');
    db.tx(() => {
      const id = db.run('INSERT INTO flags(org_id,key,name,description,created_by,created_at) VALUES(?,?,?,?,?,?)', c.user.org_id, key, c.body.name || key, c.body.description || '', c.user.email, now()).lastInsertRowid;
      for (const e of db.all('SELECT id FROM environments WHERE org_id=?', c.user.org_id)) {
        db.run('INSERT INTO flag_configs VALUES(?,?,?,1,?,?)', id, e.id, JSON.stringify(defaultCfg()), now(), c.user.email);
        db.run('UPDATE environments SET rev=rev+1 WHERE id=?', e.id);
      }
      audit(c.user.org_id, c.user.email, 'create', key, null, 'created flag ' + key);
    });
    for (const e of db.all('SELECT id,rev FROM environments WHERE org_id=?', c.user.org_id)) push(sdkStreams.get(e.id), 'update', { rev: e.rev });
    c.code = 201; return { key };
  });
  R('PATCH', '/api/flags/:key', US, c => {
    need(c, 'admin', 'developer', 'release_manager'); const f = getFlag(c, c.params.key);
    db.run('UPDATE flags SET name=?,description=? WHERE id=?', c.body.name ?? f.name, c.body.description ?? f.description, f.id);
    audit(c.user.org_id, c.user.email, 'edit', f.key, null, 'edited flag details'); return { ok: true };
  });
  R('DELETE', '/api/flags/:key', US, c => {
    need(c, 'admin'); const f = getFlag(c, c.params.key);
    db.tx(() => { db.run('DELETE FROM flags WHERE id=?', f.id); db.run('UPDATE environments SET rev=rev+1 WHERE org_id=?', c.user.org_id); audit(c.user.org_id, c.user.email, 'delete', f.key, null, 'deleted flag ' + f.key, c.body.reason); });
    for (const e of db.all('SELECT id,rev FROM environments WHERE org_id=?', c.user.org_id)) push(sdkStreams.get(e.id), 'update', { rev: e.rev });
    return { ok: true };
  });
  R('PUT', '/api/flags/:key/environments/:env', US, c => {
    const f = getFlag(c, c.params.key), e = getEnv(c, c.params.env);
    return submit(c, f, e, cleanCfg(c.body.config), c.body.reason);
  });
  R('POST', '/api/flags/:key/environments/:env/kill', US, c => { // kill switches bypass approval on purpose
    const f = getFlag(c, c.params.key), e = getEnv(c, c.params.env);
    if (c.user.role === 'viewer') throw new HttpError(403, 'Viewers have read-only access.');
    const cur = J(db.get('SELECT config FROM flag_configs WHERE flag_id=? AND env_id=?', f.id, e.id).config);
    const next = { ...cur, kill: c.body.kill !== false };
    return { status: 'applied', ...applyConfig({ org: c.user.org_id, flag: f, env: e, cfg: next, user: c.user.email, reason: c.body.reason, action: next.kill ? 'kill' : 'unkill' }) };
  });
  R('GET', '/api/flags/:key/environments/:env/versions', US, c => {
    const f = getFlag(c, c.params.key), e = getEnv(c, c.params.env);
    return db.all('SELECT version,config,summary,reason,user,ts FROM flag_versions WHERE flag_id=? AND env_id=? ORDER BY version DESC LIMIT 100', f.id, e.id).map(v => ({ ...v, config: J(v.config) }));
  });
  R('POST', '/api/flags/:key/environments/:env/restore', US, c => {
    const f = getFlag(c, c.params.key), e = getEnv(c, c.params.env);
    const v = db.get('SELECT * FROM flag_versions WHERE flag_id=? AND env_id=? AND version=?', f.id, e.id, Number(c.body.version));
    if (!v) throw new HttpError(404, 'That version does not exist.');
    return submit(c, f, e, J(v.config), c.body.reason, 'restore', `restored version ${v.version}`);
  });
  R('GET', '/api/flags/:key/environments/:env/schedules', US, c => {
    const f = getFlag(c, c.params.key), e = getEnv(c, c.params.env);
    return db.all("SELECT id,run_at,patch,reason,created_by,status FROM schedules WHERE flag_id=? AND env_id=? ORDER BY run_at DESC LIMIT 30", f.id, e.id).map(s => ({ ...s, patch: J(s.patch) }));
  });
  R('POST', '/api/flags/:key/environments/:env/schedules', US, c => {
    const f = getFlag(c, c.params.key), e = getEnv(c, c.params.env);
    need(c, ...(e.require_approval ? ['admin', 'release_manager'] : ['admin', 'developer', 'release_manager']));
    const at = Date.parse(c.body.run_at); if (!at || at < now()) throw new HttpError(400, 'Pick a time in the future.');
    const p = {}; for (const k of ['enabled', 'kill']) if (k in (c.body.patch || {})) p[k] = !!c.body.patch[k];
    if ('rollout' in (c.body.patch || {})) p.rollout = Math.min(100, Math.max(0, Number(c.body.patch.rollout)));
    if (!Object.keys(p).length) throw new HttpError(400, 'Choose what should change.');
    db.run('INSERT INTO schedules(org_id,flag_id,env_id,run_at,patch,reason,created_by) VALUES(?,?,?,?,?,?,?)', c.user.org_id, f.id, e.id, at, JSON.stringify(p), c.body.reason || null, c.user.email);
    audit(c.user.org_id, c.user.email, 'schedule', f.key, e.key, 'scheduled ' + JSON.stringify(p) + ' for ' + new Date(at).toISOString(), c.body.reason);
    c.code = 201; return { ok: true };
  });
  R('DELETE', '/api/schedules/:id', US, c => {
    need(c, 'admin', 'developer', 'release_manager');
    db.run("UPDATE schedules SET status='cancelled' WHERE id=? AND org_id=? AND status='pending'", Number(c.params.id), c.user.org_id); return { ok: true };
  });

  R('GET', '/api/change-requests', US, c => db.all(`SELECT r.id,r.summary,r.reason,r.requested_by,r.status,r.decided_by,r.ts,r.proposed,f.key flag,e.key env FROM change_requests r
    JOIN flags f ON f.id=r.flag_id JOIN environments e ON e.id=r.env_id WHERE r.org_id=? ORDER BY r.id DESC LIMIT 100`, c.user.org_id).map(r => ({ ...r, proposed: J(r.proposed) })));
  const decide = ok => c => {
    need(c, 'admin', 'release_manager');
    const r = db.get("SELECT * FROM change_requests WHERE id=? AND org_id=? AND status='pending'", Number(c.params.id), c.user.org_id);
    if (!r) throw new HttpError(404, 'That request is no longer pending.');
    const flag = db.get('SELECT * FROM flags WHERE id=?', r.flag_id), env = db.get('SELECT * FROM environments WHERE id=?', r.env_id);
    db.run('UPDATE change_requests SET status=?,decided_by=?,decided_at=? WHERE id=?', ok ? 'approved' : 'rejected', c.user.email, now(), r.id);
    if (ok) applyConfig({ org: c.user.org_id, flag, env, cfg: J(r.proposed), user: c.user.email, reason: `Approved request from ${r.requested_by}: ${r.reason}`, action: 'approve', summary: r.summary });
    else audit(c.user.org_id, c.user.email, 'reject', flag.key, env.key, 'rejected: ' + r.summary, c.body.reason);
    return { ok: true };
  };
  R('POST', '/api/change-requests/:id/approve', US, decide(true));
  R('POST', '/api/change-requests/:id/reject', US, decide(false));

  R('GET', '/api/audit', US, c => {
    const q = c.query.flag ? ' AND flag_key=?' : '';
    return db.all(`SELECT ts,user,action,flag_key,env_key,summary,reason FROM audit WHERE org_id=?${q} ORDER BY id DESC LIMIT ?`, ...[c.user.org_id, ...(c.query.flag ? [c.query.flag] : []), Math.min(500, Number(c.query.limit) || 200)]);
  });

  R('GET', '/api/analytics/:flag/:env', US, c => {
    const e = getEnv(c, c.params.env), since = Math.floor(now() / 36e5) * 36e5 - 23 * 36e5;
    const rows = db.all('SELECT variant,hour,count FROM evaluations WHERE env_id=? AND flag_key=? AND hour>=?', e.id, c.params.flag, since);
    const hours = Array.from({ length: 24 }, (_, i) => ({ hour: since + i * 36e5, total: 0, byVariant: {} }));
    const totals = {};
    for (const r of rows) { const h = hours[(r.hour - since) / 36e5]; if (h) { h.total += r.count; h.byVariant[r.variant] = (h.byVariant[r.variant] || 0) + r.count; totals[r.variant] = (totals[r.variant] || 0) + r.count; } }
    return { hours, totals, total: Object.values(totals).reduce((a, b) => a + b, 0) };
  });
  const cdf = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
  R('GET', '/api/experiments/:flag/:env', US, c => {
    const e = getEnv(c, c.params.env), flag = c.params.flag, metric = c.query.metric || '';
    const metrics = db.all('SELECT DISTINCT metric FROM conversions WHERE env_id=?', e.id).map(r => r.metric);
    const vs = db.all('SELECT variant, COUNT(*) users FROM exposures WHERE env_id=? AND flag_key=? GROUP BY variant ORDER BY variant', e.id, flag);
    const out = vs.map(v => {
      const q = db.get(`SELECT COUNT(DISTINCT x.user_id) converters, COALESCE(SUM(c.value),0) value FROM exposures x JOIN conversions c ON c.env_id=x.env_id AND c.user_id=x.user_id AND c.metric=?
        WHERE x.env_id=? AND x.flag_key=? AND x.variant=?`, metric, e.id, flag, v.variant);
      return { variant: v.variant, users: v.users, converters: q.converters, value: q.value, rate: v.users ? q.converters / v.users : 0 };
    });
    const control = out.find(v => v.variant === 'control') || out[0];
    for (const v of out) {
      if (v === control || !control) continue;
      const p = (v.converters + control.converters) / ((v.users + control.users) || 1), se = Math.sqrt(p * (1 - p) * (1 / v.users + 1 / control.users));
      v.lift = control.rate ? (v.rate - control.rate) / control.rate : null;
      v.pValue = se ? 2 * (1 - cdf(Math.abs((v.rate - control.rate) / se))) : null;
    }
    return { metric, metrics, control: control?.variant, variants: out };
  });

  R('POST', '/api/evaluate', US, c => {
    const e = getEnv(c, c.body.env), flags = sdkFlags(e.id), out = {};
    for (const [k, cfg] of Object.entries(flags)) out[k] = evaluate(cfg, c.body.user || {});
    return out;
  });

  R('GET', '/api/users', US, c => db.all('SELECT id,email,name,role FROM users WHERE org_id=? ORDER BY id', c.user.org_id));
  R('POST', '/api/users', US, c => {
    need(c, 'admin'); const { email, name, password, role } = c.body;
    if (!email || !password || password.length < 8 || !ROLES.includes(role)) throw new HttpError(400, 'Enter an email, a role and a password of at least 8 characters.');
    if (db.get('SELECT 1 FROM users WHERE email=?', email.toLowerCase())) throw new HttpError(409, 'That email is already registered.');
    db.run('INSERT INTO users(org_id,email,name,pw,role,created_at) VALUES(?,?,?,?,?,?)', c.user.org_id, email.toLowerCase(), name || email, hashPw(password), role, now());
    audit(c.user.org_id, c.user.email, 'user_add', null, null, `added ${email} as ${role}`); c.code = 201; return { ok: true };
  });
  R('PATCH', '/api/users/:id', US, c => {
    need(c, 'admin'); if (!ROLES.includes(c.body.role)) throw new HttpError(400, 'Unknown role.');
    const u = db.get('SELECT * FROM users WHERE id=? AND org_id=?', Number(c.params.id), c.user.org_id); if (!u) throw new HttpError(404, 'User not found.');
    if (u.id === c.user.id) throw new HttpError(400, 'You cannot change your own role.');
    db.run('UPDATE users SET role=? WHERE id=?', c.body.role, u.id); audit(c.user.org_id, c.user.email, 'user_role', null, null, `${u.email} is now ${c.body.role}`); return { ok: true };
  });
  R('DELETE', '/api/users/:id', US, c => {
    need(c, 'admin'); const u = db.get('SELECT * FROM users WHERE id=? AND org_id=?', Number(c.params.id), c.user.org_id);
    if (!u || u.id === c.user.id) throw new HttpError(400, 'You cannot remove this user.');
    db.run('DELETE FROM users WHERE id=?', u.id); audit(c.user.org_id, c.user.email, 'user_remove', null, null, 'removed ' + u.email); return { ok: true };
  });
  R('GET', '/api/webhooks', US, c => { need(c, 'admin'); return db.all('SELECT id,url FROM webhooks WHERE org_id=?', c.user.org_id); });
  R('POST', '/api/webhooks', US, c => {
    need(c, 'admin'); if (!/^https?:\/\//.test(c.body.url || '')) throw new HttpError(400, 'Enter a URL that starts with http:// or https://.');
    const s = crypto.randomBytes(16).toString('hex'); db.run('INSERT INTO webhooks(org_id,url,secret) VALUES(?,?,?)', c.user.org_id, c.body.url, s); c.code = 201; return { secret: s };
  });
  R('DELETE', '/api/webhooks/:id', US, c => { need(c, 'admin'); db.run('DELETE FROM webhooks WHERE id=? AND org_id=?', Number(c.params.id), c.user.org_id); return { ok: true }; });
  R('GET', '/api/stream', { auth: 'stream' }, c => { addStream(adminStreams, c.user.org_id, c.res); return 'stream'; });

  // SDK endpoints (authenticated by environment SDK key)
  const SK = { auth: 'sdk' };
  R('GET', '/sdk/v1/config', SK, c => {
    const etag = `"${c.env.rev}"`;
    if (c.req.headers['if-none-match'] === etag) { c.res.writeHead(304, { etag }); c.res.end(); return 'sent'; }
    c.headers = { etag }; return { rev: c.env.rev, environment: c.env.key, flags: sdkFlags(c.env.id) };
  });
  R('GET', '/sdk/v1/stream', { auth: 'sdk' }, c => { addStream(sdkStreams, c.env.id, c.res); c.initial = `event: update\ndata: ${JSON.stringify({ rev: c.env.rev })}\n\n`; return 'stream'; });
  R('POST', '/sdk/v1/evaluate', SK, c => { const out = {}; for (const [k, cfg] of Object.entries(sdkFlags(c.env.id))) out[k] = evaluate(cfg, c.body.user || {}); return { flags: out }; });
  R('POST', '/sdk/v1/events', SK, c => {
    const b = c.body, hour = Math.floor(now() / 36e5) * 36e5, cap = a => (Array.isArray(a) ? a.slice(0, 1000) : []);
    db.tx(() => {
      for (const v of cap(b.evaluations)) { const n = Math.max(0, Math.floor(Number(v.count) || 0)); metrics.evals += n;
        db.run('INSERT INTO evaluations VALUES(?,?,?,?,?) ON CONFLICT(env_id,flag_key,variant,hour) DO UPDATE SET count=count+excluded.count', c.env.id, String(v.flag), String(v.variant), hour, n); }
      for (const v of cap(b.exposures)) db.run('INSERT OR IGNORE INTO exposures VALUES(?,?,?,?,?)', c.env.id, String(v.flag), String(v.userId), String(v.variant), now());
      for (const v of cap(b.conversions)) db.run('INSERT INTO conversions(env_id,user_id,metric,value,ts) VALUES(?,?,?,?,?)', c.env.id, String(v.userId), String(v.metric), Number(v.value ?? 1), now());
    });
    c.code = 202; return { ok: true };
  });

  R('GET', '/healthz', {}, () => ({ ok: true }));
  R('GET', '/metrics', {}, c => {
    let o = '# TYPE flagship_http_requests_total counter\n';
    for (const [k, v] of metrics.req) o += `flagship_http_requests_total{${k}} ${v}\n`;
    o += `# TYPE flagship_flag_evaluations_total counter\nflagship_flag_evaluations_total ${metrics.evals}\n`;
    o += `# TYPE flagship_sdk_streams gauge\nflagship_sdk_streams ${[...sdkStreams.values()].reduce((a, s) => a + s.size, 0)}\n`;
    c.res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); c.res.end(o); return 'sent';
  });

  // ---------- scheduler ----------
  function tick() {
    for (const s of db.all("SELECT * FROM schedules WHERE status='pending' AND run_at<=?", now())) {
      db.run("UPDATE schedules SET status='done' WHERE id=?", s.id);
      const flag = db.get('SELECT * FROM flags WHERE id=?', s.flag_id), env = db.get('SELECT * FROM environments WHERE id=?', s.env_id);
      if (!flag || !env) continue;
      const cur = J(db.get('SELECT config FROM flag_configs WHERE flag_id=? AND env_id=?', flag.id, env.id).config);
      applyConfig({ org: s.org_id, flag, env, cfg: { ...cur, ...J(s.patch) }, user: 'scheduler', reason: `Scheduled by ${s.created_by}. ${s.reason || ''}`.trim(), action: 'scheduled' });
    }
  }
  const timer = setInterval(() => { try { tick(); } catch (e) { console.error('scheduler', e); } }, opts.tickMs || 15000);

  // ---------- HTTP plumbing ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((ok, no) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > 1e6) { no(new HttpError(413, 'Request is too large.')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { ok(chunks.length ? J(Buffer.concat(chunks).toString()) : {}); } catch { no(new HttpError(400, 'Body must be valid JSON.')); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
    const cors = { 'access-control-allow-origin': url.pathname.startsWith('/sdk/') ? '*' : (process.env.CORS_ORIGIN || ''), 'access-control-allow-headers': 'authorization,content-type,if-none-match,x-sdk-key', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'x-content-type-options': 'nosniff' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    let status = 200;
    try {
      if (!route) {
        if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/sdk/')) throw new HttpError(404, 'Not found.');
        let f = path.join(publicDir, path.normalize(url.pathname));
        if (!f.startsWith(publicDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(publicDir, 'index.html');
        res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', ...cors }); return fs.createReadStream(f).pipe(res);
      }
      const m = url.pathname.match(route.re), params = {}; route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const c = { req, res, params, query: Object.fromEntries(url.searchParams), code: 200, headers: {}, body: {} };
      if (route.o.limit) limit('auth:' + ip, opts.authLimit ?? route.o.limit);
      const bearer = (req.headers.authorization || '').replace(/^Bearer /i, '');
      if (route.o.auth === 'user' || route.o.auth === 'stream') {
        const p = verify(route.o.auth === 'stream' ? c.query.token : bearer);
        c.user = p && db.get('SELECT * FROM users WHERE id=?', p.uid);
        if (!c.user) throw new HttpError(401, 'Sign in to continue.');
        limit('u:' + c.user.id, rateMax);
      } else if (route.o.auth === 'sdk') {
        const key = req.headers['x-sdk-key'] || bearer || c.query.key;
        c.env = key && db.get('SELECT * FROM environments WHERE sdk_key=?', key);
        if (!c.env) throw new HttpError(401, 'Unknown SDK key.');
        limit('k:' + c.env.id, rateMax * 4);
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) c.body = await readBody(req);
      const out = route.fn(c);
      if (out === 'sent') return status = res.statusCode;
      if (out === 'stream') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors }); res.write(c.initial || ': connected\n\n'); return; }
      status = c.code; send(res, c.code, out, { ...cors, ...c.headers });
    } catch (e) {
      status = e instanceof HttpError ? e.code : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message }, { ...cors, ...(e.retry ? { 'retry-after': e.retry } : {}) });
    } finally {
      if (route) { const k = `method="${req.method}",route="${route.p}",status="${status}"`; metrics.req.set(k, (metrics.req.get(k) || 0) + 1); }
    }
  });

  return { server, db, tick, close() { clearInterval(timer); clearInterval(keepAlive); for (const m of [sdkStreams, adminStreams]) for (const s of m.values()) for (const r of s) r.end(); server.close(); server.closeAllConnections?.(); db.close(); } };
}
module.exports = { createApp };
