// Vercel Function: GET /api/jobs — the smiths' jobs board: every weapon out for hire.
//
// → { isOn, items: [ { tokenId, owner, seed, value, points, share, minScore, isBusy, freeAt,
//                      ownerOwed, ownerOwedSince, ownerPaid, blocked } ], now }
//
// One copy for everyone: the edge keeps it 10 seconds, so a busy board costs a couple of Redis
// commands every 10 seconds, not per player.

import { handle, send } from "./_lib/http.js";
import { listJobs } from "./_lib/hire.js";

export default handle(async (req, res) => {
    if (req.method !== "GET") return send(res, 405, { error: "Use GET" });
    return send(res, 200, await listJobs(), { "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30" });
});
