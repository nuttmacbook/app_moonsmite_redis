// Vercel Function: POST /api/admin — tools for moving game data between versions.
// Only for the game's admin: needs the header "Authorization: Bearer <ADMIN_KEY>" (server env).
// Without ADMIN_KEY set, this endpoint does not exist (404).
//
// Body { action, ... }:
//   status                         → maintenance flag, open locks, key counts
//   maintenance { on: boolean }    → pause / resume every action that changes progress
//   backup  { cursor }             → one page of every game key and value (save them all)
//   restore { entries }            → writes back what backup returned
//   sync    { kind, cursor }       → copies the old per-sword keys ("swords") and stats ("stats")
//                                    into one document per wallet; needs maintenance on. A document
//                                    the new version already wrote (doc.live) is never overwritten.
//   verify  { kind, cursor }       → compares the documents with the old keys, page by page
//
// Paged so each call stays well under Vercel's time limit; scripts/sync-all.mjs runs the pages.
// The old keys are never changed or deleted here, so the previous version keeps working.

import { timingSafeEqual } from "node:crypto";
import { handle, readBody, refuse, send } from "./_lib/http.js";
import { cmd, pipeline, scan } from "./_lib/redis.js";
import { keys } from "./_lib/keys.js";
import { isMaintenance, setMaintenance } from "./_lib/maintenance.js";
import { decodeDoc, encodeDoc, emptyDoc } from "./_lib/docs.js";

const PAGE = 200;
const lower = (a) => String(a ?? "").toLowerCase();
const parse = (raw) => {
    try {
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};

const adminKey = () => String(process.env.ADMIN_KEY ?? "").trim();

function requireAdmin(req) {
    const want = adminKey();
    if (!want || want.includes("...")) refuse("Not found", 404);
    const header = String(req.headers?.authorization ?? "");
    const got = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) refuse("Not allowed", 403);
}

/** Counts keys matching a pattern (stops after `max` pages, then says so) */
async function count(pattern, max = 500) {
    let cursor = "0";
    let total = 0;
    let pages = 0;
    do {
        const page = await scan(cursor, pattern, 500);
        cursor = page.cursor;
        total += page.keys.length;
        pages++;
    } while (cursor !== "0" && pages < max);
    return { total, isComplete: cursor === "0" };
}

const tokenIdOf = (key) => key.slice(key.lastIndexOf(":") + 1);
const ownerOf = (key) => key.slice(key.lastIndexOf(":") + 1);

/** Old documents of these wallets, decoded, plus their stored revision */
async function docsOf(owners) {
    if (!owners.length) return {};
    const raws = await cmd("MGET", ...owners.map(keys.owner));
    return Object.fromEntries(owners.map((o, i) => {
        const { rev, doc } = decodeDoc(raws[i]);
        return [ o, { rev, doc: doc ?? emptyDoc() } ];
    }));
}

/* ------------------------------------------------------------ sync */

/** One page of sword records → their owners' documents (old keys are the source of truth) */
async function syncSwords(cursor) {
    const page = await scan(cursor, keys.swordPattern(), PAGE);
    if (!page.keys.length) return { cursor: page.cursor, swords: 0, owners: 0 };
    const raws = await cmd("MGET", ...page.keys);
    const byOwner = {};
    page.keys.forEach((key, i) => {
        const record = parse(raws[i]);
        if (!record?.owner) return;
        (byOwner[lower(record.owner)] ??= {})[tokenIdOf(key)] = record;
    });
    const docs = await docsOf(Object.keys(byOwner));
    const owners = Object.keys(byOwner).filter((o) => !docs[o].doc.live);
    const writes = owners.map((o) => {
        const { rev, doc } = docs[o];
        const next = { ...doc, swords: { ...doc.swords, ...byOwner[o] }, migratedAt: Date.now() };
        return [ "SET", keys.owner(o), encodeDoc(rev + 1, next) ];
    });
    if (writes.length) await pipeline(writes);
    return { cursor: page.cursor, swords: owners.reduce((n, o) => n + Object.keys(byOwner[o]).length, 0), owners: owners.length };
}

