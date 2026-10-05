import type { MintPanelState, WalletState } from "@alpha-agents/ui";
import type { EligibilityReason } from "@/api/client";
import type { MintProgress } from "./mint-flow";

/**
 * Which state the mint page's panel shows (P1-U10), from the wallet, its
 * mint as read from AgentNFT, the supply, and the mint running on the page.
 * Pure, so every state is tested without a browser.
 */
export type WalletMintRead =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message?: string | undefined }
  /** The API cannot check this wallet here (not deployed, or minting not configured). */
  | { readonly status: "unavailable"; readonly message: string }
  | {
      readonly status: "ready";
      readonly hasMinted: boolean;
      /** The agent this wallet minted, with its species (0 until revealed), if indexed yet. */
      readonly agent?: { readonly id: bigint; readonly species: number } | undefined;
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
  /** The agent to show, for already-minted, awaiting-reveal and revealed. */
  readonly agent?: { readonly id: bigint; readonly species: number };
  /** Why minting is closed, for unavailable and not-eligible. */
  readonly message?: string;
}

export function mintPageView(input: MintPageInputs): MintPageView {
  const { progress, walletMint } = input;
  if (!input.deployed) return { state: "unavailable" };

  // A mint running on this page, or just finished, speaks for itself.
  if (progress.state === "awaiting-reveal" || progress.state === "revealed") {
    const read = walletMint.status === "ready" ? walletMint.agent : undefined;
    const id = progress.agentId ?? read?.id;
    if (id !== undefined) {
      // Whichever saw the reveal first: the mint flow's poll or the page's read.
      const species = progress.species ?? (read?.id === id ? read.species : 0);
      return { state: species ? "revealed" : "awaiting-reveal", agent: { id, species } };
    }
  }
  if (progress.state !== "idle") return { state: "ready" };

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
  if (walletMint.hasMinted) {
    return walletMint.agent
      ? { state: "already-minted", agent: walletMint.agent }
      : { state: "already-minted" };
  }
  if (input.soldOut === "loading") return { state: "loading" };
  if (input.soldOut === true || walletMint.reason === "sold_out") return { state: "sold-out" };
  // Checked before the click (P1-U4): a wallet off the allowlist is told so up front.
  if (walletMint.reason === "not_allowlisted") {
    return { state: "not-eligible", message: walletMint.message };
  }
  return { state: "ready" };
}
