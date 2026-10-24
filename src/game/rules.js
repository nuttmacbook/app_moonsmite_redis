// Game rules shared by the phone and the game server (api/_lib/game.js).
//
// Everything here is pure: no storage, no network, no clock. The server owns the progress and
// runs these functions to change it; the phone runs the same functions to draw what the server
// said, so both always agree. Moved out of game/forge.js without changing the numbers.

const E = 10n ** 18n;

/* =====================================================================
 * GAME SETTINGS — tune the strike minigames here.
 *
 * Every strike rolls one minigame from `games` and one of the four levels. Both are fixed by
 * the weapon and its strike count, so reopening a strike gives the same roll. Scores are 0-100
 * in every game and level, so harder rolls only make a good score harder to reach.
 * ===================================================================== */
const MINIGAME = {
    // Minigames a strike can roll, equally likely. Remove one to turn it off.
    games: [ "ring", "burn", "rune" ],

    // The four levels, equally likely
    //   ringMs     hammer ring: how long a ring takes to close
    //   heatSec    flame burn: seconds of flame to take the weapon from cold to black
    //   runeSec    rune memory: seconds for all 12 runes to appear
    levels: {
        easy:   { ringMs: 1550, heatSec: 1.7, runeSec: 5.5 },
        normal: { ringMs: 1100, heatSec: 1.2, runeSec: 4.0 },
        hard:   { ringMs: 850,  heatSec: 0.8, runeSec: 2.5 },
        insane: { ringMs: 650,  heatSec: 0.5, runeSec: 1.5 },
    },

    // Hammer ring: tap when the ring lands on the glowing target
    ring: {
        blows:      10,     // targets per strike
        spawnEvery: 0.5,    // a new target appears every this share of a ring's close time
        biggestPx:  88,     // largest target circle
        smallestPx: 40,     // smallest target circle
        // How far off a tap may be and still score 100, as a share of the ring size:
        // easyTolerance for the biggest target, hardTolerance for the smallest
        easyTolerance: 0.18,
        hardTolerance: 0.05,
        falloff:    0.65,   // how fast the score drops outside that window
        hardness:   3,      // divides both windows: 1 = gentle, 3 = three times harder
    },

    // Flame burn: hold to blow fire on the weapon, let go when it reaches the target heat
    burn: {
        blows:      5,      // holds per strike
        minHoldSec: 0.1,    // shortest target hold
        maxHoldSec: 2.0,    // longest target hold (capped below the level's heatSec)
        perfectSec: 0.03,   // let go this close to the target for 100
        falloffSec: 0.3,    // score reaches 0 this far past the perfect window
        hardness:   3,      // divides both windows: 1 = gentle, 3 = three times harder
    },

    // Rune memory: 12 runes appear around the weapon, red or green, then all turn blue.
    // Tap every rune that was the color asked for, before time runs out.
    rune: {
        rounds:     3,      // rounds per strike
        answerSec:  6.0,    // time to tap
        minTarget:  2,      // runes of the asked color per round, at least...
        maxTarget:  10,     // ...and at most
    },
};

const LEVEL_IDS = [ "easy", "normal", "hard", "insane" ];

/* =====================================================================
 * HIRE SETTINGS — smiths striking other players' weapons for wages.
 *
 * A smith passes the licensing exam (every minigame at every level), then takes a job from the
 * board. The owner sets the license score a job needs and the smith's share of the value each
 * strike adds. Wages are paid per weapon into the Wages contract; smiths claim them there.
 * ===================================================================== */
const HIRE = {
    maxShare:        80,            // highest share of the value added an owner may offer (%)
    examCooldownSec: 24 * 60 * 60,  // one exam per wallet per this many seconds
    examTtlSec:      30 * 60,       // an exam must be finished within this time
    lockIdleSec:     30 * 60,       // a job frees itself after this long without a strike
    owedGraceSec:    7 * 24 * 60 * 60, // owing wages older than this blocks opening new jobs
    logSize:         20,            // strikes kept in a weapon's hire log
    workScoreOf:     20,            // the work score averages this many recent strikes
    billTtlSec:      60 * 60,       // a wages bill must go on-chain within this time
    maxBillSmiths:   20,            // smiths paid by one bill
    maxBlocked:      100,           // smiths one owner can block
};
/* ===================================================================== */

