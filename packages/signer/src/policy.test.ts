import { readFileSync } from "node:fs";
import { SIGNER_REASON_CODES, TRANSACTION_STATES } from "@alpha-agents/domain";
import { encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ERC20_ABI, EXECUTOR_ABI, type SwapIntentArgs } from "./abi.ts";
import {
  CHAIN_PINS,
  MAX_FEE_PER_GAS_CAP,
  SIGNER_REFUSALS,
  MAX_PRIORITY_FEE_CAP,
  SWAP_GAS_LIMIT,
  type PolicyContext,
  type SignRequest,
  TRANSFER_GAS_LIMIT,
  type TransferContext,
  checkSignRequest,
  checkTransferRequest,
} from "./policy.ts";

const EXECUTOR = "0xE712468eB37544B7Eafe20F402867f7a49C19F43" as Hex;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Hex;

const intent = (over: Partial<SwapIntentArgs> = {}): SwapIntentArgs => ({
  schemaVersion: 1,
  chainId: 143143n,
  agentId: 7n,
  account: "0x00000000000000000000000000000000000ac001",
  actionId: `0x${"11".repeat(32)}`,
  ownerEpoch: 0n,
  configEpoch: 0n,
  policyHash: `0x${"22".repeat(32)}`,
  adapterId: `0x${"33".repeat(32)}`,
  tokenIn: USDC,
  tokenOut: WMON,
  amountIn: 5_000_000n,
  minAmountOut: 1n,
  deadline: 1_790_876_545n,
  ...over,
});

const swap = (i = intent()): Hex =>
  encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "swap", args: [i] });

const req = (over: Partial<SignRequest> = {}): SignRequest => ({
  chainId: 143143,
  to: EXECUTOR,
  data: swap(),
  value: 0n,
  gas: SWAP_GAS_LIMIT,
  maxFeePerGas: 100_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  ...over,
});

const ctx: PolicyContext = { environment: "local", executor: EXECUTOR, agentId: 7 };
const code = (r: SignRequest, c: PolicyContext = ctx) => {
  const v = checkSignRequest(r, c);
  return v.ok ? "OK" : v.code;
};

describe("the signer's allowlist (P2-U4 item 3)", () => {
  it("signs the Executor's swap, for this chain and this agent", () => {
    const v = checkSignRequest(req(), ctx);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.intent.amountIn).toBe(5_000_000n);
  });

  it("refuses any other target, function or native value before signing", () => {
    expect(code(req({ to: USDC }))).toBe("TARGET_NOT_ALLOWED");
    expect(
      code(
        req({
          to: USDC,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [EXECUTOR, 1n],
          }),
        }),
      ),
    ).toBe("TARGET_NOT_ALLOWED");
    expect(
      code(
        req({
          data: encodeFunctionData({
            abi: EXECUTOR_ABI,
            functionName: "registerSession",
            args: [7n, EXECUTOR, 1n],
          }),
        }),
      ),
    ).toBe("FUNCTION_NOT_ALLOWED");
    expect(code(req({ data: "0x" }))).toBe("FUNCTION_NOT_ALLOWED");
    expect(code(req({ value: 1n }))).toBe("VALUE_NOT_ALLOWED");
    expect(code(req({ to: null }))).toBe("CONTRACT_CREATION");
    expect(code(req({ data: `${swap().slice(0, 10)}00` as Hex }))).toBe("INTENT_MALFORMED");
    expect(code(req(), { ...ctx, agentId: 8 })).toBe("AGENT_MISMATCH");
  });

  it("caps the gas limit and the fees", () => {
    expect(code(req({ gas: SWAP_GAS_LIMIT + 1n }))).toBe("GAS_LIMIT_EXCEEDED");
    expect(code(req({ gas: 0n }))).toBe("GAS_LIMIT_EXCEEDED");
    expect(code(req({ maxFeePerGas: MAX_FEE_PER_GAS_CAP + 1n }))).toBe("FEE_CAP_EXCEEDED");
    expect(code(req({ maxPriorityFeePerGas: MAX_PRIORITY_FEE_CAP + 1n }))).toBe("FEE_CAP_EXCEEDED");
    expect(code(req({ maxFeePerGas: 1n, maxPriorityFeePerGas: 2n }))).toBe("FEE_CAP_EXCEEDED");
  });
});

