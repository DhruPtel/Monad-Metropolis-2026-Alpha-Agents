import type { MintPanelState, WalletState } from "@alpha-agents/ui";
import type { EligibilityReason } from "@/api/client";
import type { MintProgress } from "./mint-flow";

/**
 * Which state the mint page's panel shows (P1-U10), from the wallet, its
 * mints as read from AgentNFT and the index, the supply, and the mint running
 * on the page. Pure, so every state is tested without a browser. A wallet
 * mints up to two agents (NFT-U1): with mints left it is offered the mint
 * beside the agents it already minted; at its limit it sees them alone.
 */
export interface MintedAgent {
  readonly id: bigint;
  /** 0 until revealed. */
  readonly species: number;
}

export type WalletMintRead =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message?: string | undefined }
  /** The API cannot check this wallet here (not deployed, or minting not configured). */
  | { readonly status: "unavailable"; readonly message: string }
  | {
      readonly status: "ready";
      /** How many of its mints the wallet has used, and how many are left. */
      readonly mintsUsed: number;
      readonly mintsLeft: number;
      /** The agents this wallet minted, oldest first, as far as the index has them. */
      readonly agents: readonly MintedAgent[];
      /** The control API's eligibility answer, checked before the user clicks. */
      readonly reason: EligibilityReason;
      readonly message: string;
    };

export interface MintPageInputs {
  readonly deployed: boolean;
  readonly walletState: WalletState;
  readonly walletMint: WalletMintRead;
  /**
   * From the supply read: "loading" until it first answers, "unknown" if it
   * failed. An unknown supply does not block a mint: AgentNFT refuses one
   * past the cap, and the mint flow says so.
   */
  readonly soldOut: boolean | "loading" | "unknown";
  readonly progress: MintProgress;
}

export interface MintPageView {
  readonly state: MintPanelState;
  /** The agent just minted on this page, for awaiting-reveal and revealed. */
  readonly agent?: MintedAgent;
  /** The agents the wallet minted before, for ready, already-minted and sold-out. */
  readonly agents?: readonly MintedAgent[];
  /** How many mints the wallet has left, for ready. */
  readonly mintsLeft?: number;
  /** Why minting is closed, for unavailable and not-eligible. */
  readonly message?: string;
}

export function mintPageView(input: MintPageInputs): MintPageView {
  const { progress, walletMint } = input;
  if (!input.deployed) return { state: "unavailable" };

  const read = walletMint.status === "ready" ? walletMint : undefined;
  const agents = read?.agents ?? [];

  // A mint running on this page, or just finished, speaks for itself.
  if (progress.state === "awaiting-reveal" || progress.state === "revealed") {
    const id = progress.agentId ?? agents.at(-1)?.id;
    if (id !== undefined) {
      // Whichever saw the reveal first: the mint flow's poll or the page's read.
      const indexed = agents.find((a) => a.id === id);
      const species = progress.species ?? indexed?.species ?? 0;
      return { state: species ? "revealed" : "awaiting-reveal", agent: { id, species } };
    }
  }
  if (progress.state !== "idle") {
    return { state: "ready", agents, ...(read ? { mintsLeft: read.mintsLeft } : {}) };
  }

  switch (input.walletState) {
    case "logged-out":
    case "error":
      return { state: input.soldOut === true ? "sold-out" : "logged-out" };
    case "connecting":
      return { state: "connecting" };
    case "wrong-chain":
      return { state: "wrong-network" };
    case "connected":
      break;
  }

  if (walletMint.status === "loading") return { state: "loading" };
  if (walletMint.status === "error") return { state: "read-error" };
  if (walletMint.status === "unavailable")
    return { state: "unavailable", message: walletMint.message };
  if (walletMint.mintsLeft === 0 || walletMint.reason === "already_minted") {
    return { state: "already-minted", agents };
  }
  if (input.soldOut === "loading") return { state: "loading" };
  if (input.soldOut === true || walletMint.reason === "sold_out") {
    return { state: "sold-out", agents };
  }
  // Checked before the click (P1-U4): a wallet off the allowlist is told so up front.
  if (walletMint.reason === "not_allowlisted") {
    return { state: "not-eligible", message: walletMint.message };
  }
  return { state: "ready", agents, mintsLeft: walletMint.mintsLeft };
}
