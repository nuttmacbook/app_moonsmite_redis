// The game server: owns every weapon's off-chain progress.
//
// The phone used to keep progress in localStorage and the server signed whatever it sent. Now the
// furnace, the strike and the numbers that go on-chain all live here, in Redis, and change only
// through these functions. Every phone of the same wallet reads the same records, and a strike
// score is accepted only as the replay of what the player did.

import { getChain } from "./chain.js";
import { keys } from "./keys.js";
import { cmd, mgetJSON, getJSON, msetJSON, setJSON, withLock } from "./redis.js";
import { refuse } from "./http.js";
import {
    settle, viewState, coolDown, pointsOf, rollFor, applyStrike, emptyStats, statsForChain,
    resolveSword, baseOf, maxValue, FURNACE_CAP,
} from "../../src/game/rules.js";
import { scoreLog, COUNTDOWN_MS } from "../../src/game/scoring.js";

const MAX_IDS = 500;
const STRIKE_TTL_MS = 15 * 60 * 1000;     // a strike left open longer than this has to start again
const CLOCK_SLACK_MS = 1500;              // network and frame slack on the play-time check
const IMPORT_TTL_SEC = 90 * 24 * 60 * 60;

const lower = (a) => String(a ?? "").toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
const salt = () => process.env.STRIKE_SALT || process.env.SIGNER_KEY || "dev-salt";

/* ------------------------------------------------------------ read */

/**
 * Raw records for some of a wallet's swords. No chain read: the phone already has the chain
 * snapshot and settles these records against it with the same rules (game/rules.js).
 */
async function readRecords(owner, ids) {
    const list = [ ...new Set((ids ?? []).map(String).filter((id) => /^\d+$/.test(id))) ].slice(0, MAX_IDS);
    const [ records, stats ] = await Promise.all([ mgetJSON(list.map(keys.sword)), getJSON(keys.stats(owner)) ]);
    const out = {};
    list.forEach((id, i) => {
        const r = records[i];
        // Only this wallet's records; the strike salt never leaves the server
        if (r && lower(r.owner) === lower(owner)) out[id] = { ...r, strike: r.strike ? { id: r.strike.id, strikesAtStart: r.strike.strikesAtStart } : null, signed: null };
    });
    return { records: out, stats: stats ?? emptyStats(), now: nowSec() };
}

/* ---------------------------------------------------------- mutate */

/**
 * Runs one change for a wallet: takes the wallet's lock (two phones take turns), reads the
 * chain once, settles every record against it, runs `fn`, then writes back what changed.
 */
async function mutate(owner, fn) {
    return withLock(keys.ownerLock(owner), async () => {
        const chain = getChain();
        const snap = await chain.readOwner(owner);
        const now = nowSec();
        const [ records, stats ] = await Promise.all([ mgetJSON(snap.ids.map(keys.sword)), getJSON(keys.stats(owner)) ]);
        const byId = Object.fromEntries(snap.ids.map((id, i) => [ id, records[i] ]));
        const settled = settle(owner, snap.ids, snap.swords, byId, snap.furnaces, now, snap.rate);
        const chainById = Object.fromEntries(snap.ids.map((id, i) => [ id, snap.swords[i] ]));
        const ctx = { owner: lower(owner), now, rate: snap.rate, settled, chainById, stats: stats ?? emptyStats(), isStatsChanged: false };

        const result = await fn(ctx);

        const writes = [ ...settled.changed ].map((id) => [ keys.sword(id), settled.swords[id] ]);
        if (ctx.isStatsChanged) writes.push([ keys.stats(owner), ctx.stats ]);
        if (writes.length) await msetJSON(writes);

        return { result, game: viewState(settled, now, snap.rate), stats: ctx.stats };
    });
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

/** The roll the phone plays; the seed is salted on the server, so it cannot be known in advance */
const startStrike = (owner, tokenId) => mutate(owner, (ctx) => {
    const { id, sword, chain } = own(ctx, tokenId);
    if (isListed(chain)) refuse("Cancel the listing before striking.");
    if (sword.furnace) refuse("Take the weapon out of the furnace before striking.");
    if (pointsOf(sword, ctx.rate) < 1) refuse("No strike points left. Heat the weapon in a furnace first.");

    const roll = rollFor(ctx.owner, sword, `${salt()}:${ctx.now}`);
    const sessionId = `${id}-${sword.strikes}-${Math.random().toString(36).slice(2, 10)}`;
    sword.strike = { id: sessionId, strikesAtStart: sword.strikes, startedAtMs: Date.now(), roll };
    touch(ctx, id);
    return { tokenId: id, sessionId, strikesAtStart: sword.strikes, ...roll };
});

/**
 * Scores the strike from the player's input log and grows the weapon. The log must replay to a
 * real game (scoring.js) and must not claim more play time than really passed since the start.
 */
const finishStrike = (owner, tokenId, sessionId, log) => mutate(owner, (ctx) => {
    const { id, sword } = own(ctx, tokenId);
    const session = sword.strike;
    if (!session || session.id !== String(sessionId) || session.strikesAtStart !== sword.strikes) refuse("This strike has expired. Start a new one.");
    if (Date.now() - session.startedAtMs > STRIKE_TTL_MS) refuse("This strike took too long. Start a new one.");
    if (sword.furnace) refuse("Take the weapon out of the furnace before striking.");
    if (pointsOf(sword, ctx.rate) < 1) refuse("No strike points left. Heat the weapon in a furnace first.");

    let scored;
    try {
        scored = scoreLog(session.roll, log);
    } catch (error) {
        refuse(error.message);
    }
    const realMs = Date.now() - session.startedAtMs;
    if (realMs + CLOCK_SLACK_MS < COUNTDOWN_MS + scored.playMs) refuse("This strike finished faster than it can be played. Start a new one.");

    const result = applyStrike(sword, ctx.stats, session.roll, scored.score, ctx.now, ctx.rate);
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

    const imported = [];
    const skipped = [];
    for (const local of (Array.isArray(localRecords) ? localRecords : []).slice(0, MAX_IDS)) {
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
        if (await cmd("SET", keys.imported(id, chain.syncedAt), "1", "NX", "EX", IMPORT_TTL_SEC) !== "OK") {
            skipped.push(id);
            continue;
        }

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
const statsToSign = (owner, tokenIds) => withLock(keys.ownerLock(owner), async () => {
    const ids = [ ...new Set(tokenIds.map(String)) ];
    const chain = getChain();
    const { swords, rate, now } = await chain.readSwords(ids);
    const saved = await mgetJSON(ids.map(keys.sword));

    const out = [];
    const writes = [];
    ids.forEach((id, i) => {
        const { sword: chainSword, owner: holder, nonce } = swords[i];
        if (holder !== lower(owner)) refuse(`Weapon #${id} is not in this wallet.`);
        const { sword } = resolveSword(id, owner, chainSword, saved[i]);
        let stats;
        try {
            stats = statsForChain(sword, chainSword, now, rate);
        } catch (error) {
            refuse(error.message);
        }
        assertSignable(id, chainSword, stats, now, rate);
        out.push({ tokenId: id, stats, nonce, now });
        writes.push([ keys.sword(id), { ...structuredClone(sword), signed: { ...stats, nonce: nonce.toString() } } ]);
    });
    await msetJSON(writes);
    return out;
});

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

export { readRecords, startFurnace, stopFurnace, startStrike, finishStrike, importRecords, statsToSign, formulaCap, setJSON };
