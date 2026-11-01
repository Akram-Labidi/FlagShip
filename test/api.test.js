const test = require('node:test'), assert = require('node:assert');
const { createApp } = require('../server/app');
const { Flagship } = require('../sdk/js');

let app, base, admin, sdkKey;
const call = async (method, path, body, token = admin) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
};
test.before(async () => {
  app = createApp({ dbFile: ':memory:', tickMs: 60000, rateLimit: 100000, authLimit: 1000 });
  await new Promise(r => app.server.listen(0, r)); base = 'http://localhost:' + app.server.address().port;
});
test.after(() => app.close());

test('register, environments, flag creation', async () => {
  const r = await call('POST', '/api/auth/register', { orgName: 'Bank', email: 'a@bank.tn', password: 'password1' }, null);
  assert.strictEqual(r.status, 201); admin = r.body.token;
  const envs = (await call('GET', '/api/environments')).body;
  assert.deepStrictEqual(envs.map(e => e.key), ['development', 'staging', 'production']);
  assert.ok(envs[2].require_approval); sdkKey = envs[0].sdk_key;
  assert.strictEqual((await call('POST', '/api/flags', { key: 'international_transfers' })).status, 201);
  assert.strictEqual((await call('POST', '/api/flags', { key: 'international_transfers' })).status, 409);
  assert.strictEqual((await call('POST', '/api/flags', { key: 'Bad Key' })).status, 400);
});

test('versioning and restore', async () => {
  const cfg = { enabled: true, rollout: 5, rules: [{ attr: 'country', op: 'eq', value: 'Tunisia' }] };
  let r = await call('PUT', '/api/flags/international_transfers/environments/development', { config: cfg, reason: 'start' });
  assert.strictEqual(r.body.status, 'applied');
  await call('PUT', '/api/flags/international_transfers/environments/development', { config: { ...cfg, rollout: 25 } });
  const v = (await call('GET', '/api/flags/international_transfers/environments/development/versions')).body;
  assert.strictEqual(v.length, 2); assert.match(v[0].summary, /rollout 5% to 25%/);
  await call('POST', '/api/flags/international_transfers/environments/development/restore', { version: 2 });
  const f = (await call('GET', '/api/flags')).body[0].environments.development;
  assert.strictEqual(f.rollout, 5); assert.strictEqual(f.version, 4);
});

test('roles and approval workflow', async () => {
  await call('POST', '/api/users', { email: 'dev@bank.tn', password: 'password1', role: 'developer' });
  await call('POST', '/api/users', { email: 'rm@bank.tn', password: 'password1', role: 'release_manager' });
  await call('POST', '/api/users', { email: 'v@bank.tn', password: 'password1', role: 'viewer' });
  const login = async e => (await call('POST', '/api/auth/login', { email: e, password: 'password1' }, null)).body.token;
  const [dev, rm, viewer] = [await login('dev@bank.tn'), await login('rm@bank.tn'), await login('v@bank.tn')];
  const url = '/api/flags/international_transfers/environments/production';
  const cfg = { enabled: true, rollout: 10 };
  assert.strictEqual((await call('PUT', url, { config: cfg }, viewer)).status, 403);
  assert.strictEqual((await call('PUT', url, { config: cfg }, dev)).status, 400); // reason required
  const req = await call('PUT', url, { config: cfg, reason: 'launch' }, dev);
  assert.strictEqual(req.body.status, 'pending_approval');
  assert.strictEqual((await call('GET', '/api/flags')).body[0].environments.production.enabled, false);
  assert.strictEqual((await call('POST', `/api/change-requests/${req.body.requestId}/approve`, {}, dev)).status, 403);
  assert.strictEqual((await call('POST', `/api/change-requests/${req.body.requestId}/approve`, {}, rm)).status, 200);
  assert.strictEqual((await call('GET', '/api/flags')).body[0].environments.production.rollout, 10);
  // kill switch bypasses approval
  assert.strictEqual((await call('POST', url + '/kill', { reason: 'errors' }, dev)).body.status, 'applied');
  assert.strictEqual((await call('GET', '/api/flags')).body[0].environments.production.kill, true);
  const log = (await call('GET', '/api/audit')).body; assert.ok(log.some(a => a.action === 'approve') && log.some(a => a.action === 'kill'));
});

