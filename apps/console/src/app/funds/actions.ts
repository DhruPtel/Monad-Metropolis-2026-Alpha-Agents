"use server";

import { balancesOf, mintTestUsdc, setMonBalance } from "@alpha-agents/devenv";
import { ASSET_DECIMALS, parseAmount } from "@alpha-agents/domain";
import { type ActionResult, attempt } from "@/lib/action-result";

/** Balances as decimal strings in base units: MON in wei, USDC in 6-decimal units. */
export interface BalanceView {
  readonly address: string;
  readonly monWei: string;
  readonly usdcE6: string;
}

const MON_DECIMALS = 18;

function amount(text: string, decimals: number, what: string): bigint {
  const value = parseAmount(text, decimals);
  if (value === undefined)
    throw new Error(`${what} must be a number with at most ${decimals} decimals.`);
  return value;
}

async function view(address: string): Promise<BalanceView> {
  const b = await balancesOf(address);
  return { address, monWei: b.monWei.toString(), usdcE6: b.usdcE6.toString() };
}

export async function readBalancesAction(address: string): Promise<ActionResult<BalanceView>> {
  return attempt(() => view(address));
}

/** Sets the address's MON balance to exactly this amount (anvil_setBalance). */
export async function setMonAction(
  address: string,
  monText: string,
): Promise<ActionResult<BalanceView>> {
  return attempt(async () => {
    await setMonBalance(address, amount(monText, MON_DECIMALS, "The MON amount"));
    return view(address);
  });
}

/** Adds this much USDC, minted through the real USDC contract on the fork. */
export async function giveUsdcAction(
  address: string,
  usdcText: string,
): Promise<ActionResult<BalanceView>> {
  return attempt(async () => {
    const value = amount(usdcText, ASSET_DECIMALS.USDC, "The USDC amount");
    if (value === 0n) throw new Error("The USDC amount must be greater than zero.");
    await mintTestUsdc(address, value);
    return view(address);
  });
}
