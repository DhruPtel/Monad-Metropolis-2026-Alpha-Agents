import { type Address, addressEntry } from "@alpha-agents/domain";
import {
  type Hex,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";
import { mintTestUsdc, sendAs } from "./controls.ts";
import { assertLocalFork } from "./guard.ts";
import { RpcError, hexToBigInt, rpc, toHex } from "./rpc.ts";

/**
 * Test trading on the fund agent's v3 set (F-U5): open a wallet's
 * PersonalAccountV3 for one of its agents, fund it with several registered
 * tokens, each bought with test USDC through its real pools by the F-U2 demo
 * RouteAdapter (whose executor is anvil account 0), and read the account's
 * whole held list. Every write checks that the URL is the local fork first;
 * the snapshot only reads. The owner's grant goes on Executor v3 through
 * `registerTestSessionGrant` with that Executor given.
 */
const FACTORY_ABI = parseAbi([
  "function createPersonalAccount(uint256 agentId) returns (address)",
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function isAllowlisted(address depositor) view returns (bool)",
  "function allowlistEnabled() view returns (bool)",
  "function addDepositor(address depositor)",
  "function owner() view returns (address)",
  "function personalCap() view returns (uint256)",
]);
const ACCOUNT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function holdings() view returns ((address token, uint8 decimals, uint256 balance, uint256 free, uint256 costBasis, uint256 lastPriceE18, uint64 lastPricedAt)[])",
  "function navUsdc() view returns (uint256)",
  "function mode() view returns (uint8)",
  "function screenedOptIn() view returns (bool)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address who) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const NFT_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function ownerEpoch(uint256 agentId) view returns (uint64)",
]);
const EXECUTOR_ABI = parseAbi([
  "function sessionOf(uint256 agentId) view returns ((address key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil))",
]);
const ADAPTER_ABI = parseAbi([
  "function EXECUTOR() view returns (address)",
  "function REGISTRY() view returns (address)",
  "function swapRoute(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient, bytes32[] route, bool allowScreened) returns (uint256)",
]);
const REGISTRY_ABI = parseAbi([
  "function poolCount() view returns (uint256)",
  "function poolIds(uint256) view returns (bytes32)",
  "function pool(bytes32 poolId) view returns ((uint8 lane, uint8 status, uint8 venue, address token0, address token1, uint24 fee, int24 tickSpacing, address pool, bytes32 codeHash))",
]);
const TOKENS_ABI = parseAbi([
  "function tokenCount() view returns (uint256)",
  "function tokens(uint256) view returns (address)",
  "function tokenRecord(address token) view returns ((uint8 lane, uint8 status, uint8 priceClass, uint8 decimals, uint16 maxPositionBps, uint64 screenedAt, bytes32 screenHash))",
]);

const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;
const GAS = 10n ** 19n;

type Abi =
  | typeof FACTORY_ABI
  | typeof ACCOUNT_ABI
  | typeof ERC20_ABI
  | typeof NFT_ABI
  | typeof EXECUTOR_ABI
  | typeof ADAPTER_ABI
  | typeof REGISTRY_ABI
  | typeof TOKENS_ABI;

async function read<T>(url: string, to: Hex, abi: Abi, functionName: string, args: unknown[] = []) {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const raw = (await rpc(url, "eth_call", [{ to, data }, "latest"])) as Hex;
  return decodeFunctionResult({ abi, functionName, data: raw } as never) as T;
}

function agentNumber(agentId: number): bigint {
  if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error("That is not an agent ID.");
  return BigInt(agentId);
}

function wallet(address: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) throw new Error("That is not a wallet address.");
  return getAddress(address.trim());
}

async function gasFor(url: string, who: Hex): Promise<void> {
  const balance = hexToBigInt(await rpc(url, "eth_getBalance", [who, "latest"]));
  if (balance < GAS / 10n) await rpc(url, "anvil_setBalance", [who, toHex(GAS)]);
}

async function ownerOf(url: string, agentId: bigint): Promise<Hex> {
  try {
    return await read<Hex>(url, book("agent_nft"), NFT_ABI, "ownerOf", [agentId]);
  } catch (err) {
    if (err instanceof RpcError && err.kind === "jsonrpc")
      throw new Error(`Agent ${agentId} does not exist on the fork.`, { cause: err });
    throw err;
  }
}

