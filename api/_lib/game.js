// The game server: owns every weapon's off-chain progress.
//
// The phone used to keep progress in localStorage and the server signed whatever it sent. Now the
// furnace, the strike and the numbers that go on-chain all live here, in Redis, and change only
// through these functions. Every phone of the same wallet reads the same records, and a strike
// score is accepted only as the replay of what the player did.
//
// Storage: one document per wallet (docs.js) with every sword record and the strike stats.
// A read is 1 command; a change is 2 (read, then a compare-and-set write that only lands if no
// other phone wrote in between, else it runs again on the fresh copy). A strike in progress is
// not stored at all: the phone holds a sealed ticket (seal.js) and brings it back to finish.

import { getChain } from "./chain.js";
import { keys } from "./keys.js";
import { cmd } from "./redis.js";
import { refuse } from "./http.js";
import { readDoc, writeDoc, legacyDoc } from "./docs.js";
import { seal, unseal } from "./seal.js";
import {
    settle, viewState, coolDown, pointsOf, rollFor, applyStrike, emptyStats, statsForChain,
    resolveSword, baseOf, maxValue, FURNACE_CAP,
} from "../../src/game/rules.js";
import { scoreLog, COUNTDOWN_MS } from "../../src/game/scoring.js";

const MAX_IDS = 500;
const STRIKE_TTL_MS = 15 * 60 * 1000;     // a strike left open longer than this has to start again
const CLOCK_SLACK_MS = 1500;              // network and frame slack on the play-time check
const WRITE_TRIES = 4;

const lower = (a) => String(a ?? "").toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
const salt = () => process.env.STRIKE_SALT || process.env.SIGNER_KEY || "dev-salt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const busy = () => refuse("Another device is busy with this wallet. Try again in a moment.", 409);

/**
 * The wallet's document. A wallet the admin sync did not reach (no document yet) is read from the
 * previous version's per-sword keys once; the first write then stores it as a document.
 * @param {string[]} ids  every token id the wallet owns, so nothing old is left behind
 */
async function loadDoc(owner, ids) {
    const { rev, doc } = await readDoc(owner);
    if (doc) return { rev, doc };
    return { rev: 0, doc: await legacyDoc(owner, ids) };
}

/* ------------------------------------------------------------ read */

/**
 * Raw records for some of a wallet's swords. No chain read: the phone already has the chain
 * snapshot and settles these records against it with the same rules (game/rules.js).
 */
async function readRecords(owner, ids) {
    const list = [ ...new Set((ids ?? []).map(String).filter((id) => /^\d+$/.test(id))) ].slice(0, MAX_IDS);
    const { doc } = await readDoc(owner);
    const out = {};
    list.forEach((id) => {
        const r = doc?.swords?.[id];
        // Only this wallet's records; a strike from the previous version is not shown
        if (r && lower(r.owner) === lower(owner)) out[id] = { ...r, strike: null, signed: null };
    });
    return { records: out, stats: doc?.stats ?? emptyStats(), now: nowSec() };
}

/* ---------------------------------------------------------- mutate */

/**
 * Runs one change for a wallet: reads the chain once and the wallet's document, settles every
 * record against the chain, runs `fn`, then writes the document back if anything changed. When
 * another phone wrote first, it runs again on the fresh document (fn must only change ctx).
 * @param {{ readOnly?: boolean }} opts  readOnly: never writes (strike.start)
 */
async function mutate(owner, fn, { readOnly = false } = {}) {
    const chain = getChain();
    const snap = await chain.readOwner(owner);
    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        const now = nowSec();
        const { rev, doc } = await loadDoc(owner, snap.ids);
        const settled = settle(owner, snap.ids, snap.swords, doc.swords, snap.furnaces, now, snap.rate);
        // A strike the previous version kept open is not used any more (tickets replaced it)
        Object.values(settled.swords).forEach((s) => { if (s.strike) s.strike = null; });
        const chainById = Object.fromEntries(snap.ids.map((id, i) => [ id, snap.swords[i] ]));
        const ctx = {
            owner: lower(owner), now, rate: snap.rate, settled, chainById,
            stats: structuredClone(doc.stats ?? emptyStats()), isStatsChanged: false,
            imported: { ...(doc.imported ?? {}) }, isImportChanged: false,
        };

        const result = await fn(ctx);
        const out = { result, game: viewState(settled, now, snap.rate), stats: ctx.stats };
        if (readOnly || (!settled.changed.size && !ctx.isStatsChanged && !ctx.isImportChanged)) return out;

        // Swords that left the wallet are dropped; their next owner starts from the chain
        const swords = Object.fromEntries(snap.ids.map((id) => [ id, settled.swords[id] ]));
        const imported = Object.fromEntries(Object.entries(ctx.imported).filter(([ id, at ]) => String(chainById[id]?.syncedAt ?? "") === String(at)));
        if (await writeDoc(owner, rev, { swords, stats: ctx.stats, imported, live: true })) return out;
        await sleep(40 + Math.random() * 120 * attempt);
    }
    return busy();
}

