import { SCREEN_RULES, type ScreenCheck, reviewedToken } from "@alpha-agents/domain";
import {
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  ZEPPELINOS_ADMIN_SLOT,
  ZEPPELINOS_IMPLEMENTATION_SLOT,
  proxyPattern,
  slotAddress,
} from "@alpha-agents/market";
import { type Hex, type PublicClient, getAddress, parseAbi, toFunctionSelector } from "viem";

/**
 * The token screen's static checks (F-U1, D-339 step 2), read on the same
 * fork block the simulation runs on:
 *
 * - OWNER_POWERS: the contract's dispatcher is scanned for functions that let
 *   someone blacklist or freeze holders, pause transfers, change taxes or
 *   change balances. Such a function is a refusal when the token has a live
 *   owner or admin (anything but the zero or dead address, or unknown), unless
 *   the token is on the reviewed list for owner powers. Minting is recorded as
 *   evidence; D-339 does not refuse it.
 * - UPGRADEABLE: an EIP-1967, beacon or ZeppelinOS proxy passes only when its
 *   upgrade authority is the zero address or a timelock with a delay of at
 *   least a day (OpenZeppelin's `getMinDelay` or Compound's `delay`), unless
 *   the token is on the reviewed list for upgrades. A minimal proxy cannot
 *   change and passes.
 *
 * A selector scan sees what the code can do, not who may call it; the owner
 * check stands in for that, so a renounced token with these functions passes.
 */
const sig = (s: string) => toFunctionSelector(`function ${s}`).slice(2);

export const POWER_SIGNATURES: Readonly<
  Record<"blacklist" | "pause" | "tax" | "balance", readonly string[]>
> = {
  blacklist: [
    "blacklist(address)",
    "addToBlacklist(address)",
    "addBlacklist(address)",
    "setBlacklist(address,bool)",
    "blacklistAddress(address,bool)",
    "setBlacklisted(address,bool)",
    "updateBlacklist(address,bool)",
    "setBot(address,bool)",
    "setBots(address[],bool)",
    "addBot(address)",
    "blockBots(address[])",
    "freeze(address)",
    "freezeAccount(address,bool)",
    "freezeAccount(address)",
    "setIsBlacklisted(address,bool)",
    "addBlackList(address)",
  ],
  pause: ["pause()", "setPaused(bool)", "pauseTransfers()", "setTradingPaused(bool)"],
  tax: [
    "setTaxFee(uint256)",
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "setTaxes(uint256,uint256)",
    "setTax(uint256,uint256)",
    "updateFees(uint256,uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setTransferFee(uint256)",
    "updateBuyFees(uint256,uint256,uint256)",
    "updateSellFees(uint256,uint256,uint256)",
    "setBuyFees(uint256,uint256,uint256)",
    "setSellFees(uint256,uint256,uint256)",
    "setTaxRates(uint256,uint256)",
  ],
  balance: ["setBalance(address,uint256)", "burn(address,uint256)", "adminBurn(address,uint256)"],
};
const MINT_SIGNATURES = ["mint(address,uint256)", "mint(uint256)"];

/** Whether the code's dispatcher pushes this selector (PUSH4, or PUSH3 for a leading zero byte). */
export function hasSelector(code: string, selectorHex: string): boolean {
  const c = code.toLowerCase();
  const s = selectorHex.toLowerCase();
  return c.includes(`63${s}`) || (s.startsWith("00") && c.includes(`62${s.slice(2)}`));
}

export function scanPowers(codes: readonly string[]) {
  const found: Record<keyof typeof POWER_SIGNATURES, string[]> = {
    blacklist: [],
    pause: [],
    tax: [],
    balance: [],
  };
  for (const [kind, sigs] of Object.entries(POWER_SIGNATURES) as [
    keyof typeof POWER_SIGNATURES,
    readonly string[],
  ][])
    for (const s of sigs)
      if (codes.some((c) => hasSelector(c, sig(s)))) found[kind].push(s.split("(")[0] ?? s);
  const mint = MINT_SIGNATURES.filter((s) => codes.some((c) => hasSelector(c, sig(s))));
  return { found, mint: mint.length > 0 };
}

