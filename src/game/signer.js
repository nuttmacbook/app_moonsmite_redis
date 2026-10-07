import { postAs } from "./session";

// Progress goes on-chain only with the game's signature. The signer key lives in a Vercel
// Function (api/sign.js, env SIGNER_KEY), never in the browser. The numbers come from the game
// server's own records; the phone only says which weapons to save, as the signed-in wallet.

/**
 * Signs progress for several weapons in one request.
 * @param {string} owner  the connected wallet that will send the transaction
 * @param {string[]} tokenIds
 * @returns {Promise<{ tokenId: string, stats: object, deadline: string, sig: string }[]>}
 */
async function signUploads(owner, tokenIds) {
    const out = await postAs(String(owner).toLowerCase(), "/api/sign", { items: tokenIds.map((tokenId) => ({ tokenId: String(tokenId) })) });
    return out.items;
}

/**
 * Signs progress for one weapon. Bound to this owner, weapon and its on-chain nonce, so the
 * signature works for exactly one transaction.
 * @returns {Promise<{ stats: object, deadline: string, sig: string }>}
 */
async function signUpload(owner, tokenId) {
    const [ signed ] = await signUploads(owner, [ tokenId ]);
    return { stats: signed.stats, deadline: signed.deadline, sig: signed.sig };
}

export { signUpload, signUploads };
