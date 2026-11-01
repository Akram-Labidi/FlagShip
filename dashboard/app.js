'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const OPS = { eq: 'is', neq: 'is not', in: 'is one of', nin: 'is not one of', contains: 'contains', gt: '>', gte: '>=', lt: '<', lte: '<=', after: 'is after', before: 'is before', exists: 'exists' };
const TABS = [['flags', 'Feature flags'], ['approvals', 'Approvals'], ['experiments', 'Experiments'], ['playground', 'Playground'], ['audit', 'Audit log'], ['settings', 'Settings']];
const ROLE = { admin: 'Administrator', developer: 'Developer', release_manager: 'Release manager', viewer: 'Viewer' };
const S = { token: localStorage.getItem('fs_token'), tab: 'flags', env: localStorage.getItem('fs_env') || 'production', q: '', flags: [], envs: [], reqs: [], audit: [], users: [], hooks: [], open: null, draft: null, detail: {}, authMode: 'login', exp: {}, pg: { id: 'user-1042', country: 'Tunisia', plan: 'premium', platform: 'Android', type: 'customer' }, pgOut: null };
const can = (...r) => r.includes(S.user?.role);
const writer = () => can('admin', 'developer', 'release_manager');
const E = () => S.envs.find(e => e.key === S.env) || S.envs[0];

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); const d = t ? JSON.parse(t) : null;
  if (r.status === 401 && S.token) { signOut(); throw new Error('Your session expired. Sign in again.'); }
  if (!r.ok) throw new Error(d?.error || 'Request failed');
  return d;
}
let tt; function toast(m, err) { const t = $('#toast'); t.textContent = m; t.className = err ? 'er' : ''; t.style.display = 'block'; clearTimeout(tt); tt = setTimeout(() => (t.style.display = 'none'), 3500); }
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function ask(title, { reason = false, required = false, fields = [], ok = 'Confirm' } = {}) {
  return new Promise(res => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog"><h1 style="font-size:18px">${esc(title)}</h1>${fields.map((f, i) => `<div class="fld"><label>${esc(f.label)}</label>${f.options ? `<select name="f${i}">${f.options.map(o => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select>` : `<input name="f${i}" type="${f.type || 'text'}" ${f.value ? `value="${esc(f.value)}"` : ''}>`}</div>`).join('')}
    ${reason ? `<div class="fld"><label>Reason${required ? '' : ' (optional)'}</label><textarea name="reason" placeholder="Why are you making this change?"></textarea></div>` : ''}
    <div class="row" style="justify-content:flex-end"><button class="btn" value="x" formnovalidate>Cancel</button><button class="btn pri" value="ok">${esc(ok)}</button></div></form>`;
    d.onclose = () => { if (d.returnValue !== 'ok') return res(null); const f = new FormData(d.querySelector('form')); const out = { reason: (f.get('reason') || '').trim(), values: fields.map((_, i) => f.get('f' + i)) };
      if (required && !out.reason) { toast('Add a reason first.', true); return res(null); } res(out); };
    d.returnValue = ''; d.showModal();
  });
}
function signOut() { localStorage.removeItem('fs_token'); S.token = null; S.user = null; S.es?.close(); render(); }

async function boot() {
  if (!S.token) return render();
  try {
    const me = await api('/api/me'); S.user = me.user; S.org = me.org;
    S.envs = await api('/api/environments'); if (!S.envs.some(e => e.key === S.env)) S.env = S.envs[0].key;
    connect(); await load(); render();
  } catch (e) { render(); }
}
function connect() {
  S.es?.close(); S.es = new EventSource('/api/stream?token=' + encodeURIComponent(S.token));
  S.es.addEventListener('change', run(async ev => { const d = JSON.parse(ev.data); if (d.user !== S.user.email) toast(`${d.user}: ${d.summary}${d.flag ? ' (' + d.flag + ')' : ''}`); await load(); render(true); }));
}
async function load() {
  const t = S.tab;
  const [flags, reqs] = await Promise.all([api('/api/flags'), api('/api/change-requests')]); S.flags = flags; S.reqs = reqs;
  if (t === 'audit') S.audit = await api('/api/audit');
  if (t === 'settings') { S.envs = await api('/api/environments'); S.users = await api('/api/users'); S.hooks = can('admin') ? await api('/api/webhooks') : []; }
  if (S.open) await loadDetail();
}
async function loadDetail() {
  const f = S.open, p = `/api/flags/${f}/environments/${S.env}`;
  const [versions, schedules, analytics] = await Promise.all([api(p + '/versions'), api(p + '/schedules'), api(`/api/analytics/${f}/${S.env}`)]);
  S.detail = { versions, schedules, analytics };
}

// ---------- views ----------
function render(soft) {
  const app = $('#app');
  if (!S.user) return (app.innerHTML = authView());
  const pend = S.reqs.filter(r => r.status === 'pending').length;
  const active = document.activeElement?.id;
  app.innerHTML = `<header><div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/></svg>Flagship</div><span class="mut">${esc(S.org?.name)}</span><span class="sp"></span>
   <label class="mut">Environment <select onchange="A.setEnv(this.value)">${S.envs.map(e => `<option value="${e.key}" ${e.key === S.env ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
   <span>${esc(S.user.name)} <span class="badge br">${ROLE[S.user.role]}</span></span><button class="btn" onclick="signOut()">Sign out</button></header>
   <nav>${TABS.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" onclick="A.tab('${k}')">${l}${k === 'approvals' && pend ? ` <span class="badge wr">${pend}</span>` : ''}</button>`).join('')}</nav>
   <main>${{ flags: flagsView, approvals: approvalsView, experiments: expView, playground: pgView, audit: auditView, settings: settingsView }[S.tab]()}</main>${S.open ? drawer() : ''}`;
  if (active) $('#' + active)?.focus();
}
function authView() {
  const reg = S.authMode === 'register';
  return `<div class="auth"><div class="logo" style="margin-bottom:16px;font-size:20px">Flagship</div><div class="card pad"><h1>${reg ? 'Create your organization' : 'Sign in'}</h1><p class="sub">Release features gradually and switch them off instantly.</p>
  <form onsubmit="A.auth(event)">${reg ? '<div class="fld"><label>Organization</label><input name="orgName" required></div><div class="fld"><label>Your name</label><input name="name"></div>' : ''}
  <div class="fld"><label>Email</label><input name="email" type="email" required></div><div class="fld"><label>Password</label><input name="password" type="password" minlength="${reg ? 8 : 1}" required></div>
  <button class="btn pri" style="width:100%">${reg ? 'Create account' : 'Sign in'}</button></form>
  <p class="mut" style="margin-top:12px">${reg ? 'Already have an account?' : 'New here?'} <a href="#" onclick="A.mode('${reg ? 'login' : 'register'}');return false">${reg ? 'Sign in' : 'Create an organization'}</a></p></div></div>`;
}
function status(c) { if (c.kill) return '<span class="badge er">Killed</span>'; if (!c.enabled) return '<span class="badge">Off</span>'; if (c.variants.length) return '<span class="badge br">Experiment</span>'; return c.rollout === 100 && !c.rules.length ? '<span class="badge ok">On for everyone</span>' : '<span class="badge br">Gradual</span>'; }
function flagsView() {
  const e = E(), list = S.flags.filter(f => (f.key + f.name + f.description).toLowerCase().includes(S.q.toLowerCase()));
  return `<h1>Feature flags</h1><p class="sub">Settings for ${esc(e.name)}. Changes reach connected apps within a second, with no redeploy.</p>
  ${e.require_approval ? '<div class="msg">This environment requires approval. A developer\'s changes go to a release manager first. Kill switches always apply immediately.</div>' : ''}
  <div class="bar"><input id="q" type="text" placeholder="Search flags" value="${esc(S.q)}" oninput="S.q=this.value;render()" aria-label="Search flags"><span class="sp"></span><button class="btn pri" ${writer() ? '' : 'disabled'} onclick="A.newFlag()">New flag</button></div>
  <div class="card wrap"><table><thead><tr><th>On</th><th>Flag</th><th>Status</th><th>Rollout</th><th>Rules</th><th>Version</th></tr></thead><tbody>${list.map(f => { const c = f.environments[S.env]; return `<tr class="clk" onclick="A.openFlag('${f.key}')">
   <td onclick="event.stopPropagation()"><button class="sw ${c.enabled && !c.kill ? 'on' : ''}" ${writer() ? '' : 'disabled'} role="switch" aria-checked="${c.enabled}" aria-label="Toggle ${f.key}" onclick="A.quick('${f.key}')"></button></td>
   <td><code>${esc(f.key)}</code><div class="mut">${esc(f.description)}</div></td><td>${status(c)}</td><td style="min-width:120px">${c.rollout}%<div class="meter"><span style="width:${c.rollout}%"></span></div></td><td>${c.rules.length + c.excludes.length || 'None'}</td><td>v${c.version}</td></tr>`; }).join('') || '<tr><td colspan="6" class="mut">No flags yet. Create your first flag to start releasing gradually.</td></tr>'}</tbody></table></div>`;
}
function ruleRows(list, kind) {
  return list.map((r, i) => `<div class="row"><input type="text" value="${esc(r.attr)}" placeholder="attribute" style="width:120px" onchange="S.draft.${kind}[${i}].attr=this.value" aria-label="Attribute">
   <select onchange="S.draft.${kind}[${i}].op=this.value" aria-label="Operator">${Object.entries(OPS).map(([k, v]) => `<option value="${k}" ${k === r.op ? 'selected' : ''}>${v}</option>`).join('')}</select>
   <input type="text" value="${esc(Array.isArray(r.value) ? r.value.join(', ') : r.value)}" placeholder="value, or A, B" style="width:150px" onchange="S.draft.${kind}[${i}].value=this.value" aria-label="Value"><button class="btn" onclick="A.rm('${kind}',${i})">Remove</button></div>`).join('')
    || `<p class="mut">${kind === 'rules' ? 'No rules. Everyone is eligible for the rollout.' : 'No exclusions.'}</p>`;
}
function drawer() {
  const f = S.flags.find(x => x.key === S.open); if (!f) return ''; const d = S.draft, e = E(), dis = writer() ? '' : 'disabled', det = S.detail;
  const max = Math.max(1, ...(det.analytics?.hours || []).map(h => h.total));
  return `<div class="panel" onclick="if(event.target===this)A.close()"><div role="dialog" aria-label="${esc(f.key)}">
  <div class="bar"><h1 style="margin:0"><code>${esc(f.key)}</code></h1><span class="sp"></span><button class="btn" onclick="A.close()">Close</button></div>
  <p class="sub">${esc(f.description) || 'No description'} · ${esc(e.name)} · v${f.environments[S.env].version}</p>
  ${d.kill ? '<div class="msg er">The kill switch is on. This flag returns off for everyone.</div>' : ''}
  <div class="row"><button class="sw ${d.enabled ? 'on' : ''}" ${dis} role="switch" aria-checked="${d.enabled}" aria-label="Enabled" onclick="S.draft.enabled=!S.draft.enabled;render()"></button><b>${d.enabled ? 'Enabled' : 'Disabled'}</b><span class="sp"></span>
   <button class="btn dng" ${dis} onclick="A.kill('${f.key}',${!d.kill})">${d.kill ? 'Release kill switch' : 'Kill switch'}</button></div>
  <h2>Rollout: ${d.rollout}% of eligible users</h2><input type="range" min="0" max="100" step="1" value="${d.rollout}" ${dis} oninput="S.draft.rollout=+this.value;this.previousElementSibling.textContent='Rollout: '+this.value+'% of eligible users'" aria-label="Rollout">
  <div class="row">${[5, 25, 50, 100].map(p => `<button class="btn" ${dis} onclick="S.draft.rollout=${p};render()">${p}%</button>`).join('')}</div>
  <p class="mut">Each user is hashed with the flag key, so they always get the same answer, and raising the percentage never removes anyone.</p>
  <h2>Targeting rules (all must match)</h2>${ruleRows(d.rules, 'rules')}<button class="btn" ${dis} onclick="A.add('rules')">Add rule</button>
  <h2>Exclusions (any match turns the flag off)</h2>${ruleRows(d.excludes, 'excludes')}<button class="btn" ${dis} onclick="A.add('excludes')">Add exclusion</button>
  <h2>Variants for A/B testing</h2>${d.variants.map((v, i) => `<div class="row"><input type="text" value="${esc(v.key)}" style="width:150px" onchange="S.draft.variants[${i}].key=this.value" aria-label="Variant name"><input type="number" value="${v.weight}" min="0" style="width:80px" onchange="S.draft.variants[${i}].weight=+this.value" aria-label="Weight"><span class="mut">weight</span><button class="btn" onclick="A.rm('variants',${i})">Remove</button></div>`).join('') || '<p class="mut">No variants. This is a simple on/off flag.</p>'}
  <div class="row"><button class="btn" ${dis} onclick="A.add('variants')">Add variant</button>${d.variants.length ? '' : `<button class="btn" ${dis} onclick="A.ab()">Set up A/B test</button>`}</div>
  <div class="row" style="margin-top:16px"><button class="btn pri" ${dis} onclick="A.save('${f.key}')">${e.require_approval && can('developer') ? 'Request approval' : 'Save changes'}</button><button class="btn" onclick="A.reset()">Discard edits</button></div>
  <h2>Evaluations, last 24 hours: ${det.analytics?.total ?? 0}</h2><div class="chart" aria-hidden="true">${(det.analytics?.hours || []).map(h => `<i title="${h.total}" style="height:${h.total / max * 100}%"></i>`).join('')}</div>
  <p class="mut">${Object.entries(det.analytics?.totals || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || 'No evaluations reported yet. SDKs report counts every few seconds.'}</p>
  <h2>Scheduled changes</h2>${(det.schedules || []).map(s => `<div class="row"><span class="badge ${s.status === 'pending' ? 'wr' : ''}">${s.status}</span><span>${new Date(s.run_at).toLocaleString()}: ${esc(JSON.stringify(s.patch))}</span>${s.status === 'pending' ? `<button class="btn" onclick="A.unschedule(${s.id})">Cancel</button>` : ''}</div>`).join('') || '<p class="mut">Nothing scheduled.</p>'}
  <button class="btn" ${writer() && !(e.require_approval && can('developer')) ? '' : 'disabled'} onclick="A.schedule('${f.key}')">Schedule a change</button>
  <h2>Version history</h2>${(det.versions || []).map(v => `<div class="row"><span class="badge">v${v.version}</span><span style="flex:1">${esc(v.summary)}<div class="mut">${new Date(v.ts).toLocaleString()} · ${esc(v.user)}${v.reason ? ' · ' + esc(v.reason) : ''}</div></span><button class="btn" ${dis} onclick="A.restore('${f.key}',${v.version})">Restore</button></div>`).join('') || '<p class="mut">No changes yet.</p>'}
  ${can('admin') ? `<h2>Danger zone</h2><button class="btn dng" onclick="A.del('${f.key}')">Delete flag in all environments</button>` : ''}</div></div>`;
}
function approvalsView() {
  const p = S.reqs.filter(r => r.status === 'pending'), h = S.reqs.filter(r => r.status !== 'pending');
  const row = r => `<tr><td><code>${esc(r.flag)}</code><div class="mut">${esc(r.env)}</div></td><td>${esc(r.summary)}</td><td>${esc(r.requested_by)}<div class="mut">${esc(r.reason)}</div></td><td>${r.status === 'pending' ? `<button class="btn pri" ${can('admin', 'release_manager') ? '' : 'disabled'} onclick="A.decide(${r.id},'approve')">Approve</button> <button class="btn" ${can('admin', 'release_manager') ? '' : 'disabled'} onclick="A.decide(${r.id},'reject')">Reject</button>` : `<span class="badge ${r.status === 'approved' ? 'ok' : 'er'}">${r.status}</span> <span class="mut">${esc(r.decided_by)}</span>`}</td></tr>`;
  return `<h1>Approvals</h1><p class="sub">Production changes from developers wait here for a release manager.</p><div class="card wrap"><table><thead><tr><th>Flag</th><th>Change</th><th>Requested by</th><th></th></tr></thead><tbody>${p.map(row).join('') || '<tr><td colspan="4" class="mut">Nothing is waiting for approval.</td></tr>'}</tbody></table></div>
  ${h.length ? `<h2>Recent decisions</h2><div class="card wrap"><table><tbody>${h.slice(0, 20).map(row).join('')}</tbody></table></div>` : ''}`;
}
function expView() {
  const fl = S.flags.filter(f => f.environments[S.env].variants.length), x = S.exp;
  if (!x.flag || !fl.some(f => f.key === x.flag)) x.flag = fl[0]?.key;
  const r = x.res;
  return `<h1>Experiments</h1><p class="sub">Compare variants of a flag in ${esc(E().name)}. Call <code>sdk.variation()</code> to assign users and <code>sdk.track()</code> to record conversions.</p>
  ${!fl.length ? '<div class="card pad mut">No experiments yet. Open a flag, choose "Set up A/B test", and save it.</div>' : `<div class="bar"><select onchange="S.exp.flag=this.value;S.exp.res=null;A.runExp()" aria-label="Flag">${fl.map(f => `<option ${f.key === x.flag ? 'selected' : ''}>${esc(f.key)}</option>`).join('')}</select>
  <input type="text" id="metric" placeholder="Conversion metric, e.g. purchase" value="${esc(x.metric || '')}" style="width:260px" onchange="S.exp.metric=this.value"><button class="btn pri" onclick="S.exp.metric=$('#metric').value;A.runExp()">Show results</button></div>
  ${r ? `<div class="card wrap"><table><thead><tr><th>Variant</th><th>Users</th><th>Converted</th><th>Conversion rate</th><th>Lift vs ${esc(r.control || 'control')}</th><th>p-value</th></tr></thead><tbody>${r.variants.map(v => `<tr><td><b>${esc(v.variant)}</b></td><td>${v.users}</td><td>${v.converters}</td><td style="min-width:180px"><div class="vbar"><div class="meter"><span style="width:${Math.min(100, v.rate * 100 * 3)}%"></span></div>${(v.rate * 100).toFixed(1)}%</div></td>
   <td>${v.lift == null ? '–' : (v.lift > 0 ? '+' : '') + (v.lift * 100).toFixed(1) + '%'}</td><td>${v.pValue == null ? '–' : v.pValue.toFixed(3) + (v.pValue < 0.05 ? ' <span class="badge ok">significant</span>' : '')}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No exposures recorded yet.</td></tr>'}</tbody></table></div><p class="mut">Known metrics: ${r.metrics.map(esc).join(', ') || 'none yet'}</p>` : ''}`}`;
}
function pgView() {
  const p = S.pg, f = (k, o) => `<div class="fld"><label>${k}</label>${o ? `<select onchange="S.pg.${k}=this.value">${o.map(v => `<option ${p[k] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>` : `<input type="text" value="${esc(p[k])}" onchange="S.pg.${k}=this.value">`}</div>`;
  return `<h1>Playground</h1><p class="sub">See what the engine returns for one user in ${esc(E().name)}.</p><div class="card pad"><div class="grid">${f('id')}${f('country', ['Tunisia', 'France', 'Germany', 'Egypt'])}${f('plan', ['premium', 'standard'])}${f('platform', ['Android', 'iOS', 'Web'])}${f('type', ['customer', 'internal-test'])}</div><button class="btn pri" onclick="A.play()">Evaluate</button></div>
  ${S.pgOut ? `<div class="card wrap"><table><thead><tr><th>Flag</th><th>Result</th><th>Variant</th><th>Reason</th></tr></thead><tbody>${Object.entries(S.pgOut).map(([k, r]) => `<tr><td><code>${esc(k)}</code></td><td class="res ${r.enabled ? 't' : 'f'}">${r.enabled}</td><td>${esc(r.variant)}</td><td class="mut">${esc(r.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
function auditView() {
  return `<h1>Audit log</h1><p class="sub">Every change, who made it, and why.</p><div class="card wrap"><table><thead><tr><th>When</th><th>Who</th><th>Flag</th><th>Environment</th><th>Change</th><th>Reason</th></tr></thead><tbody>${S.audit.map(a => `<tr><td style="white-space:nowrap">${new Date(a.ts).toLocaleString()}</td><td>${esc(a.user)}</td><td>${a.flag_key ? `<code>${esc(a.flag_key)}</code>` : ''}</td><td>${esc(a.env_key || '')}</td><td>${esc(a.summary)}</td><td class="mut">${esc(a.reason || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No activity yet.</td></tr>'}</tbody></table></div>`;
}
function settingsView() {
  const e = E(), adm = can('admin');
  return `<h1>Settings</h1><p class="sub">Environments, SDK keys, team and webhooks.</p>
  <div class="card pad"><h2 style="margin-top:0">Environments</h2>${S.envs.map(v => `<div class="row"><b style="width:120px">${esc(v.name)}</b><label><input type="checkbox" ${v.require_approval ? 'checked' : ''} ${adm ? '' : 'disabled'} onchange="A.approval('${v.key}',this.checked)"> Require approval</label>
   ${v.sdk_key ? `<code style="word-break:break-all">${esc(v.sdk_key)}</code><button class="btn" onclick="navigator.clipboard?.writeText('${v.sdk_key}');toast('SDK key copied')">Copy</button>${adm ? `<button class="btn" onclick="A.rotate('${v.key}')">Rotate</button>` : ''}` : ''}</div>`).join('')}${adm ? '<button class="btn" onclick="A.newEnv()">Add environment</button>' : ''}
   <h2>Connect an app</h2><pre>const { Flagship } = require('flagship-sdk');
const flags = await new Flagship({ sdkKey: '${esc(e.sdk_key || 'YOUR_SDK_KEY')}', baseUrl: '${location.origin}' }).init();
if (flags.isEnabled('international_transfers', { id: user.id, country: user.country })) { /* show the feature */ }</pre></div>
  <div class="card pad"><h2 style="margin-top:0">Team</h2><div class="wrap"><table><tbody>${S.users.map(u => `<tr><td>${esc(u.name)}<div class="mut">${esc(u.email)}</div></td><td>${adm && u.id !== S.user.id ? `<select onchange="A.role(${u.id},this.value)">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select> <button class="btn dng" onclick="A.rmUser(${u.id})">Remove</button>` : `<span class="badge br">${ROLE[u.role]}</span>`}</td></tr>`).join('')}</tbody></table></div>${adm ? '<button class="btn" onclick="A.addUser()">Add team member</button>' : ''}</div>
  ${adm ? `<div class="card pad"><h2 style="margin-top:0">Webhooks</h2><p class="mut">Receive a signed POST (x-flagship-signature, HMAC-SHA256) whenever a flag changes.</p>${S.hooks.map(h => `<div class="row"><code>${esc(h.url)}</code><button class="btn" onclick="A.rmHook(${h.id})">Remove</button></div>`).join('')}<button class="btn" onclick="A.addHook()">Add webhook</button></div>` : ''}`;
}

// ---------- actions ----------
const refresh = async keepOpen => { await load(); render(); };
const cfgOf = f => JSON.parse(JSON.stringify((({ enabled, kill, rollout, rules, excludes, variants }) => ({ enabled, kill, rollout, rules, excludes, variants }))(f.environments[S.env])));
const reqReason = () => E().require_approval && can('developer');
const A = {
  mode: m => { S.authMode = m; render(); },
  auth: run(async ev => { ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target)); const d = await api(S.authMode === 'register' ? '/api/auth/register' : '/api/auth/login', 'POST', f); S.token = d.token; localStorage.setItem('fs_token', d.token); await boot(); }),
  tab: run(async t => { S.tab = t; S.open = null; await load(); render(); }),
  setEnv: run(async k => { S.env = k; localStorage.setItem('fs_env', k); S.open = null; await load(); render(); }),
  newFlag: run(async () => { const r = await ask('New flag', { fields: [{ label: 'Key (letters, numbers, underscores)' }, { label: 'Description' }], ok: 'Create' }); if (!r) return; await api('/api/flags', 'POST', { key: r.values[0], description: r.values[1] }); toast('Created ' + r.values[0]); await refresh(); }),
  quick: run(async k => { const f = S.flags.find(x => x.key === k), c = cfgOf(f); c.enabled = !c.enabled; await A.submit(k, c, c.enabled ? 'Turn on ' + k : 'Turn off ' + k); }),
  submit: async (k, c, title) => { const r = await ask(title, { reason: true, required: reqReason(), ok: reqReason() ? 'Request approval' : 'Save' }); if (!r) return await refresh(); const d = await api(`/api/flags/${k}/environments/${S.env}`, 'PUT', { config: c, reason: r.reason }); toast(d.status === 'applied' ? 'Saved' : 'Sent for approval'); await refresh(); if (S.open) { S.draft = cfgOf(S.flags.find(x => x.key === k)); await loadDetail(); render(); } },
  openFlag: run(async k => { S.open = k; S.draft = cfgOf(S.flags.find(x => x.key === k)); await loadDetail(); render(); }),
  close: () => { S.open = null; render(); },
  reset: () => { S.draft = cfgOf(S.flags.find(x => x.key === S.open)); render(); },
  add: kind => { S.draft[kind].push(kind === 'variants' ? { key: '', weight: 50 } : { attr: '', op: 'eq', value: '' }); render(); },
  rm: (kind, i) => { S.draft[kind].splice(i, 1); render(); },
  ab: () => { S.draft.variants = [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }]; S.draft.rollout = 100; render(); },
  save: run(async k => A.submit(k, S.draft, 'Save changes to ' + k)),
  kill: run(async (k, on) => { const r = await ask(on ? 'Activate kill switch' : 'Release kill switch', { reason: true, ok: on ? 'Kill ' + k : 'Release' }); if (!r) return; await api(`/api/flags/${k}/environments/${S.env}/kill`, 'POST', { kill: on, reason: r.reason }); toast(on ? 'Kill switch activated' : 'Kill switch released'); await refresh(); S.draft = cfgOf(S.flags.find(x => x.key === k)); await loadDetail(); render(); }),
  restore: run(async (k, v) => { const r = await ask('Restore version ' + v, { reason: true, required: reqReason(), ok: 'Restore' }); if (!r) return; const d = await api(`/api/flags/${k}/environments/${S.env}/restore`, 'POST', { version: v, reason: r.reason }); toast(d.status === 'applied' ? 'Restored' : 'Sent for approval'); await refresh(); S.draft = cfgOf(S.flags.find(x => x.key === k)); await loadDetail(); render(); }),
  schedule: run(async k => { const r = await ask('Schedule a change', { reason: true, ok: 'Schedule', fields: [{ label: 'When', type: 'datetime-local' }, { label: 'Rollout %', type: 'number', value: '50' }, { label: 'Turn the flag', options: [['', 'Leave as is'], ['on', 'On'], ['off', 'Off']] }] }); if (!r) return;
    const patch = { rollout: +r.values[1] }; if (r.values[2]) patch.enabled = r.values[2] === 'on'; await api(`/api/flags/${k}/environments/${S.env}/schedules`, 'POST', { run_at: new Date(r.values[0]).toISOString(), patch, reason: r.reason }); toast('Scheduled'); await loadDetail(); render(); }),
  unschedule: run(async id => { await api('/api/schedules/' + id, 'DELETE'); await loadDetail(); render(); }),
  del: run(async k => { const r = await ask('Delete ' + k + '?', { reason: true, ok: 'Delete' }); if (!r) return; await api('/api/flags/' + k, 'DELETE', { reason: r.reason }); S.open = null; toast('Deleted'); await refresh(); }),
  decide: run(async (id, a) => { await api(`/api/change-requests/${id}/${a}`, 'POST', {}); toast(a === 'approve' ? 'Approved and released' : 'Rejected'); await refresh(); }),
  runExp: run(async () => { const x = S.exp; if (!x.flag) return render(); x.res = await api(`/api/experiments/${x.flag}/${S.env}?metric=${encodeURIComponent(x.metric || '')}`); render(); }),
  play: run(async () => { S.pgOut = await api('/api/evaluate', 'POST', { env: S.env, user: S.pg }); render(); }),
  approval: run(async (k, v) => { await api('/api/environments/' + k, 'PATCH', { require_approval: v }); S.envs = await api('/api/environments'); toast('Updated'); render(); }),
  rotate: run(async k => { if (!confirm('Rotate this key? Apps using the old key will stop receiving updates.')) return; await api(`/api/environments/${k}/rotate-key`, 'POST'); S.envs = await api('/api/environments'); render(); }),
  newEnv: run(async () => { const r = await ask('Add environment', { fields: [{ label: 'Key, e.g. qa' }, { label: 'Name' }], ok: 'Add' }); if (!r) return; await api('/api/environments', 'POST', { key: r.values[0], name: r.values[1] }); S.envs = await api('/api/environments'); render(); }),
  addUser: run(async () => { const r = await ask('Add team member', { ok: 'Add', fields: [{ label: 'Name' }, { label: 'Email', type: 'email' }, { label: 'Temporary password (8+ characters)', type: 'password' }, { label: 'Role', options: Object.entries(ROLE) }] }); if (!r) return; await api('/api/users', 'POST', { name: r.values[0], email: r.values[1], password: r.values[2], role: r.values[3] }); await refresh(); }),
  role: run(async (id, role) => { await api('/api/users/' + id, 'PATCH', { role }); toast('Role updated'); await refresh(); }),
  rmUser: run(async id => { if (!confirm('Remove this person?')) return; await api('/api/users/' + id, 'DELETE'); await refresh(); }),
  addHook: run(async () => { const r = await ask('Add webhook', { fields: [{ label: 'URL' }], ok: 'Add' }); if (!r) return; const d = await api('/api/webhooks', 'POST', { url: r.values[0] }); alert('Signing secret (shown once): ' + d.secret); await refresh(); }),
  rmHook: run(async id => { await api('/api/webhooks/' + id, 'DELETE'); await refresh(); }),
};
Object.assign(window, { A, S, signOut, render, toast, $ });
boot();
