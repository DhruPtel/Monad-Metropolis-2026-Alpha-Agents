import { type Address, type Hex, decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import type { HoldingsJson } from "../src/api/client";

/**
 * D-315: an agent's holdings at its three addresses for the e2e suite, answered
 * as GET /v1/agents/:id/holdings does, and changed by the owner's moves: when
 * the mock wallet sends the token-bound account's `execute`, the balance moves
 * to the owner here, as it would on chain.
 */
const TBA_ABI = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
]);
const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
export const EXECUTE_SELECTOR = "0x51945447";

export const HOLDING_TOKENS = {
  USDC: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address, decimals: 6 },
  WMON: { address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address, decimals: 18 },
} as const;
type Symbol = "MON" | keyof typeof HOLDING_TOKENS;

type Role = HoldingsJson["addresses"][number]["role"];
export interface FakeAddress {
  readonly role: Role;
  readonly address: Address | null;
  readonly balances: Partial<Record<Symbol, bigint>>;
}

const USE: Readonly<Record<Role, Partial<Record<Symbol, "gas" | "credits" | "trading">>>> = {
  funding: { MON: "gas", USDC: "credits" },
  token_bound: {},
  personal_account: { USDC: "trading", WMON: "trading" },
};

export class FakeHoldings {
  readonly owner: Address;
  addresses: FakeAddress[];
  /** Moves the fake applied, as "role symbol". */
  readonly moved: string[] = [];

  constructor(owner: Address, addresses: FakeAddress[]) {
    this.owner = owner;
    this.addresses = addresses;
  }

  json(agentId: bigint): HoldingsJson {
    return {
      agentId: Number(agentId),
      owner: this.owner,
      block: "109670100",
      addresses: this.addresses.map((a) => ({
        role: a.role,
        address: a.address,
        holdings: (["MON", "USDC", "WMON"] as const).flatMap((symbol) => {
          const raw = a.balances[symbol] ?? 0n;
          const use = USE[a.role][symbol] ?? null;
          if (raw === 0n && !use) return [];
          const status = use
            ? ("in_use" as const)
            : a.role === "token_bound"
              ? ("movable" as const)
              : a.role === "funding"
                ? ("platform_only" as const)
                : ("stuck" as const);
          const token = symbol === "MON" ? null : HOLDING_TOKENS[symbol].address;
          return [
            {
              symbol,
              token,
              decimals: symbol === "USDC" ? 6 : 18,
              raw: raw.toString(),
              use,
              status,
              recoverCall:
                status === "movable" && a.address
                  ? { to: a.address, data: this.recoverData(token, raw), value: "0" as const }
                  : null,
            },
          ];
        }),
      })),
    };
  }

  private recoverData(token: Address | null, raw: bigint): Hex {
    return token === null
      ? encodeFunctionData({
          abi: TBA_ABI,
          functionName: "execute",
          args: [this.owner, raw, "0x", 0],
        })
      : encodeFunctionData({
          abi: TBA_ABI,
          functionName: "execute",
          args: [
            token,
            0n,
            encodeFunctionData({
              abi: ERC20_ABI,
              functionName: "transfer",
              args: [this.owner, raw],
            }),
            0,
          ],
        });
  }

  /** The owner's `execute` on the token-bound account: the balance leaves it. */
  onSend(tx: { from: Address; to: Address; data: Hex }): void {
    const tba = this.addresses.find((a) => a.role === "token_bound");
    if (!tba?.address || tx.to.toLowerCase() !== tba.address.toLowerCase()) return;
    if (tx.from.toLowerCase() !== this.owner.toLowerCase()) return;
    const { args } = decodeFunctionData({ abi: TBA_ABI, data: tx.data });
    const [to, value, inner] = args;
    let symbol: Symbol;
    if (inner === "0x") symbol = "MON";
    else {
      const t = (Object.keys(HOLDING_TOKENS) as (keyof typeof HOLDING_TOKENS)[]).find(
        (k) => HOLDING_TOKENS[k].address.toLowerCase() === to.toLowerCase(),
      );
      if (!t) return;
      symbol = t;
    }
    const amount =
      symbol === "MON" ? value : decodeFunctionData({ abi: ERC20_ABI, data: inner }).args[1];
    this.addresses = this.addresses.map((a) =>
      a === tba
        ? { ...a, balances: { ...a.balances, [symbol]: (a.balances[symbol] ?? 0n) - amount } }
        : a,
    );
    this.moved.push(`token_bound ${symbol}`);
  }
}
