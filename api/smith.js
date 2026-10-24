// Vercel Function: /api/smith — smiths for hire: the licensing exam and jobs on other players' weapons.
//
// GET  ?wallet=0x…                → license, current job, wages waiting on owners (no sign-in)
// POST { owner, action, ... }     → needs the session token; `owner` is the smith's own wallet
//
// Actions:
//   exam.start                         → the rounds to play and a sealed ticket
//   exam.finish   { ticket, logs }     → scores every round from its input log
//   job.take      { from, tokenId }    → locks that owner's weapon to this smith
//   job.release                        → ends the job
//   strike.start                       → the roll for the next strike on the job's weapon
//   strike.finish { sessionId, log }   → scores it, grows the weapon, books the wage
//
// Off (404) until WAGES_ADDRESS is set. Settings: HIRE in src/game/rules.js.

import { isAddress } from "ethers";
import { handle, readBody, queryOf, refuse, send } from "./_lib/http.js";
import { requireOwner } from "./_lib/auth.js";
import { assertOpen } from "./_lib/maintenance.js";
import { getSmith, startExam, finishExam, takeJob, releaseJob, startHireStrike, finishHireStrike } from "./_lib/hire.js";

const ACTIONS = {
    "exam.start":    (smith) => startExam(smith),
    "exam.finish":   (smith, b) => finishExam(smith, b.ticket, b.logs),
    "job.take":      (smith, b) => takeJob(smith, String(b.from ?? "").toLowerCase(), b.tokenId),
    "job.release":   (smith) => releaseJob(smith),
    "strike.start":  (smith) => startHireStrike(smith),
    "strike.finish": (smith, b) => finishHireStrike(smith, b.sessionId, b.log),
};

// Actions that change the smith's page send the new page back; the rest skip that read
const WITH_PAGE = new Set([ "exam.finish", "job.take", "job.release", "strike.finish" ]);

export default handle(async (req, res) => {
    if (req.method === "GET") {
        const wallet = String(queryOf(req).wallet ?? "").toLowerCase();
        if (!isAddress(wallet)) refuse("Wallet address is not valid");
        return send(res, 200, await getSmith(wallet));
    }

    if (req.method !== "POST") return send(res, 405, { error: "Use GET or POST" });
    const body = await readBody(req);
    const smith = String(body?.owner ?? "").toLowerCase();
    if (!isAddress(smith)) refuse("Wallet address is not valid");
    const run = ACTIONS[String(body?.action)];
    if (!run) refuse("Unknown action");
    await assertOpen();

    await requireOwner(req, smith);
    const result = await run(smith, body);
    return send(res, 200, WITH_PAGE.has(String(body.action)) ? { result, smith: await getSmith(smith) } : { result });
});
