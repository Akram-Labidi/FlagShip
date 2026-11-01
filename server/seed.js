'use strict';
// Creates a demo organization with the example flags from the brief. Run while the server is up.
const base = process.env.BASE_URL || 'http://localhost:3000';
const creds = { email: 'demo@flagship.dev', password: 'demo1234' };
const call = async (m, p, b, t) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b && JSON.stringify(b) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || r.status), { status: r.status }); return d;
};
(async () => {
  let auth;
  try { auth = await call('POST', '/api/auth/register', { orgName: 'Demo Bank', name: 'Demo Admin', ...creds }); }
  catch (e) { if (e.status !== 409) throw e; auth = await call('POST', '/api/auth/login', creds); }
  const t = auth.token, set = (k, env, config) => call('PUT', `/api/flags/${k}/environments/${env}`, { config, reason: 'Seed data' }, t);
  const existing = (await call('GET', '/api/flags', null, t)).map(f => f.key);
  const flags = [
    ['international_transfers', 'New international transfer flow', {
      development: { enabled: true, rollout: 100 }, staging: { enabled: true, rollout: 50 },
      production: { enabled: true, rollout: 10, rules: [{ attr: 'country', op: 'eq', value: 'Tunisia' }], excludes: [{ attr: 'type', op: 'eq', value: 'internal-test' }] } }],
    ['new_dashboard', 'Redesigned account dashboard', { development: { enabled: true, rollout: 100 }, staging: { enabled: true, rollout: 100 }, production: { enabled: true, rollout: 50 } }],
    ['dark_mode', 'Dark theme in the mobile app', { development: { enabled: true }, staging: { enabled: true }, production: { enabled: true, rules: [{ attr: 'platform', op: 'in', value: 'Android, iOS' }] } }],
    ['new_payment_system', 'Payment interface v2', { development: { enabled: true }, staging: { enabled: true, rollout: 20 }, production: { enabled: false, rollout: 0 } }],
    ['checkout_redesign', 'A/B test of the new checkout', { development: { enabled: true, rollout: 100, variants: [{ key: 'control', weight: 50 }, { key: 'new_checkout', weight: 50 }] } }],
  ];
  for (const [key, description, envs] of flags) {
    if (!existing.includes(key)) await call('POST', '/api/flags', { key, description }, t);
    for (const [env, cfg] of Object.entries(envs)) await set(key, env, cfg);
  }
  const envs = await call('GET', '/api/environments', null, t);
  console.log(`Seeded. Sign in at ${base} with ${creds.email} / ${creds.password}\n`);
  for (const e of envs) console.log(`${e.name.padEnd(12)} SDK key: ${e.sdk_key}`);
})().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
