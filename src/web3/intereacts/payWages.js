import { box, getRpc } from "../connect";
import { Wages } from "../contracts/contract_wages";
import { Coin } from "../contracts/contract_coin";
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
 * Pays the wages one weapon owes to the smiths who struck it, with the bill the game server
 * signed (game/hire.js billWages). The MWLD waits in the Wages contract until each smith claims
 * their share. The bill works once, for this wallet only, for one hour.
 *
 * @param {object} wallet  current wallet state
 * @param {{ tokenId: string, smiths: string[], amounts: string[], total: string, billId: string, deadline: number, sig: string }} bill
 * @param {object} options
 * @param {(step: {stage: string, index: number, total: number}) => void} options.onStep
 * @returns {Promise<object>} the transaction receipt
 */
export async function payWages(wallet, bill, { onStep = () => {} } = {}) {
    const account = wallet?.address ?? box.ZERO;
    const signer = wallet?.signer;
    const TOTAL = BigInt(bill?.total ?? 0);

    if (!account || account === box.ZERO || !signer) {
        throw new Error("Wallet is not connected.");
    }
    if (!Wages.address) throw new Error("Smith jobs are not open yet.");

    onStep({ stage: "checking", index: 0, total: 1 });

    const isApproved = await box.isTokenApproval(Coin, account, Wages.address, TOTAL, getRpc());
    const total = isApproved ? 1 : 2;

    try {
        const token = box.createWeb3Contract(Coin, getRpc());
        const balance = await token.methods.balanceOf(account).call();
        if (BigInt(balance ?? 0) < TOTAL) {
            throw new Error("Not enough MWLD in your wallet to pay these wages.");
        }
    } catch (error) {
        if (/Not enough MWLD/.test(error?.message)) throw error;
    }

    if (!isApproved) {
        onStep({ stage: "approve", index: 1, total });
        try {
            const token = box.createEtherContract(Coin, signer);
            const tx = await token.approve(Wages.address, TOTAL);
            onStep({ stage: "approving", index: 1, total });
            await tx.wait();
        } catch (error) {
            const handled = box.handleTxError(Coin, error);
            throw normalize(error, handled, "Approval failed. Please try again.");
        }
    }

    onStep({ stage: "create", index: total, total });
    try {
        const value = await txFee();
        const engine = box.createEtherContract(Wages, signer);
        const tx = await engine.pay(
            { tokenId: BigInt(bill.tokenId), smiths: bill.smiths, amounts: bill.amounts.map(BigInt), billId: bill.billId, deadline: BigInt(bill.deadline) },
            bill.sig,
            { value },
        );
        onStep({ stage: "creating", index: total, total });
        return await tx.wait();
    } catch (error) {
        const handled = box.handleTxError(Wages, error);
        throw normalize(error, handled, "The wages could not be paid.");
    }
}
