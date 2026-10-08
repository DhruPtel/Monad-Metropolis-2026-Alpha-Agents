// @ts-check
// pnpm testnet:measure: the real-chain checklist items of P2-EC that the
// end-to-end run does not already measure, on Monad testnet: finality of a
// few more transactions, one deliberate nonce-gap send, each RPC's range, rate
// and historical-state limits, eth_feeHistory, the clock against block time,
// Pyth Entropy's delivery for the recorded reveal, and the indexing lag of a
// credit with the stack's polling paced. Uses the throwaway test wallet; needs
// the testnet stack running. Writes evidence/p2-ec/measurements.json. Prints
// no key and no RPC URL.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "@alpha-agents/config";
import { redact } from "@alpha-agents/devenv";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import { TESTNET, assertTestnet, reveal, testnetConfig } from "./lib/testnet.js";

const PUBLIC_RPC = "https://testnet-rpc.monad.xyz";
const AGENT_NFT = /** @type {`0x${string}`} */ ("0x0c2472Ed555836F22FB3eAB7aBC2Cc3AebeaC9ea");
const KEEPER_REQUEST = /** @type {`0x${string}`} */ (
  "0xeba0652358709c6a1b644dab683f89ab2cd877f93f196a4a13ffd5bcc3873de7"
);
const KEEPER_REVEAL = /** @type {`0x${string}`} */ (
  "0x54bcfe7cef462a7ef431f5e69f61de1305f7afb57c49e6443899b9dce6bc8e0d"
);
const DEPLOY_BLOCK = 69_281_610;

loadRootEnv();
let config;
try {
  config = testnetConfig(["TESTNET_TEST_WALLET_PRIVATE_KEY"]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const account = privateKeyToAccount(
  /** @type {`0x${string}`} */ (reveal(config, "TESTNET_TEST_WALLET_PRIVATE_KEY")),
);
const chain = {
  id: TESTNET.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};
const client = createPublicClient({ chain, transport: http(url) });
const wallet = createWalletClient({ account, chain, transport: http(url) });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @type {Record<string, unknown>} */
const out = { measuredAt: new Date().toISOString(), wallet: account.address };
const say = (/** @type {string} */ s) => console.log(redact(s, [url]));

/** A raw JSON-RPC call to either provider; answers { status, result | error } without throwing. */
async function raw(
  /** @type {string} */ endpoint,
  /** @type {string} */ method,
  /** @type {unknown[]} */ params,
) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 120) } };
    }
    return {
      status: res.status,
      result: body.result,
      error: body.error ? redact(JSON.stringify(body.error), [url]).slice(0, 200) : null,
    };
  } catch (err) {
    return { status: 0, result: null, error: redact(String(err), [url]).slice(0, 200) };
  }
}

async function finality(/** @type {number} */ n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const sentAt = Date.now();
    const hash = await wallet.sendTransaction({ to: account.address, value: 0n, gas: 21_000n });
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 200 });
    const receiptMs = Date.now() - sentAt;
    const at = async (/** @type {"safe" | "finalized"} */ tag) => {
      for (;;) {
        if ((await client.getBlock({ blockTag: tag })).number >= receipt.blockNumber)
          return Date.now() - sentAt;
        await sleep(150);
      }
    };
    const [safeMs, finalizedMs] = await Promise.all([at("safe"), at("finalized")]);
    const again = await client.getTransactionReceipt({ hash });
    samples.push({
      hash,
      block: Number(receipt.blockNumber),
      receiptMs,
      safeMs,
      finalizedMs,
      stable: again.blockHash === receipt.blockHash,
    });
    say(
      `self-transfer ${hash}: receipt ${receiptMs} ms, safe ${safeMs} ms, finalized ${finalizedMs} ms`,
    );
  }
  return samples;
}