const FURNACE_CAP = 24 * 60 * 60;       // one charge counts up to 24h
const VALUE_CAP_COINS = 5000;
const BPS = 10000n;
const MAX_RATE_BPS = 1400n;
const RECENT_STRIKES = 20;
const CLOCK_MARGIN = 90;                // seconds of slack between the server clock and the chain
const DEFAULT_FURNACES = 3;

const lower = (a) => String(a ?? "").toLowerCase();

/** Furnace speed and point cap as the contract reports them (furnaceRate) */
const rateFrom = (pointsPerHour, maxPoints) => {
    const pph = Number(pointsPerHour) || 3;
    return { pointsPerHour: pph, strikesPerMonth: pph * 720, maxPoints: Number(maxPoints) || 1000 };
};

const DEFAULT_RATE = rateFrom(3, 1000);

/* ----------------------------------------------------------- formula */

/** Monthly rate: 4% time + up to 4% from value (0-5000) + up to 6% from the strike score */
const rateOf = (valueWei, score) => {
    const coins = Number(BigInt(valueWei) / 10n ** 14n) / 1e4;
    return 0.04 + 0.04 * Math.min(coins, VALUE_CAP_COINS) / VALUE_CAP_COINS + 0.06 * Math.max(0, Math.min(100, score)) / 100;
};

/** Value added by one strike, compounding so a month of strikes lands exactly on the monthly rate */
const strikeIncrease = (valueWei, score, rate = DEFAULT_RATE) => {
    const factor = Math.pow(1 + rateOf(valueWei, score), 1 / rate.strikesPerMonth) - 1;
    return BigInt(valueWei) * BigInt(Math.floor(factor * 1e18)) / E;
};

/** Same integer math as ForgeEngine.maxValue, so an upload never trips the cap */
const maxValue = (value, strikes, rate = DEFAULT_RATE) => {
    let v = BigInt(value);
    const months = BigInt(strikes) / BigInt(rate.strikesPerMonth);
    for (let i = 0n; i < months; i++) v = v * (BPS + MAX_RATE_BPS) / BPS;
    const rest = BigInt(strikes) % BigInt(rate.strikesPerMonth);
    return v + v * MAX_RATE_BPS * rest / (BPS * BigInt(rate.strikesPerMonth));
};

/** Points earned from heat; older records without the field fall back to 1 point per 5 minutes */
const earnedOf = (sword) => Number(sword?.earnedPoints ?? Math.floor(Number(sword?.furnaceSeconds ?? 0) / 300));

/** Unspent points, never above the per-weapon cap */
const pointsOf = (sword, rate = DEFAULT_RATE) => Math.max(0, Math.min(rate.maxPoints, earnedOf(sword) - Number(sword?.strikes ?? 0)));

/* ------------------------------------------------------------ swords */

/** The on-chain snapshot a record builds on. getSword / getUserInfo give these fields */
const baseOf = (chain) => ({
    syncedAt: String(chain?.syncedAt ?? 0),
    value: String(chain?.value ?? 0),
    strikes: Number(chain?.strikes ?? 0),
    furnaceMinutes: Number(chain?.furnaceMinutes ?? 0),
    totalScore: Number(chain?.totalScore ?? 0),
    points: Number(chain?.points ?? 0),
});

