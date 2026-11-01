"""Flagship Python SDK: local flag evaluation, polling refresh, disk cache for offline starts.
No third-party dependencies. Evaluation matches the JavaScript engine exactly."""
import json, threading, time, urllib.request, urllib.error
from datetime import datetime

def fnv1a(s):
    h = 2166136261
    for b in str(s).encode("utf-8"):
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h

def bucket(user_id, flag_key, salt=""):
    return (fnv1a(flag_key + ":" + str(user_id) + salt) % 10000) / 100

def _attr(user, path):
    cur = user
    for k in str(path).split("."):
        if not isinstance(cur, dict) or k not in cur or cur[k] is None:
            return None
        cur = cur[k]
    return cur

def _s(v):
    if isinstance(v, bool): return str(v).lower()
    if isinstance(v, float) and v.is_integer(): return str(int(v)).lower()
    return str(v).lower()

def _list(v):
    return [_s(x) for x in v] if isinstance(v, list) else [x.strip().lower() for x in str(v).split(",")]

def _num(v):
    try: return float(v)
    except (TypeError, ValueError): return float("nan")

def _date(v):
    try: return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError: return float("nan")

def matches(cond, user):
    a, v, op = _attr(user, cond["attr"]), cond.get("value"), cond["op"]
    has = a is not None
    if op == "exists": return has
    if op == "eq": return has and _s(a) == _s(v)
    if op == "neq": return (not has) or _s(a) != _s(v)
    if op == "in": return has and _s(a) in _list(v)
    if op == "nin": return (not has) or _s(a) not in _list(v)
    if op == "contains": return has and _s(v) in _s(a)
    if op == "gt": return has and _num(a) > _num(v)
    if op == "gte": return has and _num(a) >= _num(v)
    if op == "lt": return has and _num(a) < _num(v)
    if op == "lte": return has and _num(a) <= _num(v)
    if op == "before": return has and _date(a) < _date(v)
    if op == "after": return has and _date(a) > _date(v)
    return False

def _off(reason): return {"enabled": False, "variant": "off", "reason": reason}

def evaluate(cfg, user):
    if not cfg: return _off("flag_not_found")
    user = user or {}
    if cfg.get("kill"): return _off("kill_switch")
    if not cfg.get("enabled"): return _off("disabled")
    for ex in cfg.get("excludes") or []:
        if matches(ex, user): return _off("excluded:" + ex["attr"])
    for r in cfg.get("rules") or []:
        if not matches(r, user): return _off("rule_mismatch:" + r["attr"])
    uid = user.get("id", user.get("key", ""))
    rollout = cfg.get("rollout", 100)
    if rollout < 100 and bucket(uid, cfg["key"]) >= rollout: return _off("outside_rollout")
    vs = cfg.get("variants") or []
    if not vs: return {"enabled": True, "variant": "on", "reason": "rollout"}
    total = sum(float(v.get("weight") or 0) for v in vs)
    if total <= 0: return {"enabled": True, "variant": vs[0]["key"], "reason": "rollout"}
    pick, acc = bucket(uid, cfg["key"], ":variant") / 100 * total, 0
    for v in vs:
        acc += float(v.get("weight") or 0)
        if pick < acc: return {"enabled": True, "variant": v["key"], "reason": "rollout"}
    return {"enabled": True, "variant": vs[-1]["key"], "reason": "rollout"}


class Flagship:
    def __init__(self, sdk_key, base_url="http://localhost:3000", poll_interval=15, flush_interval=10, cache_file=".flagship-cache.json"):
        self.sdk_key, self.base, self.poll, self.flush_every, self.cache_file = sdk_key, base_url.rstrip("/"), poll_interval, flush_interval, cache_file
        self.flags, self.rev, self.ready, self.offline, self.from_cache = {}, None, False, False, False
        self._counts, self._exposures, self._conversions, self._lock = {}, {}, [], threading.Lock()
        self._stop = threading.Event()

    def init(self):
        self.refresh()
        if not self.ready: self._load_cache()
        threading.Thread(target=self._loop, daemon=True).start()
        return self

    def _req(self, path, body=None, headers=None):
        h = {"x-sdk-key": self.sdk_key, "content-type": "application/json", **(headers or {})}
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method="POST" if body is not None else "GET")
        return urllib.request.urlopen(req, timeout=5)

    def refresh(self):
        try:
            with self._req("/sdk/v1/config", headers={"if-none-match": '"%s"' % self.rev} if self.rev else None) as r:
                data = json.load(r)
            self.flags, self.rev, self.ready, self.offline = data["flags"], data["rev"], True, False
            if self.cache_file:
                try: json.dump(data, open(self.cache_file, "w"))
                except OSError: pass
        except urllib.error.HTTPError as e:
            self.offline = e.code != 304
        except Exception:
            self.offline = True

    def _load_cache(self):
        try:
            d = json.load(open(self.cache_file))
            self.flags, self.rev, self.ready, self.from_cache = d["flags"], d["rev"], True, True
        except Exception: pass

    def _loop(self):
        last_flush = time.time()
        while not self._stop.wait(self.poll):
            self.refresh()
            if time.time() - last_flush >= self.flush_every: self.flush(); last_flush = time.time()

    def evaluate(self, key, user):
        r = evaluate(self.flags.get(key), user)
        cfg = self.flags.get(key)
        with self._lock:
            self._counts[(key, r["variant"])] = self._counts.get((key, r["variant"]), 0) + 1
            if cfg and cfg.get("variants") and r["enabled"] and user and user.get("id") is not None:
                self._exposures.setdefault((key, str(user["id"])), {"flag": key, "variant": r["variant"], "userId": str(user["id"])})
        return r

    def is_enabled(self, key, user, default=False):
        return self.evaluate(key, user)["enabled"] if key in self.flags else default

    def variation(self, key, user, default=None):
        return self.evaluate(key, user)["variant"] if key in self.flags else default

    def track(self, user_id, metric, value=1):
        with self._lock: self._conversions.append({"userId": str(user_id), "metric": metric, "value": value})

    def flush(self):
        with self._lock:
            body = {"evaluations": [{"flag": k, "variant": v, "count": n} for (k, v), n in self._counts.items()],
                    "exposures": list(self._exposures.values()), "conversions": self._conversions}
            self._counts, self._exposures, self._conversions = {}, {}, []
        if not (body["evaluations"] or body["exposures"] or body["conversions"]): return
        try: self._req("/sdk/v1/events", body).close()
        except Exception:
            with self._lock:
                for e in body["evaluations"]: self._counts[(e["flag"], e["variant"])] = self._counts.get((e["flag"], e["variant"]), 0) + e["count"]
                for e in body["exposures"]: self._exposures[(e["flag"], e["userId"])] = e
                self._conversions += body["conversions"]

    def close(self):
        self._stop.set(); self.flush()
