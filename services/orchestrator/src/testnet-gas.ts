import type { Hex } from "viem";

/**
 * CO-U1 (owner, 2026-10-14): on the testnet stacks the deployer tops an agent's
 * session key up when it cannot pay a swap's gas, as the fork's balance setter
 * does, so an armed agent trades without an operator. 2026-10-18 (owner): the
 * trade flow asks for the next few swaps at the limit and fees of the one that
 * needs it (GAS_TOP_UP_LEGS, each limit from the swap's estimate), and the
 * deployer sends only the difference from what the key holds, so one deployer
 * funds many agents.
 *
 * 2026-10-18 (L-284): Monad checks a transaction's gas against the sender's
 * balance a few blocks back, so a swap signed right after its top-up landed was
 * refused "Signer had insufficient balance"; the top-up returns only once the
 * chain is that many blocks past it. And a top-up the deployer cannot pay is
 * still included on Monad and reverts, charging its gas each time the trade
 * flow asks again; it is refused before sending instead.
 */
export interface TopUpChain {
  readonly deployer: Hex;
  balance(address: Hex): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  /** Sends `wei` from the deployer and waits for its receipt. */
  send(
    to: Hex,
    wei: bigint,
  ): Promise<{ hash: Hex; status: "success" | "reverted"; blockNumber: bigint }>;
}

/** Blocks past a top-up before the key may spend it: Monad's delay of 3, and 2 of margin. */
export const TOP_UP_SETTLE_BLOCKS = 5n;
/** What the deployer keeps back for its own gas (L-270). */
export const DEPLOYER_GAS_ROOM_WEI = 250_000_000_000_000_000n;

const mon = (wei: bigint) => (Number(wei) / 1e18).toFixed(4);

export function testnetGasTopUp(o: {
  readonly chain: TopUpChain;
  readonly log: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly settleTimeoutMs?: number;
}): (address: Hex, wei: bigint) => Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 500;
  const settleTimeoutMs = o.settleTimeoutMs ?? 30_000;
  return async (address, wei) => {
    const target = wei;
    const have = await o.chain.balance(address);
    if (have >= target) return;
    const value = target - have;
    const deployerHas = await o.chain.balance(o.chain.deployer);
    if (deployerHas < value + DEPLOYER_GAS_ROOM_WEI)
      throw new Error(
        `the deployer holds ${mon(deployerHas)} MON, too little to top ${address} up by ${mon(value)} MON and keep ${mon(DEPLOYER_GAS_ROOM_WEI)} for its gas; nothing was sent`,
      );
    const receipt = await o.chain.send(address, value);
    if (receipt.status !== "success") throw new Error(`the gas top-up ${receipt.hash} reverted`);
    const ready = receipt.blockNumber + TOP_UP_SETTLE_BLOCKS;
    for (let waited = 0; (await o.chain.blockNumber()) < ready; waited += pollMs) {
      if (waited >= settleTimeoutMs)
        throw new Error(
          `the gas top-up ${receipt.hash} landed in block ${receipt.blockNumber}, but the chain did not reach block ${ready} within ${settleTimeoutMs / 1000} seconds`,
        );
      await sleep(pollMs);
    }
    o.log(`gas: topped ${address} up to ${target} wei from the deployer (${receipt.hash})`);
  };
}
