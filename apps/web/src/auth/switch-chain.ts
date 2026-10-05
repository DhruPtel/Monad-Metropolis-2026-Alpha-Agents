import type { AppChain } from "@alpha-agents/config";
import { chainName, isUserRejection } from "./session";

/**
 * Switches the wallet to the app's chain through the wallet's own provider
 * (P1-U11). It asks with wallet_switchEthereumChain; if the wallet does not
 * know the chain (4902), it asks to add it with wallet_addEthereumChain and
 * switches again; then it reads eth_chainId to confirm, because a wallet can
 * accept a switch request and stay where it was. Every outcome comes back as
 * a result with owner-facing text, so the switch button never fails silently.
 */
export type WalletRequest = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type SwitchPhase = "pending" | "adding";

export type SwitchResult =
  | { readonly outcome: "switched" }
  | { readonly outcome: "rejected"; readonly message: string }
  | { readonly outcome: "failed"; readonly message: string };

export interface SwitchInput {
  readonly request: WalletRequest;
  readonly target: AppChain;
  /** Called as the request waits in the wallet: to switch, or to add the chain. */
  readonly onPhase?: (phase: SwitchPhase) => void;
}

/** What progress looks like to the owner while the wallet is asked. */
export function phaseText(phase: SwitchPhase, target: AppChain): string {
  return phase === "adding"
    ? `Approve adding ${target.name} in your wallet. Waiting for the wallet.`
    : `Approve the switch to ${target.name} in your wallet. Waiting for the wallet.`;
}

/** The parameters for wallet_addEthereumChain. No explorer URL: the fork has none, and an empty one is invalid. */
export function addChainParams(target: AppChain) {
  return {
    chainId: `0x${target.id.toString(16)}`,
    chainName: target.name,
    nativeCurrency: target.nativeCurrency,
    rpcUrls: [target.browserRpcUrl],
  };
}

/** The EIP-1193 or JSON-RPC error code anywhere in an error's cause chain. */
function codes(error: unknown): number[] {
  const found: number[] = [];
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    const { code, data, cause } = e as { code?: unknown; data?: unknown; cause?: unknown };
    if (typeof code === "number") found.push(code);
    // MetaMask mobile wraps 4902 as -32603 with data.originalError.code.
    const original = (data as { originalError?: { code?: unknown } } | undefined)?.originalError;
    if (typeof original?.code === "number") found.push(original.code);
    e = cause;
  }
  return found;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The wallet does not know the chain: EIP-3326 4902, also seen only in the message. */
export function isUnrecognizedChain(error: unknown): boolean {
  return codes(error).includes(4902) || /4902|unrecognized chain/i.test(text(error));
}

/** The wallet already has a request open (JSON-RPC -32002). */
export function isRequestAlreadyPending(error: unknown): boolean {
  return codes(error).includes(-32002);
}

const PENDING_MESSAGE =
  "Your wallet already has a request open. Open your wallet to approve or decline it, then try again.";

export async function switchWalletChain({
  request,
  target,
  onPhase,
}: SwitchInput): Promise<SwitchResult> {
  const chainId = `0x${target.id.toString(16)}`;
  const switchOnce = () => request("wallet_switchEthereumChain", [{ chainId }]);
  const declined = (what: string): SwitchResult => ({
    outcome: "rejected",
    message: `You declined ${what} in your wallet.`,
  });

  onPhase?.("pending");
  try {
    await switchOnce();
  } catch (error) {
    if (isUserRejection(error)) return declined("the network switch");
    if (isRequestAlreadyPending(error)) return { outcome: "failed", message: PENDING_MESSAGE };
    if (!isUnrecognizedChain(error)) {
      return { outcome: "failed", message: `Your wallet could not switch: ${text(error)}` };
    }
    onPhase?.("adding");
    try {
      await request("wallet_addEthereumChain", [addChainParams(target)]);
      // MetaMask switches after adding; asking again covers wallets that do not.
      onPhase?.("pending");
      await switchOnce();
    } catch (addError) {
      if (isUserRejection(addError)) return declined(`adding ${target.name}`);
      if (isRequestAlreadyPending(addError)) return { outcome: "failed", message: PENDING_MESSAGE };
      return {
        outcome: "failed",
        message: `Your wallet could not add ${target.name}: ${text(addError)}`,
      };
    }
  }

  // Confirm: a wallet can accept the request and stay on its network.
  let now: number;
  try {
    now = Number(await request("eth_chainId", []));
  } catch (error) {
    return { outcome: "failed", message: `Could not read your wallet's network: ${text(error)}` };
  }
  if (now !== target.id) {
    const current = chainName(now, target) ?? `chain ${now}`;
    return {
      outcome: "failed",
      message: `Your wallet still reports ${current}. MetaMask can keep a separate network for each site: open MetaMask on this page and choose ${target.name}.`,
    };
  }
  return { outcome: "switched" };
}