async function requireOwner(url: string, agentId: bigint, who: Hex): Promise<void> {
  const owner = await ownerOf(url, agentId);
  if (!isAddressEqual(owner, who))
    throw new Error(`Agent ${agentId} belongs to ${owner}, not ${who}.`);
}

/** A registered token as the console lists it. */
export interface RegisteredTokenView {
  readonly symbol: string;
  readonly token: string;
  readonly decimals: number;
  readonly lane: "NONE" | "CORE" | "SCREENED";
  readonly status: "NONE" | "BUYABLE" | "SELL_ONLY" | "FROZEN";
  readonly priceClass: "NONE" | "F" | "A";
}

const LANES = ["NONE", "CORE", "SCREENED"] as const;
const STATUSES = ["NONE", "BUYABLE", "SELL_ONLY", "FROZEN"] as const;
const CLASSES = ["NONE", "F", "A"] as const;

/** Every token in the TokenRegistry with its symbol, read from the fork. */
export async function registeredTokens(url: string): Promise<RegisteredTokenView[]> {
  const registry = book("token_registry_v3");
  const n = await read<bigint>(url, registry, TOKENS_ABI, "tokenCount");
  const out: RegisteredTokenView[] = [];
  for (let i = 0n; i < n; i++) {
    const token = await read<Hex>(url, registry, TOKENS_ABI, "tokens", [i]);
    const [rec, symbol] = await Promise.all([
      read<{ lane: number; status: number; priceClass: number; decimals: number }>(
        url,
        registry,
        TOKENS_ABI,
        "tokenRecord",
        [token],
      ),
      read<string>(url, token, ERC20_ABI, "symbol").catch(() => token.slice(0, 10)),
    ]);
    out.push({
      symbol: symbol.slice(0, 32),
      token: getAddress(token),
      decimals: rec.decimals,
      lane: LANES[rec.lane] ?? "NONE",
      status: STATUSES[rec.status] ?? "NONE",
      priceClass: CLASSES[rec.priceClass] ?? "NONE",
    });
  }
  return out;
}

export interface HoldingView {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly balanceRaw: string;
  readonly freeRaw: string;
  readonly costBasisE6: string;
}

export interface TradingSnapshotV3 {
  readonly agentId: string;
  readonly owner: string;
  readonly ownerEpoch: string;
  /** The PersonalAccountV3, or null before the owner opened one. */
  readonly account: string | null;
  /** The agent's v2 PersonalAccount, if it has one (D-367). */
  readonly v2Account: string | null;
  readonly grant: { readonly key: string; readonly validUntil: string } | null;
  readonly holdings: readonly HoldingView[];
  /** The account's value in USDC base units, or null while a held feed is unusable. */
  readonly navE6: string | null;
  readonly mode: number;
  readonly screenedOptIn: boolean;
  readonly personalCapE6: string;
  readonly blockNumber: string;
}