const OWNER_ABI = parseAbi([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function admin() view returns (address)",
]);
const TIMELOCK_ABI = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function delay() view returns (uint256)",
]);
const ACCESS_CONTROL = sig("grantRole(bytes32,address)");
const DEAD = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

/** Who owns a contract: an address, "none" when renounced, or "unknown" when it names none. */
export async function ownerOf(client: PublicClient, address: string): Promise<string | "unknown"> {
  for (const fn of ["owner", "getOwner", "admin"] as const) {
    try {
      const o = (await client.readContract({
        address: getAddress(address),
        abi: OWNER_ABI,
        functionName: fn,
      })) as string;
      return o.toLowerCase();
    } catch {
      // Not this getter: try the next.
    }
  }
  return "unknown";
}

const AAVE_PAYLOADS_ABI = parseAbi([
  "function getExecutorSettingsByAccessControl(uint8 accessLevel) view returns ((address executor, uint40 delay))",
]);

/** The timelock kinds the screen recognizes as an upgrade authority's delay (D-359). */
export type TimelockKind = "openzeppelin" | "compound" | "aave_governance_v3";

/**
 * An upgrade authority's timelock, or null when it is none the screen knows:
 * OpenZeppelin's TimelockController (`getMinDelay`), Compound's Timelock
 * (`delay`), or Aave Governance v3, where the authority is an Executor owned
 * by a PayloadsController that queues every payload for that executor with a
 * delay (`getExecutorSettingsByAccessControl`). GHO on Monad is upgraded
 * through the last: its ProxyAdmin's owner is the level 1 Executor, delayed a
 * day (read 2026-10-09).
 */
export async function timelockDelay(
  client: PublicClient,
  address: string,
): Promise<{ seconds: number; kind: TimelockKind } | null> {
  for (const [fn, kind] of [
    ["getMinDelay", "openzeppelin"],
    ["delay", "compound"],
  ] as const) {
    try {
      const d = await client.readContract({
        address: getAddress(address),
        abi: TIMELOCK_ABI,
        functionName: fn,
      });
      return { seconds: Number(d), kind };
    } catch {
      // Not this kind of timelock.
    }
  }
  const controller = await ownerOf(client, address);
  if (controller === "unknown" || DEAD.has(controller)) return null;
  for (const level of [1, 2]) {
    try {
      const s = await client.readContract({
        address: getAddress(controller),
        abi: AAVE_PAYLOADS_ABI,
        functionName: "getExecutorSettingsByAccessControl",
        args: [level],
      });
      if (s.executor.toLowerCase() === address.toLowerCase())
        return { seconds: Number(s.delay), kind: "aave_governance_v3" };
    } catch {
      return null;
    }
  }
  return null;
}

export interface StaticFacts {
  readonly codeSize: number;
  readonly proxy: { readonly pattern: string; readonly implementation: string | null };
  readonly owner: string;
}

