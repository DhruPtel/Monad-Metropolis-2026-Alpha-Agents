import type { MintState } from "@alpha-agents/ui";
import { type Address, BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { isUserRejection } from "@/auth/session";
import type { MintClaim } from "./agent-nft";
import type { NetworkCheck } from "./network-check";
import { ReceiptTimeoutError, SentElsewhereError } from "./receipt-watch";
import { StuckNonceError } from "./stuck-nonce";

/**
 * The mint, step by step (P1-U11): ask the claim route for a claim, have the
 * wallet send `mintWithClaim`, wait for the receipt and read the new agent
 * from `AgentMinted`, then wait for the reveal. Pure: the app passes the
 * steps in, so tests drive every state with fakes.
 */
export interface MintFlowDeps {
  readonly wallet: Address;
  /**
   * Confirms the wallet is on the network the app reads (network-check.ts),
   * before a claim is requested or anything is sent (L-53).
   */
  readonly checkNetwork: () => Promise<NetworkCheck>;
  /** POSTs to /api/mint-claim; resolves to the HTTP status and JSON body. */
  readonly requestClaim: (wallet: Address) => Promise<{ status: number; body: unknown }>;
  /** Sends mintWithClaim from the wallet; resolves to the transaction hash. */
  readonly sendMint: (claim: MintClaim) => Promise<Hex>;
  /** Waits for the receipt; resolves to the minted agent ID, or throws on a revert. */
  readonly waitForMint: (hash: Hex) => Promise<bigint>;
  /** Resolves once the agent is revealed, to its species index (1 to 25). */
  readonly waitForReveal: (agentId: bigint) => Promise<number>;
}

export interface MintProgress {
  readonly state: MintState;
  readonly agentId?: bigint;
  readonly species?: number;
  readonly hash?: Hex;
  readonly message?: string;
}

/** Owner-facing text for an AgentNFT revert. */
const REVERT_MESSAGES: Readonly<Record<string, string>> = {
  AlreadyMinted: "This wallet has already minted an agent.",
  SoldOut: "All 1,000 agents have been minted.",
  ClaimExpired: "The mint claim expired. Mint again to get a fresh one.",
  ClaimNonceUsed: "That mint claim was already used. Mint again to get a fresh one.",
  InvalidClaimSigner: "The mint claim was not accepted by the contract.",
};

/** The AgentNFT error name inside a viem error, if any. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export async function runMint(
  deps: MintFlowDeps,
  report: (p: MintProgress) => void,
): Promise<MintProgress> {
  const finish = (p: MintProgress) => {
    report(p);
    return p;
  };

  report({ state: "claiming" });
  const network = await deps.checkNetwork().catch((): NetworkCheck => ({
    ok: false,
    reason: "wallet-unreachable",
    message: "Could not check which network your wallet is on. Try again.",
  }));
  if (!network.ok) return finish({ state: "error", message: network.message });

  let claim: MintClaim;
  try {
    const { status, body } = await deps.requestClaim(deps.wallet);
    const message = (body as { message?: unknown } | null)?.message;
    if (status !== 200) {
      // Refusals the user cannot fix by retrying: no claim for this wallet.
      const refused = status === 403 || status === 404 || status === 409 || status === 503;
      return finish({
        state: refused ? "claim-refused" : "error",
        message: typeof message === "string" ? message : "The platform did not issue a mint claim.",
      });
    }
    claim = body as MintClaim;
  } catch {
    return finish({ state: "error", message: "Could not reach the platform for a mint claim." });
  }

  report({ state: "signing" });
  let hash: Hex;
  try {
    hash = await deps.sendMint(claim);
  } catch (error) {
    if (isUserRejection(error)) return finish({ state: "rejected" });
    const name = revertName(error);
    const known = name ? REVERT_MESSAGES[name] : undefined;
    return finish(
      name === "AlreadyMinted" || name === "SoldOut"
        ? { state: "claim-refused", message: known ?? name }
        : { state: "error", message: known ?? "The wallet could not send the mint." },
    );
  }

  report({ state: "minting", hash });
  let agentId: bigint;
  try {
    agentId = await deps.waitForMint(hash);
  } catch (error) {
    // A send to another network, a nonce the fork will never mine, or no receipt
    // at all, is said as it is (L-53, P2-U1 step 0).
    if (
      error instanceof SentElsewhereError ||
      error instanceof StuckNonceError ||
      error instanceof ReceiptTimeoutError
    ) {
      return finish({ state: "error", hash, message: error.message });
    }
    const name = revertName(error);
    return finish({
      state: "error",
      hash,
      message: (name && REVERT_MESSAGES[name]) ?? "The mint transaction failed.",
    });
  }

  report({ state: "awaiting-reveal", agentId, hash });
  const species = await deps.waitForReveal(agentId);
  return finish({ state: "revealed", agentId, species, hash });
}