/** Starts a record from what the chain says; used for new swords and anything out of date */
const fromChain = (tokenId, owner, chain, previous) => ({
    tokenId: String(tokenId),
    owner: lower(owner),
    base: baseOf(chain),
    value: String(chain?.value ?? 0),
    furnaceSeconds: Number(chain?.furnaceMinutes ?? 0) * 60,
    earnedPoints: Number(chain?.points ?? 0) + Number(chain?.strikes ?? 0),
    strikes: Number(chain?.strikes ?? 0),
    totalScore: Number(chain?.totalScore ?? 0),
    furnace: null,
    strike: null,
    signed: null,
    // Keeps difficulty alternating across a save, as long as the owner is the same
    lastStrike: lower(previous?.owner) === lower(owner) ? previous?.lastStrike ?? null : null,
});

/** A record still sits on top of the chain snapshot (same owner, no save, sale or transfer since) */
const isCurrent = (saved, owner, chain) => Boolean(saved)
    && lower(saved.owner) === lower(owner)
    && String(saved.base?.syncedAt) === String(chain?.syncedAt ?? 0)
    && Number(saved.strikes) >= Number(chain?.strikes ?? 0);

/** The chain now holds exactly what the server signed for this record, so progress made after signing is kept */
const isSignedSave = (saved, owner, chain) => Boolean(saved?.signed)
    && lower(saved.owner) === lower(owner)
    && String(saved.signed.value) === String(chain?.value ?? 0)
    && Number(saved.signed.points) === Number(chain?.points ?? 0)
    && Number(saved.signed.furnaceMinutes) === Number(chain?.furnaceMinutes ?? 0)
    && Number(saved.signed.strikes) === Number(chain?.strikes ?? 0)
    && Number(saved.signed.totalScore) === Number(chain?.totalScore ?? 0)
    && Number(saved.strikes) >= Number(chain?.strikes ?? 0);

/**
 * The record to use for one sword: the saved one if it still fits the chain, a rebased one if the
 * chain just took a save we signed, otherwise a fresh one from the chain.
 * @returns {{ sword: object, isChanged: boolean }}
 */
const resolveSword = (tokenId, owner, chain, saved) => {
    if (isCurrent(saved, owner, chain)) return { sword: saved, isChanged: false };
    if (isSignedSave(saved, owner, chain)) {
        return { sword: { ...saved, base: baseOf(chain), signed: null }, isChanged: true };
    }
    return { sword: fromChain(tokenId, owner, chain, saved), isChanged: true };
};

/** Banks heat up to the 24h cap and empties the furnace. Returns seconds heated */
const coolDown = (sword, now, rate = DEFAULT_RATE) => {
    const heated = Math.max(0, Math.min(Number(now) - Number(sword.furnace?.startedAt ?? now), FURNACE_CAP));
    sword.furnaceSeconds += heated;
    // Heat past the cap is wasted: a weapon holds at most maxPoints unspent points
    const earned = earnedOf(sword) + Math.floor(heated * rate.pointsPerHour / 3600);
    sword.earnedPoints = Math.min(earned, Number(sword.strikes ?? 0) + rate.maxPoints);
    sword.furnace = null;
    return heated;
};

/** Progress not on-chain yet; it lives on the game server until the next list, save or send */
const unsavedOf = (sword) => ({
    strikes: Math.max(0, sword.strikes - Number(sword.base?.strikes ?? 0)),
    minutes: Math.max(0, Math.floor(sword.furnaceSeconds / 60) - Number(sword.base?.furnaceMinutes ?? 0)),
});

/** When the unsaved progress started piling up: the last on-chain save. null when nothing is unsaved */
const unsavedSinceOf = (sword) => {
    const u = unsavedOf(sword);
    return u.strikes > 0 || u.minutes > 0 ? Number(sword.base?.syncedAt ?? 0) : null;
};

const viewOf = (sword, rate = DEFAULT_RATE) => ({
    tokenId: sword.tokenId,
    value: sword.value,
    points: pointsOf(sword, rate),
    // Holding the most points a weapon can bank: more heat is wasted until some are spent
    isFull: pointsOf(sword, rate) >= rate.maxPoints,
    furnaceSeconds: sword.furnaceSeconds,
    earnedPoints: earnedOf(sword),
    strikes: sword.strikes,
    totalScore: sword.totalScore,
    isInFurnace: Boolean(sword.furnace),
    lastStrike: sword.lastStrike,
    unsaved: unsavedOf(sword),
    unsavedSince: unsavedSinceOf(sword),
});