/** The agent's owner, v3 account, Executor v3 grant and every held token, read from the fork. Read-only. */
export async function tradingSnapshotV3(url: string, agentId: number): Promise<TradingSnapshotV3> {
  const id = agentNumber(agentId);
  const owner = await ownerOf(url, id);
  const factory = book("account_factory_v3");
  const [ownerEpoch, account, v2Account, grant, cap, block] = await Promise.all([
    read<bigint>(url, book("agent_nft"), NFT_ABI, "ownerEpoch", [id]),
    read<Hex>(url, factory, FACTORY_ABI, "personalAccountOf", [id, owner]),
    read<Hex>(url, book("account_factory"), FACTORY_ABI, "personalAccountOf", [id, owner]),
    read<{ key: Hex; validUntil: bigint }>(url, book("executor_v3"), EXECUTOR_ABI, "sessionOf", [
      id,
    ]),
    read<bigint>(url, factory, FACTORY_ABI, "personalCap"),
    rpc(url, "eth_blockNumber", []),
  ]);
  const has = account !== zeroAddress;
  let holdings: HoldingView[] = [];
  let navE6: bigint | null = null;
  let mode = 0;
  let optedIn = false;
  if (has) {
    const raw = await read<
      { token: Hex; decimals: number; balance: bigint; free: bigint; costBasis: bigint }[]
    >(url, account, ACCOUNT_ABI, "holdings");
    holdings = await Promise.all(
      raw.map(async (h) => ({
        token: getAddress(h.token),
        symbol: await read<string>(url, h.token, ERC20_ABI, "symbol").catch(() =>
          h.token.slice(0, 10),
        ),
        decimals: h.decimals,
        balanceRaw: h.balance.toString(),
        freeRaw: h.free.toString(),
        costBasisE6: h.costBasis.toString(),
      })),
    );
    [navE6, mode, optedIn] = await Promise.all([
      read<bigint>(url, account, ACCOUNT_ABI, "navUsdc").catch(() => null),
      read<number>(url, account, ACCOUNT_ABI, "mode"),
      read<boolean>(url, account, ACCOUNT_ABI, "screenedOptIn"),
    ]);
  }
  return {
    agentId: id.toString(),
    owner,
    ownerEpoch: ownerEpoch.toString(),
    account: has ? account : null,
    v2Account: v2Account === zeroAddress ? null : v2Account,
    grant:
      grant.key === zeroAddress
        ? null
        : { key: grant.key, validUntil: grant.validUntil.toString() },
    holdings,
    navE6: navE6 === null ? null : navE6.toString(),
    mode,
    screenedOptIn: optedIn,
    personalCapE6: cap.toString(),
    blockNumber: hexToBigInt(block as Hex).toString(),
  };
}

/** Adds a wallet to AccountFactoryV3's deposit allowlist as the factory's owner (instant). */
async function allowDepositorV3(url: string, depositor: Hex): Promise<boolean> {
  const factory = book("account_factory_v3");
  const [enabled, listed] = await Promise.all([
    read<boolean>(url, factory, FACTORY_ABI, "allowlistEnabled"),
    read<boolean>(url, factory, FACTORY_ABI, "isAllowlisted", [depositor]),
  ]);
  if (!enabled || listed) return false;
  const admin = await read<Hex>(url, factory, FACTORY_ABI, "owner");
  await gasFor(url, admin);
  await sendAs(
    url,
    admin as Address,
    factory as Address,
    encodeFunctionData({ abi: FACTORY_ABI, functionName: "addDepositor", args: [depositor] }),
  );
  return true;
}

/** Opens the wallet's PersonalAccountV3 for its agent, allowlisting the wallet first when needed. */
export async function createTestPersonalAccountV3(
  url: string,
  agentId: number,
  owner: string,
): Promise<Address> {
  await assertLocalFork(url);
  const id = agentNumber(agentId);
  const who = wallet(owner);
  await requireOwner(url, id, who);
  const factory = book("account_factory_v3");
  const existing = await read<Hex>(url, factory, FACTORY_ABI, "personalAccountOf", [id, who]);
  if (existing !== zeroAddress) return existing as Address;
  await allowDepositorV3(url, who);
  await gasFor(url, who);
  await sendAs(
    url,
    who as Address,
    factory as Address,
    encodeFunctionData({ abi: FACTORY_ABI, functionName: "createPersonalAccount", args: [id] }),
  );
  return (await read<Hex>(url, factory, FACTORY_ABI, "personalAccountOf", [id, who])) as Address;
}

interface Pool {
  readonly id: Hex;
  readonly a: Hex;
  readonly b: Hex;
}

/** The demo adapter's registry's active core pools, with native MON read as WMON. */
async function corePools(url: string, registry: Hex): Promise<Pool[]> {
  const wmon = book("wmon");
  const n = await read<bigint>(url, registry, REGISTRY_ABI, "poolCount");
  const out: Pool[] = [];
  for (let i = 0n; i < n; i++) {
    const id = await read<Hex>(url, registry, REGISTRY_ABI, "poolIds", [i]);
    const p = await read<{ lane: number; status: number; token0: Hex; token1: Hex }>(
      url,
      registry,
      REGISTRY_ABI,
      "pool",
      [id],
    );
    if (p.lane !== 1 || p.status !== 1) continue;
    const held = (t: Hex) => (t === zeroAddress ? wmon : getAddress(t));
    out.push({ id, a: held(p.token0), b: held(p.token1) });
  }
  return out;
}

