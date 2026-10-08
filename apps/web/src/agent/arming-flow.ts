import type { Hex } from "viem";
import { isUserRejection } from "@/auth/session";
import type { NetworkCheck } from "./network-check";
import { ReceiptTimeoutError, SentElsewhereError } from "./receipt-watch";
import { StuckNonceError } from "./stuck-nonce";

/**
 * Arming and disarming from the owner's own wallet (P2-U6), step by step.
 * Arm: check the wallet's network, get the grant call from the control API
 * (a session grant to the agent's funding address, 30 days at most), have the
 * wallet send it, wait for the receipt, then ask the API to check it on chain
 * and record it. Disarm: the API ends arming at once and hands back the
 * revoke call, which the wallet sends. Pure: the app passes the steps in, so
 * tests drive every state with fakes. The portfolio page's arming card that
 * uses this is P2-U7.
 */

/** A call for the owner's wallet, as the control API returns it. */
export interface WalletCall {
  readonly to: Hex;
  readonly data: Hex;
  readonly value: "0";
}

export interface ArmingFlowDeps {
  /** Confirms the wallet is on the network the app reads, before anything is sent (L-53). */
  readonly checkNetwork: () => Promise<NetworkCheck>;
  /** GET /v1/agents/:id/arming with the owner session. */
  readonly getArming: () => Promise<{ status: number; body: unknown }>;
  /** POST /v1/agents/:id/arming with the owner session, once the grant is on chain. */
  readonly confirmArming: () => Promise<{ status: number; body: unknown }>;
  /** POST /v1/agents/:id/disarm with the owner session. */
  readonly disarm: () => Promise<{ status: number; body: unknown }>;
  /** Sends the call from the connected wallet's provider; resolves to the transaction hash. */
  readonly send: (call: WalletCall) => Promise<Hex>;
  /** Waits for a successful receipt on the app's network; throws on a revert or timeout. */
  readonly waitForReceipt: (hash: Hex) => Promise<void>;
}

export type ArmingFlowState =
  | "checking"
  | "signing"
  | "confirming"
  | "recording"
  | "awaiting-first-trade"
  | "disarmed"
  | "rejected"
  | "error";

export interface ArmingProgress {
  readonly state: ArmingFlowState;
  readonly hash?: Hex;
  readonly message?: string;
}

const messageOf = (body: unknown, fallback: string): string => {
  const m = (body as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : fallback;
};

async function sendAndWait(
  deps: ArmingFlowDeps,
  call: WalletCall,
  report: (p: ArmingProgress) => void,
  what: string,
): Promise<ArmingProgress | Hex> {
  report({ state: "signing" });
  let hash: Hex;
  try {
    hash = await deps.send(call);
  } catch (error) {
    if (isUserRejection(error)) return { state: "rejected" };
    return { state: "error", message: `The wallet could not send the ${what}.` };
  }
  report({ state: "confirming", hash });
  try {
    await deps.waitForReceipt(hash);
  } catch (error) {
    if (
      error instanceof SentElsewhereError ||
      error instanceof StuckNonceError ||
      error instanceof ReceiptTimeoutError
    )
      return { state: "error", hash, message: error.message };
    return { state: "error", hash, message: `The ${what} transaction failed.` };
  }
  return hash;
}

const networkOk = async (deps: ArmingFlowDeps): Promise<NetworkCheck> =>
  deps.checkNetwork().catch(
    (): NetworkCheck => ({
      ok: false,
      reason: "wallet-unreachable",
      message: "Could not check which network your wallet is on. Try again.",
    }),
  );

export async function runArm(
  deps: ArmingFlowDeps,
  report: (p: ArmingProgress) => void,
): Promise<ArmingProgress> {
  const finish = (p: ArmingProgress) => {
    report(p);
    return p;
  };
  report({ state: "checking" });
  const network = await networkOk(deps);
  if (!network.ok) return finish({ state: "error", message: network.message });

  let call: WalletCall | null;
  try {
    const { status, body } = await deps.getArming();
    if (status !== 200)
      return finish({ state: "error", message: messageOf(body, "Could not load the agent's arming.") });
    call = (body as { grantCall?: WalletCall | null }).grantCall ?? null;
  } catch {
    return finish({ state: "error", message: "Could not reach the platform." });
  }
  if (!call)
    return finish({
      state: "error",
      message: "Trading is not available for this agent yet: it has no funding address or no trading contracts.",
    });

  const sent = await sendAndWait(deps, call, report, "trading permission");
  if (typeof sent !== "string") return finish(sent);

  report({ state: "recording", hash: sent });
  try {
    const { status, body } = await deps.confirmArming();
    if (status !== 200 && status !== 201)
      return finish({
        state: "error",
        hash: sent,
        message: messageOf(body, "The platform could not confirm the trading permission."),
      });
  } catch {
    return finish({ state: "error", hash: sent, message: "Could not reach the platform." });
  }
  return finish({ state: "awaiting-first-trade", hash: sent });
}

export async function runDisarm(
  deps: ArmingFlowDeps,
  report: (p: ArmingProgress) => void,
): Promise<ArmingProgress> {
  const finish = (p: ArmingProgress) => {
    report(p);
    return p;
  };
  report({ state: "checking" });
  let call: WalletCall | null;
  try {
    const { status, body } = await deps.disarm();
    if (status !== 200)
      return finish({ state: "error", message: messageOf(body, "Could not disarm the agent.") });
    call = (body as { revokeCall?: WalletCall | null }).revokeCall ?? null;
  } catch {
    return finish({ state: "error", message: "Could not reach the platform." });
  }
  // Arming has ended on the platform: no trade is sent from here. The revoke clears the grant on chain.
  if (!call) return finish({ state: "disarmed" });
  const network = await networkOk(deps);
  if (!network.ok)
    return finish({
      state: "error",
      message: `The agent is disarmed. ${network.message} Then revoke the trading permission again.`,
    });
  const sent = await sendAndWait(deps, call, report, "revoke");
  if (typeof sent !== "string")
    return finish(
      sent.state === "rejected"
        ? { state: "disarmed", message: "The agent is disarmed; the permission stays on chain until you revoke it." }
        : sent,
    );
  return finish({ state: "disarmed", hash: sent });
}
