// @ts-check
// pnpm rpc:probe: measures every configured Monad RPC provider without
// printing its URL or key (P2-EC follow-up, Q-52, Q-59): the chain it serves,
// the provider's domain, latency, the widest eth_getLogs range it allows,
// whether it serves state at old blocks (archive), and its answers under the
// stack's normal polling mix (7.5 requests a second, D-310) and at about
// 19 a second for a minute each. Writes evidence/rpc-providers.json.
//
//   pnpm rpc:probe            every configured provider
//   pnpm rpc:probe --quick    skip the two one-minute load tests
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";

const VARIABLES = [
  "MONAD_RPC_URL",
  "MONAD_RPC_URL_SECONDARY",
  "MONAD_TESTNET_RPC_URL",
  "MONAD_TESTNET_RPC_URL_SECONDARY",
];
/** USDC on each chain: a busy contract to ask for logs, and a fixed address to read. */
const USDC = {
  143: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  10143: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
};
/** Old blocks to read state at: mainnet's fork pin (D-195) and far back on each chain. */
const OLD_BLOCKS = {
  143: [109_670_000, 50_000_000, 1_000_000],
  10143: [60_000_000, 30_000_000, 1_000_000],
};

loadRootEnv();
const quick = process.argv.includes("--quick");
const urls = VARIABLES.map((v) => process.env[v]?.trim()).filter((u) => !!u);
const hide = (/** @type {string} */ s) => redact(s, urls).slice(0, 160);

/** @param {string} url @param {string} method @param {unknown[]} params */
async function call(url, method, params = []) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const ms = performance.now() - started;
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 100) } };
    }
    return {
      status: res.status,
      ms,
      result: body.result,
      error: body.error ? hide(JSON.stringify(body.error)) : null,
    };
  } catch (err) {
    return { status: 0, ms: performance.now() - started, result: null, error: hide(String(err)) };
  }
}

const pct = (/** @type {number[]} */ xs, /** @type {number} */ p) =>
  Math.round(
    [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] ?? 0,
  );

/** The widest eth_getLogs range (in blocks) the provider answers, up to 10,000. */
async function logRange(
  /** @type {string} */ url,
  /** @type {number} */ head,
  /** @type {string} */ address,
) {
  const ok = async (/** @type {number} */ n) =>
    !(
      await call(url, "eth_getLogs", [
        {
          fromBlock: `0x${(head - n - 4).toString(16)}`,
          toBlock: `0x${(head - 5).toString(16)}`,
          address,
        },
      ])
    ).error;
  if (await ok(10_000)) return { max: 10_000, note: "10,000 or more" };
  let lo = 0;
  let hi = 10_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await ok(mid)) lo = mid;
    else hi = mid;
  }
  const refusal = await call(url, "eth_getLogs", [
    {
      fromBlock: `0x${(head - hi - 4).toString(16)}`,
      toBlock: `0x${(head - 5).toString(16)}`,
      address,
    },
  ]);
  return { max: lo, refusal: refusal.error };
}

/** Sends `perSecond` requests a second for `seconds` in the stack's method mix; counts answers. */
async function load(
  /** @type {string} */ url,
  /** @type {number} */ head,
  /** @type {string} */ usdc,
  /** @type {number} */ perSecond,
  /** @type {number} */ seconds,
) {
  const mix = [
    ...Array(8).fill("eth_call"),
    ...Array(3).fill("eth_getLogs"),
    ...Array(3).fill("eth_getBlockByNumber"),
    "eth_blockNumber",
  ];
  /** @type {Record<string, number>} */
  const statuses = {};
  const pending = [];
  const gap = 1000 / perSecond;
  const end = Date.now() + seconds * 1000;
  for (let i = 0; Date.now() < end; i++) {
    const method = mix[i % mix.length];
    const params =
      method === "eth_call"
        ? [{ to: usdc, data: "0x18160ddd" }, "latest"]
        : method === "eth_getLogs"
          ? [
              {
                fromBlock: `0x${(head - 9).toString(16)}`,
                toBlock: `0x${head.toString(16)}`,
                address: usdc,
              },
            ]
          : method === "eth_getBlockByNumber"
            ? ["latest", false]
            : [];
    pending.push(
      call(url, /** @type {string} */ (method), params).then((r) => {
        const key = r.error && r.status === 200 ? "200-error" : String(r.status);
        statuses[key] = (statuses[key] ?? 0) + 1;
      }),
    );
    await new Promise((r) => setTimeout(r, gap));
  }
  await Promise.all(pending);
  return statuses;
}

const results = [];
for (const name of VARIABLES) {
  const url = process.env[name]?.trim();
  if (!url) {
    results.push({ variable: name, configured: false });
    console.log(`${name}: not set`);
    continue;
  }
  const domain = new URL(url).hostname.split(".").slice(-2).join(".");
  const id = await call(url, "eth_chainId");
  const chainId = id.result ? Number(id.result) : null;
  const r = /** @type {Record<string, unknown>} */ ({
    variable: name,
    configured: true,
    domain,
    chainId,
  });
  if (chainId !== 143 && chainId !== 10143) {
    r.error = id.error ?? `unexpected chain ${chainId}`;
    results.push(r);
    console.log(`${name}: ${JSON.stringify(r)}`);
    continue;
  }
  const lat = [];
  for (let i = 0; i < 20; i++) lat.push((await call(url, "eth_blockNumber")).ms);
  r.latencyMs = { p50: pct(lat, 50), p95: pct(lat, 95) };
  const head = Number((await call(url, "eth_blockNumber")).result);
  const usdc = USDC[/** @type {143 | 10143} */ (chainId)];
  r.logRange = await logRange(url, head, usdc);
  r.archive = {};
  for (const block of OLD_BLOCKS[/** @type {143 | 10143} */ (chainId)]) {
    const tag = `0x${block.toString(16)}`;
    const code = await call(url, "eth_getCode", [usdc, tag]);
    const balance = await call(url, "eth_getBalance", [
      "0x0000000000000000000000000000000000000000",
      tag,
    ]);
    /** @type {Record<string, unknown>} */ (r.archive)[block] =
      !code.error && !balance.error ? "state served" : (code.error ?? balance.error);
  }
  if (!quick) {
    r.normalLoad = { perSecond: 7.5, seconds: 60, answers: await load(url, head, usdc, 7.5, 60) };
    r.heavyLoad = { perSecond: 19, seconds: 60, answers: await load(url, head, usdc, 19, 60) };
  }
  results.push(r);
  console.log(`${name}: ${JSON.stringify(r)}`);
}
const file = join(ROOT, "evidence/rpc-providers.json");
writeFileSync(
  file,
  `${JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(`recorded in ${file}`);
