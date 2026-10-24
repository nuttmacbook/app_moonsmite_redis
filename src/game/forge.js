import { Forge } from "../web3/contracts/contract_forge";
import { read, remove } from "./storage";
import { json, postAs } from "./session";
import { settle, viewState, practiceRoll, emptyStats, rateFrom, DEFAULT_RATE, unsavedOf } from "./rules";

// The game loop runs on the game server (api/game.js) and its records live there, so every phone
// of the same wallet sees the same furnaces and strikes, and progress can only change the way the
// game allows. This file is the phone's side: it asks the server to make each change and draws
// what comes back. The rules themselves (furnace, formula, records) are in game/rules.js, shared
// with the server; the minigame settings are at the top of that file.
//
// Old storage keys (progress kept on the phone before the game server existed). They are moved
// to the server once, after the first sign-in, then removed:
//   forge:<contract>:sword:<tokenId>   { tokenId, owner, base, value, furnaceSeconds, earnedPoints, strikes, totalScore, furnace, lastStrike }
//   forge:<contract>:stats:<address>   { count, totalScore, valueAdded, perfect, clean, rough, glancing, recent }

const scope = String(Forge.address).toLowerCase();
const swordKey = (tokenId) => `forge:${scope}:sword:${tokenId}`;
const statsKey = (account) => `forge:${scope}:stats:${String(account).toLowerCase()}`;
const lower = (a) => String(a ?? "").toLowerCase();

let lastStats = emptyStats();

/* ------------------------------------------------------------- state */

/**
 * Everything the armory needs: the server's records for these swords, settled against the chain
 * snapshot the page just read, with the same rules the server uses. One small request, no RPC.
 * @param {string} account
 * @param {string[]} ids          owned token ids (getUserInfo)
 * @param {object[]} chainSwords  matching on-chain swords
 * @param {number} slots          furnace slots (getAccount().furnaces)
 * @param {{ pointsPerHour: number, maxPoints: number }} furnaceRate  from the contract
 * @param {number} now            block time of the chain read
 */
async function loadState(account, ids, chainSwords, slots, furnaceRate, now) {
    const rate = furnaceRate ? rateFrom(furnaceRate.pointsPerHour, furnaceRate.maxPoints) : DEFAULT_RATE;
    let records = {};
    let hire = null;
    let offline = "";
    if (account) {
        // The chain data still shows if the game server is down; only unsaved progress is missing
        try {
            const out = await json(`/api/game?owner=${lower(account)}&ids=${ids.join(",")}`);
            records = out?.records ?? {};
            hire = out?.hire ?? null;
            lastStats = out?.stats ?? emptyStats();
        } catch (error) {
            offline = error?.message ?? "The game server is not available right now.";
        }
    }
    // hire: this wallet's weapons out for hire and the wages they owe (see game/hire.js)
    const view = { ...viewState(settle(account, ids, chainSwords, records, slots, now, rate), now, rate), hire };
    return offline ? { ...view, offline } : view;
}

/** The profile's strike history, as the server last sent it */
const getStats = () => lastStats;

/** Every change answers with the new armory state, so the page redraws without reading the chain */
async function act(account, action, body = {}) {
    const out = await postAs(lower(account), "/api/game", { action, ...body });
    if (out?.stats) lastStats = out.stats;
    return out;
}

/* ---------------------------------------------------------- furnaces */

/** @returns {Promise<{ result, game, stats }>} */
const startFurnace = (account, tokenId) => act(account, "furnace.start", { tokenId: String(tokenId) });

/** @returns {Promise<{ result: { heated, earned, points }, game, stats }>} */
const stopFurnace = (account, tokenId) => act(account, "furnace.stop", { tokenId: String(tokenId) });

/* ------------------------------------------------------------ strike */

/** The roll to play; the server picks it, so it cannot be chosen or known ahead */
async function startStrike(account, tokenId) {
    const out = await act(account, "strike.start", { tokenId: String(tokenId) });
    return out.result;
}

/**
 * Sends what the player did; the server replays it to get the score.
 * @param {object} session  from startStrike
 * @param {object} log      from the minigame: { game, taps } | { game, holds } | { game, rounds }
 * @returns {Promise<{ result: { tokenId, score, increase, value, points }, game, stats }>}
 */
const finishStrike = (account, session, log) => act(account, "strike.finish", { tokenId: session.tokenId, sessionId: session.sessionId, log });

/* ------------------------------------------------- moving old progress */

const localRecords = (account, ids) => ids
    .map((id) => read(swordKey(id)))
    .filter((r) => r && lower(r.owner) === lower(account));

/** Progress this phone kept before the game server existed, not on-chain yet */
const hasLocalProgress = (account, ids) => localRecords(account, ids).some((r) => {
    const u = unsavedOf(r);
    return r.furnace || u.strikes > 0 || u.minutes > 0;
});

/**
 * Moves this phone's old progress to the game server, once. The server trims it to what the
 * contract would accept; the phone copies are removed after.
 * @returns {Promise<{ imported: string[], skipped: string[] }>}
 */
async function importLocal(account, ids) {
    const records = localRecords(account, ids);
    const stats = read(statsKey(account));
    const out = await act(account, "import", { records, stats });
    // Done either way: what was skipped is older than what the server or the chain already has
    records.forEach((r) => remove(swordKey(r.tokenId)));
    remove(statsKey(account));
    return out.result;
}

export {
    loadState, getStats,
    startFurnace, stopFurnace,
    startStrike, finishStrike, practiceRoll,
    hasLocalProgress, importLocal,
};
