// Minigame scoring shared by the phone (live play) and the game server (replay).
//
// The phone records what the player did (tap and hold times, runes tapped) and sends that log
// with the finished strike. The server rebuilds the same targets from the strike's seed and
// scores the log again with these functions, so a score the player never played cannot be sent.
// Everything here is pure; all times are milliseconds from the moment the game went live.

/** Seeded random, so the server can rebuild the exact targets the phone showed */
const rng = (seed) => {
    let t = (Number(seed) >>> 0) || 1;
    return () => {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
};

const average = (scores) => Math.round(scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length));

const clampScore = (n) => Math.max(0, Math.min(100, Math.round(n)));

// Countdown before every minigame (kit.js): 300ms lead, 4 beats, the level, then START!
const COUNTDOWN_MS = 300 + 4 * 650 + 900 + 600 * 0.6;

/* ------------------------------------------------------------ ring */

const RING_START_SCALE = 3;   // rings start at 3x the target size
const RING_MISS_SCALE = 0.35; // a ring shrinking past this without a tap is a miss

/**
 * Every target of a hammer-ring strike: when it appears and how forgiving it is.
 * Positions on screen come from a second random stream, so screen size never changes a score.
 */
const ringPlan = (roll) => {
    const cfg = roll?.ring ?? {};
    const blows = Number(cfg.blows ?? 10);
    const closeMs = Number(roll?.closeMs ?? 1100);
    const spawnMs = closeMs * Math.max(0.15, Number(cfg.spawnEvery ?? 0.5));
    const big = Number(cfg.biggestPx ?? 88);
    const small = Number(cfg.smallestPx ?? 40);
    const easy = Number(cfg.easyTolerance ?? 0.18);
    const hard = Number(cfg.hardTolerance ?? 0.05);
    const hardness = Math.max(0.1, Number(cfg.hardness ?? 1));
    const falloff = Number(cfg.falloff ?? 0.65) / hardness;
    const rand = rng(roll?.seed);

    const targets = Array.from({ length: blows }, (_, k) => {
        const t = rand();
        return {
            index: k,
            startMs: k * spawnMs,
            size: Math.round(big - t * (big - small)),
            tolerance: (easy - t * (easy - hard)) / hardness,
        };
    });
    const missMs = closeMs * (1 - RING_MISS_SCALE / RING_START_SCALE);
    return { blows, closeMs, spawnMs, missMs, falloff, targets };
};

/** Ring size relative to its target at `atMs` (1 = landed) */
const ringScale = (plan, target, atMs) => RING_START_SCALE * (1 - Math.min(1, (atMs - target.startMs) / plan.closeMs));

/** Score of one tap on one target */
const ringTapScore = (plan, target, atMs) => {
    const off = Math.abs(ringScale(plan, target, atMs) - 1);
    return off <= target.tolerance ? 100 : clampScore(100 * (1 - (off - target.tolerance) / plan.falloff));
};

/**
 * Replays a hammer-ring strike. A tap always strikes the oldest target on screen; a target whose
 * ring shrinks past it without a tap scores 0.
 * @param {number[]} taps  tap times
 * @returns {{ scores: number[], score: number }}
 */
const scoreRing = (roll, taps) => {
    const plan = ringPlan(roll);
    const scores = Array(plan.blows).fill(null);
    let next = 0;   // oldest target not resolved yet

    const expire = (atMs) => {
        while (next < plan.blows && plan.targets[next].startMs + plan.missMs <= atMs) scores[next++] = 0;
    };

    [ ...taps ].map(Number).filter(Number.isFinite).sort((a, b) => a - b).forEach((at) => {
        expire(at);
        if (next >= plan.blows) return;
        const target = plan.targets[next];
        if (target.startMs > at) return;            // nothing on screen yet
        scores[next++] = ringTapScore(plan, target, at);
    });
    for (; next < plan.blows; next++) scores[next] = 0;

    return { scores, score: average(scores) };
};

/* ------------------------------------------------------------ burn */

/** Target hold time of every blow in a flame-burn strike, and the scoring windows */
const burnPlan = (roll) => {
    const cfg = roll?.burn ?? {};
    const blows = Number(cfg.blows ?? 5);
    const heatSec = Math.max(0.5, Number(roll?.heatSec ?? 2.5));
    const hardness = Math.max(0.1, Number(cfg.hardness ?? 1));
    const perfect = Number(cfg.perfectSec ?? 0.06) / hardness;
    const falloff = Math.max(0.03, Number(cfg.falloffSec ?? 0.6) / hardness);
    const minHold = Number(cfg.minHoldSec ?? 0.3);
    // Targets stay below full black so there is always a right moment to let go
    const maxHold = Math.min(Number(cfg.maxHoldSec ?? 2.0), heatSec * 0.9);
    const rand = rng(roll?.seed);
    const targets = Array.from({ length: blows }, () => +(minHold + rand() * Math.max(0.05, maxHold - minHold)).toFixed(2));
    // A hold this long lets go by itself (the weapon is burnt)
    return { blows, heatSec, perfect, falloff, targets, maxHeldSec: heatSec * 1.15 };
};

/** Score of letting go after `heldSec` on a target of `target` seconds */
const burnHoldScore = (plan, target, heldSec) => {
    const held = Math.min(Math.max(0, heldSec), plan.maxHeldSec);
    const off = Math.abs(held - target);
    return off <= plan.perfect ? 100 : clampScore(100 * (1 - (off - plan.perfect) / plan.falloff));
};

