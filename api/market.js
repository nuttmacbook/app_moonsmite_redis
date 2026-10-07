// Vercel Function: GET /api/market — every listing, read from the chain by the server for everyone.
//
// Before, every phone read every listing from the RPC every 5 minutes, so the RPC load grew with
// players times listings. Now one shared copy lives in Redis and on Vercel's CDN:
//   - the chain is read at most once every 30 seconds, whatever the number of players
//   - ?fresh=1 (after the player's own buy, list or cancel) accepts a copy up to 5 seconds old
//   - only one request rebuilds the copy at a time; the others get the last copy meanwhile
//
// Response: { items: [ { tokenId, seller, price, value, strikes, totalScore, furnaceMinutes, points, seed, listedAt } ], total, updatedAt }

import { handle, queryOf, refuse, send, clientIp } from "./_lib/http.js";
import { getChain } from "./_lib/chain.js";
import { cmd, getJSON, setJSON, underLimit } from "./_lib/redis.js";
import { keys } from "./_lib/keys.js";

const MAX_AGE_MS = 30 * 1000;
const FRESH_AGE_MS = 5 * 1000;
const KEEP_SEC = 24 * 60 * 60;

const toEntry = ({ tokenId, sword, seller }) => ({
    tokenId: String(tokenId),
    seller: String(seller ?? "").toLowerCase(),
    price: String(sword?.listPrice ?? 0),
    value: String(sword?.value ?? 0),
    strikes: Number(sword?.strikes ?? 0),
    totalScore: Number(sword?.totalScore ?? 0),
    furnaceMinutes: Number(sword?.furnaceMinutes ?? 0),
    points: Number(sword?.points ?? 0),
    seed: String(sword?.seed ?? 0),
    // list() writes syncedAt, so it doubles as the listing time
    listedAt: Number(sword?.syncedAt ?? 0),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reads the chain and stores the shared copy. Only the request holding the lock does this */
async function rebuild() {
    const { items } = await getChain().readListings();
    const copy = { items: items.map(toEntry), total: items.length, updatedAt: Date.now() };
    await setJSON(keys.market(), copy, KEEP_SEC);
    return copy;
}

async function listings(maxAgeMs) {
    const cached = await getJSON(keys.market());
    if (cached && Date.now() - cached.updatedAt <= maxAgeMs) return cached;

    if (await cmd("SET", keys.marketLock(), "1", "NX", "PX", 15000) === "OK") {
        try {
            return await rebuild();
        } finally {
            await cmd("DEL", keys.marketLock()).catch(() => {});
        }
    }
    // Someone else is rebuilding: the last copy is good enough, or wait for the new one
    if (cached) return cached;
    for (let i = 0; i < 25; i++) {
        await sleep(200);
        const fresh = await getJSON(keys.market());
        if (fresh) return fresh;
    }
    refuse("The market is loading. Try again in a moment.", 503);
}

export default handle(async (req, res) => {
    if (req.method !== "GET") return send(res, 405, { error: "Use GET" });
    const isFresh = String(queryOf(req).fresh ?? "") === "1";
    if (isFresh && !(await underLimit(keys.limit("market-fresh", clientIp(req)), 12, 60))) refuse("Refreshing too often. Wait a minute and try again.", 429);

    const copy = await listings(isFresh ? FRESH_AGE_MS : MAX_AGE_MS);
    return send(res, 200, copy, {
        // Vercel's CDN answers repeat requests for 15s, then serves the old copy while one request refreshes it
        "Cache-Control": isFresh ? "no-store" : "public, max-age=0, s-maxage=15, stale-while-revalidate=60",
    });
});