/**
 * Settles every sword of one owner against the chain: stale records reset, listed swords and
 * furnace clashes cool down. Mutates nothing; returns the settled records.
 * @param {string[]} ids          owned token ids (getUserInfo)
 * @param {object[]} chainSwords  matching on-chain swords
 * @param {object} records        tokenId -> server record (may be missing)
 * @param {number} slots          furnace slots (getAccount().furnaces)
 */
function settle(owner, ids, chainSwords, records, slots, now, rate = DEFAULT_RATE) {
    const swords = {};
    const changed = new Set();
    const items = Array(Math.max(1, Number(slots) || DEFAULT_FURNACES)).fill(null);

    ids.forEach((id, i) => {
        const key = String(id);
        const chain = chainSwords[i];
        const { sword: resolved, isChanged } = resolveSword(key, owner, chain, records?.[key]);
        const sword = structuredClone(resolved);
        if (isChanged) changed.add(key);

        const isListed = BigInt(chain?.listPrice ?? 0) > 0n;
        const slot = Number(sword.furnace?.slot);
        // A listed sword cannot heat; a clash or a lost slot just banks the heat
        if (sword.furnace && (isListed || !(slot < items.length) || items[slot])) {
            coolDown(sword, now, rate);
            changed.add(key);
        }
        if (sword.furnace) items[slot] = { tokenId: key, startedAt: sword.furnace.startedAt, endsAt: sword.furnace.startedAt + FURNACE_CAP };
        swords[key] = sword;
    });

    return { swords, changed, furnaces: { slots: items.length, items } };
}

/** Everything the armory needs, in the same shape game/forge.js always returned */
function viewState(settled, now, rate = DEFAULT_RATE) {
    const swords = {};
    Object.values(settled.swords).forEach((s) => { swords[s.tokenId] = viewOf(s, rate); });
    return {
        now,
        swords,
        furnaces: settled.furnaces,
        rules: { pointsPerHour: rate.pointsPerHour, maxPoints: rate.maxPoints, furnaceCap: FURNACE_CAP, strikesPerMonth: rate.strikesPerMonth },
    };
}

/* ------------------------------------------------------------ strike */

/** Small stable hash, so a strike's game and difficulty do not change by reopening it */
const hash = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return h >>> 0;
};

/**
 * Turns three random numbers (0-1) into a roll: the minigame, the level, a little speed jitter
 * inside the level, and a seed the minigame uses for its targets.
 */
const makeRoll = (gamePick, levelPick, jitter, seed) => {
    const games = MINIGAME.games.length ? MINIGAME.games : [ "ring" ];
    const game = games[Math.min(games.length - 1, Math.floor(gamePick * games.length))];
    const difficulty = LEVEL_IDS[Math.min(3, Math.floor(levelPick * 4))];
    const level = MINIGAME.levels[difficulty];
    const wobble = 0.92 + jitter * 0.16;            // +-8% inside the level
    return {
        game,
        difficulty,
        seed,
        closeMs: Math.round(level.ringMs * wobble),
        heatSec: +(level.heatSec * wobble).toFixed(2),
        runeSec: level.runeSec,
        ring: MINIGAME.ring,
        burn: MINIGAME.burn,
        rune: MINIGAME.rune,
    };
};

/**
 * The strike's roll. The server adds a secret salt, so nobody can work out the targets of a
 * strike before the server hands the roll over.
 */
const rollFor = (scope, sword, salt = "") => {
    const h = hash(`${scope}:${sword.tokenId}:${sword.strikes}:${salt}`);
    return makeRoll((h % 997) / 997, ((h >>> 10) % 991) / 991, ((h >>> 20) % 101) / 100, h >>> 1);
};

