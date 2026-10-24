// Sign-in with the wallet, once a day per device.
//
// The phone asks for a message, the wallet signs it (no transaction, no gas), and the server
// answers with a session token that lasts 24 hours. Every action that changes progress (furnace,
// strike, save) needs that token, so nobody can play another wallet's weapons.
//
// Nothing is stored for this: the nonce is derived from the wallet and a 5-minute time window,
// and the token carries the wallet and its expiry, sealed with the server's key (seal.js). Tokens
// from the previous version (64 hex characters, kept in Redis) still work until they expire.

import { verifyMessage, isAddress } from "ethers";
import { cmd } from "./redis.js";
import { refuse } from "./http.js";
import { keys } from "./keys.js";
import { seal, unseal, digest } from "./seal.js";

const SESSION_SEC = 24 * 60 * 60;
const WINDOW_SEC = 5 * 60;
const WINDOWS = 3;          // a sign-in message stays good for 10 to 15 minutes

const lower = (a) => String(a ?? "").toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
const windowOf = (sec) => Math.floor(sec / WINDOW_SEC);

/** The exact text the wallet signs; the phone shows it in the wallet as is */
const loginMessage = (owner, nonce, expiresAt) => [
    "Moon Smith sign-in",
    "",
    `Wallet: ${lower(owner)}`,
    `Nonce: ${nonce}`,
    `Valid until: ${new Date(expiresAt * 1000).toISOString()}`,
    "",
    "Signing proves this wallet is yours. It is not a transaction and costs no gas.",
].join("\n");

/** Nonce and expiry for one time window: the same inputs always give the same message */
const ticketOf = (owner, window) => ({
    nonce: digest("nonce", `${lower(owner)}:${window}`),
    expiresAt: (window + 1) * WINDOW_SEC + SESSION_SEC,
});

/** Step 1: the message to sign */
async function startLogin(owner) {
    if (!isAddress(owner)) refuse("Wallet address is not valid.");
    const { nonce, expiresAt } = ticketOf(owner, windowOf(nowSec()));
    return { message: loginMessage(owner, nonce, expiresAt), expiresAt };
}

/** Step 2: checks the signature against the last few windows and opens a 24h session */
async function finishLogin(owner, signature) {
    if (!isAddress(owner)) refuse("Wallet address is not valid.");
    const now = windowOf(nowSec());
    let opened = null;
    for (let w = now; w > now - WINDOWS && !opened; w--) {
        const { nonce, expiresAt } = ticketOf(owner, w);
        let signer = "";
        try {
            signer = verifyMessage(loginMessage(owner, nonce, expiresAt), String(signature ?? ""));
        } catch {
            refuse("That signature could not be read. Please try again.");
        }
        if (lower(signer) === lower(owner)) opened = { expiresAt };
    }
    if (!opened) refuse("That sign-in request expired or is from a different wallet. Please try again.", 401);

    const token = seal("session", { o: lower(owner), e: opened.expiresAt });
    return { token, owner: lower(owner), expiresAt: opened.expiresAt };
}

/** The wallet behind a token, or "" */
async function ownerOfToken(token) {
    // Signed in before this version: the token is in Redis until it expires
    if (/^[0-9a-f]{64}$/.test(token)) return lower(await cmd("GET", keys.session(token)) ?? "");
    const session = unseal("session", token);
    return session && Number(session.e) > nowSec() ? lower(session.o) : "";
}

/** The wallet behind the request's session token, or a 401 the phone answers by signing in again */
async function requireOwner(req, owner) {
    const header = String(req.headers?.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const who = token ? await ownerOfToken(token) : "";
    if (!who) refuse("Please sign in with your wallet again.", 401);
    if (owner && lower(owner) !== who) refuse("Signed in with a different wallet. Please sign in again.", 401);
    return who;
}

export { loginMessage, startLogin, finishLogin, requireOwner, SESSION_SEC };
