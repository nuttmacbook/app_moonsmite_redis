// Smiths for hire: a player without weapons passes the licensing exam, takes a job from the
// board, and strikes another player's weapon for a share of the value each strike adds.
//
// Where things live (all "<rev>:<json>", written with compare-and-set, see docs.js):
//   owner document  rent[tokenId]   { minScore, share, openedAt, seed, lock: { smith, since, lastAt } | null, closing }
//                   owed[tokenId]   { [smith]: { wei, since, strikes } }      wages not paid yet
//                   hireLog[tokenId] last strikes by smiths
//                   paid            { count, total, bills: [billId] }          bills already counted
//                   bills[tokenId]  the one live bill (signed, unpaid) so wages can't be billed twice
//                   blocked         [smith]
//   smith document  license, job { owner, tokenId }, stats, pending { "<owner>:<tokenId>": { wei, since } }
//   jobs index      { [tokenId]: owner }  every weapon open for hire (the board reads the owners from it)
//
// The whole feature stays off until WAGES_ADDRESS is set: wages have nowhere to go without it.
// The settings (share cap, exam cooldown, lock time) are HIRE in src/game/rules.js.

import { isAddress, Wallet, AbiCoder, keccak256, getBytes } from "ethers";
import { randomBytes } from "node:crypto";
import { getChain } from "./chain.js";
import { keys } from "./keys.js";
import { cmd } from "./redis.js";
import { refuse } from "./http.js";
import { decodeDoc, encodeDoc, decodeRev, encodeRev, readMany, writeMany } from "./docs.js";
import { seal, unseal } from "./seal.js";
import { HIRE, MINIGAME, LEVEL_IDS, makeRoll, hash, resolveSword, pointsOf, rollFor, applyStrike, emptyStats } from "../../src/game/rules.js";
import { scoreLog, COUNTDOWN_MS } from "../../src/game/scoring.js";

const STRIKE_TTL_MS = 15 * 60 * 1000;
const CLOCK_SLACK_MS = 1500;
const WRITE_TRIES = 4;
const BOARD_OWNERS = 500;

const lower = (a) => String(a ?? "").toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
const salt = () => process.env.STRIKE_SALT || process.env.SIGNER_KEY || "dev-salt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = () => refuse("Another device is busy with this job. Try again in a moment.", 409);
const envOf = (...names) => names.map((n) => String(process.env[n] ?? "").trim()).find((v) => v && !v.includes("...")) ?? "";

/* ------------------------------------------------------------ switch */

const wagesAddress = () => {
    const address = envOf("WAGES_ADDRESS", "VITE_WAGES_ADDRESS");
    return isAddress(address) ? address : "";
};

const isHireOn = () => Boolean(wagesAddress());

const requireHire = () => {
    if (!isHireOn()) refuse("Smith jobs are not open yet.", 404);
};

/* ------------------------------------------------------------ shapes */

const emptySmith = () => ({ license: null, job: null, stats: { strikes: 0, valueAdded: "0", wages: "0", recent: [] }, pending: {} });

const smithOf = (raw) => {
    const { rev, value } = decodeRev(raw);
    const doc = { ...emptySmith(), ...(value ?? {}) };
    doc.stats = { ...emptySmith().stats, ...(doc.stats ?? {}) };
    doc.pending = doc.pending ?? {};
    return { rev, doc };
};

const hireOf = (doc) => ({
    rent: doc?.rent ?? {},
    owed: doc?.owed ?? {},
    hireLog: doc?.hireLog ?? {},
    paid: doc?.paid ?? { count: 0, total: "0", bills: [] },
    blocked: doc?.blocked ?? [],
});

const isLockActive = (lock, now = nowSec()) => Boolean(lock?.smith) && now - Number(lock.lastAt ?? 0) < HIRE.lockIdleSec;

const owedTotal = (bySmith) => Object.values(bySmith ?? {}).reduce((sum, x) => sum + BigInt(x?.wei ?? 0), 0n);

/** Oldest unpaid wage across every weapon of an owner, as unix time; 0 when nothing is owed */
const oldestOwed = (owed) => Object.values(owed ?? {}).flatMap((bySmith) => Object.values(bySmith ?? {}))
    .filter((x) => BigInt(x?.wei ?? 0) > 0n)
    .reduce((min, x) => (min && min < Number(x.since) ? min : Number(x.since)), 0);