export async function staticChecks(
  client: PublicClient,
  token: string,
  blockNumber: bigint,
): Promise<{ checks: ScreenCheck[]; facts: StaticFacts }> {
  const address = getAddress(token);
  const code = ((await client.getCode({ address, blockNumber })) ?? "0x") as Hex;
  const slot = (s: Hex) => client.getStorageAt({ address, slot: s, blockNumber });
  const [impl, beacon, zos, admin, zosAdmin] = await Promise.all([
    slot(EIP1967_IMPLEMENTATION_SLOT),
    slot(EIP1967_BEACON_SLOT),
    slot(ZEPPELINOS_IMPLEMENTATION_SLOT),
    slot(EIP1967_ADMIN_SLOT),
    slot(ZEPPELINOS_ADMIN_SLOT),
  ]);
  const proxy = proxyPattern(code, {
    ...(impl ? { implementation: impl } : {}),
    ...(beacon ? { beacon } : {}),
    ...(zos ? { zeppelinos: zos } : {}),
  });
  const codes = [code as string];
  if (proxy.implementation && proxy.pattern !== "eip1967_beacon") {
    const ic = await client.getCode({ address: getAddress(proxy.implementation), blockNumber });
    if (ic) codes.push(ic);
  }
  const owner = await ownerOf(client, token);
  const reviewed = reviewedToken(token);
  const { found, mint } = scanPowers(codes);
  const powers = Object.entries(found).flatMap(([kind, fns]) => fns.map((f) => `${kind}:${f}`));
  const accessControl = codes.some((c) => hasSelector(c, ACCESS_CONTROL));
  const renounced = DEAD.has(owner) && !accessControl;

  const ownerCheck: ScreenCheck = (() => {
    const evidence = {
      powers: powers.join(", ") || null,
      owner,
      accessControl,
      canMint: mint,
      reviewed: reviewed?.issuer ?? null,
    };
    if (powers.length === 0)
      return {
        code: "OWNER_POWERS",
        status: "pass",
        reason: "The code has no function to blacklist, pause, change taxes or change balances.",
        evidence,
      };
    if (renounced)
      return {
        code: "OWNER_POWERS",
        status: "pass",
        reason: `The code has ${powers.length} such function(s), but ownership is renounced.`,
        evidence,
      };
    if (reviewed?.accepts.includes("owner_powers"))
      return {
        code: "OWNER_POWERS",
        status: "pass",
        reason: `On the reviewed list: ${reviewed.reason}.`,
        evidence,
      };
    return {
      code: "OWNER_POWERS",
      status: "fail",
      reason: `A live ${owner === "unknown" ? "admin" : "owner"} can call ${powers.map((p) => p.split(":")[1]).join(", ")}.`,
      evidence,
    };
  })();

  const upgradeCheck: ScreenCheck = await (async () => {
    const evidence: Record<string, string | number | boolean | null> = {
      pattern: proxy.pattern,
      implementation: proxy.implementation,
    };
    if (proxy.pattern === "none" || proxy.pattern === "eip1167_minimal_proxy")
      return {
        code: "UPGRADEABLE",
        status: "pass",
        reason:
          proxy.pattern === "none"
            ? "Not a proxy: the code cannot be swapped."
            : "A minimal proxy: its implementation is fixed.",
        evidence,
      };
    if (reviewed?.accepts.includes("upgradeable"))
      return {
        code: "UPGRADEABLE",
        status: "pass",
        reason: `An upgradeable proxy on the reviewed list: ${reviewed.reason}.`,
        evidence,
      };
    // The authority: the EIP-1967 admin (or the owner of a ProxyAdmin there), else the token's owner (UUPS).
    let authority = (slotAddress(admin) ?? slotAddress(zosAdmin))?.toLowerCase() ?? null;
    if (authority) {
      const adminOwner = await ownerOf(client, authority);
      if (adminOwner !== "unknown") authority = adminOwner;
    } else if (proxy.pattern === "eip1967_beacon" && proxy.implementation) {
      authority = await ownerOf(client, proxy.implementation);
    } else authority = owner;
    evidence.authority = authority;
    if (authority !== "unknown" && DEAD.has(authority))
      return {
        code: "UPGRADEABLE",
        status: "pass",
        reason: "A proxy whose upgrade authority is renounced.",
        evidence,
      };
    const lock = authority === "unknown" ? null : await timelockDelay(client, authority);
    const delay = lock?.seconds ?? null;
    evidence.timelockSeconds = delay;
    evidence.timelockKind = lock?.kind ?? null;
    if (lock && lock.seconds >= SCREEN_RULES.minTimelockSeconds)
      return {
        code: "UPGRADEABLE",
        status: "pass",
        reason: `A proxy upgraded only through a timelock of ${Math.round(lock.seconds / 3600)} hours${lock.kind === "aave_governance_v3" ? " (Aave Governance v3)" : ""}.`,
        evidence,
      };
    return {
      code: "UPGRADEABLE",
      status: "fail",
      reason:
        delay === null
          ? "An upgradeable proxy whose code can be changed without a timelock."
          : `An upgradeable proxy behind a timelock of only ${Math.round(delay / 60)} minutes.`,
      evidence,
    };
  })();

  return {
    checks: [ownerCheck, upgradeCheck],
    facts: { codeSize: (code.length - 2) / 2, proxy, owner },
  };
}
