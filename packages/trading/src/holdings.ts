import { AGENT_NFT_ABI } from "@alpha-agents/domain";
import { type Hex, createPublicClient, encodeFunctionData, getAddress, http, parseAbi } from "viem";
import type { WalletCall } from "./actions.ts";

/**
 * Everything an agent holds, at each of its addresses (P2-EC testnet tuning,
 * D-315): the funding address (credits in USDC, MON for gas), the token-bound
 * account (the NFT's own account, which the platform never uses) and the
 * PersonalAccount (the trading account). Each balance says whether it does
 * something there; what sits in the token-bound account does nothing, and its
 * owner can move it to their own wallet with a call the owner signs: the
 * account's `execute`, which only the agent's current owner may call.
 */
export type HoldingRole = "funding" | "token_bound" | "personal_account";

/** A token the environment's address book knows, and its decimals. */
export interface HoldingToken {
  readonly symbol: string;
  readonly address: Hex;
  readonly decimals: number;
}

export interface HoldingsContracts {
  readonly agentNft: Hex;
  readonly accountFactory: Hex | null;
  readonly tokens: readonly HoldingToken[];
}

export interface AddressReading {
  readonly role: HoldingRole;
  /** Null when the address does not exist yet (no funding address recorded, no account opened). */
  readonly address: Hex | null;
  /** Native MON, then every known token, raw. */
  readonly native: bigint;
  readonly tokens: readonly { readonly token: HoldingToken; readonly raw: bigint }[];
}

export interface HoldingsReading {
  readonly chainId: number;
  readonly block: bigint;
  readonly agentId: number;
  readonly owner: Hex;
  readonly addresses: readonly AddressReading[];
}

export interface HoldingsReader {
  /** Null when the agent does not exist. */
  holdings(agentId: number, fundingAddress: Hex | null): Promise<HoldingsReading | null>;
}

/** What a balance does where it is. */
export type HoldingUse = "gas" | "credits" | "trading" | null;
/**
 * `in_use`: the agent uses it there. `movable`: it does nothing there and the
 * owner can move it to their wallet. `platform_only`: it does nothing there and
 * only the platform's key can move it. `stuck`: nothing can move it.
 */
export type HoldingStatus = "in_use" | "movable" | "platform_only" | "stuck";

export interface HoldingJson {
  readonly symbol: string;
  /** Null for native MON. */
  readonly token: Hex | null;
  readonly decimals: number;
  readonly raw: string;
  readonly use: HoldingUse;
  readonly status: HoldingStatus;
  /** For a movable balance: the call that sends it to the owner's wallet. */
  readonly recoverCall: WalletCall | null;
}

export interface AddressHoldingsJson {
  readonly role: HoldingRole;
  readonly address: Hex | null;
  readonly holdings: readonly HoldingJson[];
}

export interface HoldingsJson {
  readonly agentId: number;
  readonly owner: Hex;
  readonly block: string;
  readonly addresses: readonly AddressHoldingsJson[];
}

const TBA_ABI = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const FACTORY_ABI = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

/** The call, signed by the owner, that has the token-bound account send `raw` of an asset to the owner. */
export function tokenBoundRecoverCall(
  tba: Hex,
  owner: Hex,
  token: Hex | null,
  raw: bigint,
): WalletCall {
  const data =
    token === null
      ? encodeFunctionData({ abi: TBA_ABI, functionName: "execute", args: [owner, raw, "0x", 0] })
      : encodeFunctionData({
          abi: TBA_ABI,
          functionName: "execute",
          args: [
            token,
            0n,
            encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [owner, raw] }),
            0,
          ],
        });
  return { to: tba, data, value: "0" };
}

/** What each balance is for at each address, and how a stranded one can move. */
export function holdingsJson(r: HoldingsReading): HoldingsJson {
  return {
    agentId: r.agentId,
    owner: r.owner,
    block: r.block.toString(),
    addresses: r.addresses.map((a) => {
      const line = (symbol: string, token: HoldingToken | null, raw: bigint): HoldingJson => {
        const { use, status } = classify(a.role, symbol);
        return {
          symbol,
          token: token?.address ?? null,
          decimals: token?.decimals ?? 18,
          raw: raw.toString(),
          use,
          status,
          recoverCall:
            status === "movable" && a.address && raw > 0n
              ? tokenBoundRecoverCall(a.address, r.owner, token?.address ?? null, raw)
              : null,
        };
      };
      const all = [
        line("MON", null, a.native),
        ...a.tokens.map((t) => line(t.token.symbol, t.token, t.raw)),
      ];
      // What an address is for always shows (even at zero); anything else only when held.
      const holdings = all.filter((h) => h.raw !== "0" || h.status === "in_use");
      return { role: a.role, address: a.address, holdings };
    }),
  };
}

function classify(role: HoldingRole, symbol: string): { use: HoldingUse; status: HoldingStatus } {
  if (role === "funding") {
    if (symbol === "MON") return { use: "gas", status: "in_use" };
    if (symbol === "USDC") return { use: "credits", status: "in_use" };
    return { use: null, status: "platform_only" };
  }
  if (role === "personal_account") {
    if (symbol === "USDC" || symbol === "WMON") return { use: "trading", status: "in_use" };
    return { use: null, status: "stuck" };
  }
  return { use: null, status: "movable" };
}

/** Reads every balance at the agent's addresses, fresh from the chain. */
export function rpcHoldingsReader(
  rpcUrl: string,
  chainId: number,
  c: HoldingsContracts,
): HoldingsReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const read = <T>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const balances = async (role: HoldingRole, address: Hex | null): Promise<AddressReading> => {
    if (!address) return { role, address, native: 0n, tokens: [] };
    const [native, ...raws] = await Promise.all([
      client.getBalance({ address }),
      ...c.tokens.map((t) => read<bigint>(t.address, ERC20_ABI, "balanceOf", [address])),
    ]);
    return {
      role,
      address,
      native,
      tokens: c.tokens.map((token, i) => ({ token, raw: raws[i] ?? 0n })),
    };
  };
  return {
    async holdings(agentId, fundingAddress) {
      const id = BigInt(agentId);
      let owner: Hex;
      try {
        owner = await read<Hex>(c.agentNft, AGENT_NFT_ABI, "ownerOf", [id]);
      } catch (err) {
        if (err instanceof Error && /revert/i.test(err.message)) return null;
        throw err;
      }
      const [block, tba, account] = await Promise.all([
        client.getBlockNumber(),
        read<Hex>(c.agentNft, AGENT_NFT_ABI, "tbaOf", [id]),
        c.accountFactory
          ? read<Hex>(c.accountFactory, FACTORY_ABI, "personalAccountOf", [id, owner])
          : Promise.resolve(ZERO as Hex),
      ]);
      const addresses = await Promise.all([
        balances("funding", fundingAddress),
        balances("token_bound", getAddress(tba)),
        balances("personal_account", account === ZERO ? null : getAddress(account)),
      ]);
      return { chainId, block, agentId, owner: getAddress(owner), addresses };
    },
  };
}