/** One page of stats → their owners' documents (wallets with stats but no swords included) */
async function syncStats(cursor) {
    const page = await scan(cursor, keys.statsPattern(), PAGE);
    if (!page.keys.length) return { cursor: page.cursor, owners: 0 };
    const raws = await cmd("MGET", ...page.keys);
    const byOwner = {};
    page.keys.forEach((key, i) => {
        const stats = parse(raws[i]);
        if (stats) byOwner[lower(ownerOf(key))] = stats;
    });
    const docs = await docsOf(Object.keys(byOwner));
    const owners = Object.keys(byOwner).filter((o) => !docs[o].doc.live);
    const writes = owners.map((o) => {
        const { rev, doc } = docs[o];
        return [ "SET", keys.owner(o), encodeDoc(rev + 1, { ...doc, stats: byOwner[o], migratedAt: Date.now() }) ];
    });
    if (writes.length) await pipeline(writes);
    return { cursor: page.cursor, owners: owners.length };
}

/* ------------------------------------------------------------ verify */

async function verifyPage(kind, cursor) {
    const isSwords = kind !== "stats";
    const page = await scan(cursor, isSwords ? keys.swordPattern() : keys.statsPattern(), PAGE);
    if (!page.keys.length) return { cursor: page.cursor, checked: 0, mismatched: [] };
    const raws = await cmd("MGET", ...page.keys);
    const items = page.keys.map((key, i) => ({ key, value: parse(raws[i]) })).filter((x) => x.value);
    const ownerFor = (x) => (isSwords ? lower(x.value.owner) : lower(ownerOf(x.key)));
    const owners = [ ...new Set(items.map(ownerFor)) ];
    const docs = await docsOf(owners);
    const mismatched = items.filter((x) => {
        const doc = docs[ownerFor(x)]?.doc;
        const copy = isSwords ? doc?.swords?.[tokenIdOf(x.key)] : doc?.stats;
        return JSON.stringify(copy ?? null) !== JSON.stringify(x.value);
    }).map((x) => x.key);
    return { cursor: page.cursor, checked: items.length, mismatched };
}

/* ------------------------------------------------------------ backup */

async function backupPage(cursor) {
    const page = await scan(cursor, keys.allPattern(), PAGE);
    if (!page.keys.length) return { cursor: page.cursor, entries: [] };
    const raws = await cmd("MGET", ...page.keys);
    return { cursor: page.cursor, entries: page.keys.map((k, i) => [ k, raws[i] ]).filter(([ , v ]) => v !== null) };
}

async function restore(entries) {
    const list = (Array.isArray(entries) ? entries : []).filter(([ k, v ]) => typeof k === "string" && k.startsWith(`ms:${keys.scope()}:`) && typeof v === "string");
    for (let i = 0; i < list.length; i += 200) await pipeline(list.slice(i, i + 200).map(([ k, v ]) => [ "SET", k, v ]));
    return { restored: list.length };
}

/* ------------------------------------------------------------ handler */

export default handle(async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
    requireAdmin(req);
    const body = await readBody(req);
    const action = String(body?.action ?? "");
    const cursor = String(body?.cursor ?? "0");

    if (action === "status") {
        const [ maintenance, locks, swords, stats, owners ] = await Promise.all([
            isMaintenance({ fresh: true }),
            count(keys.lockPattern()), count(keys.swordPattern()), count(keys.statsPattern()), count(keys.ownerPattern()),
        ]);
        return send(res, 200, { scope: keys.scope(), maintenance, locks: locks.total, oldSwordKeys: swords, oldStatsKeys: stats, ownerDocs: owners });
    }
    if (action === "maintenance") {
        await setMaintenance(Boolean(body?.on));
        return send(res, 200, { maintenance: await isMaintenance({ fresh: true }) });
    }
    if (action === "backup") return send(res, 200, await backupPage(cursor));
    if (action === "restore") return send(res, 200, await restore(body?.entries));
    if (action === "sync") {
        if (!(await isMaintenance({ fresh: true })) && !body?.force) refuse("Turn maintenance on first, so nothing changes while it copies.", 409);
        return send(res, 200, body?.kind === "stats" ? await syncStats(cursor) : await syncSwords(cursor));
    }
    if (action === "verify") return send(res, 200, await verifyPage(body?.kind, cursor));
    refuse("Unknown action");
});
