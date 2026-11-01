'use strict';
// Flagship JavaScript SDK. Evaluates flags locally from a cached config, so no request is needed per check.
// Config is refreshed by streaming (instant) with polling as a fallback, and cached on disk for offline starts.
const fs = require('node:fs');
const { evaluate } = require('../engine');

class Flagship {
  constructor({ sdkKey, baseUrl = 'http://localhost:3000', pollInterval = 30000, flushInterval = 10000, cacheFile = '.flagship-cache.json', stream = true, onChange } = {}) {
    if (!sdkKey) throw new Error('sdkKey is required');
    Object.assign(this, { sdkKey, baseUrl: baseUrl.replace(/\/$/, ''), pollInterval, flushInterval, cacheFile, useStream: stream, onChange });
    this.flags = {}; this.rev = null; this.ready = false; this.offline = false;
    this.counts = new Map(); this.exposures = new Map(); this.conversions = []; this.seen = new Set();
    this.abort = null; this.timers = [];
  }

  async init() {
    await this.refresh();
    if (!this.ready) this._loadCache();
    this.timers.push(setInterval(() => this.refresh(), this.pollInterval), setInterval(() => this.flush(), this.flushInterval));
    if (this.useStream) this._stream();
    for (const t of this.timers) t.unref?.();
    return this;
  }

  async refresh() {
    try {
      const res = await fetch(this.baseUrl + '/sdk/v1/config', { headers: { 'x-sdk-key': this.sdkKey, ...(this.rev ? { 'if-none-match': `"${this.rev}"` } : {}) } });
      if (res.status === 304) { this.offline = false; return false; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const changed = this.rev !== null && data.rev !== this.rev;
      this.flags = data.flags; this.rev = data.rev; this.ready = true; this.offline = false;
      this._saveCache(data);
      if (changed && this.onChange) this.onChange(Object.keys(this.flags));
      return true;
    } catch { this.offline = true; return false; }
  }

  async _stream() {
    let wait = 1000;
    while (this.useStream && !this.closed) {
      try {
        this.abort = new AbortController();
        const res = await fetch(this.baseUrl + '/sdk/v1/stream', { headers: { 'x-sdk-key': this.sdkKey }, signal: this.abort.signal });
        if (!res.ok) throw new Error('stream ' + res.status);
        wait = 1000; let buf = '';
        const dec = new TextDecoder();
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) { const msg = buf.slice(0, i); buf = buf.slice(i + 2); if (msg.includes('event: update')) this.refresh(); }
        }
      } catch { /* reconnect below */ }
      if (this.closed) return;
      await new Promise(r => { const t = setTimeout(r, wait); t.unref?.(); }); wait = Math.min(wait * 2, 30000);
    }
  }

  _saveCache(data) { if (this.cacheFile) try { fs.writeFileSync(this.cacheFile, JSON.stringify(data)); } catch {} }
  _loadCache() {
    try { const d = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); this.flags = d.flags; this.rev = d.rev; this.ready = true; this.fromCache = true; } catch {}
  }

  // Full result: { enabled, variant, reason }
  evaluate(key, user) {
    const r = evaluate(this.flags[key], user);
    const k = key + '\u0000' + r.variant; this.counts.set(k, (this.counts.get(k) || 0) + 1);
    const cfg = this.flags[key];
    if (cfg && cfg.variants?.length && r.enabled && user?.id != null) {
      const ek = key + '\u0000' + user.id;
      if (!this.seen.has(ek) && this.seen.size < 50000) { this.seen.add(ek); this.exposures.set(ek, { flag: key, variant: r.variant, userId: String(user.id) }); }
    }
    return r;
  }
  isEnabled(key, user, fallback = false) { return this.flags[key] ? this.evaluate(key, user).enabled : fallback; }
  variation(key, user, fallback = null) { return this.flags[key] ? this.evaluate(key, user).variant : fallback; }
  track(userId, metric, value = 1) { this.conversions.push({ userId: String(userId), metric, value }); }

  async flush() {
    if (!this.counts.size && !this.exposures.size && !this.conversions.length) return;
    const body = {
      evaluations: [...this.counts].map(([k, count]) => { const [flag, variant] = k.split('\u0000'); return { flag, variant, count }; }),
      exposures: [...this.exposures.values()], conversions: this.conversions,
    };
    this.counts = new Map(); this.exposures = new Map(); this.conversions = [];
    try {
      const res = await fetch(this.baseUrl + '/sdk/v1/events', { method: 'POST', headers: { 'x-sdk-key': this.sdkKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error();
    } catch { // keep for the next attempt
      for (const e of body.evaluations) this.counts.set(e.flag + '\u0000' + e.variant, (this.counts.get(e.flag + '\u0000' + e.variant) || 0) + e.count);
      for (const e of body.exposures) this.exposures.set(e.flag + '\u0000' + e.userId, e);
      this.conversions.push(...body.conversions);
    }
  }

  async close() { this.closed = true; this.abort?.abort(); this.timers.forEach(clearInterval); await this.flush(); }
}
module.exports = { Flagship };