const own = (ctx, tokenId) => {
    const id = String(tokenId);
    const sword = ctx.settled.swords[id];
    if (!sword) refuse(`NFT #${id} is not in this wallet.`);
    return { id, sword, chain: ctx.chainById[id] };
};

const isListed = (chain) => BigInt(chain?.listPrice ?? 0) > 0n;

const touch = (ctx, id) => ctx.settled.changed.add(id);

/* --------------------------------------------------------- furnace */

const startFurnace = (owner, tokenId) => mutate(owner, (ctx) => {
    const { id, sword, chain } = own(ctx, tokenId);
    if (isListed(chain)) refuse("Cancel the listing before heating this weapon.");
    if (sword.furnace) refuse("This weapon is already in a furnace.");
    const items = ctx.settled.furnaces.items;
    const slot = items.findIndex((item) => !item);
    if (slot < 0) refuse(`All ${items.length} furnaces are busy. Take a weapon out first.`);

    sword.furnace = { slot, startedAt: ctx.now };
    items[slot] = { tokenId: id, startedAt: ctx.now, endsAt: ctx.now + FURNACE_CAP };
    touch(ctx, id);
    return { slot };
});

const stopFurnace = (owner, tokenId) => mutate(owner, (ctx) => {
    const { id, sword } = own(ctx, tokenId);
    if (!sword.furnace) refuse("That weapon is not in a furnace.");
    const before = pointsOf(sword, ctx.rate);
    const slot = sword.furnace.slot;
    const heated = coolDown(sword, ctx.now, ctx.rate);
    ctx.settled.furnaces.items[slot] = null;
    touch(ctx, id);
    return { heated, earned: pointsOf(sword, ctx.rate) - before, points: pointsOf(sword, ctx.rate) };
});

/* ---------------------------------------------------------- strike */

const strikeChecks = (ctx, sword, chain) => {
    if (isListed(chain)) refuse("Cancel the listing before striking.");
    if (sword.furnace) refuse("Take the weapon out of the furnace before striking.");
    if (pointsOf(sword, ctx.rate) < 1) refuse("No strike points left. Heat the weapon in a furnace first.");
};

/**
 * The roll the phone plays. Its seed is salted on the server, so it cannot be known in advance,
 * and it depends only on the weapon and its strike count: opening the strike again shows the
 * same game, so there is no rolling again for an easier one. Nothing is written: the session id
 * is a sealed ticket that says which strike this is and when it started.
 */
const startStrike = (owner, tokenId) => mutate(owner, (ctx) => {
    const { id, sword, chain } = own(ctx, tokenId);
    strikeChecks(ctx, sword, chain);
    const roll = rollFor(ctx.owner, sword, salt());
    const sessionId = seal("strike", { o: ctx.owner, t: id, s: sword.strikes, at: Date.now() });
    return { tokenId: id, sessionId, strikesAtStart: sword.strikes, ...roll };
}, { readOnly: true });

/**
 * Scores the strike from the player's input log and grows the weapon. The log must replay to a
 * real game (scoring.js) and must not claim more play time than really passed since the start.
 * The ticket is good for one strike: once it lands the weapon's strike count has moved on.
 */
const finishStrike = (owner, tokenId, sessionId, log) => mutate(owner, (ctx) => {
    const { id, sword, chain } = own(ctx, tokenId);
    const ticket = unseal("strike", sessionId);
    if (!ticket || ticket.o !== ctx.owner || ticket.t !== id || ticket.s !== sword.strikes) refuse("This strike has expired. Start a new one.");
    const startedAtMs = Number(ticket.at);
    if (!(Date.now() - startedAtMs <= STRIKE_TTL_MS)) refuse("This strike took too long. Start a new one.");
    strikeChecks(ctx, sword, chain);

    const roll = rollFor(ctx.owner, sword, salt());
    let scored;
    try {
        scored = scoreLog(roll, log);
    } catch (error) {
        refuse(error.message);
    }
    const realMs = Date.now() - startedAtMs;
    if (realMs + CLOCK_SLACK_MS < COUNTDOWN_MS + scored.playMs) refuse("This strike finished faster than it can be played. Start a new one.");

    const result = applyStrike(sword, ctx.stats, roll, scored.score, ctx.now, ctx.rate);
    sword.strike = null;
    ctx.isStatsChanged = true;
    touch(ctx, id);
    return { ...result, scores: scored.scores };
});

