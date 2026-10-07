// @ts-check
// The Executor on a fork of its own (P2-U2): a fresh fork of Monad at the
// pinned block on port 8548 (never the playtest fork on 8545), with the whole
// trading stack deployed by pnpm deploy:account-factory. It opens anvil
// account 6's PersonalAccount, deposits, swaps both ways on the real Uniswap
// v4 MON/USDC pool, then tries one intent per hard limit and prints the
// reason the Executor gives. The fork stops when it is done (or on Ctrl-C
// with --keep).
//
//   pnpm executor:local demo [--keep]
import { setMonBalance, startTestFork } from "@alpha-agents/devenv";

const FORK_PORT = 8548;
// Every library below reads the fork's port from here when it loads (D-200, L-100).
process.env.LOCAL_FORK_PORT = String(FORK_PORT);

const { loadRootEnv, ANVIL_URL } = await import("./lib/config.js");
const { deployAccountFactoryLocal } = await import("./lib/account-factory.js");
const custody = await import("./lib/custody.js");
const { impersonate, send } = await import("./lib/agent-reveal.js");
const { CUSTODY_ROLES } = await import("./lib/account-factory.js");
const oracle = await import("./lib/oracle.js");
const { addressEntry, REJECTION_CODES } = await import("@alpha-agents/domain");
const viem = await import("viem");
const {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
} = viem;

loadRootEnv();
const args = process.argv.slice(2);
if ((args[0] ?? "demo") !== "demo") {
  console.error("usage: pnpm executor:local demo [--keep]");
  process.exit(2);
}
const keep = args.includes("--keep");

const INTENT =
  "(uint16 schemaVersion,uint256 chainId,uint256 agentId,address account,bytes32 actionId,uint64 ownerEpoch,uint64 configEpoch,bytes32 policyHash,bytes32 adapterId,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint64 deadline)";
const EXECUTOR_ABI = parseAbi([
  `function swap(${INTENT} i) returns (uint256)`,
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
  "function bumpConfigEpoch(uint256 agentId)",
  "function policyHash() view returns (bytes32)",
  "function configEpochOf(uint256 agentId) view returns (uint64)",
  "function oracleFloor(address tokenIn, address tokenOut, uint256 amountIn, uint256 px, uint256 slippageBps) view returns (uint256)",
  "error Rejected(uint8 reason)",
]);
const ACCOUNT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function setReduceOnly()",
  "function unpause()",
  "function freeBalance(address token) view returns (uint256)",
]);
const ERC20_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const NFT_ABI = parseAbi(["function ownerEpoch(uint256 agentId) view returns (uint64)"]);
const PRICE_ABI = parseAbi(["function priceE18(address asset) view returns (uint256)"]);
const FACTORY_ABI = parseAbi(["function removeBuyable(address token)"]);

const client = createPublicClient({ transport: http(ANVIL_URL) });
const book = (/** @type {import("@alpha-agents/domain").AddressBookId} */ id) =>
  /** @type {`0x${string}`} */ (addressEntry("local", id).address);
const usdc = book("usdc");
const wmon = book("wmon");
const V4 = viem.keccak256(viem.toBytes("uniswap-v4-mon-usdc-500"));
const V3 = viem.keccak256(viem.toBytes("uniswap-v3-usdc-wmon-3000"));
/** A session key the owner registers: an address anvil signs for by impersonation. */
const SESSION = /** @type {`0x${string}`} */ ("0x5e55105e55105e55105e55105e55105e55105e55");

/**
 * The contract's own refusal, by name.
 * @param {unknown} err
 */
function why(err) {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data) {
      if (r.data.errorName === "Rejected") return REJECTION_CODES[Number(r.data.args?.[0])] ?? "?";
      return `${r.data.errorName}(${(r.data.args ?? []).join(", ")})`;
    }
    return err.shortMessage;
  }
  return String(err);
}

/**
 * @param {{ executor: `0x${string}`, nft: `0x${string}`, account: `0x${string}`, agentId: bigint }} ctx
 * @param {{ tokenIn: `0x${string}`, amountIn: bigint, minOutDelta?: bigint, deadlineIn?: bigint, actionId?: `0x${string}`, adapterId?: `0x${string}` }} t
 */
