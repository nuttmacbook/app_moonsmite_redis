// Vercel Function: POST /api/sign
//
// Signs weapon progress before it goes on-chain, with the game's signer key. The key lives only
// here, in the server-side env SIGNER_KEY (no VITE_ prefix), so it never reaches a browser.
//
// The numbers come from the game server's own records (api/_lib/game.js), not from the phone:
// the phone only says which weapons to save. Every item is still checked against the chain the
// same way the contract will check it, plus the growth-formula rule, before it is signed.
//
// Header:   Authorization: Bearer <session token from /api/session>
// Body:     { owner: "0x…", items: [ { tokenId: "12" } ] }
// Response: { items: [ { tokenId, stats, deadline, sig } ] }
//
// Env: SIGNER_KEY (required), FORGE_ADDRESS, RPC_URL, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

import { Wallet, AbiCoder, keccak256, getBytes, isAddress } from "ethers";
import { handle, readBody, refuse, send } from "./_lib/http.js";
import { requireOwner } from "./_lib/auth.js";
import { statsToSign } from "./_lib/game.js";
import { getChain } from "./_lib/chain.js";
import { underLimit } from "./_lib/redis.js";
import { keys } from "./_lib/keys.js";

const MAX_ITEMS = 30;
const TTL = 60 * 60;
const TYPES = [ "address", "uint256", "string", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256" ];

let signer = null;
const getSigner = () => {
    if (signer) return signer;
    if (!process.env.SIGNER_KEY) throw new Error("Signer is not configured (SIGNER_KEY)");
    signer = new Wallet(process.env.SIGNER_KEY);
    return signer;
};

export default handle(async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
    const body = await readBody(req);
    const owner = String(body?.owner ?? "").toLowerCase();
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!isAddress(owner)) refuse("Wallet address is not valid");
    if (items.length < 1 || items.length > MAX_ITEMS) refuse(`Sign 1 to ${MAX_ITEMS} weapons at a time`);

    await requireOwner(req, owner);
    if (!(await underLimit(keys.limit("sign", owner), 20, 60))) refuse("Too many saves at once. Wait a minute and try again.", 429);

    const tokenIds = items.map((item) => String(item?.tokenId ?? "")).filter((id) => /^\d+$/.test(id));
    if (tokenIds.length !== items.length) refuse("tokenId is not a valid number");

    const chain = getChain();
    const chainId = await chain.chainId();
    const wallet = getSigner();

    const out = [];
    for (const { tokenId, stats, nonce, now } of await statsToSign(owner, tokenIds)) {
        const deadline = BigInt(now + TTL);
        const hash = keccak256(AbiCoder.defaultAbiCoder().encode(TYPES, [
            chain.forgeAddress, chainId, "STATS", owner, BigInt(tokenId), nonce,
            stats.value, stats.points, stats.furnaceMinutes, stats.strikes, stats.totalScore, deadline,
        ]));
        out.push({ tokenId, stats, deadline: deadline.toString(), sig: await wallet.signMessage(getBytes(hash)) });
    }
    return send(res, 200, { items: out });
});