const allOwed = (owed) => Object.values(owed ?? {}).reduce((sum, bySmith) => sum + owedTotal(bySmith), 0n);

/** Average of the latest strike scores a smith made for others */
const workScoreOf = (stats) => {
    const recent = (stats?.recent ?? []).slice(0, HIRE.workScoreOf);
    return recent.length ? Math.round(recent.reduce((a, b) => a + Number(b), 0) / recent.length) : null;
};

/**
 * What the owner's phone draws about hire: each weapon's job, wages owed by smith and the log.
 * Sent with every game state, so the armory can lock buttons without asking again.
 */
function hireView(doc, now = nowSec()) {
    const { rent, owed, hireLog, paid, blocked } = hireOf(doc);
    const jobs = Object.fromEntries(Object.entries(rent).map(([ id, r ]) => {
        const isBusy = isLockActive(r.lock, now);
        return [ id, {
            minScore: r.minScore, share: r.share, openedAt: r.openedAt, closing: Boolean(r.closing),
            smith: isBusy ? r.lock.smith : null,
            freeAt: isBusy ? Number(r.lock.lastAt) + HIRE.lockIdleSec : 0,
        } ];
    }));
    const wages = Object.fromEntries(Object.entries(owed)
        .map(([ id, bySmith ]) => [ id, {
            total: owedTotal(bySmith).toString(),
            smiths: Object.entries(bySmith).filter(([ , x ]) => BigInt(x?.wei ?? 0) > 0n)
                .map(([ smith, x ]) => ({ smith, wei: String(x.wei), strikes: Number(x.strikes ?? 0), since: Number(x.since ?? 0) })),
        } ])
        .filter(([ , w ]) => BigInt(w.total) > 0n));
    return {
        isOn: isHireOn(),
        jobs,
        wages,
        log: hireLog,
        paid: { count: Number(paid.count ?? 0), total: String(paid.total ?? "0") },
        blocked,
        oldestOwed: oldestOwed(owed),
    };
}

/* ------------------------------------------------------- jobs index */

/**
 * Adds or removes weapons on the jobs board. Runs after the owner's document has landed; the
 * board only lists where to look, so the owner's document stays the source of truth.
 * @param {[ "set" | "del", string, string? ][]} ops  [ op, tokenId, owner ]
 */
async function updateIndex(ops) {
    if (!ops.length) return;
    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        const { rev, value } = decodeRev(await cmd("GET", keys.jobs()));
        const index = { ...(value ?? {}) };
        ops.forEach(([ op, id, owner ]) => {
            if (op === "set") index[id] = lower(owner);
            else delete index[id];
        });
        if (await writeMany([ { key: keys.jobs(), rev, raw: encodeRev(rev + 1, index) } ])) return;
        await sleep(30 + Math.random() * 90 * attempt);
    }
}

/* ------------------------------------------------------------- exam */

/** Every minigame at every level, in that order; the seeds are salted, so no one knows them ahead */
function examRounds(smith, attempt) {
    const games = MINIGAME.games.length ? MINIGAME.games : [ "ring" ];
    return games.flatMap((game, g) => LEVEL_IDS.map((level, l) => {
        const h = hash(`${lower(smith)}:exam:${attempt}:${game}:${level}:${salt()}`);
        return makeRoll((g + 0.5) / games.length, (l + 0.5) / LEVEL_IDS.length, ((h >>> 20) % 101) / 100, h >>> 1);
    }));
}

const nextExamAt = (license) => (license?.takenAt ? Number(license.takenAt) + HIRE.examCooldownSec : 0);

/** The rounds to play and a sealed ticket; nothing is written until the exam is handed in */
async function startExam(smith) {
    requireHire();
    const { doc } = smithOf(await cmd("GET", keys.smith(smith)));
    const now = nowSec();
    if (nextExamAt(doc.license) > now) refuse("You can take the exam again once a day. Come back later.");
    const attempt = Number(doc.license?.attempts ?? 0);
    const ticket = seal("exam", { o: lower(smith), n: attempt, at: Date.now() });
    return { ticket, attempt, rounds: examRounds(smith, attempt) };
}

/**
 * Scores every round from its input log, the same replay as a strike. The license keeps the best
 * score; the next exam opens a day later.
 * @param {object[]} logs  one input log per round, in round order
 */