async function intent(ctx, t) {
  const tokenOut = t.tokenIn === usdc ? wmon : usdc;
  const [now, px, policyHash, configEpoch, ownerEpoch] = await Promise.all([
    oracle.forkTime(),
    client
      .readContract({
        address: book("oracle_adapter"),
        abi: PRICE_ABI,
        functionName: "priceE18",
        args: [wmon],
      })
      .catch(() => 0n),
    client.readContract({ address: ctx.executor, abi: EXECUTOR_ABI, functionName: "policyHash" }),
    client.readContract({
      address: ctx.executor,
      abi: EXECUTOR_ABI,
      functionName: "configEpochOf",
      args: [ctx.agentId],
    }),
    client.readContract({
      address: ctx.nft,
      abi: NFT_ABI,
      functionName: "ownerEpoch",
      args: [ctx.agentId],
    }),
  ]);
  const floor =
    px === 0n
      ? 1n
      : await client.readContract({
          address: ctx.executor,
          abi: EXECUTOR_ABI,
          functionName: "oracleFloor",
          args: [t.tokenIn, tokenOut, t.amountIn, px, 50n],
        });
  return {
    schemaVersion: 1,
    chainId: BigInt(await client.getChainId()),
    agentId: ctx.agentId,
    account: ctx.account,
    actionId: t.actionId ?? viem.keccak256(viem.toBytes(`demo-${Math.random()}`)),
    ownerEpoch,
    configEpoch,
    policyHash,
    adapterId: t.adapterId ?? V4,
    tokenIn: t.tokenIn,
    tokenOut,
    amountIn: t.amountIn,
    minAmountOut: floor + (t.minOutDelta ?? 0n),
    deadline: now + (t.deadlineIn ?? 120n),
  };
}

/** Sends from the session key; returns the amount out, or the refusal's name. */
async function attempt(/** @type {any} */ ctx, /** @type {any} */ i, from = SESSION) {
  try {
    await client.simulateContract({
      address: ctx.executor,
      abi: EXECUTOR_ABI,
      functionName: "swap",
      args: [i],
      account: from,
    });
  } catch (err) {
    return { refused: why(err) };
  }
  const receipt = await send(from, {
    address: ctx.executor,
    abi: EXECUTOR_ABI,
    functionName: "swap",
    args: [i],
  });
  return { gas: receipt.gasUsed };
}

