// @ts-check
// The signer on a fork of its own (P2-U4): a fresh fork of Monad at the pinned
// block on port 8553 (never the playtest fork on 8545) and a throwaway
// database, with the trading stack deployed by pnpm deploy:account-factory.
// Each step is one command of the signer's flow; `demo` runs them in order:
//
//   create-key      the signer creates agent's session key; only its address comes out
//   register-grant  the agent's owner registers that address as the Executor grant
//   swap            a test swap through the signer, the Executor and the real v4 pool,
//                   followed through the outbox to its reconciled ledger entry
//   break-limit     a swap that breaks a limit, and the reason it is refused
//   timeout         a broadcast whose answer is lost: unknown, resolved by hash, not resent
//
//   pnpm signer:local demo [--keep]
//   pnpm signer:local swap [--direction buy|sell] [--amount 5] [--keep]
//
// A later step runs the steps it needs first. The fork stops when it is done
// (or on Ctrl-C with --keep). Needs Postgres (pnpm dev:up).
import { randomBytes } from "node:crypto";
import { setMonBalance, startTestFork } from "@alpha-agents/devenv";

const FORK_PORT = 8553;
// Every library below reads the fork's port from here when it loads (D-200, L-100).
process.env.LOCAL_FORK_PORT = String(FORK_PORT);

const { loadRootEnv } = await import("./lib/config.js");
loadRootEnv();
const { deployAccountFactoryLocal } = await import("./lib/account-factory.js");
const custody = await import("./lib/custody.js");
const { send } = await import("./lib/agent-reveal.js");
const oracle = await import("./lib/oracle.js");
const { addressEntry, parseAmount } = await import("@alpha-agents/domain");
const { createTestDatabase, databaseAvailable } = await import("@alpha-agents/db/testing");
const signerPkg = await import("@alpha-agents/signer");
const { createPublicClient, formatUnits, http } = await import("viem");

const STEPS = ["create-key", "register-grant", "swap", "break-limit", "timeout"];
const args = process.argv.slice(2);
const command = args[0] ?? "demo";
if (command !== "demo" && !STEPS.includes(command)) {
  console.error(`usage: pnpm signer:local demo|${STEPS.join("|")} [--keep]`);
  process.exit(2);
}
const keep = args.includes("--keep");
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const direction = flag("direction") === "sell" ? "sell" : "buy";
const amountText = flag("amount") ?? (direction === "buy" ? "5" : "0.5");
const upTo = command === "demo" ? STEPS.length : STEPS.indexOf(command) + 1;

const book = (/** @type {import("@alpha-agents/domain").AddressBookId} */ id) =>
  /** @type {`0x${string}`} */ (addressEntry("local", id).address);

/** @param {import("@alpha-agents/signer").OutboxView} r */
function describe(r) {
  const states = r.history.map((h) => h.status).join(" -> ");
  return `${states}${r.reasonCode ? ` (${r.reasonCode})` : ""}${r.txHash ? `\n     tx ${r.txHash}` : ""}`;
}

