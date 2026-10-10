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
 * Test trading on the local fork (P2-U4 item 12): open a chosen wallet's
 * PersonalAccount for one of its agents, fund it with test USDC, and register
 * the signer's session key as the agent's grant, each as the wallet itself
 * through anvil impersonation. Every write checks that the URL is the local
 * fork first; the snapshot only reads.
 */
const FACTORY_ABI = parseAbi([
  "function createPersonalAccount(uint256 agentId) returns (address)",
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function isAllowlisted(address depositor) view returns (bool)",
  "function allowlistEnabled() view returns (bool)",
  "function addDepositor(address depositor)",
  "function owner() view returns (address)",
]);
const ACCOUNT_ABI = parseAbi(["function deposit(address token, uint256 amount)"]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address who) view returns (uint256)",
]);
const NFT_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function ownerEpoch(uint256 agentId) view returns (uint64)",
]);
const EXECUTOR_ABI = parseAbi([
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
  "function revokeSession(uint256 agentId)",
  "function sessionOf(uint256 agentId) view returns ((address key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil))",
]);

const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;
const GAS = 10n ** 19n; // 10 MON, enough for any of these calls

type Abi = typeof FACTORY_ABI | typeof NFT_ABI | typeof ERC20_ABI | typeof EXECUTOR_ABI;

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

/** Gives a wallet MON for gas only when it has almost none. */
async function gasFor(url: string, who: Hex): Promise<void> {
  const balance = hexToBigInt(await rpc(url, "eth_getBalance", [who, "latest"]));
  if (balance < GAS / 10n) await rpc(url, "anvil_setBalance", [who, toHex(GAS)]);
}

async function ownerOf(url: string, agentId: bigint): Promise<Hex> {
  try {
    return await read<Hex>(url, book("agent_nft"), NFT_ABI, "ownerOf", [agentId]);
  } catch (err) {
    // Only the contract's refusal means "no such agent"; an unreachable fork says so itself.
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

export interface TradingSnapshot {
  readonly agentId: string;
  readonly owner: string;
  readonly ownerEpoch: string;
  readonly account: string | null;
  readonly grant: { readonly key: string; readonly validUntil: string } | null;
  readonly usdcE6: string;
  readonly wmonWei: string;
  readonly blockNumber: string;
}

/** The agent's owner, account, grant and the account's balances, read from the fork. Read-only. */
export async function tradingSnapshot(url: string, agentId: number): Promise<TradingSnapshot> {
  const id = agentNumber(agentId);
  const owner = await ownerOf(url, id);
  const [ownerEpoch, account, grant, block] = await Promise.all([
    read<bigint>(url, book("agent_nft"), NFT_ABI, "ownerEpoch", [id]),
    read<Hex>(url, book("account_factory"), FACTORY_ABI, "personalAccountOf", [id, owner]),
    read<{ key: Hex; validUntil: bigint }>(url, book("executor"), EXECUTOR_ABI, "sessionOf", [id]),
    rpc(url, "eth_blockNumber", []),
  ]);
  const has = account !== zeroAddress;
  const balance = (token: Hex) =>
    has ? read<bigint>(url, token, ERC20_ABI, "balanceOf", [account]) : Promise.resolve(0n);
  const [usdcE6, wmonWei] = await Promise.all([balance(book("usdc")), balance(book("wmon"))]);
  return {
    agentId: id.toString(),
    owner,
    ownerEpoch: ownerEpoch.toString(),
    account: has ? account : null,
    grant:
      grant.key === zeroAddress
        ? null
        : { key: grant.key, validUntil: grant.validUntil.toString() },
    usdcE6: usdcE6.toString(),
    wmonWei: wmonWei.toString(),
    blockNumber: hexToBigInt(block).toString(),
  };
}

/**
 * Adds a wallet to AccountFactory's beta deposit allowlist on the local fork,
 * as the factory's owner (D-231: adding is instant). Returns false when it was
 * already listed or the allowlist is off.
 */
export async function addTestDepositor(url: string, depositor: string): Promise<boolean> {
  await assertLocalFork(url);
  const who = wallet(depositor);
  const factory = book("account_factory");
  const [enabled, listed] = await Promise.all([
    read<boolean>(url, factory, FACTORY_ABI, "allowlistEnabled"),
    read<boolean>(url, factory, FACTORY_ABI, "isAllowlisted", [who]),
  ]);
  if (!enabled || listed) return false;
  const admin = await read<Hex>(url, factory, FACTORY_ABI, "owner");
  await gasFor(url, admin);
  await sendAs(
    url,
    admin as Address,
    factory as Address,
    encodeFunctionData({ abi: FACTORY_ABI, functionName: "addDepositor", args: [who] }),
  );
  return true;
}

/**
 * Opens the wallet's PersonalAccount for its agent. A wallet that is not on
 * the beta allowlist is added first by the factory's owner (Q-46).
 */
export async function createTestPersonalAccount(
  url: string,
  agentId: number,
  owner: string,
): Promise<Address> {
  await assertLocalFork(url);
  const id = agentNumber(agentId);
  const who = wallet(owner);
  await requireOwner(url, id, who);
  const factory = book("account_factory");
  const existing = await read<Hex>(url, factory, FACTORY_ABI, "personalAccountOf", [id, who]);
  if (existing !== zeroAddress) return existing as Address;
  await addTestDepositor(url, who);
  await gasFor(url, who);
  await sendAs(
    url,
    who as Address,
    factory as Address,
    encodeFunctionData({ abi: FACTORY_ABI, functionName: "createPersonalAccount", args: [id] }),
  );
  return (await read<Hex>(url, factory, FACTORY_ABI, "personalAccountOf", [id, who])) as Address;
}

/** Mints test USDC to the wallet, approves exactly that amount and deposits it in the account. */
export async function fundTestPersonalAccount(
  url: string,
  agentId: number,
  owner: string,
  amountE6: bigint,
): Promise<void> {
  await assertLocalFork(url);
  const id = agentNumber(agentId);
  const who = wallet(owner);
  if (amountE6 <= 0n) throw new Error("The USDC amount must be greater than zero.");
  await requireOwner(url, id, who);
  const account = await read<Hex>(url, book("account_factory"), FACTORY_ABI, "personalAccountOf", [
    id,
    who,
  ]);
  if (account === zeroAddress) throw new Error(`Agent ${id} has no PersonalAccount yet.`);
  const usdc = book("usdc");
  await mintTestUsdc(who, amountE6, url);
  await gasFor(url, who);
  await sendAs(
    url,
    who as Address,
    usdc as Address,
    encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [account, amountE6] }),
  );
  await sendAs(
    url,
    who as Address,
    account as Address,
    encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "deposit", args: [usdc, amountE6] }),
  );
}