async function finishExam(smith, ticket, logs) {
    requireHire();
    const t = unseal("exam", ticket);
    if (!t || t.o !== lower(smith)) refuse("This exam has expired. Start a new one.");
    const startedAtMs = Number(t.at);
    if (!(Date.now() - startedAtMs <= HIRE.examTtlSec * 1000)) refuse("This exam took too long. Start a new one.");

    const rounds = examRounds(smith, t.n);
    const list = Array.isArray(logs) ? logs : [];
    if (list.length !== rounds.length) refuse(`Play all ${rounds.length} rounds to finish the exam.`);
    let playMs = 0;
    const scores = rounds.map((roll, i) => {
        try {
            const scored = scoreLog(roll, list[i]);
            playMs += COUNTDOWN_MS + scored.playMs;
            return scored.score;
        } catch (error) {
            return refuse(`Round ${i + 1}: ${error.message}`);
        }
    });
    if (Date.now() - startedAtMs + CLOCK_SLACK_MS * rounds.length < playMs) refuse("This exam finished faster than it can be played. Start a new one.");
    const score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        const { rev, doc } = smithOf(await cmd("GET", keys.smith(smith)));
        const now = nowSec();
        if (Number(doc.license?.attempts ?? 0) !== t.n) refuse("This exam was already handed in.");
        if (nextExamAt(doc.license) > now) refuse("You can take the exam again once a day. Come back later.");
        const best = Math.max(score, Number(doc.license?.best ?? 0));
        doc.license = { best, last: score, takenAt: now, attempts: t.n + 1, scores };
        if (await writeMany([ { key: keys.smith(smith), rev, raw: encodeRev(rev + 1, doc) } ])) {
            return { score, best, scores, nextAt: now + HIRE.examCooldownSec };
        }
        await sleep(30 + Math.random() * 90 * attempt);
    }
    return busy();
}

/* ------------------------------------------------------- smith view */

/** One chain read for the weapon behind a job: its record settled on the chain, and the checks */
async function swordOnChain(owner, tokenId, record) {
    const { swords: [ found ], rate, now } = await getChain().readSwords([ tokenId ]);
    if (!found || found.owner !== lower(owner)) refuse("The owner no longer has this weapon. The job is closed.");
    if (BigInt(found.sword.listPrice ?? 0) > 0n) refuse("The owner listed this weapon for sale. The job is closed.");
    const { sword } = resolveSword(String(tokenId), owner, found.sword, record);
    return { sword: structuredClone(sword), chainSword: found.sword, rate, now };
}

/** The job a smith holds, if its lock is still theirs */
const activeJob = (smith, smithDoc, ownerDoc, now) => {
    const job = smithDoc?.job;
    if (!job) return null;
    const rent = ownerDoc?.rent?.[job.tokenId];
    if (!rent || lower(rent.lock?.smith) !== lower(smith) || !isLockActive(rent.lock, now)) return null;
    return { ...job, rent };
};

/** License, current job, wages waiting on owners: what the smith's page draws (1 or 2 reads) */
async function getSmith(smith) {
    const { doc } = smithOf(await cmd("GET", keys.smith(smith)));
    const now = nowSec();
    let job = null;
    if (doc.job) {
        const { doc: ownerDoc } = decodeDoc(await cmd("GET", keys.owner(doc.job.owner)));
        const held = activeJob(smith, doc, ownerDoc, now);
        if (held) {
            const record = ownerDoc?.swords?.[held.tokenId];
            job = {
                owner: held.owner, tokenId: held.tokenId, share: held.rent.share, seed: held.rent.seed,
                value: String(record?.value ?? "0"), points: pointsOf(record ?? {}),
                freeAt: Number(held.rent.lock.lastAt) + HIRE.lockIdleSec,
                log: (ownerDoc?.hireLog?.[held.tokenId] ?? []).filter((x) => lower(x.smith) === lower(smith)),
            };
        }
    }
    const pending = Object.entries(doc.pending).map(([ key, x ]) => {
        const [ owner, tokenId ] = key.split(":");
        return { owner, tokenId, wei: String(x.wei), since: Number(x.since) };
    }).filter((x) => BigInt(x.wei) > 0n);
    return {
        isOn: isHireOn(),
        license: doc.license ? { ...doc.license, nextAt: nextExamAt(doc.license) } : null,
        workScore: workScoreOf(doc.stats),
        stats: doc.stats,
        job,
        pending,
        pendingTotal: pending.reduce((sum, x) => sum + BigInt(x.wei), 0n).toString(),
        now,
    };
}

