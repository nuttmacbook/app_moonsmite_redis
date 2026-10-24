// Chain reads for the game server. Every request is one eth_call through Multicall3
// (already deployed on BSC and BSC testnet), so a whole wallet costs a single RPC request.
// Env: FORGE_ADDRESS (or VITE_FORGE_ADDRESS), RPC_URL (server only; falls back to VITE_RPC_URL,
// then the public RPC of VITE_CHAIN).

import { JsonRpcProvider, Contract, Interface, isAddress } from "ethers";
import { rateFrom } from "../../src/game/rules.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const PUBLIC_RPC = {
    bsc: "https://bsc-dataseed.bnbchain.org",
    bscTestnet: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
};
const LISTING_PAGE = 300;

const SWORD = "(uint256 value,uint256 points,uint256 furnaceMinutes,uint256 strikes,uint256 totalScore,uint256 syncedAt,uint256 listPrice,uint256 mintPrice,uint256 seed)";
const ACCOUNT = "(address referrer,uint256 joinedAt,uint256 referrals,uint256 spent,uint256 earned,uint256 taxPaid,uint256 minted,uint256 bought,uint256 sold,uint256 furnaces,uint256 guildProfit,uint256 referralEarned,uint256 referralClaimed,uint256 id)";

const FORGE = new Interface([
    `function getSword(uint256 tokenId) view returns (${SWORD}, address, uint256)`,
    `function getUserInfo(address account_) view returns (uint256[], ${SWORD}[])`,
    `function getAccount(address account_) view returns (${ACCOUNT}, bool)`,
    "function furnaceRate() view returns (uint256 pointsPerHour, uint256 strikesPerMonth, uint256 maxPoints)",
    "function getDappInfo() view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256)",
    `function getListings(uint256 offset, uint256 limit) view returns (uint256[], ${SWORD}[], address[])`,
]);

const MULTI = new Interface([
    "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
    "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);

/** Plain object from an ethers Result for a Sword struct */
const swordOf = (r) => ({
    value: r.value, points: r.points, furnaceMinutes: r.furnaceMinutes, strikes: r.strikes, totalScore: r.totalScore,
    syncedAt: r.syncedAt, listPrice: r.listPrice, mintPrice: r.mintPrice, seed: r.seed,
});

function ethersChain({ rpc, forgeAddress, runner } = {}) {
    const provider = runner ?? new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
    const multicall = new Contract(MULTICALL3, MULTI, provider);
    let chainId = null;

    /**
     * Runs calls on the Forge contract plus the block time in one eth_call.
     * @param {[string, any[]][]} calls  [ functionName, args ]
     */
    const read = async (calls) => {
        const encoded = [
            ...calls.map(([ fn, args ]) => ({ target: forgeAddress, allowFailure: false, callData: FORGE.encodeFunctionData(fn, args) })),
            { target: MULTICALL3, allowFailure: false, callData: MULTI.encodeFunctionData("getCurrentBlockTimestamp", []) },
        ];
        const results = await multicall.aggregate3.staticCall(encoded);
        const out = calls.map(([ fn ], i) => FORGE.decodeFunctionResult(fn, results[i].returnData));
        const [ now ] = MULTI.decodeFunctionResult("getCurrentBlockTimestamp", results[calls.length].returnData);
        return { out, now: Number(now) };
    };

    return {
        forgeAddress,

        async chainId() {
            if (chainId === null) chainId = (await provider.getNetwork?.())?.chainId ?? 0n;
            return chainId;
        },

        /** Everything the server needs about one wallet: its swords, furnace slots, furnace speed, block time */
        async readOwner(owner) {
            const { out: [ user, account, rate ], now } = await read([
                [ "getUserInfo", [ owner ] ],
                [ "getAccount", [ owner ] ],
                [ "furnaceRate", [] ],
            ]);
            return {
                ids: Array.from(user[0], (id) => String(id)),
                swords: Array.from(user[1], swordOf),
                furnaces: Number(account[0].furnaces) || 3,
                isRegistered: Boolean(account[1]),
                rate: rateFrom(rate[0], rate[2]),
                now,
            };
        },

        /** Swords with their owner and the nonce the next stats signature must use */
        async readSwords(ids) {
            const { out, now } = await read([ ...ids.map((id) => [ "getSword", [ id ] ]), [ "furnaceRate", [] ] ]);
            const rate = out.pop();
            return {
                swords: out.map(([ s, owner, nonce ]) => ({ sword: swordOf(s), owner: String(owner).toLowerCase(), nonce: BigInt(nonce) })),
                rate: rateFrom(rate[0], rate[2]),
                now,
            };
        },

        /** Every listing, read in pages of 300, a few pages per eth_call */
        async readListings() {
            const { out: [ info ], now } = await read([ [ "getDappInfo", [] ] ]);
            const total = Number(info[1]);
            const offsets = Array.from({ length: Math.ceil(total / LISTING_PAGE) }, (_, i) => i * LISTING_PAGE);
            const items = [];
            for (let i = 0; i < offsets.length; i += 4) {
                const { out: pages } = await read(offsets.slice(i, i + 4).map((offset) => [ "getListings", [ offset, LISTING_PAGE ] ]));
                pages.forEach(([ ids, swords, sellers ]) => {
                    Array.from(ids).forEach((id, j) => items.push({ tokenId: String(id), sword: swordOf(swords[j]), seller: String(sellers[j]).toLowerCase() }));
                });
            }
            return { items, info: Array.from(info, (x) => x.toString()), now };
        },
    };
}

let current = null;

/** Tests swap in a mock chain */
const setChain = (adapter) => {
    current = adapter;
};

const getChain = () => {
    if (current) return current;
    // Skips empty values and leftover placeholders like "https://..."
    const envOf = (...names) => names.map((n) => String(process.env[n] ?? "").trim()).find((v) => v && !v.includes("...")) ?? "";
    const forgeAddress = envOf("FORGE_ADDRESS", "VITE_FORGE_ADDRESS");
    const rpc = envOf("RPC_URL", "VITE_RPC_URL") || PUBLIC_RPC[envOf("VITE_CHAIN") || "bsc"];
    if (!isAddress(forgeAddress || "") || !rpc) throw new Error("Chain is not configured (FORGE_ADDRESS, RPC_URL)");
    current = ethersChain({ rpc, forgeAddress });
    return current;
};

export { ethersChain, getChain, setChain, MULTICALL3, FORGE, MULTI };
