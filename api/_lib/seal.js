// Signed tokens that need no Redis: "<payload>.<mac>", both base64url. The server can trust what
// it handed out earlier without storing it, because only the server knows the secret.
//
// Used for the sign-in token (24h) and the strike ticket (15 min). Each use gets its own key,
// derived from a server secret, so a token of one kind is never accepted as another.
//
// Env: SESSION_SECRET (optional, any long random text). Without it the keys are derived from
// SIGNER_KEY, which every deploy already has. STRIKE_SALT is mixed in for strike tickets.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const envOf = (...names) => names.map((n) => String(process.env[n] ?? "").trim()).find((v) => v && !v.includes("...")) ?? "";

const keyCache = new Map();

/** A key for one purpose ("session", "nonce", "strike"), never the raw secret itself */
function keyOf(purpose) {
    if (keyCache.has(purpose)) return keyCache.get(purpose);
    const base = envOf("SESSION_SECRET", "SIGNER_KEY");
    if (!base) throw new Error("Server secret is not configured (SESSION_SECRET or SIGNER_KEY)");
    const extra = purpose === "strike" ? envOf("STRIKE_SALT") : "";
    const key = createHash("sha256").update(`moonsmith:${purpose}:${extra}:${base}`).digest();
    keyCache.set(purpose, key);
    return key;
}

const mac = (purpose, text) => createHmac("sha256", keyOf(purpose)).update(text).digest("base64url");

/** Hex digest, for values that go inside a message the wallet shows */
const digest = (purpose, text, length = 32) => createHmac("sha256", keyOf(purpose)).update(text).digest("hex").slice(0, length);

/** { ... } -> "<payload>.<mac>" */
function seal(purpose, payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${mac(purpose, body)}`;
}

/** "<payload>.<mac>" -> { ... }, or null when it was not made here for this purpose */
function unseal(purpose, token) {
    const text = String(token ?? "");
    const at = text.indexOf(".");
    if (at < 1 || text.length > 2048) return null;
    const body = text.slice(0, at);
    const a = Buffer.from(text.slice(at + 1));
    const b = Buffer.from(mac(purpose, body));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
        return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }
}

/** Tests change the env between runs */
const resetSealKeys = () => keyCache.clear();

export { seal, unseal, digest, resetSealKeys };