/* ------------------------------------------------------------- board */

/**
 * Every weapon open for hire with what a smith needs to choose: share, license needed, points
 * left, whether someone is on it, and how its owner pays. One read for the index, one for the
 * owners; the endpoint is cached at the edge for a few seconds.
 */
async function listJobs() {
    if (!isHireOn()) return { isOn: false, items: [], now: nowSec() };
    const { value: index } = decodeRev(await cmd("GET", keys.jobs()));
    const entries = Object.entries(index ?? {});
    const owners = [ ...new Set(entries.map(([ , o ]) => o)) ].slice(0, BOARD_OWNERS);
    const raws = await readMany(owners.map(keys.owner));
    const docs = Object.fromEntries(owners.map((o, i) => [ o, decodeDoc(raws[i]).doc ]));
    const now = nowSec();

    const items = entries.map(([ tokenId, owner ]) => {
        const doc = docs[owner];
        const rent = doc?.rent?.[tokenId];
        if (!rent || rent.closing) return null;
        const record = doc?.swords?.[tokenId] ?? {};
        const points = pointsOf(record);
        if (points < 1) return null;
        const isBusy = isLockActive(rent.lock, now);
        const { owed, paid } = hireOf(doc);
        return {
            tokenId, owner, seed: rent.seed, value: String(record.value ?? "0"), points,
            share: rent.share, minScore: rent.minScore, openedAt: rent.openedAt,
            isBusy, freeAt: isBusy ? Number(rent.lock.lastAt) + HIRE.lockIdleSec : 0,
            ownerOwed: allOwed(owed).toString(), ownerOwedSince: oldestOwed(owed), ownerPaid: Number(paid.count ?? 0),
            blocked: doc?.blocked ?? [],
        };
    }).filter(Boolean).sort((a, b) => b.share - a.share || b.points - a.points);
    return { isOn: true, items, now };
}

/* ---------------------------------------------------------- jobs */

/**
 * Locks a weapon to this smith. Checks the license, the owner's terms, that nobody else is on it,
 * and on the chain that the owner still holds it unlisted.
 */
async function takeJob(smith, owner, tokenId) {
    requireHire();
    const id = String(tokenId ?? "");
    if (!/^\d+$/.test(id)) refuse("Pick a job from the board.");
    if (!isAddress(owner)) refuse("Pick a job from the board.");
    if (lower(owner) === lower(smith)) refuse("That is your own weapon. Strike it from your armory.");

    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        const [ rawSmith, rawOwner ] = await readMany([ keys.smith(smith), keys.owner(owner) ]);
        const { rev: smithRev, doc: smithDoc } = smithOf(rawSmith);
        const { rev: ownerRev, doc: ownerDoc } = decodeDoc(rawOwner);
        const now = nowSec();
        const rent = ownerDoc?.rent?.[id];
        if (!rent || rent.closing) refuse("This job is closed.");
        if (!smithDoc.license) refuse("Pass the licensing exam first.");
        if (Number(smithDoc.license.best) < Number(rent.minScore)) refuse(`This job needs a license score of ${rent.minScore}.`);
        if ((ownerDoc.blocked ?? []).includes(lower(smith))) refuse("This owner does not take your jobs.");
        if (isLockActive(rent.lock, now) && lower(rent.lock.smith) !== lower(smith)) refuse("Another smith is on this job. Try again later.");

        // Holding another job: it has to end first (a stale pointer to a lapsed lock does not count)
        if (smithDoc.job && !(smithDoc.job.tokenId === id && lower(smithDoc.job.owner) === lower(owner))) {
            const { doc: otherDoc } = decodeDoc(await cmd("GET", keys.owner(smithDoc.job.owner)));
            if (activeJob(smith, smithDoc, otherDoc, now)) refuse("Finish or release your current job first.");
        }

        const { sword } = await swordOnChain(owner, id, ownerDoc.swords?.[id]);
        if (pointsOf(sword) < 1) refuse("This weapon has no strike points left.");

        const since = isLockActive(rent.lock, now) ? rent.lock.since : now;
        ownerDoc.rent = { ...ownerDoc.rent, [id]: { ...rent, lock: { smith: lower(smith), since, lastAt: now } } };
        smithDoc.job = { owner: lower(owner), tokenId: id };
        const ok = await writeMany([
            { key: keys.owner(owner), rev: ownerRev, raw: encodeDoc(ownerRev + 1, ownerDoc) },
            { key: keys.smith(smith), rev: smithRev, raw: encodeRev(smithRev + 1, smithDoc) },
        ]);
        if (ok) return { owner: lower(owner), tokenId: id, share: rent.share, freeAt: now + HIRE.lockIdleSec };
        await sleep(30 + Math.random() * 90 * attempt);
    }
    return busy();
}

