import { json } from "./session";

// Market search: every listing comes from /api/market, which reads the chain for all players at
// once and shares the copy (at most one chain read every 30 seconds, whatever the number of
// players). The phone keeps it for 30 seconds, then filters, sorts and pages it locally.
// After the player's own buy, list or cancel, a fresh copy (at most 5 seconds old) is asked for.

const CACHE_MS = 30 * 1000;
const PAGE_SIZE_MAX = 50;

let cache = { items: [], at: 0, updatedAt: 0 };
let loading = null;
const gone = new Map();      // tokenId -> until (ms): listings this player just bought or cancelled

async function load(isFresh) {
    const out = await json(`/api/market${isFresh ? "?fresh=1" : ""}`);
    cache = { items: Array.isArray(out?.items) ? out.items : [], at: Date.now(), updatedAt: Number(out?.updatedAt ?? Date.now()) };
    return cache.items;
}

/** @param {boolean} isFresh  the player just listed or bought; skip the cache */
async function listings(isFresh) {
    if (!isFresh && Date.now() - cache.at < CACHE_MS) return cache.items;
    loading ??= load(isFresh).finally(() => (loading = null));
    return loading;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const avgOf = (x) => (x.strikes ? x.totalScore / x.strikes : -1);
const GRADE_RANGES = { S: [ 95, 101 ], A: [ 85, 95 ], B: [ 70, 85 ], C: [ 50, 70 ], D: [ 0, 50 ] };

const SORTS = {
    newest:     (a, b) => b.listedAt - a.listedAt || cmp(BigInt(b.tokenId), BigInt(a.tokenId)),
    oldest:     (a, b) => a.listedAt - b.listedAt || cmp(BigInt(a.tokenId), BigInt(b.tokenId)),
    price_asc:  (a, b) => cmp(BigInt(a.price), BigInt(b.price)),
    price_desc: (a, b) => cmp(BigInt(b.price), BigInt(a.price)),
    value_desc: (a, b) => cmp(BigInt(b.value), BigInt(a.value)),
    deal:       (a, b) => cmp(BigInt(a.price) * BigInt(b.value), BigInt(b.price) * BigInt(a.value)),
    quality:    (a, b) => avgOf(b) - avgOf(a),
};

const toWei = (coins) => {
    const n = Number(coins);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e4)) * 10n ** 14n : null;
};

/**
 * @param {{ q?: string, minPrice?: number, maxPrice?: number, grade?: string, isUnderValue?: boolean, sort?: string, page?: number, pageSize?: number, isFresh?: boolean }} params
 * @returns {Promise<{ items: object[], total: number, page: number, pages: number }>}
 */
async function queryMarket(params = {}) {
    const id = String(params?.q ?? "").replace(/[^0-9]/g, "");
    const min = toWei(params?.minPrice);
    const max = toWei(params?.maxPrice);
    const range = GRADE_RANGES[String(params?.grade ?? "")];
    const pageSize = Math.max(1, Math.min(PAGE_SIZE_MAX, Number(params?.pageSize) || 20));
    const page = Math.max(1, Number(params?.page) || 1);

    const now = Date.now();
    gone.forEach((until, key) => until < now && gone.delete(key));
    let items = (await listings(Boolean(params?.isFresh))).filter((x) => !gone.has(x.tokenId));
    if (id) items = items.filter((x) => x.tokenId === id);
    if (min !== null) items = items.filter((x) => BigInt(x.price) >= min);
    if (max !== null) items = items.filter((x) => BigInt(x.price) <= max);
    if (range) items = items.filter((x) => x.strikes > 0 && avgOf(x) >= range[0] && avgOf(x) < range[1]);
    if (params?.isUnderValue) items = items.filter((x) => BigInt(x.price) < BigInt(x.value));
    items.sort(SORTS[params?.sort] ?? SORTS.newest);

    const total = items.length;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total, page, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** When the listings were last read from the chain, in ms; 0 before the first read */
const marketUpdatedAt = () => cache.updatedAt;

/**
 * Shows the player's own change right away: a listing they bought or cancelled stays hidden on
 * this phone for a minute, even if the shared copy is a few seconds behind the chain.
 */
const dropListing = (tokenId) => gone.set(String(tokenId), Date.now() + 60 * 1000);

export { queryMarket, marketUpdatedAt, dropListing };
