import { Interface } from "ethers";
import { getRpc } from "./connect";

// Many contract reads in one RPC request, through Multicall3 (the same address on every EVM chain).
// The page used to send one request per read (8 on every refresh); public RPCs rate-limit that
// quickly when many players are online. Results come back in the same shape kitbox's web3 reads
// gave: one output is the value itself, several outputs are an array, structs are objects that
// answer to both their index and their field name.

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTI = new Interface([
    "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
    "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);
const RETRIES = 3;

const interfaces = new Map();
const interfaceOf = (abi) => {
    if (!interfaces.has(abi)) interfaces.set(abi, new Interface(abi));
    return interfaces.get(abi);
};

/** ethers Result -> the plain shape web3.js returned */
const plain = (value, type) => {
    if (type.baseType === "array") return Array.from(value, (x) => plain(x, type.arrayChildren));
    if (type.baseType === "tuple") {
        const out = { __length__: type.components.length };
        type.components.forEach((c, i) => {
            out[i] = plain(value[i], c);
            if (c.name) out[c.name] = out[i];
        });
        return out;
    }
    return value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One eth_call, retried with backoff when the RPC says slow down (429) or the network blips */
async function ethCall(to, data) {
    let lastError;
    for (let i = 0; i < RETRIES; i++) {
        if (i) await sleep(400 * 2 ** i + Math.random() * 300);
        try {
            const res = await fetch(getRpc(), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [ { to, data }, "latest" ] }),
            });
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error("The network is busy. Please try again in a moment.");
                continue;
            }
            const json = await res.json();
            if (json?.error) {
                // -32005 / "rate" = limit reached: worth another try; anything else is a real error
                if (json.error.code === -32005 || /rate|limit/i.test(json.error.message ?? "")) {
                    lastError = new Error("The network is busy. Please try again in a moment.");
                    continue;
                }
                throw new Error(json.error.message ?? "Reading the chain failed.");
            }
            return json.result;
        } catch (error) {
            lastError = error;
            if (!(error instanceof TypeError)) throw error;   // TypeError = fetch could not connect
        }
    }
    throw lastError;
}

/**
 * @param {{ contract: { address: string, abi: object[] }, method: string, args?: any[] }[]} calls
 * @returns {Promise<{ results: any[], now: number }>} results in call order (null for a call that
 *   reverted), and the block time the reads were made at
 */
async function multicall(calls) {
    const encoded = calls.map(({ contract, method, args = [] }) => ({
        target: contract.address,
        allowFailure: true,
        callData: interfaceOf(contract.abi).encodeFunctionData(method, args),
    }));
    encoded.push({ target: MULTICALL3, allowFailure: false, callData: MULTI.encodeFunctionData("getCurrentBlockTimestamp") });

    const raw = await ethCall(MULTICALL3, MULTI.encodeFunctionData("aggregate3", [ encoded ]));
    const [ replies ] = MULTI.decodeFunctionResult("aggregate3", raw);

    const results = calls.map(({ contract, method }, i) => {
        const [ success, data ] = replies[i];
        if (!success) return null;
        const iface = interfaceOf(contract.abi);
        const fragment = iface.getFunction(method);
        const decoded = iface.decodeFunctionResult(fragment, data);
        const values = fragment.outputs.map((type, k) => plain(decoded[k], type));
        return values.length === 1 ? values[0] : values;
    });
    const now = Number(MULTI.decodeFunctionResult("getCurrentBlockTimestamp", replies.at(-1)[1])[0]);
    return { results, now };
}

export { multicall, MULTICALL3 };
