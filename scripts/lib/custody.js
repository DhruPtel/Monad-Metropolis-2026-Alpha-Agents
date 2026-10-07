// @ts-check
// PersonalAccount on the local fork (P2-U1), as an owner would use it: one of
// the local test owners (anvil accounts 6 to 9, allowlisted at deployment)
// mints an agent if it has none, creates its PersonalAccount, deposits test
// USDC and withdraws it. Local fork only: every step checks the fork first,
// and the wallets are anvil's public development accounts.
import { assertLocalFork, mintTestUsdc, readForkConfig } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { createPublicClient, formatUnits, http, parseAbi, parseAbiItem } from "viem";
import { deployAccountFactoryLocal, LOCAL_TEST_OWNERS } from "./account-factory.js";
import { deployLocal as deployAgentNftLocal } from "./agent-nft.js";
import { mintLocal } from "./agent-mint.js";
import { send } from "./agent-reveal.js";
import { ANVIL_URL } from "./config.js";

export const FACTORY_ABI = parseAbi([
  "function createPersonalAccount(uint256 agentId) returns (address)",
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
  "function predictPersonalAccount(uint256 agentId, address owner) view returns (address)",
  "function personalCap() view returns (uint256)",
  "function platformCap() view returns (uint256)",
  "function platformTotal() view returns (uint256)",
  "function oracle() view returns (address)",
]);

export const ACCOUNT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, address to)",
  "function withdrawAll(address to)",
  "function principal() view returns (uint256)",
  "function mode() view returns (uint8)",
  "function depositsClosed() view returns (bool)",
  "function claimable(address token) view returns (uint256)",
  "function owner() view returns (address)",
  "function agentId() view returns (uint256)",
  "error PersonalCapExceeded(uint256 principalAfter, uint256 cap)",
  "error PlatformCapExceeded(uint256 totalAfter, uint256 cap)",
  "error NotAllowlisted(address depositor)",
  "error DepositsPaused()",
  "error DepositsAreClosed()",
  "error NotAgentOwner(address currentOwner)",
  "error NotOwner(address caller)",
  "error OracleUnset()",
  "error OracleUnavailable(address asset, uint8 reason)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address who) view returns (uint256)",
]);

const NFT_ABI = parseAbi(["function hasMinted(address wallet) view returns (bool)"]);
const MINTED = parseAbiItem(
  "event AgentMinted(uint256 indexed agentId, address indexed owner, address tba)",
);

/** ACCOUNT_MODES order in packages/domain (custody-modes.test.ts checks the contract). */
const MODES = ["NORMAL", "REDUCE_ONLY", "PAUSED", "HANDOVER", "WIND_DOWN"];

const client = createPublicClient({ transport: http(ANVIL_URL) });
const usdc = () => /** @type {`0x${string}`} */ (addressEntry("local", "usdc").address);
const wmon = () => /** @type {`0x${string}`} */ (addressEntry("local", "wmon").address);

/**
 * A local test owner by index (6 to 9, anvil's account numbering).
 * @param {number} index
 */
export function testOwner(index) {
  const owner = LOCAL_TEST_OWNERS[index - 6];
  if (!owner) throw new Error("the owner must be anvil account 6, 7, 8 or 9");
  return owner;
}

/**
 * The contracts, deployed if the fork has none (the deploys are idempotent).
 * @returns {Promise<{ nft: `0x${string}`, factory: `0x${string}`, oracle: `0x${string}` }>}
 */
export async function custodyContracts() {
  await assertLocalFork(ANVIL_URL);
  const nft = /** @type {`0x${string}`} */ (await deployAgentNftLocal({ quiet: true }));
  const { factory, oracle } = await deployAccountFactoryLocal({ quiet: true });
  return { nft, factory, oracle };
}

/**
 * The owner's agent: the one it minted, or a new one (one mint per wallet).
 * @param {`0x${string}`} nft
 * @param {`0x${string}`} owner
 * @returns {Promise<bigint>}
 */
export async function ownersAgent(nft, owner) {
  const minted = await client.readContract({
    address: nft,
    abi: NFT_ABI,
    functionName: "hasMinted",
    args: [owner],
  });
  if (!minted) return (await mintLocal(nft, owner)).agentId;
  const logs = await client.getLogs({
    address: nft,
    event: MINTED,
    args: { owner },
    fromBlock: BigInt(readForkConfig().blockNumber),
  });
  const id = logs[0]?.args.agentId;
  if (id === undefined) throw new Error(`${owner} has minted, but no AgentMinted event was found`);
  return id;
}

/**
 * The owner's PersonalAccount for the agent, created if it does not exist yet.
 * @param {`0x${string}`} factory
 * @param {bigint} agentId
 * @param {`0x${string}`} owner
 */
