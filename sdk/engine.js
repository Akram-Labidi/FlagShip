'use strict';
// Flagship evaluation engine. Used by the server (remote evaluation) and by the SDK (local evaluation).
// Pure functions, no I/O, so results are identical everywhere. The Python SDK ports the same algorithm.

function fnv1a(str) {
  let h = 2166136261;
  const bytes = Buffer.from(String(str), 'utf8');
  for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// Deterministic bucket in [0, 100) with two decimals. Same user + flag always gives the same bucket.
function bucket(userId, flagKey, salt = '') {
  return (fnv1a(flagKey + ':' + userId + salt) % 10000) / 100;
}

function getAttr(user, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), user);
}

const list = v => Array.isArray(v) ? v.map(String) : String(v).split(',').map(s => s.trim());
const low = v => String(v).toLowerCase();

function matches(cond, user) {
  const a = getAttr(user, cond.attr), v = cond.value, has = a !== undefined && a !== null;
  switch (cond.op) {
    case 'exists': return has;
    case 'eq': return has && low(a) === low(v);
    case 'neq': return !has || low(a) !== low(v);
    case 'in': return has && list(v).map(low).includes(low(a));
    case 'nin': return !has || !list(v).map(low).includes(low(a));
    case 'contains': return has && low(a).includes(low(v));
    case 'gt': return has && Number(a) > Number(v);
    case 'gte': return has && Number(a) >= Number(v);
    case 'lt': return has && Number(a) < Number(v);
    case 'lte': return has && Number(a) <= Number(v);
    case 'before': return has && Date.parse(a) < Date.parse(v);
    case 'after': return has && Date.parse(a) > Date.parse(v);
    default: return false;
  }
}

const OFF = reason => ({ enabled: false, variant: 'off', reason });

// cfg: { key, enabled, kill, rollout, rules[], excludes[], variants[{key,weight}] }
function evaluate(cfg, user) {
  if (!cfg) return OFF('flag_not_found');
  user = user || {};
  if (cfg.kill) return OFF('kill_switch');
  if (!cfg.enabled) return OFF('disabled');
  for (const ex of cfg.excludes || []) if (matches(ex, user)) return OFF('excluded:' + ex.attr);
  for (const r of cfg.rules || []) if (!matches(r, user)) return OFF('rule_mismatch:' + r.attr);
  const id = user.id ?? user.key ?? '';
  const rollout = cfg.rollout ?? 100;
  const b = bucket(id, cfg.key);
  if (rollout < 100 && b >= rollout) return OFF('outside_rollout');
  const vs = cfg.variants || [];
  if (!vs.length) return { enabled: true, variant: 'on', reason: 'rollout' };
  const total = vs.reduce((s, v) => s + (Number(v.weight) || 0), 0);
  if (total <= 0) return { enabled: true, variant: vs[0].key, reason: 'rollout' };
  const pick = bucket(id, cfg.key, ':variant') / 100 * total;
  let acc = 0;
  for (const v of vs) { acc += Number(v.weight) || 0; if (pick < acc) return { enabled: true, variant: v.key, reason: 'rollout' }; }
  return { enabled: true, variant: vs[vs.length - 1].key, reason: 'rollout' };
}

const OPS = ['eq', 'neq', 'in', 'nin', 'contains', 'gt', 'gte', 'lt', 'lte', 'before', 'after', 'exists'];
module.exports = { fnv1a, bucket, matches, evaluate, OPS };
