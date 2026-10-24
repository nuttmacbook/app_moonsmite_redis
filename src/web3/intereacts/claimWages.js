import { box, getRpc } from "../connect";
import { Wages } from "../contracts/contract_wages";
import { normalize } from "../errors";

/** The network fee the Wages contract asks with every write (its owner can change it) */
const txFee = async () => {
    try {
        const info = await box.createWeb3Contract(Wages, getRpc()).methods.getDappInfo().call();
        return BigInt(info?.[2] ?? 1e14);
    } catch {
        return BigInt(1e14);
    }
};

/**
 * Sends the smith every wage owners have paid into the Wages contract for them.
 *
 * @param {object} wallet  current wallet state
 * @param {object} options
 * @param {(step: {stage: string, index: number, total: number}) => void} options.onStep
 * @returns {Promise<object>} the transaction receipt
 */
export async function claimWages(wallet, { onStep = () => {} } = {}) {
    const account = wallet?.address ?? box.ZERO;
    const signer = wallet?.signer;

    if (!account || account === box.ZERO || !signer) {
        throw new Error("Wallet is not connected.");
    }
    if (!Wages.address) throw new Error("Smith jobs are not open yet.");

    onStep({ stage: "create", index: 1, total: 1 });
    try {
        const value = await txFee();
        const engine = box.createEtherContract(Wages, signer);
        const tx = await engine.claim({ value });
        onStep({ stage: "creating", index: 1, total: 1 });
        return await tx.wait();
    } catch (error) {
        const handled = box.handleTxError(Wages, error);
        throw normalize(error, handled, "Wages could not be claimed.");
    }
}