/* -------------------------------------------------------- one-time import */

/**
 * Highest value the growth formula allows for `strikes` strikes averaging `avgScore`, starting
 * from `value` (wei). Same formula as the game; the average gives an upper bound.
 */
const formulaCap = (value, strikes, avgScore, strikesPerMonth) => {
    let v = Number(value) / 1e18;
    const s = Math.max(0, Math.min(100, avgScore));
    for (let i = 0; i < strikes; i++) {
        const rate = 0.04 + 0.04 * Math.min(v, 5000) / 5000 + 0.06 * s / 100;
        v *= Math.pow(1 + rate, 1 / strikesPerMonth);
    }
    return v;
};

/**
 * Brings progress that only lives on a phone (the old localStorage records) onto the server, once
 * per weapon and save. It is trimmed to what the contract would accept and to the growth formula,
 * the same checks the signer always made. Records the server already moved past are skipped.
 */
const importRecords = (owner, localRecords, localStats) => mutate(owner, async (ctx) => {
    const until = Number(process.env.IMPORT_UNTIL || 0);
    if (until && nowSec() > until) refuse("Moving progress from this phone has ended.");

    const list = (Array.isArray(localRecords) ? localRecords : []).slice(0, MAX_IDS);
    // Weapons the previous version already imported (one key each)
    const candidates = list.map((r) => String(r?.tokenId ?? "")).filter((id) => ctx.chainById[id]);
    const before = candidates.length ? await cmd("MGET", ...candidates.map((id) => keys.imported(id, ctx.chainById[id].syncedAt))) : [];
    const wasImported = new Set(candidates.filter((_, i) => before[i]));

    const imported = [];
    const skipped = [];
    for (const local of list) {
        const id = String(local?.tokenId ?? "");
        const sword = ctx.settled.swords[id];
        const chain = ctx.chainById[id];
        const isFresh = sword && !sword.furnace && !sword.strike && sword.strikes === Number(chain?.strikes ?? 0)
            && sword.furnaceSeconds === Number(chain?.furnaceMinutes ?? 0) * 60;
        const fits = lower(local?.owner) === ctx.owner && String(local?.base?.syncedAt) === String(chain?.syncedAt ?? "");
        if (!sword || !isFresh || !fits || Number(local?.strikes) < Number(chain?.strikes ?? 0)) {
            skipped.push(id);
            continue;
        }
        if (wasImported.has(id) || String(ctx.imported[id] ?? "") === String(chain.syncedAt)) {
            skipped.push(id);
            continue;
        }

        ctx.imported[id] = String(chain.syncedAt);
        ctx.isImportChanged = true;
        try {
            importOne(ctx, id, sword, chain, local);
            imported.push(id);
        } catch {
            skipped.push(id);
        }
    }

    // The profile's strike history comes along once, if the server has none yet
    // (only alongside at least one imported weapon, so it cannot be sent on its own)
    if (imported.length && ctx.stats.count === 0 && localStats && Number(localStats.count) > 0) {
        ctx.stats = { ...emptyStats(), ...localStats, recent: Array.isArray(localStats.recent) ? localStats.recent.slice(0, 20) : [] };
        ctx.isStatsChanged = true;
    }
    return { imported, skipped };
});

/** One phone record, trimmed like a save would be trimmed */
function importOne(ctx, id, sword, chain, local) {
    const draft = {
        ...sword,
        value: String(BigInt(String(local.value ?? chain.value))),
        furnaceSeconds: Math.max(sword.furnaceSeconds, Number(local.furnaceSeconds) || 0),
        earnedPoints: Math.max(0, Number(local.earnedPoints) || 0),
        strikes: Math.max(sword.strikes, Number(local.strikes) || 0),
        totalScore: Math.max(sword.totalScore, Number(local.totalScore) || 0),
        lastStrike: local.lastStrike ?? null,
        furnace: null,
    };
    // A furnace still burning on the phone banks its heat now (up to the 24h cap)
    if (local.furnace?.startedAt) {
        draft.furnace = { slot: 0, startedAt: Math.max(Number(chain.syncedAt), Math.min(ctx.now, Number(local.furnace.startedAt))) };
        coolDown(draft, ctx.now, ctx.rate);
    }
    const stats = statsForChain(draft, chain, ctx.now, ctx.rate);
    const addedStrikes = Number(stats.strikes) - Number(chain.strikes);
    draft.totalScore = Math.min(Number(stats.totalScore), Number(chain.totalScore) + addedStrikes * 100);
    let value = BigInt(stats.value);
    if (addedStrikes > 0) {
        const avg = (draft.totalScore - Number(chain.totalScore)) / addedStrikes;
        const cap = BigInt(Math.floor(formulaCap(chain.value, addedStrikes, avg, ctx.rate.strikesPerMonth) * 1e18));
        if (value > cap) value = cap > BigInt(chain.value) ? cap : BigInt(chain.value);
    } else {
        value = BigInt(chain.value);
    }

    ctx.settled.swords[id] = {
        ...draft,
        base: baseOf(chain),
        value: value.toString(),
        furnaceSeconds: Number(stats.furnaceMinutes) * 60,
        earnedPoints: Number(stats.points) + Number(stats.strikes),
        strikes: Number(stats.strikes),
        totalScore: draft.totalScore,
        furnace: null,
        strike: null,
        signed: null,
    };
    touch(ctx, id);
}