/** A route of one or two core pools from USDC to `token`: direct, else through WMON. */
function routeTo(pools: readonly Pool[], usdc: Hex, wmon: Hex, token: Hex): Hex[] | null {
  const between = (x: Hex, y: Hex) =>
    pools.find(
      (p) =>
        (isAddressEqual(p.a, x) && isAddressEqual(p.b, y)) ||
        (isAddressEqual(p.a, y) && isAddressEqual(p.b, x)),
    );
  const direct = between(usdc, token);
  if (direct) return [direct.id];
  const first = between(usdc, wmon);
  const second = between(wmon, token);
  return first && second ? [first.id, second.id] : null;
}

export interface FundingLeg {
  /** The token to hold: USDC itself, or a registered token bought with USDC. */
  readonly token: string;
  /** Test USDC to deposit, or to spend on the token. */
  readonly usdcE6: bigint;
}

export interface FundedLeg {
  readonly token: string;
  readonly symbol: string;
  readonly amountRaw: string;
  readonly usdcE6: string;
}

/**
 * Funds the wallet's PersonalAccountV3 with several tokens: test USDC is
 * minted to the wallet and deposited; every other token is bought with test
 * USDC through its real pools by the demo RouteAdapter (as its executor,
 * anvil account 0), paid to the wallet, approved and deposited. The factory's
 * per-account cap bounds the whole deposit.
 */
export async function fundTestPersonalAccountV3(
  url: string,
  agentId: number,
  owner: string,
  legs: readonly FundingLeg[],
): Promise<FundedLeg[]> {
  await assertLocalFork(url);
  const id = agentNumber(agentId);
  const who = wallet(owner);
  await requireOwner(url, id, who);
  if (legs.length === 0) throw new Error("Name at least one token to fund.");
  for (const leg of legs)
    if (leg.usdcE6 <= 0n) throw new Error("Every USDC amount must be greater than zero.");
  const account = await read<Hex>(
    url,
    book("account_factory_v3"),
    FACTORY_ABI,
    "personalAccountOf",
    [id, who],
  );
  if (account === zeroAddress) throw new Error(`Agent ${id} has no PersonalAccountV3 yet.`);
  const usdc = book("usdc");
  const wmon = book("wmon");
  const adapter = book("route_adapter_v3");
  const [executor, registry] = await Promise.all([
    read<Hex>(url, adapter, ADAPTER_ABI, "EXECUTOR"),
    read<Hex>(url, adapter, ADAPTER_ABI, "REGISTRY"),
  ]);
  const pools = await corePools(url, registry);
  await gasFor(url, who);
  await gasFor(url, executor);
  const funded: FundedLeg[] = [];
  for (const leg of legs) {
    const token = wallet(leg.token);
    let amount: bigint;
    if (isAddressEqual(token, usdc)) {
      await mintTestUsdc(who, leg.usdcE6, url);
      amount = leg.usdcE6;
    } else {
      const route = routeTo(pools, usdc, wmon, token);
      if (!route)
        throw new Error(`No core pool route of up to two hops connects USDC to ${token}.`);
      const before = await read<bigint>(url, token, ERC20_ABI, "balanceOf", [who]);
      await mintTestUsdc(executor, leg.usdcE6, url);
      await sendAs(
        url,
        executor as Address,
        usdc as Address,
        encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [adapter, leg.usdcE6],
        }),
      );
      await sendAs(
        url,
        executor as Address,
        adapter as Address,
        encodeFunctionData({
          abi: ADAPTER_ABI,
          functionName: "swapRoute",
          args: [usdc, token, leg.usdcE6, 1n, who, route, false],
        }),
      );
      const after = await read<bigint>(url, token, ERC20_ABI, "balanceOf", [who]);
      amount = after - before;
      if (amount <= 0n) throw new Error(`The buy of ${token} returned nothing.`);
    }
    await sendAs(
      url,
      who as Address,
      token as Address,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [account, amount] }),
    );
    await sendAs(
      url,
      who as Address,
      account as Address,
      encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "deposit", args: [token, amount] }),
    );
    const symbol = await read<string>(url, token, ERC20_ABI, "symbol").catch(() =>
      token.slice(0, 10),
    );
    funded.push({ token, symbol, amountRaw: amount.toString(), usdcE6: leg.usdcE6.toString() });
  }
  return funded;
}
