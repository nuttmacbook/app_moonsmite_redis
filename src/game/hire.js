import { json, postAs } from "./session";

// Smiths for hire, the phone's side. The game server (api/smith.js, api/jobs.js, and the hire
// actions of api/game.js) keeps the licenses, the jobs and the wages owed; this file only asks it.
// Wages themselves are paid and claimed on the Wages contract (web3/intereacts/payWages.js, claimWages.js).

const lower = (a) => String(a ?? "").toLowerCase();

/* ------------------------------------------------------------ reads */

/** License, current job and wages waiting on owners; null when hire is off or the server is down */
async function loadSmith(account) {
    if (!account) return null;
    try {
        return await json(`/api/smith?wallet=${lower(account)}`);
    } catch {
        return null;
    }
}

/** Every weapon out for hire (one shared copy, a few seconds old at most) */
const loadJobs = () => json("/api/jobs");

/* ------------------------------------------------------------ smith */

const smithAct = async (account, action, body = {}) => postAs(lower(account), "/api/smith", { action, ...body });

/** The exam's rounds (every minigame at every level) and the ticket to hand them in with */
const startExam = async (account) => (await smithAct(account, "exam.start")).result;

/** @returns {Promise<{ result: { score, best, scores, nextAt }, smith }>} */
const finishExam = (account, ticket, logs) => smithAct(account, "exam.finish", { ticket, logs });

const takeJob = (account, from, tokenId) => smithAct(account, "job.take", { from: lower(from), tokenId: String(tokenId) });

const releaseJob = (account) => smithAct(account, "job.release");

/** The roll for the next strike on the job's weapon */
const startHireStrike = async (account) => (await smithAct(account, "strike.start")).result;

/** @returns {Promise<{ result: { score, increase, value, points, wage, share, isJobOver }, smith }>} */
const finishHireStrike = (account, session, log) => smithAct(account, "strike.finish", { sessionId: session.sessionId, log });

/* ------------------------------------------------------------ owner */

const ownerAct = async (account, action, body = {}) => postAs(lower(account), "/api/game", { action, ...body });

const openHire = (account, tokenId, minScore, share) => ownerAct(account, "hire.open", { tokenId: String(tokenId), minScore: Number(minScore), share: Number(share) });

const closeHire = (account, tokenId) => ownerAct(account, "hire.close", { tokenId: String(tokenId) });

const blockSmith = (account, smith, isBlocked = true) => ownerAct(account, "hire.block", { smith: lower(smith), isBlocked });

/** A signed bill for the wages one weapon owes: what Wages.pay takes */
const billWages = async (account, tokenId) => (await ownerAct(account, "wages.bill", { tokenId: String(tokenId) })).result;

/**
 * Tells the game server a bill was paid, so the weapon unlocks. The server checks the contract
 * itself; right after the transaction the RPC may lag a block, so it asks a few times.
 */
async function confirmWages(account, token) {
    let lastError;
    for (let i = 0; i < 5; i++) {
        try {
            return (await ownerAct(account, "wages.confirm", { token })).result;
        } catch (error) {
            lastError = error;
            if (error?.status !== 409) throw error;
            await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        }
    }
    throw lastError;
}

export {
    loadSmith, loadJobs, startExam, finishExam, takeJob, releaseJob, startHireStrike, finishHireStrike,
    openHire, closeHire, blockSmith, billWages, confirmWages,
};