/** Ends this smith's job; a hire the owner asked to close closes now */
async function releaseJob(smith) {
    requireHire();
    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        const { rev: smithRev, doc: smithDoc } = smithOf(await cmd("GET", keys.smith(smith)));
        if (!smithDoc.job) return { released: false };
        const { owner, tokenId } = smithDoc.job;
        const { rev: ownerRev, doc: ownerDoc } = decodeDoc(await cmd("GET", keys.owner(owner)));
        const writes = [];
        const indexOps = [];
        const rent = ownerDoc?.rent?.[tokenId];
        if (rent && lower(rent.lock?.smith) === lower(smith)) {
            const nextRent = { ...ownerDoc.rent };
            if (rent.closing) {
                delete nextRent[tokenId];
                indexOps.push([ "del", tokenId ]);
            } else {
                nextRent[tokenId] = { ...rent, lock: null };
            }
            writes.push({ key: keys.owner(owner), rev: ownerRev, raw: encodeDoc(ownerRev + 1, { ...ownerDoc, rent: nextRent }) });
        }
        smithDoc.job = null;
        writes.push({ key: keys.smith(smith), rev: smithRev, raw: encodeRev(smithRev + 1, smithDoc) });
        if (await writeMany(writes)) {
            await updateIndex(indexOps);
            return { released: true };
        }
        await sleep(30 + Math.random() * 90 * attempt);
    }
    return busy();
}

/* ----------------------------------------------------------- strike */

/** The roll for the next strike on the job's weapon: the same roll the owner would get. Writes nothing */
async function startHireStrike(smith) {
    requireHire();
    const { doc: smithDoc } = smithOf(await cmd("GET", keys.smith(smith)));
    if (!smithDoc.job) refuse("Take a job from the board first.");
    const { owner, tokenId } = smithDoc.job;
    const { doc: ownerDoc } = decodeDoc(await cmd("GET", keys.owner(owner)));
    const held = activeJob(smith, smithDoc, ownerDoc, nowSec());
    if (!held) refuse("This job has ended. Take a job from the board.");

    const { sword } = await swordOnChain(owner, tokenId, ownerDoc.swords?.[tokenId]);
    if (pointsOf(sword) < 1) refuse("This weapon has no strike points left.");
    const roll = rollFor(lower(owner), sword, salt());
    const sessionId = seal("hire", { o: lower(smith), w: lower(owner), t: String(tokenId), s: sword.strikes, at: Date.now() });
    return { tokenId: String(tokenId), owner: lower(owner), sessionId, strikesAtStart: sword.strikes, share: held.rent.share, ...roll };
}

/**
 * Scores the smith's strike, grows the owner's weapon, and books the wage on both sides:
 * owed on the owner's weapon, waiting on the smith's page. All in one write.
 */
