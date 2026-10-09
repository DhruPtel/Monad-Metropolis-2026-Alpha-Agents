import { addressEntry } from "@alpha-agents/domain";
import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  size,
  toHex,
} from "viem";
import { type Cached, type MarketCache, cacheKey } from "./cache.ts";
import { MAINNET_CHAIN_ID } from "./mainnet.ts";
import { readOnlyTransport } from "./readonly.ts";
import { MarketError } from "./upstream.ts";

/**
 * Contract lookups for research on Monad mainnet (P3-U9, FINAL_PLAN 4.4.2,
 * A-24): a curated set of read-only calls on any `target`, a token or native
 * balance, and code presence with the proxy pattern. Reads only, over the
 * read-only transport (D-289): nothing here can sign or send. Values come
 * back typed: integers as decimal strings, addresses checksummed, booleans;
 * a string or dynamic bytes only as its length and keccak256 hash, never as
 * text, so a contract cannot put words in front of the model. Every answer
 * names its block.
 */
export const READ_FUNCTIONS = {
  erc20_total_supply: {
    abi: "function totalSupply() view returns (uint256)",
    args: [],
    about: "ERC-20 total supply, raw units",
  },
  erc20_decimals: {
    abi: "function decimals() view returns (uint8)",
    args: [],
    about: "ERC-20 decimals",
  },
  erc20_name: {
    abi: "function name() view returns (string)",
    args: [],
    about: "ERC-20 name, as length and hash only",
  },
  erc20_symbol: {
    abi: "function symbol() view returns (string)",
    args: [],
    about: "ERC-20 symbol, as length and hash only",
  },
  erc20_balance_of: {
    abi: "function balanceOf(address) view returns (uint256)",
    args: ["holder"],
    about: "ERC-20 balance of `holder`, raw units",
  },
  owner: { abi: "function owner() view returns (address)", args: [], about: "Ownable owner" },
  paused: { abi: "function paused() view returns (bool)", args: [], about: "Pausable state" },
  proxy_implementation: {
    abi: null,
    args: [],
    about: "EIP-1967 implementation slot",
  },
  proxy_admin: { abi: null, args: [], about: "EIP-1967 admin slot" },
  chainlink_latest_round: {
    abi: "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    args: [],
    about: "Chainlink feed's latest round, with the feed's decimals",
  },
  uniswap_v4_slot0: {
    abi: "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    args: ["poolId"],
    about: "Uniswap v4 pool state through a StateView `target`",
  },
  uniswap_v4_liquidity: {
    abi: "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
    args: ["poolId"],
    about: "Uniswap v4 pool liquidity through a StateView `target`",
  },
} as const;
export type ReadFunction = keyof typeof READ_FUNCTIONS;
export const READ_FUNCTION_NAMES = Object.keys(READ_FUNCTIONS) as ReadFunction[];

/** EIP-1967 slots: keccak256("eip1967.proxy.<name>") - 1. */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;
export const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex;

export type TypedValue =
  | { readonly type: "uint" | "int"; readonly value: string }
  | { readonly type: "address"; readonly value: string | null }
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "bytes32"; readonly value: string }
  | { readonly type: "string" | "bytes"; readonly length: number; readonly keccak256: string };

export interface AsOf {
  readonly block: string;
  readonly timestamp: string;
}

export interface ReadResult {
  readonly function: ReadFunction;
  readonly target: string;
  readonly outputs: Readonly<Record<string, TypedValue>>;
  readonly asOf: AsOf;
}

export interface BalanceResult {
  readonly target: string;
  readonly asset: "USDC" | "WMON" | "NATIVE";
  readonly amount: string;
  readonly amountRaw: string;
  readonly decimals: number;
  readonly asOf: AsOf;
}

export type ProxyPattern =
  "none" | "eip1967" | "eip1967_beacon" | "eip1167_minimal_proxy" | "eip7702_delegation";

export interface CodeResult {
  readonly target: string;
  readonly hasCode: boolean;
  readonly sizeBytes: number;
  readonly codeHash: string | null;
  readonly proxy: { readonly pattern: ProxyPattern; readonly implementation: string | null };
  readonly note: string;
  readonly asOf: AsOf;
}

export interface MainnetLookup {
  read(fn: ReadFunction, target: Address, args: Record<string, string>): Promise<ReadResult>;
  balance(target: Address, asset: BalanceResult["asset"]): Promise<BalanceResult>;
  code(target: Address): Promise<CodeResult>;
}

