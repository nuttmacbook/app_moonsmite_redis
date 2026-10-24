// Vercel Function: /api/game — the furnace and the strike, kept on the game server.
//
// GET  ?owner=0x…&ids=1,2,3   → { records, stats, now }   no sign-in, no chain read, 1 Redis command
// POST { owner, action, ... } → { result, game, stats }   needs the session token, 2 Redis commands
//
// No per-request counters here (they cost Redis commands on every call): limit floods with a
// Vercel Firewall rate-limit rule on /api/ instead (see the runbook).
//
// Actions:
//   furnace.start  { tokenId }
//   furnace.stop   { tokenId }
//   strike.start   { tokenId }                      → the roll to play and a sealed ticket (sessionId)
//   strike.finish  { tokenId, sessionId, log }      → score replayed from the input log
//   import         { records, stats }               once: progress the phone kept before this server existed

import { isAddress } from "ethers";
import { handle, readBody, queryOf, refuse, send } from "./_lib/http.js";
import { requireOwner } from "./_lib/auth.js";
import { assertOpen } from "./_lib/maintenance.js";
import { readRecords, startFurnace, stopFurnace, startStrike, finishStrike, importRecords } from "./_lib/game.js";

const ACTIONS = {
    "furnace.start": (owner, b) => startFurnace(owner, b.tokenId),
    "furnace.stop":  (owner, b) => stopFurnace(owner, b.tokenId),
    "strike.start":  (owner, b) => startStrike(owner, b.tokenId),
    "strike.finish": (owner, b) => finishStrike(owner, b.tokenId, b.sessionId, b.log),
    "import":        (owner, b) => importRecords(owner, b.records, b.stats),
};

export default handle(async (req, res) => {
    if (req.method === "GET") {
        const q = queryOf(req);
        const owner = String(q.owner ?? "").toLowerCase();
        if (!isAddress(owner)) refuse("Wallet address is not valid");
        const ids = String(q.ids ?? "").split(",").filter(Boolean);
        return send(res, 200, await readRecords(owner, ids));
    }

    if (req.method !== "POST") return send(res, 405, { error: "Use GET or POST" });
    const body = await readBody(req);
    const owner = String(body?.owner ?? "").toLowerCase();
    if (!isAddress(owner)) refuse("Wallet address is not valid");
    const run = ACTIONS[String(body?.action)];
    if (!run) refuse("Unknown action");
    await assertOpen();

    await requireOwner(req, owner);

    return send(res, 200, await run(owner, body));
});