/** @param {string} url */
async function run(url) {
  if (!(await databaseAvailable())) throw new Error("Postgres is not running: pnpm dev:up");
  const t = await createTestDatabase("signer_local");
  try {
    console.log(
      "deploying the trading stack and opening anvil account 6's PersonalAccount with 60 USDC",
    );
    await deployAccountFactoryLocal({ quiet: true });
    await oracle.useFreshFeeds();
    const owner = /** @type {`0x${string}`} */ (custody.testOwner(6));
    const agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
    const { account } = await custody.ensureAccount(
      book("account_factory"),
      BigInt(agentId),
      owner,
    );
    await custody.depositUsdc(account, owner, 60_000_000n);
    console.log(`   agent #${agentId}, account ${account}`);

    // A seed made for this run and never printed: the keys die with the fork.
    const seed = /** @type {`0x${string}`} */ (`0x${randomBytes(32).toString("hex")}`);
    const usdc = book("usdc");
    const wmon = book("wmon");
    /** @param {import("@alpha-agents/signer").ChainClient} [chain] */
    const makeSigner = (chain) =>
      new signerPkg.Signer({
        db: t.db,
        environment: "local",
        chain: chain ?? new signerPkg.ViemChainClient({ chainId: 143143, primaryUrl: url }),
        keys: new signerPkg.LocalKeyProvider(seed),
        executor: book("executor"),
        assets: { [usdc.toLowerCase()]: "USDC", [wmon.toLowerCase()]: "WMON" },
        topUpGas: (address, wei) => setMonBalance(address, wei, url),
      });
    const signer = makeSigner();
    await signer.start();
    const client = createPublicClient({ transport: http(url) });
    const balances = async () => {
      const read = (/** @type {`0x${string}`} */ token) =>
        client.readContract({
          address: token,
          abi: signerPkg.ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        });
      const [u, w] = await Promise.all([read(usdc), read(wmon)]);
      return `${formatUnits(u, 6)} USDC, ${Number(formatUnits(w, 18)).toFixed(6)} WMON`;
    };
    /** @param {import("@alpha-agents/signer").Signer} s @param {string} txId */
    const settle = async (s, txId) => {
      for (let i = 0; i < 60; i++) {
        await s.tick();
        const [r] = (await s.outbox(agentId, 50)).filter((x) => x.txId === txId);
        if (r && (r.status === "reconciled" || r.status === "failed" || r.reasonCode)) return r;
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error("the transaction did not settle in 15 s");
    };

    console.log("\n1. create-key: the signer creates the agent's session key");
    const key = await signer.createKey(agentId);
    console.log(`   session key ${key} (the key itself stays in the signer)`);
    if (upTo < 2) return;

    console.log("\n2. register-grant: the owner registers it on the Executor for 30 days");
    const now = (await client.getBlock()).timestamp;
    await send(owner, {
      address: book("executor"),
      abi: signerPkg.EXECUTOR_ABI,
      functionName: "registerSession",
      args: [BigInt(agentId), key, now + 30n * 86_400n],
    });
    console.log(`   grant registered for agent #${agentId}`);
    if (upTo < 3) return;

    console.log(
      `\n3. swap: ${direction} with ${amountText} ${direction === "buy" ? "USDC" : "WMON"}`,
    );
    if (direction === "sell") {
      const first = await signerPkg.buildTestSwap(url, {
        agentId,
        direction: "buy",
        amountIn: 5_000_000n,
      });
      if (first.kind === "swap")
        await settle(signer, (await signer.submitSwap(agentId, first.intent)).txId);
    }
    console.log(`   before: ${await balances()}`);
    const amountIn = parseAmount(amountText, direction === "buy" ? 6 : 18);
    if (!amountIn) throw new Error(`--amount ${amountText} is not a positive amount`);
    const swap = await signerPkg.buildTestSwap(url, { agentId, direction, amountIn });
    if (swap.kind !== "swap") throw new Error("expected a swap");
    const done = await settle(signer, (await signer.submitSwap(agentId, swap.intent)).txId);
    console.log(`   ${describe(done)}`);
    console.log(`   after:  ${await balances()}`);
    const entry = done.ledgerEntryId ? await signer.ledgerEntry(done.ledgerEntryId) : null;
    if (entry) {
      console.log(
        `   ledger entry ${entry.entryId} (${entry.kind}), written with the reconciliation:`,
      );
      for (const l of entry.lines)
        console.log(`     ${l.account.padEnd(17)} ${l.asset.padEnd(5)} ${l.amount}`);
    }
    if (upTo < 4) return;

    console.log("\n4. break-limit: one swap per limit, and the reason it is refused");
    for (const limit of signerPkg.BREAKABLE_LIMITS) {
      const s = await signerPkg.buildTestSwap(url, {
        agentId,
        direction: "buy",
        amountIn: 1_000_000n,
        breakLimit: limit,
      });
      const accepted =
        s.kind === "swap"
          ? await signer.submitSwap(agentId, s.intent)
          : await signer.accept(agentId, s.request);
      const r = accepted.status === "failed" ? accepted : await settle(signer, accepted.txId);
      const code = "reasonCode" in r ? r.reasonCode : null;
      console.log(`   ${signerPkg.BREAKABLE_LIMIT_TEXT[limit].padEnd(54)} ${code}`);
    }
    if (upTo < 5) return;

    console.log("\n5. timeout: the node takes a swap but the answer is lost");
    const real = new signerPkg.ViemChainClient({ chainId: 143143, primaryUrl: url });
    let sends = 0;
    const lossy = Object.assign(Object.create(real), {
      sendRaw: async (/** @type {`0x${string}`} */ raw) => {
        sends++;
        await real.sendRaw(raw);
        return { kind: "unknown", detail: "The request took too long to respond." };
      },
    });
    const s2 = makeSigner(lossy);
    const lost = await signerPkg.buildTestSwap(url, {
      agentId,
      direction: "buy",
      amountIn: 1_000_000n,
    });
    if (lost.kind !== "swap") throw new Error("expected a swap");
    const r = await settle(s2, (await s2.submitSwap(agentId, lost.intent)).txId);
    console.log(`   ${describe(r)}`);
    console.log(`   broadcasts: ${sends} (resolved by its hash and nonce, never sent again)`);
  } finally {
    await t.drop();
  }
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
  await run(fork.url);
  if (keep) {
    console.log(`\nThe fork stays up at ${fork.url} until Ctrl-C.`);
    await new Promise(() => undefined);
  }
} catch (err) {
  status = 1;
  console.error(
    `error: ${err instanceof Error ? err.message.replace(/https?:\/\/\S+/g, "<rpc>") : String(err)}`,
  );
} finally {
  await fork.stop();
}
process.exit(status);