const ZERO = /^0x0*$/;

/** A 32-byte slot holding an address, or null when it is empty. */
export function slotAddress(word: Hex | undefined): string | null {
  if (!word || ZERO.test(word)) return null;
  return getAddress(`0x${word.slice(-40)}`);
}

/** The proxy pattern code and slots show, with the implementation it points to. */
export function proxyPattern(
  code: Hex,
  slots: { implementation?: Hex; beacon?: Hex },
): CodeResult["proxy"] {
  const c = code.toLowerCase();
  if (c.startsWith("0xef0100") && c.length === 2 + 46)
    return { pattern: "eip7702_delegation", implementation: getAddress(`0x${c.slice(8)}`) };
  const minimal = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(c);
  if (minimal?.[1])
    return { pattern: "eip1167_minimal_proxy", implementation: getAddress(`0x${minimal[1]}`) };
  const impl = slotAddress(slots.implementation);
  if (impl) return { pattern: "eip1967", implementation: impl };
  const beacon = slotAddress(slots.beacon);
  if (beacon) return { pattern: "eip1967_beacon", implementation: beacon };
  return { pattern: "none", implementation: null };
}

/** One decoded output as a typed value; strings and dynamic bytes only as length and hash. */
export function typed(abiType: string, v: unknown): TypedValue {
  if (abiType.startsWith("uint")) return { type: "uint", value: String(v) };
  if (abiType.startsWith("int")) return { type: "int", value: String(v) };
  if (abiType === "address") return { type: "address", value: v ? getAddress(String(v)) : null };
  if (abiType === "bool") return { type: "bool", value: v === true };
  if (abiType === "bytes32") return { type: "bytes32", value: String(v) };
  if (abiType === "string") {
    const hex = toHex(String(v));
    return { type: "string", length: size(hex), keccak256: keccak256(hex) };
  }
  const hex = (typeof v === "string" && v.startsWith("0x") ? v : "0x") as Hex;
  return { type: "bytes", length: size(hex), keccak256: keccak256(hex) };
}

const ASSET_DECIMALS = { USDC: 6, WMON: 18, NATIVE: 18 } as const;

