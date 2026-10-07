// Vercel Function: /api/session — sign in with the wallet, once a day per device.
//
// GET  ?owner=0x…                 → { message, expiresAt }   the text the wallet signs
// POST { owner, signature }       → { token, owner, expiresAt }

import { handle, readBody, queryOf, refuse, send, clientIp } from "./_lib/http.js";
import { startLogin, finishLogin } from "./_lib/auth.js";
import { underLimit } from "./_lib/redis.js";
import { keys } from "./_lib/keys.js";

export default handle(async (req, res) => {
    if (!(await underLimit(keys.limit("session", clientIp(req)), 30, 60))) refuse("Too many sign-in attempts. Wait a minute and try again.", 429);

    if (req.method === "GET") {
        return send(res, 200, await startLogin(String(queryOf(req).owner ?? "")));
    }
    if (req.method === "POST") {
        const body = await readBody(req);
        return send(res, 200, await finishLogin(String(body?.owner ?? ""), body?.signature));
    }
    return send(res, 405, { error: "Use GET or POST" });
});
