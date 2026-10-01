import { z } from "zod";

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

/** An EVM address as written: 0x plus 40 hex characters, any case. */
export type Address = `0x${string}`;
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((s) => s as Address);

/** The AgentNFT token ID; one agent per token. */
export type AgentId = Branded<bigint, "agent-id">;
/** `AgentNFT.ownerEpoch`: bumped on every transfer, including into and out of escrow. */
export type OwnerEpoch = Branded<bigint, "owner-epoch">;
/** `BuildRegistry.configEpoch`: bumped on every accepted build or parameter change. */
export type ConfigEpoch = Branded<bigint, "config-epoch">;
/** The Executor's single-use action ID (bytes32). */
export type ActionId = Branded<`0x${string}`, "action-id">;
/** The platform's intent ID, returned by the propose tools. */
export type IntentId = Branded<string, "intent-id">;
/** Caller-chosen idempotency key for intent-creating tools. */
export type ClientRequestId = Branded<string, "client-request-id">;

const uintString = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative decimal integer string");
const UINT64_MAX = 2n ** 64n - 1n;
const uint64 = uintString
  .transform((s) => BigInt(s))
  .refine((v) => v <= UINT64_MAX, "must fit in uint64");

export const AgentIdSchema = uintString.transform((s) => BigInt(s) as AgentId);
export const OwnerEpochSchema = uint64.transform((v) => v as OwnerEpoch);
export const ConfigEpochSchema = uint64.transform((v) => v as ConfigEpoch);
export const ActionIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex value")
  .transform((s) => s as ActionId);
export const IntentIdSchema = z.uuid().transform((s) => s as IntentId);
export const ClientRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "must be 8 to 64 characters of letters, digits, _ or -")
  .transform((s) => s as ClientRequestId);

/** A 32-byte hash such as a transaction hash, build hash or usage hash. */
export type Bytes32 = `0x${string}`;
export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex value")
  .transform((s) => s as Bytes32);

/** A Unix time in whole seconds. */
export type UnixSeconds = number;
export const UnixSecondsSchema = z.number().int().nonnegative();

/** `0x754704Bc...b603` shortened to `0x7547…b603` for display. The full address stays available for copying. */
export function shortenAddress(address: string, visible = 4): string {
  if (!/^0x[0-9a-fA-F]+$/.test(address) || address.length <= 2 + visible * 2) return address;
  return `${address.slice(0, 2 + visible)}…${address.slice(-visible)}`;
}