export function viemMainnetLookup(
  rpcUrls: readonly string[],
  expectChainId: number = MAINNET_CHAIN_ID,
): MainnetLookup {
  const client = createPublicClient({ transport: readOnlyTransport(rpcUrls) }) as PublicClient;
  const unavailable = () =>
    new MarketError("UPSTREAM_UNAVAILABLE", "monad", "Could not read Monad mainnet.", {
      retryable: true,
    });

  async function head(): Promise<{ number: bigint; asOf: AsOf }> {
    const chainId = await client.getChainId();
    if (chainId !== expectChainId)
      throw new MarketError(
        "UPSTREAM_UNAVAILABLE",
        "monad",
        `The mainnet RPC serves chain ${chainId}, not 143.`,
        { retryable: false },
      );
    const b = await client.getBlock();
    return {
      number: b.number,
      asOf: {
        block: b.number.toString(),
        timestamp: new Date(Number(b.timestamp) * 1000).toISOString(),
      },
    };
  }

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MarketError) throw err;
      throw unavailable();
    }
  };

  return {
    read: (fn, target, args) =>
      guard(async () => {
        const h = await head();
        const spec = READ_FUNCTIONS[fn];
        if (spec.abi === null) {
          const slot =
            fn === "proxy_implementation" ? EIP1967_IMPLEMENTATION_SLOT : EIP1967_ADMIN_SLOT;
          const word = await client.getStorageAt({ address: target, slot, blockNumber: h.number });
          return {
            function: fn,
            target: getAddress(target),
            outputs: {
              [fn === "proxy_implementation" ? "implementation" : "admin"]: {
                type: "address",
                value: slotAddress(word),
              },
            },
            asOf: h.asOf,
          };
        }
        const abi = parseAbi([spec.abi]) as Abi;
        const item = abi[0] as {
          name: string;
          outputs: readonly { name?: string; type: string }[];
        };
        let raw: unknown;
        try {
          raw = await client.readContract({
            address: target,
            abi,
            functionName: item.name,
            args: spec.args.map((a) => args[a]) as never,
            blockNumber: h.number,
          });
        } catch {
          throw new MarketError(
            "UPSTREAM_UNAVAILABLE",
            "monad",
            `The call ${fn} reverted or returned nothing at this target: it may not implement it.`,
            { retryable: false },
          );
        }
        const values = item.outputs.length === 1 ? [raw] : (raw as unknown[]);
        const outputs: Record<string, TypedValue> = {};
        item.outputs.forEach((o, i) => {
          outputs[o.name || (item.outputs.length === 1 ? "value" : `out${i}`)] = typed(
            o.type,
            values[i],
          );
        });
        if (fn === "chainlink_latest_round") {
          const decimals = await client
            .readContract({
              address: target,
              abi: parseAbi(["function decimals() view returns (uint8)"]),
              functionName: "decimals",
              blockNumber: h.number,
            })
            .catch(() => null);
          if (decimals !== null) outputs.decimals = { type: "uint", value: String(decimals) };
        }
        return { function: fn, target: getAddress(target), outputs, asOf: h.asOf };
      }),

    balance: (target, asset) =>
      guard(async () => {
        const h = await head();
        let raw: bigint;
        if (asset === "NATIVE")
          raw = await client.getBalance({ address: target, blockNumber: h.number });
        else
          raw = (await client.readContract({
            address: addressEntry("beta", asset === "USDC" ? "usdc" : "wmon").address as Address,
            abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
            functionName: "balanceOf",
            args: [target],
            blockNumber: h.number,
          })) as bigint;
        const decimals = ASSET_DECIMALS[asset];
        return {
          target: getAddress(target),
          asset,
          amount: formatUnits(raw, decimals),
          amountRaw: raw.toString(),
          decimals,
          asOf: h.asOf,
        };
      }),

    code: (target) =>
      guard(async () => {
        const h = await head();
        const [code, implementation, beacon] = await Promise.all([
          client.getCode({ address: target, blockNumber: h.number }),
          client.getStorageAt({
            address: target,
            slot: EIP1967_IMPLEMENTATION_SLOT,
            blockNumber: h.number,
          }),
          client.getStorageAt({
            address: target,
            slot: EIP1967_BEACON_SLOT,
            blockNumber: h.number,
          }),
        ]);
        const bytes = (code ?? "0x") as Hex;
        const has = bytes !== "0x";
        const proxy: CodeResult["proxy"] = has
          ? proxyPattern(bytes, {
              ...(implementation ? { implementation } : {}),
              ...(beacon ? { beacon } : {}),
            })
          : { pattern: "none", implementation: null };
        return {
          target: getAddress(target),
          hasCode: has,
          sizeBytes: size(bytes),
          codeHash: has ? keccak256(bytes) : null,
          proxy,
          note: !has
            ? "No code at this address on Monad mainnet: it is an account with no contract, or nothing is deployed there."
            : proxy.pattern === "eip7702_delegation"
              ? "An account with an EIP-7702 delegation: it runs the delegate's code."
              : proxy.pattern === "none"
                ? "A contract with no proxy pattern detected."
                : "A proxy: the logic lives at the implementation, which can change if the proxy is upgradeable.",
          asOf: h.asOf,
        };
      }),
  };
}

/** A-57: lookups are cached 15 seconds across agents (about 35 Monad blocks). */
export const LOOKUP_TTL_MS = 15_000;

export const lookupKey = (method: string, input: Record<string, unknown>) =>
  cacheKey("monad", `lookup.${method}`, input);

/** The lookups through the shared cache. */
export function cachedLookup(lookup: MainnetLookup, cache: MarketCache) {
  return {
    read: (
      fn: ReadFunction,
      target: Address,
      args: Record<string, string>,
    ): Promise<Cached<ReadResult>> =>
      cache.get(lookupKey("read", { fn, target: target.toLowerCase(), args }), LOOKUP_TTL_MS, () =>
        lookup.read(fn, target, args),
      ),
    balance: (target: Address, asset: BalanceResult["asset"]): Promise<Cached<BalanceResult>> =>
      cache.get(lookupKey("balance", { target: target.toLowerCase(), asset }), LOOKUP_TTL_MS, () =>
        lookup.balance(target, asset),
      ),
    code: (target: Address): Promise<Cached<CodeResult>> =>
      cache.get(lookupKey("code", { target: target.toLowerCase() }), LOOKUP_TTL_MS, () =>
        lookup.code(target),
      ),
  };
}
