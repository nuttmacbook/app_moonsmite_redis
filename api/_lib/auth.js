// Sign-in with the wallet, once a day per device.
//
// The phone asks for a nonce, the wallet signs a plain message (no transaction, no gas), and the
// server answers with a session token that lasts 24 hours. Every action that changes progress
// (furnace, strike, save) needs that token, so nobody can play another wallet's weapons.

import { verifyMessage, isAddress } from "ethers";
import { randomBytes } from "node:crypto";
import { cmd } from "./redis.js";
import { refuse } from "./http.js";
import { keys } from "./keys.js";

const SESSION_SEC = 24 * 60 * 60;
const NONCE_SEC = 10 * 60;

const lower = (a) => String(a ?? "").toLowerCase();

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

/** Step 1: a fresh nonce and the message to sign */
async function startLogin(owner) {
    if (!isAddress(owner)) refuse("Wallet address is not valid.");
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SEC;
    await cmd("SET", keys.nonce(owner), JSON.stringify({ nonce, expiresAt }), "EX", NONCE_SEC);
    return { message: loginMessage(owner, nonce, expiresAt), expiresAt };
}

/** Step 2: checks the signature and opens a 24h session */
async function finishLogin(owner, signature) {
    if (!isAddress(owner)) refuse("Wallet address is not valid.");
    const raw = await cmd("GETDEL", keys.nonce(owner));
    if (!raw) refuse("That sign-in request expired. Please try again.");
    const { nonce, expiresAt } = JSON.parse(raw);

    let signer = "";
    try {
        signer = verifyMessage(loginMessage(owner, nonce, expiresAt), String(signature ?? ""));
    } catch {
        refuse("That signature could not be read. Please try again.");
    }
    if (lower(signer) !== lower(owner)) refuse("That signature is from a different wallet.", 401);

    const token = randomBytes(32).toString("hex");
    await cmd("SET", keys.session(token), lower(owner), "EX", Math.max(60, expiresAt - Math.floor(Date.now() / 1000)));
    return { token, owner: lower(owner), expiresAt };
}

/** The wallet behind the request's session token, or a 401 the phone answers by signing in again */
async function requireOwner(req, owner) {
    const header = String(req.headers?.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const who = token && /^[0-9a-f]{64}$/.test(token) ? await cmd("GET", keys.session(token)) : null;
    if (!who) refuse("Please sign in with your wallet again.", 401);
    if (owner && lower(owner) !== lower(who)) refuse("Signed in with a different wallet. Please sign in again.", 401);
    return lower(who);
}

export { loginMessage, startLogin, finishLogin, requireOwner, SESSION_SEC };
