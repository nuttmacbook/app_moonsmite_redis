// One Redis value per wallet holding all of its sword records and its strike stats.
//
// Stored as "<rev>:<json>" so a short Lua script can compare the revision without decoding JSON:
// a write only lands if nobody else wrote since it was read (two phones never overwrite each
// other), which replaces the per-wallet lock and its two extra commands.
//
//   { v: 1, swords: { [tokenId]: record }, stats, imported?: { [tokenId]: syncedAt }, live?, migratedAt? }
// live: written by the game itself (not only copied by the admin sync), so a sync never replaces it

import { cmd, mgetJSON, getJSON } from "./redis.js";
import { keys } from "./keys.js";
import { emptyStats } from "../../src/game/rules.js";

const DOC_VERSION = 1;

// "-- cas" marks the script for the in-memory Redis used in tests
const CAS = `-- cas
local cur = redis.call('GET', KEYS[1])
local rev = 0
if cur then rev = tonumber(string.match(cur, '^(%d+):')) or 0 end
if rev ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

const emptyDoc = () => ({ v: DOC_VERSION, swords: {}, stats: emptyStats() });

/** "<rev>:<json>" -> { rev, doc }; a missing value is rev 0 */
const decodeDoc = (raw) => {
    if (!raw) return { rev: 0, doc: null };
    const at = raw.indexOf(":");
    const doc = JSON.parse(raw.slice(at + 1));
    return { rev: Number(raw.slice(0, at)) || 0, doc: { ...emptyDoc(), ...doc, swords: doc.swords ?? {}, stats: doc.stats ?? emptyStats() } };
};

const encodeDoc = (rev, doc) => `${rev}:${JSON.stringify({ ...doc, v: DOC_VERSION })}`;

/** Reads a wallet's document (1 command) */
async function readDoc(owner) {
    return decodeDoc(await cmd("GET", keys.owner(owner)));
}

/**
 * Builds a document from the old per-sword keys, for a wallet the sync missed.
 * Only runs when the wallet has no document yet.
 */
async function legacyDoc(owner, ids) {
    const list = [ ...new Set((ids ?? []).map(String)) ];
    const [ records, stats ] = await Promise.all([ mgetJSON(list.map(keys.sword)), getJSON(keys.stats(owner)) ]);
    const doc = emptyDoc();
    list.forEach((id, i) => {
        const r = records[i];
        if (r && String(r.owner).toLowerCase() === String(owner).toLowerCase()) doc.swords[id] = r;
    });
    if (stats) doc.stats = stats;
    return doc;
}

/** Writes `doc` if the stored revision is still `rev`. true when it landed */
async function writeDoc(owner, rev, doc) {
    return Number(await cmd("EVAL", CAS, 1, keys.owner(owner), rev, encodeDoc(rev + 1, doc))) === 1;
}

export { DOC_VERSION, CAS, emptyDoc, decodeDoc, encodeDoc, readDoc, legacyDoc, writeDoc };