/**
 * Replays a flame-burn strike.
 * @param {{ down: number, up: number }[]} holds  press and release times, one per blow, in order
 */
const scoreBurn = (roll, holds) => {
    const plan = burnPlan(roll);
    const scores = plan.targets.map((target, k) => {
        const h = holds?.[k];
        if (!h || !Number.isFinite(Number(h.down)) || !Number.isFinite(Number(h.up))) return 0;
        return burnHoldScore(plan, target, (Number(h.up) - Number(h.down)) / 1000);
    });
    return { scores, score: average(scores) };
};

/* ------------------------------------------------------------ rune */

const RUNE_COUNT = 12;

/** Every round of a rune-memory strike: the color asked for and the 12 rune colors */
const runePlan = (roll) => {
    const cfg = roll?.rune ?? {};
    const rounds = Number(cfg.rounds ?? 3);
    const minTarget = Math.max(1, Number(cfg.minTarget ?? 2));
    const maxTarget = Math.min(RUNE_COUNT - 1, Number(cfg.maxTarget ?? 10));
    const answerMs = Number(cfg.answerSec ?? 2.0) * 1000;
    const rand = rng(roll?.seed);

    const deal = (want) => {
        for (let tries = 0; tries < 50; tries++) {
            const colors = Array.from({ length: RUNE_COUNT }, () => (rand() < 0.5 ? "red" : "green"));
            const n = colors.filter((c) => c === want).length;
            if (n >= minTarget && n <= maxTarget) return colors;
        }
        return Array.from({ length: RUNE_COUNT }, (_, i) => (i % 2 ? "red" : want));
    };

    const list = Array.from({ length: rounds }, () => {
        const want = rand() < 0.5 ? "red" : "green";
        const colors = deal(want);
        return { want, colors, total: colors.filter((c) => c === want).length };
    });
    return { rounds, answerMs, list };
};

/**
 * Score of one rune round. Taps after the timer, repeats, and taps after every right rune was
 * found do not count, the same as on screen.
 * @param {{ i: number, t: number }[]} taps  rune index and time from the moment the color was asked
 */
const runeRoundScore = (plan, round, taps) => {
    const used = new Set();
    let right = 0;
    let wrong = 0;
    [ ...(taps ?? []) ].filter((x) => Number.isFinite(Number(x?.t))).sort((a, b) => Number(a.t) - Number(b.t)).forEach((tap) => {
        const i = Number(tap.i);
        if (right >= round.total || Number(tap.t) > plan.answerMs || Number(tap.t) < 0) return;
        if (!(i >= 0 && i < RUNE_COUNT) || used.has(i)) return;
        used.add(i);
        if (round.colors[i] === round.want) right++;
        else wrong++;
    });
    return clampScore(((right - wrong) / round.total) * 100);
};

/** @param {{ i: number, t: number }[][]} rounds  taps per round */
const scoreRune = (roll, rounds) => {
    const plan = runePlan(roll);
    const scores = plan.list.map((round, k) => runeRoundScore(plan, round, rounds?.[k] ?? []));
    return { scores, score: average(scores) };
};

/* ------------------------------------------------------------ any */

/**
 * Scores the log of any minigame. The log comes from the phone, so its shape is checked here.
 * @param {object} roll  the strike's roll
 * @param {object} log   { game, taps } | { game, holds } | { game, rounds }
 * @returns {{ scores: number[], score: number, playMs: number }} playMs = time from go to the last input
 */
const scoreLog = (roll, log) => {
    const game = roll?.game;
    if (log?.game !== game) throw new Error("This strike was played as a different game.");

    if (game === "ring") {
        const taps = Array.isArray(log.taps) ? log.taps.slice(0, 200).map(Number).filter(Number.isFinite) : [];
        const out = scoreRing(roll, taps);
        return { ...out, playMs: Math.max(0, ...taps) };
    }
    if (game === "burn") {
        const holds = Array.isArray(log.holds) ? log.holds.slice(0, 20) : [];
        // Holds come one after another
        for (let k = 1; k < holds.length; k++) {
            if (Number(holds[k].down) < Number(holds[k - 1].up)) throw new Error("This strike's holds overlap.");
        }
        const out = scoreBurn(roll, holds);
        return { ...out, playMs: Math.max(0, ...holds.map((h) => Number(h.up) || 0)) };
    }
    if (game === "rune") {
        const rounds = Array.isArray(log.rounds) ? log.rounds.slice(0, 10).map((r) => (Array.isArray(r) ? r.slice(0, 24) : [])) : [];
        const out = scoreRune(roll, rounds);
        // Each round takes at least the reveal and the question before the first tap
        const plan = runePlan(roll);
        const revealMs = Math.max(0.2, Number(roll?.runeSec ?? 2.0)) * 1000;
        const playMs = plan.rounds * (revealMs + 750) + (plan.rounds - 1) * 1800;
        return { ...out, playMs };
    }
    throw new Error("Unknown minigame.");
};

export {
    rng, average, COUNTDOWN_MS,
    RING_START_SCALE, RING_MISS_SCALE, ringPlan, ringScale, ringTapScore, scoreRing,
    burnPlan, burnHoldScore, scoreBurn,
    RUNE_COUNT, runePlan, runeRoundScore, scoreRune,
    scoreLog,
};
