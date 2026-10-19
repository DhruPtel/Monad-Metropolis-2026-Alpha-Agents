import { rpcTransport } from "@alpha-agents/chain-tools";
import { type Hex, createPublicClient, createWalletClient, parseAbi } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { SentinelChain } from "./sentinel.ts";

/**
 * The sentinel key's chain calls (P4-U2, D-138): a wallet on the sentinel
 * key that knows the three tightenings the custody core opens to the
 * sentinel. No other call exists here, so the service cannot unpause, change
 * a policy or move anything even by mistake; the core refuses the sentinel
 * for those too (`unpause` is the owner's alone). CO-U1 (2026-10-19, owner):
 * no `poke` either. Each pass sent one per agent (about 518,000 gas, about
 * 0.05 MON on Monad testnet, every minute); the sentinel now only reads the
 * account's breakerState, which values it at current prices against its peak.
 */
const SENTINEL_ABI = parseAbi([
  "function setReduceOnly()",
  "function pause()",
  "function closeDeposits()",
]);

/** Anvil's mnemonic, index 5: the local fork's sentinel (D-230; scripts/lib/account-factory.js). */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const LOCAL_SENTINEL_INDEX = 5;

export function localSentinelKey(): Hex {
  const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: LOCAL_SENTINEL_INDEX }).getHdKey()
    .privateKey;
  if (!key) throw new Error("the local sentinel key could not be derived");
  return `0x${Buffer.from(key).toString("hex")}` as Hex;
}

export function viemSentinelChain(o: {
  readonly rpcUrl: string;
  /** Taken when the first provider fails (a 429 included). */
  readonly fallbackRpcUrl?: string | null;
  readonly chainId: number;
  readonly privateKey: Hex;
  readonly chainName?: string;
}): SentinelChain {
  const transport = rpcTransport(o.rpcUrl, o.fallbackRpcUrl);
  const account = privateKeyToAccount(o.privateKey);
  const chain = {
    id: o.chainId,
    name: o.chainName ?? "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  } as const;
  const wallet = createWalletClient({ account, chain, transport });
  const client = createPublicClient({ chain, transport });
  const send = async (
    address: Hex,
    functionName: "setReduceOnly" | "pause" | "closeDeposits",
  ): Promise<Hex> => {
    // Simulated first, so a call the core refuses (NotTightener, a stale feed) never spends gas.
    const { request } = await client.simulateContract({
      address,
      abi: SENTINEL_ABI,
      functionName,
      account,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    return hash;
  };
  return {
    address: account.address,
    setReduceOnly: (a) => send(a, "setReduceOnly"),
    pause: (a) => send(a, "pause"),
    closeDeposits: (a) => send(a, "closeDeposits"),
  };
}
