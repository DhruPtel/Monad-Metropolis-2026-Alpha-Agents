import { AGENT_NFT_ABI } from "@alpha-agents/domain";
import {
  type Hex,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
} from "viem";
import type { WalletCall } from "./actions.ts";
import { ACCOUNT_HOLDINGS_ABI, chainSymbols, heldTokenSymbol } from "./portfolio-v3.ts";

/**
 * Everything an agent holds, at each of its addresses (P2-EC testnet tuning,
 * D-315): the funding address (credits in USDC, MON for gas), the token-bound
 * account (the NFT's own account, which the platform never uses) and the
 * PersonalAccount (the trading account). Each balance says whether it does
 * something there; what sits in the token-bound account does nothing, and its
 * owner can move it to their own wallet with a call the owner signs: the
 * account's `execute`, which only the agent's current owner may call.
 */
export type HoldingRole = "funding" | "token_bound" | "personal_account" | "older_account";

/** A token the environment's address book knows, and its decimals. */
export interface HoldingToken {
  readonly symbol: string;
  readonly address: Hex;
  readonly decimals: number;
}

export interface HoldingsContracts {
  readonly agentNft: Hex;
  /** The v2 AccountFactory; its account is the trading account where no v3 factory is deployed, else an older account (A-80). */
  readonly accountFactory: Hex | null;
  /** AccountFactoryV3, where the fund agent's set is deployed. */
  readonly accountFactoryV3?: Hex | null;
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
export type HoldingStatus = "in_use" | "movable" | "platform_only" | "stuck" | "older";

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
    if (symbol === "MON") return { use: null, status: "stuck" };
    return { use: "trading", status: "in_use" };
  }
  // A-80: what the older v2 account holds is the owner's to withdraw, from the portfolio page.
  if (role === "older_account") {
    if (symbol === "MON") return { use: null, status: "stuck" };
    return { use: null, status: "older" };
  }
  return { use: null, status: "movable" };
}

/** The reads the holdings reader makes; a test gives a fake, the app a viem client. */
export interface HoldingsClient {
  readContract(args: {
    address: Hex;
    abi: unknown;
    functionName: string;
    args?: unknown[];
  }): Promise<unknown>;
  getBalance(args: { address: Hex }): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
}

/** Reads every balance at the agent's addresses, fresh from the chain. */
export function rpcHoldingsReader(
  rpcUrl: string,
  chainId: number,
  c: HoldingsContracts,
  injected?: HoldingsClient,
): HoldingsReader {
  const client: HoldingsClient =
    injected ?? (createPublicClient({ transport: http(rpcUrl) }) as unknown as HoldingsClient);
  const read = <T>(address: Hex, abi: unknown, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;
  const chainSymbol = chainSymbols(client);
  /**
   * 2026-10-17: the v3 trading account's own list of what it holds (the portfolio's read), each
   * token named as the portfolio names it, so a token the address book does not list (the
   * testnet stand-ins TALPHA and TBETA) shows here as it does in the portfolio.
   */
  const heldByAccount = async (account: Hex) => {
    const held = await read<readonly { token: Hex; decimals: number; balance: bigint }[]>(
      account,
      ACCOUNT_HOLDINGS_ABI,
      "holdings",
    );
    return Promise.all(
      held
        .filter((h) => h.balance > 0n && !c.tokens.some((t) => isAddressEqual(t.address, h.token)))
        .map(async (h) => ({
          token: {
            symbol: await heldTokenSymbol(h.token, { listed: c.tokens, chainSymbol }),
            address: getAddress(h.token),
            decimals: Number(h.decimals),
          },
          raw: h.balance,
        })),
    );
  };
  const balances = async (role: HoldingRole, address: Hex | null): Promise<AddressReading> => {
    if (!address) return { role, address, native: 0n, tokens: [] };
    const v3Account = role === "personal_account" && Boolean(c.accountFactoryV3);
    const [native, held, ...raws] = await Promise.all([
      client.getBalance({ address }),
      v3Account ? heldByAccount(address) : Promise.resolve([]),
      ...c.tokens.map((t) => read<bigint>(t.address, ERC20_ABI, "balanceOf", [address])),
    ]);
    return {
      role,
      address,
      native,
      tokens: [...c.tokens.map((token, i) => ({ token, raw: raws[i] ?? 0n })), ...held],
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
      const accountOf = (factory: Hex | null | undefined) =>
        factory
          ? read<Hex>(factory, FACTORY_ABI, "personalAccountOf", [id, owner])
          : Promise.resolve(ZERO as Hex);
      const [block, tba, v2, v3] = await Promise.all([
        client.getBlockNumber(),
        read<Hex>(c.agentNft, AGENT_NFT_ABI, "tbaOf", [id]),
        accountOf(c.accountFactory),
        accountOf(c.accountFactoryV3),
      ]);
      const at = (a: Hex) => (a === ZERO ? null : getAddress(a));
      // Where the fund set is deployed the v3 account is the trading account and a v2 one is older (A-80).
      const addresses = await Promise.all([
        balances("funding", fundingAddress),
        balances("token_bound", getAddress(tba)),
        balances("personal_account", c.accountFactoryV3 ? at(v3) : at(v2)),
        ...(c.accountFactoryV3 && v2 !== ZERO ? [balances("older_account", at(v2))] : []),
      ]);
      return { chainId, block, agentId, owner: getAddress(owner), addresses };
    },
  };
}
