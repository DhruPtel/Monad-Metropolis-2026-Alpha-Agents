import { z } from "zod";

/**
 * The asset enum every tool schema uses (FINAL_PLAN 4.4.1). Addresses come from
 * the address book, never from the agent. USDC is the base currency.
 */
export const ASSET_IDS = ["USDC", "WMON"] as const;
export type AssetId = (typeof ASSET_IDS)[number];
export const AssetIdSchema = z.enum(ASSET_IDS);

export const BASE_ASSET: AssetId = "USDC";

/** `chain.balance` may also read native MON. NATIVE is never tradable. */
export const BALANCE_ASSET_IDS = [...ASSET_IDS, "NATIVE"] as const;
export type BalanceAssetId = (typeof BALANCE_ASSET_IDS)[number];

/** Decimals as read from the token contracts on the fork at block 109670000. */
export const ASSET_DECIMALS: Readonly<Record<AssetId, number>> = {
  USDC: 6,
  WMON: 18,
};

/** Address book entry ID for each asset's token contract. */
export const ASSET_ADDRESS_ID = {
  USDC: "usdc",
  WMON: "wmon",
} as const satisfies Record<AssetId, string>;