/** A practice round: same minigame and settings as a real strike, random every time */
function practiceRoll() {
    return {
        ...makeRoll(Math.random(), Math.random(), Math.random(), Math.floor(Math.random() * 2 ** 31)),
        isPractice: true,
        weaponSeed: String(Math.floor(Math.random() * 1e9)),
    };
}

const bucketOf = (score) => (score >= 95 ? "perfect" : score >= 75 ? "clean" : score >= 40 ? "rough" : "glancing");

const emptyStats = () => ({ count: 0, totalScore: 0, valueAdded: "0", perfect: 0, clean: 0, rough: 0, glancing: 0, recent: [] });

/** Spends one point and grows the value; mutates sword and stats */
function applyStrike(sword, stats, session, score, now, rate = DEFAULT_RATE) {
    const quality = Math.round(Math.max(0, Math.min(100, Number(score) || 0)));
    const increase = strikeIncrease(sword.value, quality, rate);
    sword.value = (BigInt(sword.value) + increase).toString();
    sword.strikes += 1;
    sword.totalScore += quality;
    sword.lastStrike = { score: quality, increase: increase.toString(), game: session.game, difficulty: session.difficulty, at: now };

    stats.count += 1;
    stats.totalScore += quality;
    stats.valueAdded = (BigInt(stats.valueAdded) + increase).toString();
    stats[bucketOf(quality)] += 1;
    stats.recent = [ { tokenId: sword.tokenId, game: session.game, difficulty: session.difficulty, score: quality, increase: increase.toString(), at: now }, ...(stats.recent ?? []) ].slice(0, RECENT_STRIKES);

    return { tokenId: sword.tokenId, score: quality, increase: increase.toString(), value: sword.value, points: pointsOf(sword, rate) };
}

/* ---------------------------------------------------------- on-chain */

/**
 * The Stats struct for list / sync / transferWithStats, trimmed to what the contract will accept
 * at `now` (block time), so a clock running a little ahead costs a few minutes of heat instead of
 * a failed transaction.
 */
function statsForChain(sword, chain, now, rate = DEFAULT_RATE) {
    if (sword.furnace) throw new Error("Take the weapon out of the furnace first.");

    const baseMinutes = Number(chain?.furnaceMinutes ?? 0);
    const sinceSave = Math.max(0, Number(now) - CLOCK_MARGIN - Number(chain?.syncedAt ?? 0));
    const furnaceMinutes = Math.max(baseMinutes, Math.min(Math.floor(sword.furnaceSeconds / 60), baseMinutes + Math.floor(sinceSave / 60)));

    // Same rule as the contract: points earned since the last save fit in the heat added since then
    const earnedBefore = Number(chain?.points ?? 0) + Number(chain?.strikes ?? 0);
    const allowed = earnedBefore + Math.floor((furnaceMinutes - baseMinutes) * rate.pointsPerHour / 60);
    const earned = Math.min(earnedOf(sword), allowed, sword.strikes + rate.maxPoints);
    const points = earned - sword.strikes;
    if (points < 0) throw new Error("Your progress is ahead of the chain clock. Try again in a few minutes.");

    const cap = maxValue(chain?.value ?? 0, sword.strikes - Number(chain?.strikes ?? 0), rate);
    const value = BigInt(sword.value) > cap ? cap : BigInt(sword.value);

    return {
        value: value.toString(),
        points: String(points),
        furnaceMinutes: String(furnaceMinutes),
        strikes: String(sword.strikes),
        totalScore: String(sword.totalScore),
    };
}

export {
    MINIGAME, LEVEL_IDS, HIRE, FURNACE_CAP, CLOCK_MARGIN, DEFAULT_FURNACES, DEFAULT_RATE,
    rateFrom, rateOf, strikeIncrease, maxValue, earnedOf, pointsOf,
    baseOf, fromChain, isCurrent, isSignedSave, resolveSword, coolDown, unsavedOf, viewOf, settle, viewState,
    hash, makeRoll, rollFor, practiceRoll, bucketOf, emptyStats, applyStrike, statsForChain,
};
