// Upstash Redis over its REST API, with plain fetch (no client package).
// Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or Vercel KV's KV_REST_API_URL + KV_REST_API_TOKEN).
// Files in api/_lib are helpers, not endpoints: Vercel skips paths that start with an underscore.

let fetchImpl = (...args) => fetch(...args);
let config = null;

/** Tests swap in an in-memory Redis */
const setRedisFetch = (fn, cfg = { url: "http://redis.test", token: "test" }) => {
    fetchImpl = fn;
    config = cfg;
};

const conf = () => {
    if (config) return config;
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) throw new Error("Redis is not configured (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)");
    config = { url: url.replace(/\/$/, ""), token };
    return config;
};

const post = async (path, body) => {
    const { url, token } = conf();
    const res = await fetchImpl(`${url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.error) throw new Error(`Redis: ${json?.error ?? res.status}`);
    return json;
};

/** One command: cmd("SET", "k", "v", "EX", 60) */
const cmd = async (...args) => (await post("", args.map(String))).result;

/** Several commands in one round trip; returns their results in order */
const pipeline = async (commands) => {
    if (!commands.length) return [];
    const out = await post("/pipeline", commands.map((c) => c.map(String)));
    return out.map((r) => {
        if (r?.error) throw new Error(`Redis: ${r.error}`);
        return r.result;
    });
};

/* ------------------------------------------------------------ json */

const getJSON = async (key) => {
    const raw = await cmd("GET", key);
    return raw ? JSON.parse(raw) : null;
};

const mgetJSON = async (keys) => {
    if (!keys.length) return [];
    const raws = await cmd("MGET", ...keys);
    return raws.map((raw) => (raw ? JSON.parse(raw) : null));
};

const setJSON = (key, value, ttlSec) => (ttlSec ? cmd("SET", key, JSON.stringify(value), "EX", ttlSec) : cmd("SET", key, JSON.stringify(value)));

/** Writes several JSON values in one round trip */
const msetJSON = (entries) => pipeline(entries.map(([ key, value ]) => [ "SET", key, JSON.stringify(value) ]));

/* ------------------------------------------------------------ locks */

const UNLOCK = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs fn while holding a short lock, so two phones acting on the same wallet take turns.
 * Waits up to ~3s for the lock, then gives up with a message the player can act on.
 */
async function withLock(key, fn, { ttlMs = 10000, waitMs = 3000 } = {}) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const until = Date.now() + waitMs;
    for (;;) {
        if (await cmd("SET", key, token, "NX", "PX", ttlMs) === "OK") break;
        if (Date.now() > until) throw Object.assign(new Error("Another device is busy with this wallet. Try again in a moment."), { status: 409 });
        await sleep(120);
    }
    try {
        return await fn();
    } finally {
        await cmd("EVAL", UNLOCK, 1, key, token).catch(() => {});
    }
}

/**
 * Counts one hit and says whether the caller is still under `max` hits per `windowSec`.
 * Fixed windows: cheap and good enough to stop floods.
 */
const HIT = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c";

async function underLimit(key, max, windowSec) {
    const count = await cmd("EVAL", HIT, 1, key, windowSec);
    return Number(count) <= max;
}

export { setRedisFetch, cmd, pipeline, getJSON, mgetJSON, setJSON, msetJSON, withLock, underLimit };