async function finishHireStrike(smith, sessionId, log) {
    requireHire();
    const t = unseal("hire", sessionId);
    if (!t || t.o !== lower(smith)) refuse("This strike has expired. Start a new one.");
    const startedAtMs = Number(t.at);
    if (!(Date.now() - startedAtMs <= STRIKE_TTL_MS)) refuse("This strike took too long. Start a new one.");

    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        const [ rawSmith, rawOwner ] = await readMany([ keys.smith(smith), keys.owner(t.w) ]);
        const { rev: smithRev, doc: smithDoc } = smithOf(rawSmith);
        const { rev: ownerRev, doc: ownerDoc } = decodeDoc(rawOwner);
        const now = nowSec();
        const held = activeJob(smith, smithDoc, ownerDoc, now);
        if (!held || held.tokenId !== t.t || lower(held.owner) !== t.w) refuse("This job has ended. Take a job from the board.");

        const { sword, rate } = await swordOnChain(t.w, t.t, ownerDoc.swords?.[t.t]);
        if (sword.strikes !== t.s) refuse("This strike has expired. Start a new one.");
        if (pointsOf(sword, rate) < 1) refuse("This weapon has no strike points left.");

        const roll = rollFor(t.w, sword, salt());
        let scored;
        try {
            scored = scoreLog(roll, log);
        } catch (error) {
            refuse(error.message);
        }
        if (Date.now() - startedAtMs + CLOCK_SLACK_MS < COUNTDOWN_MS + scored.playMs) refuse("This strike finished faster than it can be played. Start a new one.");

        const before = BigInt(sword.value);
        const result = applyStrike(sword, emptyStats(), roll, scored.score, now, rate);
        const added = BigInt(sword.value) - before;
        const wage = added * BigInt(held.rent.share) / 100n;
        const who = lower(smith);

        // Owner side: the weapon, the wage it owes, the log, the lock kept alive (or ended)
        const owed = { ...(ownerDoc.owed ?? {}) };
        const bySmith = { ...(owed[t.t] ?? {}) };
        const prev = bySmith[who];
        bySmith[who] = { wei: (BigInt(prev?.wei ?? 0) + wage).toString(), since: Number(prev?.since) || now, strikes: Number(prev?.strikes ?? 0) + 1 };
        owed[t.t] = bySmith;
        const entry = { smith: who, score: scored.score, added: added.toString(), wage: wage.toString(), at: now };
        const hireLog = { ...(ownerDoc.hireLog ?? {}), [t.t]: [ entry, ...(ownerDoc.hireLog?.[t.t] ?? []) ].slice(0, HIRE.logSize) };
        const isOut = pointsOf(sword, rate) < 1;
        const rent = { ...ownerDoc.rent };
        const indexOps = [];
        if (isOut && held.rent.closing) {
            delete rent[t.t];
            indexOps.push([ "del", t.t ]);
        } else {
            rent[t.t] = { ...held.rent, lock: isOut ? null : { ...held.rent.lock, lastAt: now } };
        }
        const nextOwner = { ...ownerDoc, swords: { ...ownerDoc.swords, [t.t]: sword }, owed, hireLog, rent, live: true };

        // Smith side: stats and the wage waiting on this owner
        const key = `${t.w}:${t.t}`;
        const waiting = smithDoc.pending[key];
        smithDoc.pending = { ...smithDoc.pending, [key]: { wei: (BigInt(waiting?.wei ?? 0) + wage).toString(), since: Number(waiting?.since) || now } };
        smithDoc.stats = {
            strikes: Number(smithDoc.stats.strikes ?? 0) + 1,
            valueAdded: (BigInt(smithDoc.stats.valueAdded ?? 0) + added).toString(),
            wages: (BigInt(smithDoc.stats.wages ?? 0) + wage).toString(),
            recent: [ scored.score, ...(smithDoc.stats.recent ?? []) ].slice(0, HIRE.workScoreOf),
        };
        if (isOut) smithDoc.job = null;

        const ok = await writeMany([
            { key: keys.owner(t.w), rev: ownerRev, raw: encodeDoc(ownerRev + 1, nextOwner) },
            { key: keys.smith(smith), rev: smithRev, raw: encodeRev(smithRev + 1, smithDoc) },
        ]);
        if (ok) {
            await updateIndex(indexOps);
            return { ...result, scores: scored.scores, wage: wage.toString(), share: held.rent.share, isJobOver: isOut };
        }
        await sleep(30 + Math.random() * 90 * attempt);
    }
    return busy();
}

/* ------------------------------------------------------------ wages */

let signer = null;
const getSigner = () => {
    if (signer) return signer;
    if (!process.env.SIGNER_KEY) throw new Error("Signer is not configured (SIGNER_KEY)");
    signer = new Wallet(process.env.SIGNER_KEY);
    return signer;
};

const BILL_TYPES = [ "address", "uint256", "string", "address", "uint256", "address[]", "uint256[]", "bytes32", "uint256" ];

/**
 * A signed bill for the wages one weapon owes, ready for Wages.pay. Signed for this owner only,
 * for one use, and it runs out after an hour. Nothing is written: the wages are taken off when the
 * payment shows on the chain (confirmBill).
 */
