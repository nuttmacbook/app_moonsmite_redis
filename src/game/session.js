import { box } from "../web3/connect";
import { Forge } from "../web3/contracts/contract_forge";
import { read, write, remove } from "./storage";
import { notify } from "../componants/txModal";

// Sign-in to the game server. The wallet signs a one-time message (no gas, no transaction), the
// server checks the signature and hands back a token that works for 24 hours. Every change to
// game progress (furnace, strike, save) carries that token, so only the wallet's owner can make it.
//
// Storage: forge:<contract>:session:<address>   { token, expiresAt }

const scope = String(Forge.address).toLowerCase();
const sessionKey = (owner) => `forge:${scope}:session:${String(owner).toLowerCase()}`;
const EARLY_SEC = 120;          // sign in again a little before the server would refuse

let signingIn = null;

const valid = (owner) => {
    const saved = read(sessionKey(owner));
    return saved?.token && Number(saved.expiresAt) - EARLY_SEC > Date.now() / 1000 ? saved.token : null;
};

const forget = (owner) => remove(sessionKey(owner));

async function json(path, init) {
    let res;
    try {
        res = await fetch(path, init);
    } catch {
        throw new Error("Could not reach the game server. Check your connection and try again.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const error = new Error(body?.error ?? "The game server could not do that. Please try again.");
        error.status = res.status;
        throw error;
    }
    return body;
}

async function signIn(owner) {
    const wallet = await box.getCurrentState();
    if (String(wallet?.address ?? "").toLowerCase() !== String(owner).toLowerCase() || !wallet?.signer) {
        throw new Error("Wallet is not connected.");
    }
    notify.pending({ stage: "login" });
    const { message } = await json(`/api/session?owner=${owner}`);
    const signature = await wallet.signer.signMessage(message);
    const out = await json("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, signature }),
    });
    write(sessionKey(owner), { token: out.token, expiresAt: out.expiresAt });
    notify.close();
    return out.token;
}

/** The wallet's token, signing in first when there is none or it ran out (once a day) */
async function ensureSession(owner) {
    const token = valid(owner);
    if (token) return token;
    // Two taps at once share one signature request
    signingIn ??= signIn(owner).finally(() => (signingIn = null));
    return signingIn;
}

/** True when no wallet signature is needed for the next action */
const hasSession = (owner) => Boolean(valid(owner));

/**
 * POST to the game server as this wallet. A refused token (signed out on the server, or another
 * wallet) clears it and signs in once more.
 */
async function postAs(owner, path, body) {
    const send = async (token) => json(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body, owner }),
    });
    try {
        return await send(await ensureSession(owner));
    } catch (error) {
        if (error?.status !== 401) throw error;
        forget(owner);
        return send(await ensureSession(owner));
    }
}

export { ensureSession, hasSession, postAs, json };