async function nonceGap() {
  const pending = await client.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const signed = await wallet.signTransaction({
    to: account.address,
    value: 0n,
    gas: 21_000n,
    nonce: pending + 3,
    maxFeePerGas: 210_000_000_000n,
    maxPriorityFeePerGas: 3_000_000_000n,
    chain,
  });
  const answer = await raw(url, "eth_sendRawTransaction", [signed]);
  await sleep(20_000);
  const hash = answer.result;
  const seen = hash ? await raw(url, "eth_getTransactionByHash", [hash]) : null;
  const receipt = hash ? await raw(url, "eth_getTransactionReceipt", [hash]) : null;
  const r = {
    nonce: pending + 3,
    pendingNonce: pending,
    sendAnswer: answer,
    after20s: {
      byHash: seen?.result ?? null,
      byHashError: seen?.error ?? null,
      receipt: receipt?.result ?? null,
    },
  };
  say(`nonce gap: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
}

async function rpcLimits(/** @type {string} */ endpoint, /** @type {string} */ label) {
  const head = Number((await raw(endpoint, "eth_blockNumber", [])).result);
  const ranges = [];
  for (const n of [10, 11, 100, 1000]) {
    const r = await raw(endpoint, "eth_getLogs", [
      {
        fromBlock: `0x${(head - n - 5).toString(16)}`,
        toBlock: `0x${(head - 6).toString(16)}`,
        address: TESTNET.usdc,
      },
    ]);
    ranges.push({ blocks: n, ok: !r.error, error: r.error });
  }
  const burst = await Promise.all(
    Array.from({ length: 40 }, () => raw(endpoint, "eth_blockNumber", [])),
  );
  const statuses = burst.reduce(
    (/** @type {Record<string, number>} */ acc, r) => (
      (acc[r.status] = (acc[r.status] ?? 0) + 1),
      acc
    ),
    {},
  );
  const old = await raw(endpoint, "eth_getBalance", [
    account.address,
    `0x${DEPLOY_BLOCK.toString(16)}`,
  ]);
  const older = await raw(endpoint, "eth_getBalance", [
    account.address,
    `0x${(head - 200_000).toString(16)}`,
  ]);
  const oldCall = await raw(endpoint, "eth_call", [
    { to: TESTNET.usdc, data: "0x18160ddd" },
    `0x${(head - 1000).toString(16)}`,
  ]);
  const fees = await raw(endpoint, "eth_feeHistory", ["0x5", "latest", [50]]);
  const r = {
    ranges,
    burstOf40: statuses,
    historicalState: {
      balanceAtDeployBlock: old.error ?? "ok",
      balance200kBlocksBack: older.error ?? "ok",
      callAt1000BlocksBack: oldCall.error ?? "ok",
    },
    feeHistory: fees.result ?? fees.error,
  };
  say(`${label}: ${JSON.stringify(r).slice(0, 600)}`);
  return r;
}

async function clock() {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const before = Date.now();
    const b = await client.getBlock();
    const after = Date.now();
    samples.push({
      block: Number(b.number),
      skewMs: Math.round((before + after) / 2) - Number(b.timestamp) * 1000,
    });
    await sleep(1_000);
  }
  // Blocks per second, from 1,000 blocks back.
  const head = await client.getBlock();
  const back = await client.getBlock({ blockNumber: head.number - 1000n });
  const blockTimeMs = (Number(head.timestamp - back.timestamp) * 1000) / 1000;
  say(`clock: skew ${samples.map((s) => s.skewMs).join(", ")} ms; block time ${blockTimeMs} ms`);
  return { samples, blockTimeMs };
}

async function entropy() {
  const req = await client.getTransactionReceipt({ hash: KEEPER_REQUEST });
  const reqTx = await client.getTransaction({ hash: KEEPER_REQUEST });
  const rev = await client.getTransactionReceipt({ hash: KEEPER_REVEAL });
  // The callback is Pyth's provider calling AgentNFT between the request and the reveal.
  const logs = [];
  for (let from = req.blockNumber; from <= rev.blockNumber; from += 10n) {
    const to = from + 9n > rev.blockNumber ? rev.blockNumber : from + 9n;
    logs.push(...(await client.getLogs({ address: AGENT_NFT, fromBlock: from, toBlock: to })));
  }
  const callbackLog = logs.find(
    (l) => l.transactionHash !== KEEPER_REQUEST && l.transactionHash !== KEEPER_REVEAL,
  );
  const time = async (/** @type {bigint} */ n) =>
    Number((await client.getBlock({ blockNumber: n })).timestamp);
  const cb = callbackLog
    ? await client.getTransaction({ hash: callbackLog.transactionHash })
    : null;
  const r = {
    requestTx: KEEPER_REQUEST,
    requestBlock: Number(req.blockNumber),
    feePaidWei: reqTx.value.toString(),
    callbackTx: cb?.hash ?? null,
    callbackFrom: cb?.from ?? null,
    callbackBlock: callbackLog ? Number(callbackLog.blockNumber) : null,
    callbackBlocksAfterRequest: callbackLog
      ? Number(callbackLog.blockNumber - req.blockNumber)
      : null,
    callbackSecondsAfterRequest: callbackLog
      ? (await time(callbackLog.blockNumber)) - (await time(req.blockNumber))
      : null,
    revealTx: KEEPER_REVEAL,
    revealBlock: Number(rev.blockNumber),
  };
  say(`entropy: ${JSON.stringify(r)}`);
  return r;
}

async function creditLag() {
  const credits = /** @type {{ creditsUsdcE6: string, fundingAddress: `0x${string}` }} */ (
    await fetch("http://127.0.0.1:4100/v1/agents/1/credits").then((r) => r.json())
  );
  const before = BigInt(credits.creditsUsdcE6);
  const sentAt = Date.now();
  const hash = await wallet.sendTransaction({
    to: TESTNET.usdc,
    data: encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [credits.fundingAddress, 10_000n],
    }),
  });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 200 });
  const receiptMs = Date.now() - sentAt;
  for (;;) {
    const now = /** @type {{ creditsUsdcE6: string }} */ (
      await fetch("http://127.0.0.1:4100/v1/agents/1/credits").then((r) => r.json())
    );
    if (BigInt(now.creditsUsdcE6) > before) break;
    await sleep(250);
  }
  const r = {
    hash,
    block: Number(receipt.blockNumber),
    receiptMs,
    creditedMs: Date.now() - sentAt,
  };
  say(`credit lag (paced indexer): ${JSON.stringify(r)}`);
  return r;
}

try {
  await assertTestnet(url);
  out.finality = await finality(5);
  out.clock = await clock();
  out.entropy = await entropy();
  out.creditLag = await creditLag();
  out.rpc = {
    keyed: await rpcLimits(url, "keyed RPC"),
    public: await rpcLimits(PUBLIC_RPC, "public RPC"),
  };
  // Last: the gap stays open, so nothing this wallet sends afterwards is affected in this run.
  out.nonceGap = await nonceGap();
  out.ok = true;
} catch (err) {
  out.ok = false;
  out.error = redact(err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err), [
    url,
  ]);
  say(`FAILED: ${out.error}`);
}
const file = join(ROOT, "evidence/p2-ec/measurements.json");
writeFileSync(
  file,
  `${redact(
    JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2),
    [url],
  )}\n`,
);
say(`recorded in ${file}`);
process.exit(out.ok ? 0 : 1);