async function makeBill(owner, doc, tokenId) {
    requireHire();
    const id = String(tokenId);
    const lines = Object.entries(doc?.owed?.[id] ?? {})
        .filter(([ , x ]) => BigInt(x?.wei ?? 0) > 0n)
        .slice(0, HIRE.maxBillSmiths);
    if (!lines.length) refuse("No wages are owed on this weapon.");
    const smiths = lines.map(([ s ]) => s);
    const amounts = lines.map(([ , x ]) => String(x.wei));
    const billId = `0x${randomBytes(32).toString("hex")}`;
    const deadline = nowSec() + HIRE.billTtlSec;
    const chainId = await getChain().chainId();
    if (!chainId) throw new Error("Chain id is not known; the RPC did not answer");
    const digest = keccak256(AbiCoder.defaultAbiCoder().encode(BILL_TYPES, [
        wagesAddress(), chainId, "WAGES", lower(owner), BigInt(id), smiths, amounts.map(BigInt), billId, BigInt(deadline),
    ]));
    const sig = await getSigner().signMessage(getBytes(digest));
    const token = seal("bill", { o: lower(owner), t: id, s: smiths, a: amounts, b: billId });
    const total = amounts.reduce((sum, a) => sum + BigInt(a), 0n).toString();
    return { tokenId: id, smiths, amounts, total, billId, deadline, sig, token };
}

/**
 * Takes a paid bill off the owner's weapon and off every smith's waiting list, once. The bill is
 * checked on the Wages contract first, so only money that really arrived is counted.
 */
async function confirmBill(owner, token) {
    requireHire();
    const bill = unseal("bill", token);
    if (!bill || bill.o !== lower(owner)) refuse("That payment could not be read. Refresh the page.");
    if (!(await getChain().isBillPaid(bill.b))) refuse("The payment is not on the chain yet. Try again in a moment.", 409);

    for (let attempt = 1; attempt <= WRITE_TRIES; attempt++) {
        const raws = await readMany([ keys.owner(owner), ...bill.s.map(keys.smith) ]);
        const { rev: ownerRev, doc: ownerDoc } = decodeDoc(raws[0]);
        const { paid } = hireOf(ownerDoc);
        // Only the weapon's live bill can be counted, once: counting removes it, and a bill is
        // replaced only after it ran out unpaid. An old token sent again changes nothing.
        if (ownerDoc?.bills?.[bill.t]?.billId !== bill.b) return { isCounted: false, billId: bill.b };

        const owed = { ...(ownerDoc.owed ?? {}) };
        const bySmith = { ...(owed[bill.t] ?? {}) };
        let total = 0n;
        bill.s.forEach((smith, i) => {
            const amount = BigInt(bill.a[i]);
            total += amount;
            const left = BigInt(bySmith[smith]?.wei ?? 0) - amount;
            if (left > 0n) bySmith[smith] = { ...bySmith[smith], wei: left.toString() };
            else delete bySmith[smith];
        });
        if (Object.keys(bySmith).length) owed[bill.t] = bySmith;
        else delete owed[bill.t];
        const bills = { ...(ownerDoc.bills ?? {}) };
        delete bills[bill.t];
        const nextOwner = {
            ...ownerDoc, owed, bills, live: true,
            paid: { count: Number(paid.count ?? 0) + 1, total: (BigInt(paid.total ?? 0) + total).toString(), bills: [ bill.b, ...(paid.bills ?? []) ].slice(0, 50) },
        };

        const writes = [ { key: keys.owner(owner), rev: ownerRev, raw: encodeDoc(ownerRev + 1, nextOwner) } ];
        bill.s.forEach((smith, i) => {
            const { rev, doc } = smithOf(raws[i + 1]);
            const key = `${lower(owner)}:${bill.t}`;
            const left = BigInt(doc.pending[key]?.wei ?? 0) - BigInt(bill.a[i]);
            const pending = { ...doc.pending };
            if (left > 0n) pending[key] = { ...pending[key], wei: left.toString() };
            else delete pending[key];
            writes.push({ key: keys.smith(smith), rev, raw: encodeRev(rev + 1, { ...doc, pending }) });
        });
        if (await writeMany(writes)) return { isCounted: true, billId: bill.b, total: total.toString() };
        await sleep(30 + Math.random() * 90 * attempt);
    }
    return busy();
}

export {
    isHireOn, requireHire, wagesAddress, isLockActive, owedTotal, oldestOwed, hireOf, hireView, updateIndex,
    startExam, finishExam, examRounds, getSmith, listJobs, takeJob, releaseJob, startHireStrike, finishHireStrike,
    makeBill, confirmBill, BILL_TYPES,
};