export async function ensureAccount(factory, agentId, owner) {
  const existing = await client.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "personalAccountOf",
    args: [agentId, owner],
  });
  if (existing !== "0x0000000000000000000000000000000000000000")
    return { account: existing, created: false };
  await send(owner, {
    address: factory,
    abi: FACTORY_ABI,
    functionName: "createPersonalAccount",
    args: [agentId],
  });
  const account = await client.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "personalAccountOf",
    args: [agentId, owner],
  });
  return { account, created: true };
}

/**
 * Gives the owner test USDC, approves exactly that amount and deposits it.
 * @param {`0x${string}`} account
 * @param {`0x${string}`} owner
 * @param {bigint} amountE6
 */
export async function depositUsdc(account, owner, amountE6) {
  // Say plainly when the cap refuses it, before any test USDC is minted.
  const configAbi = parseAbi(["function config() view returns (address)"]);
  const [principal, factory] = await Promise.all([
    client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "principal" }),
    client.readContract({ address: account, abi: configAbi, functionName: "config" }),
  ]);
  const [cap, oracle] = await Promise.all([
    client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "personalCap" }),
    client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "oracle" }),
  ]);
  if (oracle === "0x0000000000000000000000000000000000000000")
    throw new Error(
      "refused: deposits need the oracle adapter (the USDC depeg guard, P2-U3), which waits the factory's 9-day timelock. " +
        "Run pnpm custody:local prepare-oracle to apply it on this fork (it moves the fork's clock 9 days), " +
        "or pnpm oracle:local demo to see the whole flow on a fork of its own",
    );
  if (principal + amountE6 > cap)
    throw new Error(
      `refused: that takes the account's principal to ${formatUnits(principal + amountE6, 6)} USDC, over the ${formatUnits(cap, 6)} USDC per-account cap`,
    );
  // The URL is passed on purpose: the default is the playtest fork, whatever LOCAL_FORK_PORT says (L-100).
  await mintTestUsdc(owner, amountE6, ANVIL_URL);
  await send(owner, {
    address: usdc(),
    abi: ERC20_ABI,
    functionName: "approve",
    args: [account, amountE6],
  });
  const request = /** @type {const} */ ({
    address: account,
    abi: ACCOUNT_ABI,
    functionName: "deposit",
    args: [usdc(), amountE6],
  });
  // Simulated first, so any other refusal comes back as the contract's named error.
  await client.simulateContract({ ...request, account: owner });
  return send(owner, request);
}

/**
 * Withdraws `amountE6` of USDC to the owner, or every held asset when null.
 * @param {`0x${string}`} account
 * @param {`0x${string}`} owner
 * @param {bigint | null} amountE6
 */
export async function withdraw(account, owner, amountE6) {
  if (amountE6 === null)
    return send(owner, {
      address: account,
      abi: ACCOUNT_ABI,
      functionName: "withdrawAll",
      args: [owner],
    });
  return send(owner, {
    address: account,
    abi: ACCOUNT_ABI,
    functionName: "withdraw",
    args: [usdc(), amountE6, owner],
  });
}

/**
 * The account and its owner, as lines to print.
 * @param {`0x${string}`} factory
 * @param {`0x${string}`} account
 * @param {`0x${string}`} owner
 */
export async function describeAccount(factory, account, owner) {
  /** @param {`0x${string}`} token @param {`0x${string}`} who */
  const bal = (token, who) =>
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] });
  /** @param {"principal" | "mode" | "depositsClosed" | "agentId"} fn */
  const read = (fn) =>
    client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: fn });
  /** @param {"personalCap" | "platformCap" | "platformTotal"} fn */
  const f = (fn) => client.readContract({ address: factory, abi: FACTORY_ABI, functionName: fn });
  const [agentId, principal, mode, closed, accUsdc, accWmon, ownerUsdc, cap, platformCap, total] =
    await Promise.all([
      read("agentId"),
      read("principal"),
      read("mode"),
      read("depositsClosed"),
      bal(usdc(), account),
      bal(wmon(), account),
      bal(usdc(), owner),
      f("personalCap"),
      f("platformCap"),
      f("platformTotal"),
    ]);
  const usd = (/** @type {bigint} */ v) => formatUnits(v, 6);
  return [
    `PersonalAccount ${account} for agent #${agentId}, owner ${owner}`,
    `  holds ${usd(/** @type {bigint} */ (accUsdc))} USDC and ${formatUnits(/** @type {bigint} */ (accWmon), 18)} WMON`,
    `  principal ${usd(/** @type {bigint} */ (principal))} USDC of the ${usd(/** @type {bigint} */ (cap))} USDC cap; mode ${MODES[Number(mode)]}; deposits ${closed ? "closed" : "open"}`,
    `  platform total ${usd(/** @type {bigint} */ (total))} of ${usd(/** @type {bigint} */ (platformCap))} USDC`,
    `  the owner's wallet holds ${usd(/** @type {bigint} */ (ownerUsdc))} USDC`,
  ];
}