describe("the chain pin (P2-U4 item 4)", () => {
  it("pins 143143 locally, 10143 on testnet and 143 on mainnet", () => {
    expect(CHAIN_PINS).toEqual({ local: 143143, testnet: 10143, beta: 143 });
  });

  it("refuses every other chain, in the transaction or in the intent", () => {
    for (const [environment, pin] of Object.entries(CHAIN_PINS)) {
      const c = { ...ctx, environment: environment as keyof typeof CHAIN_PINS };
      const own = intent({ chainId: BigInt(pin) });
      expect(code(req({ chainId: pin, data: swap(own) }), c)).toBe("OK");
      for (const other of Object.values(CHAIN_PINS).filter((p) => p !== pin)) {
        expect(code(req({ chainId: other, data: swap(own) }), c)).toBe("CHAIN_NOT_PINNED");
        expect(code(req({ chainId: pin, data: swap(intent({ chainId: BigInt(other) })) }), c)).toBe(
          "AGENT_MISMATCH",
        );
      }
      expect(code(req({ chainId: 1, data: swap(own) }), c)).toBe("CHAIN_NOT_PINNED");
    }
  });
});

describe("one list of states and codes (P2-U4)", () => {
  it("the outbox table allows exactly packages/domain's transaction states", () => {
    const migration = readFileSync(
      new URL("../../db/src/migrations/0008_signer.ts", import.meta.url),
      "utf8",
    );
    const check = /status in \(([^)]*)\)/.exec(migration)?.[1] ?? "";
    expect(check.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([
      ...TRANSACTION_STATES,
    ]);
  });

  it("the signer's refusals are packages/domain's first ten signer codes", () => {
    expect(SIGNER_REFUSALS).toEqual(SIGNER_REASON_CODES.slice(0, 10));
    expect(SIGNER_REFUSALS).toContain("TARGET_NOT_ALLOWED");
  });
});

describe("the signer's USDC transfer allowlist (P2-U5 step 0, D-261)", () => {
  const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
  const transfer = (to: Hex = OWNER, amount = 1_000_000n): Hex =>
    encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });
  const treq = (over: Partial<SignRequest> = {}): SignRequest =>
    req({ to: USDC, data: transfer(), gas: TRANSFER_GAS_LIMIT, ...over });
  const tctx: TransferContext = {
    environment: "local",
    usdc: USDC,
    kind: "usdc_refund",
    recipient: OWNER,
  };
  const tcode = (r: SignRequest, c: TransferContext = tctx) => {
    const v = checkTransferRequest(r, c);
    return v.ok ? "OK" : v.code;
  };

  it("signs a USDC transfer to the one allowed recipient", () => {
    const v = checkTransferRequest(treq(), tctx);
    expect(v.ok && v.to.toLowerCase() === OWNER && v.amount === 1_000_000n).toBe(true);
  });
  it("refuses another chain, a creation, another token, another function or value", () => {
    expect(tcode(treq({ chainId: 143 }))).toBe("CHAIN_NOT_PINNED");
    expect(tcode(treq({ to: null }))).toBe("CONTRACT_CREATION");
    expect(tcode(treq({ to: WMON }))).toBe("TARGET_NOT_ALLOWED");
    expect(tcode(treq({ data: swap() }))).toBe("FUNCTION_NOT_ALLOWED");
    expect(tcode(treq({ value: 1n }))).toBe("VALUE_NOT_ALLOWED");
  });
  it("refuses a malformed or empty transfer", () => {
    expect(tcode(treq({ data: `${transfer().slice(0, 10)}00` as Hex }))).toBe("INTENT_MALFORMED");
    expect(tcode(treq({ data: transfer(OWNER, 0n) }))).toBe("INTENT_MALFORMED");
  });
  it("refuses any recipient but the allowed one, and refuses when none is known", () => {
    expect(tcode(treq({ data: transfer(EXECUTOR) }))).toBe("RECIPIENT_NOT_ALLOWED");
    expect(tcode(treq(), { ...tctx, recipient: null })).toBe("RECIPIENT_NOT_ALLOWED");
  });
  it("holds the transfer gas limit and the fee caps", () => {
    expect(tcode(treq({ gas: TRANSFER_GAS_LIMIT + 1n }))).toBe("GAS_LIMIT_EXCEEDED");
    expect(tcode(treq({ maxFeePerGas: MAX_FEE_PER_GAS_CAP + 1n }))).toBe("FEE_CAP_EXCEEDED");
  });
});