async function demo() {
  const { executor } = await deployAccountFactoryLocal({ quiet: true });
  const factory = book("account_factory");
  const nft = book("agent_nft");
  await oracle.useFreshFeeds();
  console.log(`deployed the trading stack; Executor ${executor}`);

  console.log(
    "\n1. Anvil account 6 mints an agent, opens its PersonalAccount and deposits 60 USDC and about 30 USDC of WMON.",
  );
  const owner = custody.testOwner(6);
  const agentId = await custody.ownersAgent(nft, owner);
  const { account } = await custody.ensureAccount(factory, agentId, owner);
  await custody.depositUsdc(account, owner, 60_000_000n);
  const px = await client.readContract({
    address: book("oracle_adapter"),
    abi: PRICE_ABI,
    functionName: "priceE18",
    args: [wmon],
  });
  const wmonIn = (30_000_000n * 10n ** 30n) / px;
  await setMonBalance(owner, wmonIn + 100n * 10n ** 18n, ANVIL_URL);
  await send(owner, {
    address: wmon,
    abi: ERC20_ABI,
    functionName: "deposit",
    args: [],
    value: wmonIn,
  });
  await send(owner, {
    address: wmon,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [account, wmonIn],
  });
  await send(owner, {
    address: account,
    abi: ACCOUNT_ABI,
    functionName: "deposit",
    args: [wmon, wmonIn],
  });
  console.log(`   agent #${agentId}, account ${account}`);

  console.log("\n2. The owner registers a session key for a day.");
  await impersonate(SESSION);
  const now = await oracle.forkTime();
  await send(owner, {
    address: executor,
    abi: EXECUTOR_ABI,
    functionName: "registerSession",
    args: [agentId, SESSION, now + 86_400n],
  });
  const ctx = { executor, nft, account, agentId };

  const balances = async () => {
    const [u, w] = await Promise.all([
      client.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "freeBalance",
        args: [usdc],
      }),
      client.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "freeBalance",
        args: [wmon],
      }),
    ]);
    return `${formatUnits(u, 6)} USDC and ${Number(formatUnits(w, 18)).toFixed(4)} WMON`;
  };

  console.log(
    "\n3. Valid swaps on the real Uniswap v4 MON/USDC pool: the output stays in the account.",
  );
  let r = await attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 5_000_000n }));
  console.log(
    `   buy WMON with 5 USDC: ${r.refused ?? `done (gas ${r.gas})`}; account holds ${await balances()}`,
  );
  r = await attempt(ctx, await intent(ctx, { tokenIn: wmon, amountIn: wmonIn / 5n }));
  console.log(
    `   sell ${Number(formatUnits(wmonIn / 5n, 18)).toFixed(2)} WMON: ${r.refused ?? `done (gas ${r.gas})`}; account holds ${await balances()}`,
  );

  console.log("\n4. One intent per limit, and the reason the Executor gives:");
  /** @param {string} label @param {Promise<any>} result */
  const show = async (label, result) => {
    const x = await result;
    console.log(`   ${label.padEnd(46)} ${x.refused ?? "accepted"}`);
  };
  await show(
    "trade above 10% of value",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 9_500_000n })),
  );
  await show(
    "buy past 40% in WMON",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 8_900_000n })),
  );
  await show(
    "minimum one unit under the oracle floor",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n, minOutDelta: -1n })),
  );
  await show(
    "deadline 121 seconds ahead",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n, deadlineIn: 121n })),
  );
  await show(
    "deadline already past",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n, deadlineIn: -1n })),
  );
  await show(
    "selling more WMON than held",
    attempt(ctx, await intent(ctx, { tokenIn: wmon, amountIn: wmonIn * 2n })),
  );
  await show(
    "the paused v3 fallback venue",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n, adapterId: V3 })),
  );
  await show(
    "sent by a key nobody registered",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n }), owner),
  );
  const once = await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n });
  await attempt(ctx, once);
  await show(
    "the same actionId a second time",
    attempt(ctx, { ...once, deadline: once.deadline + 1n }),
  );

  // MON/USD 3% above the pool: the pool is too far from the oracle.
  const answers = await oracle.useFreshFeeds();
  await oracle.setMonUsd((answers.monUsd * 103n) / 100n);
  await show(
    "pool 3% from the oracle",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n })),
  );
  await oracle.setMonUsd(answers.monUsd);
  await oracle.setFeedsDown(true);
  await show(
    "MON/USD unreadable",
    attempt(ctx, {
      ...(await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n })),
      minAmountOut: 1n,
    }),
  );
  await oracle.setFeedsDown(false);

  await send(owner, {
    address: account,
    abi: ACCOUNT_ABI,
    functionName: "setReduceOnly",
    args: [],
  });
  await show(
    "a buy while REDUCE_ONLY",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n })),
  );
  await send(owner, { address: account, abi: ACCOUNT_ABI, functionName: "unpause", args: [] });

  // Taking WMON off the buy list is instant; putting it back waits the timelock.
  await send(CUSTODY_ROLES.admin, {
    address: factory,
    abi: FACTORY_ABI,
    functionName: "removeBuyable",
    args: [wmon],
  });
  await show(
    "WMON taken off the buy list",
    attempt(ctx, await intent(ctx, { tokenIn: usdc, amountIn: 1_000_000n })),
  );
  await show(
    "  but selling it is still allowed",
    attempt(ctx, await intent(ctx, { tokenIn: wmon, amountIn: wmonIn / 50n })),
  );

  // Small sales until the rolling 24 hours hold 20 trades; the next is refused.
  let made = 0;
  for (;;) {
    const x = await attempt(ctx, await intent(ctx, { tokenIn: wmon, amountIn: 10n ** 18n }));
    if (x.refused) {
      // Four trades went through above; this one is the next after `made` more.
      await show(`trade ${made + 5} in the last 24 hours`, Promise.resolve(x));
      break;
    }
    made += 1;
    if (made > 25) break;
  }

  await send(owner, {
    address: executor,
    abi: EXECUTOR_ABI,
    functionName: "bumpConfigEpoch",
    args: [agentId],
  });
  await show(
    "after the owner bumps the configuration epoch",
    attempt(ctx, await intent(ctx, { tokenIn: wmon, amountIn: wmonIn / 50n })),
  );
  console.log(
    `\nThe account holds ${await balances()}; nothing left it but through its own swaps.`,
  );
}

console.log(`starting a fork of its own on port ${FORK_PORT} (the playtest fork is not touched)`);
const fork = await startTestFork({ port: FORK_PORT });
const stopAndExit = async () => {
  await fork.stop();
  process.exit(130);
};
process.once("SIGINT", stopAndExit);
process.once("SIGTERM", stopAndExit);
let status = 0;
try {
  await demo();
  if (keep) {
    console.log(`\nThe fork stays up at ${fork.url} until Ctrl-C.`);
    // The signal handlers above stop the fork and exit.
    await new Promise(() => undefined);
  }
} catch (err) {
  status = 1;
  console.error(`error: ${why(err)}`);
} finally {
  await fork.stop();
}
process.exit(status);
