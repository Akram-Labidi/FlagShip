const test = require('node:test'), assert = require('node:assert');
const { evaluate, fnv1a } = require('../sdk/engine');
const base = { key: 'f', enabled: true, kill: false, rollout: 100, rules: [], excludes: [], variants: [] };

test('fnv1a is stable', () => assert.strictEqual(fnv1a('hello'), 1335831723));
test('deterministic per user', () => {
  const c = { ...base, rollout: 30 };
  for (let i = 0; i < 50; i++) assert.deepStrictEqual(evaluate(c, { id: 'u' + i }), evaluate(c, { id: 'u' + i }));
});
test('rollout percentage is roughly respected', () => {
  const c = { ...base, rollout: 25 }; let n = 0;
  for (let i = 0; i < 4000; i++) if (evaluate(c, { id: 'user-' + i }).enabled) n++;
  assert.ok(n > 800 && n < 1200, 'got ' + n);
});
test('increasing rollout never removes users', () => {
  for (let i = 0; i < 500; i++) {
    const u = { id: 'x' + i };
    if (evaluate({ ...base, rollout: 10 }, u).enabled) assert.ok(evaluate({ ...base, rollout: 50 }, u).enabled);
  }
});
test('rules, exclusions, kill switch, disabled', () => {
  const c = { ...base, rules: [{ attr: 'country', op: 'eq', value: 'Tunisia' }], excludes: [{ attr: 'type', op: 'eq', value: 'internal-test' }] };
  assert.ok(evaluate(c, { id: 1, country: 'tunisia' }).enabled);
  assert.strictEqual(evaluate(c, { id: 1, country: 'France' }).reason, 'rule_mismatch:country');
  assert.strictEqual(evaluate(c, { id: 1, country: 'Tunisia', type: 'internal-test' }).reason, 'excluded:type');
  assert.strictEqual(evaluate({ ...c, kill: true }, { id: 1, country: 'Tunisia' }).reason, 'kill_switch');
  assert.strictEqual(evaluate({ ...c, enabled: false }, { id: 1, country: 'Tunisia' }).reason, 'disabled');
});
test('date and numeric operators', () => {
  const c = { ...base, rules: [{ attr: 'created_at', op: 'after', value: '2025-01-01' }, { attr: 'age', op: 'gte', value: 18 }] };
  assert.ok(evaluate(c, { id: 1, created_at: '2025-06-01', age: 30 }).enabled);
  assert.ok(!evaluate(c, { id: 1, created_at: '2024-06-01', age: 30 }).enabled);
});
test('variants split by weight', () => {
  const c = { ...base, variants: [{ key: 'control', weight: 50 }, { key: 'new', weight: 50 }] }; const n = { control: 0, new: 0 };
  for (let i = 0; i < 4000; i++) n[evaluate(c, { id: 'u' + i }).variant]++;
  assert.ok(Math.abs(n.control - 2000) < 200, JSON.stringify(n));
});