/** The owner revokes the agent's grant, as the disarm's wallet call does (fork only). */
export async function revokeTestSessionGrant(
  url: string,
  agentId: number,
  owner: string,
  /** The Executor the grant is on: the v2 one by default, Executor v3 for an agent on the fund agent's set (F-U5). */
  executor: string = book("executor"),
): Promise<void> {
  await assertLocalFork(url);
  const id = agentNumber(agentId);
  const who = wallet(owner);
  await requireOwner(url, id, who);
  await gasFor(url, who);
  await sendAs(
    url,
    who as Address,
    wallet(executor) as Address,
    encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "revokeSession", args: [id] }),
  );
}

/** The owner registers the signer's session key as the agent's grant, for `days` days (at most 30). */
export async function registerTestSessionGrant(
  url: string,
  agentId: number,
  owner: string,
  key: string,
  days = 30,
  /** The Executor to register on: the v2 one by default, Executor v3 for an agent on the fund agent's set (F-U5). */
  executor: string = book("executor"),
): Promise<void> {
  await assertLocalFork(url);
  const id = agentNumber(agentId);
  const who = wallet(owner);
  const session = wallet(key);
  if (!Number.isInteger(days) || days < 1 || days > 30)
    throw new Error("A grant lasts 1 to 30 days.");
  await requireOwner(url, id, who);
  const block = (await rpc(url, "eth_getBlockByNumber", ["latest", false])) as {
    timestamp: string;
  };
  const validUntil = hexToBigInt(block.timestamp) + BigInt(days) * 86_400n;
  await gasFor(url, who);
  await sendAs(
    url,
    who as Address,
    wallet(executor) as Address,
    encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: "registerSession",
      args: [id, session, validUntil],
    }),
  );
}