/* ------------------------------------------------------------ sign */

/**
 * The Stats each weapon goes on-chain with, from the server's own records, checked the way the
 * contract will check them. Remembers what was signed, so progress made after signing survives
 * the save landing on-chain.
 * @returns {Promise<{ tokenId: string, stats: object, nonce: bigint, now: number }[]>}
 */
async function statsToSign(owner, tokenIds) {
    const ids = [ ...new Set(tokenIds.map(String)) ];
    const chain = getChain();
    const { swords, rate, now } = await chain.readSwords(ids);
    ids.forEach((id, i) => {
        if (swords[i].owner !== lower(owner)) refuse(`Weapon #${id} is not in this wallet.`);
    });

    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        let { rev, doc } = await readDoc(owner);
        // No document yet: build it from every weapon the wallet owns, not just these
        if (!doc) doc = (await loadDoc(owner, (await chain.readOwner(owner)).ids)).doc;

        const out = [];
        ids.forEach((id, i) => {
            const { sword: chainSword, nonce } = swords[i];
            const { sword } = resolveSword(id, owner, chainSword, doc.swords[id]);
            let stats;
            try {
                stats = statsForChain(sword, chainSword, now, rate);
            } catch (error) {
                refuse(error.message);
            }
            assertSignable(id, chainSword, stats, now, rate);
            out.push({ tokenId: id, stats, nonce, now });
            doc.swords[id] = { ...structuredClone(sword), signed: { ...stats, nonce: nonce.toString() } };
        });
        if (await writeDoc(owner, rev, { ...doc, live: true })) return out;
        await sleep(40 + Math.random() * 120 * attempt);
    }
    return busy();
}

/** The contract's _applyStats checks, plus the growth-formula rule the contract cannot afford */
function assertSignable(id, s, next, now, rate) {
    const n = Object.fromEntries(Object.entries(next).map(([ k, v ]) => [ k, BigInt(v) ]));
    const c = Object.fromEntries([ "value", "points", "furnaceMinutes", "strikes", "totalScore", "syncedAt" ].map((k) => [ k, BigInt(s[k] ?? 0) ]));
    const addedStrikes = n.strikes - c.strikes;
    const addedMinutes = n.furnaceMinutes - c.furnaceMinutes;
    if (n.value < c.value || n.furnaceMinutes < c.furnaceMinutes || n.strikes < c.strikes || n.totalScore < c.totalScore) refuse(`Newer progress for #${id} is already saved. Refresh the page.`);
    if (addedMinutes > (BigInt(now) - c.syncedAt) / 60n) refuse("Your progress is ahead of the chain clock. Try again in a few minutes.");
    if (n.totalScore - c.totalScore > addedStrikes * 100n) refuse(`Strike scores for #${id} do not add up.`);
    if (n.points > BigInt(rate.maxPoints)) refuse(`#${id} holds more points than a weapon can.`);
    const earnedNow = n.points + n.strikes;
    const earnedBefore = c.points + c.strikes;
    if (earnedNow > earnedBefore && (earnedNow - earnedBefore) * 60n > addedMinutes * BigInt(rate.pointsPerHour)) refuse("Your progress is ahead of the chain clock. Try again in a few minutes.");
    if (n.value > maxValue(c.value, addedStrikes, rate)) refuse(`Value for #${id} is above the growth cap.`);
    if (addedStrikes > 0n) {
        const avg = Number(n.totalScore - c.totalScore) / Number(addedStrikes);
        const cap = formulaCap(c.value, Number(addedStrikes), avg, rate.strikesPerMonth);
        if (Number(n.value) / 1e18 > cap * (1 + 1e-9) + 1e-12) refuse(`Value for #${id} does not match its strike scores.`);
    } else if (n.value !== c.value) {
        refuse(`Value for #${id} cannot grow without strikes.`);
    }
}

export { readRecords, startFurnace, stopFurnace, startStrike, finishStrike, importRecords, statsToSign, formulaCap };