test('SDK: local evaluation, live update, offline cache, analytics, experiments', async () => {
  const cacheFile = '/tmp/flagship-test-cache.json'; try { require('fs').unlinkSync(cacheFile); } catch {}
  await call('POST', '/api/flags', { key: 'checkout' });
  await call('PUT', '/api/flags/checkout/environments/development', { config: { enabled: true, rollout: 100, variants: [{ key: 'control', weight: 50 }, { key: 'new', weight: 50 }] } });
  const sdk = await new Flagship({ sdkKey, baseUrl: base, cacheFile, flushInterval: 100000 }).init();
  assert.ok(sdk.isEnabled('international_transfers', { id: 'u1', country: 'Tunisia' }) in { true: 1, false: 1 });
  assert.strictEqual(sdk.isEnabled('international_transfers', { id: 'u1', country: 'France' }), false);
  // live update through the stream
  let changed = new Promise(r => (sdk.onChange = r));
  await call('PUT', '/api/flags/international_transfers/environments/development', { config: { enabled: true, rollout: 100 } });
  await Promise.race([changed, new Promise((_, no) => setTimeout(() => no(new Error('no live update')), 3000))]);
  assert.strictEqual(sdk.isEnabled('international_transfers', { id: 'u1', country: 'France' }), true);
  // experiment traffic
  for (let i = 0; i < 600; i++) { const u = { id: 'e' + i }; const v = sdk.variation('checkout', u); if (v === 'new' ? i % 3 === 0 : i % 6 === 0) sdk.track(u.id, 'purchase'); }
  await sdk.flush();
  const an = (await call('GET', '/api/analytics/checkout/development')).body; assert.strictEqual(an.total, 600);
  const ex = (await call('GET', '/api/experiments/checkout/development?metric=purchase')).body;
  const nu = ex.variants.find(v => v.variant === 'new'); assert.ok(nu.rate > ex.variants.find(v => v.variant === 'control').rate); assert.ok(nu.pValue < 0.05);
  await sdk.close();
  // offline: server unreachable, SDK starts from disk cache
  const offline = await new Flagship({ sdkKey, baseUrl: 'http://localhost:1', cacheFile, stream: false }).init();
  assert.ok(offline.ready && offline.fromCache && offline.offline); assert.strictEqual(offline.isEnabled('international_transfers', { id: 'u1' }), true);
  await offline.close();
});

test('scheduled rollout', async () => {
  await call('POST', '/api/flags', { key: 'sched' });
  const at = new Date(Date.now() + 300).toISOString();
  assert.strictEqual((await call('POST', '/api/flags/sched/environments/development/schedules', { run_at: at, patch: { enabled: true, rollout: 40 } })).status, 201);
  await new Promise(r => setTimeout(r, 400)); app.tick();
  const f = (await call('GET', '/api/flags')).body.find(x => x.key === 'sched').environments.development;
  assert.ok(f.enabled && f.rollout === 40);
});

test('rate limiting and auth', async () => {
  assert.strictEqual((await call('GET', '/api/flags', null, 'bad')).status, 401);
  assert.strictEqual((await fetch(base + '/sdk/v1/config')).status, 401);
  const lim = createApp({ dbFile: ':memory:', authLimit: 2 }); await new Promise(r => lim.server.listen(0, r));
  const u = 'http://localhost:' + lim.server.address().port + '/api/auth/login'; let last;
  for (let i = 0; i < 4; i++) last = (await fetch(u, { method: 'POST', body: '{}' })).status;
  assert.strictEqual(last, 429); lim.close();
});
