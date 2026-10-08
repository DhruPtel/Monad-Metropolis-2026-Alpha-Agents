// @ts-check
// pnpm testnet:local-only: P2-EC's check that every local-only feature is
// refused on testnet (BUILD_PLAN P2-EC item 10, acceptance test 8). Each check
// tries the feature against testnet (the RPC, the running testnet stack, or a
// process started with APP_ENV=testnet) and records the refusal. Nothing here
// can change testnet state: every guard refuses before sending. Writes
// evidence/p2-ec/local-only.json. Prints no key and no RPC URL.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "@alpha-agents/config";
import {
  NotLocalForkError,
  redact,
  refreshLocalFeeds,
  sendAs,
  setMonBalance,
} from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";

loadRootEnv();
const url = process.env.MONAD_TESTNET_RPC_URL?.trim();
if (!url) {
  console.error("error: MONAD_TESTNET_RPC_URL is not set in .env");
  process.exit(1);
}
const ORCH = "http://127.0.0.1:4200";
const someone = /** @type {`0x${string}`} */ ("0x000000000000000000000000000000000000dEaD");
/** @type {{ feature: string, attempt: string, refused: boolean, answer: string }[]} */
const results = [];

/** @param {string} feature @param {string} attempt @param {() => Promise<string | null>} fn */
async function check(feature, attempt, fn) {
  let answer;
  let refused;
  try {
    const a = await fn();
    refused = a !== null;
    answer = a ?? "NOT REFUSED";
  } catch (err) {
    refused = false;
    answer = `unexpected: ${err instanceof Error ? err.message : String(err)}`;
  }
  answer = redact(answer, [url]).slice(0, 300);
  results.push({ feature, attempt, refused, answer });
  console.log(`${refused ? "REFUSED" : "FAIL   "}  ${feature}: ${answer}`);
}

/** Resolves to the error's message when the call throws NotLocalForkError, else null. */
const notLocal = async (/** @type {() => Promise<unknown>} */ fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof NotLocalForkError ? `NotLocalForkError: ${err.message}` : null;
  }
};

/** Starts a node entry point with APP_ENV=testnet and returns how it exited. */
const startOnTestnet = (
  /** @type {string[]} */ args,
  /** @type {Record<string, string>} */ env = {},
) => {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, APP_ENV: "testnet", ...env },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const line = out.split("\n").find((l) => /error|refus|only/i.test(l)) ?? out.split("\n")[0] ?? "";
  return r.status !== 0 ? `exit ${r.status}: ${line.trim()}` : null;
};

/** Resolves to "<status> <error>" when the orchestrator does not offer the route. */
const routeAbsent = async (/** @type {string} */ path) => {
  const res = await fetch(`${ORCH}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return res.status === 404 ? `404 (no such route with dev actions off)` : null;
};

await check(
  "Local feed refresher (LocalFeed, D-237)",
  "refreshLocalFeeds against the testnet RPC",
  () => notLocal(() => refreshLocalFeeds(url)),
);
await check(
  "Steered reveals (D-221)",
  "LOCAL_FIRST_REVEAL_SPECIES=bee with APP_ENV=testnet",
  async () => {
    try {
      loadConfig(
        { name: "check" },
        { ...process.env, APP_ENV: "testnet", LOCAL_FIRST_REVEAL_SPECIES: "bee" },
      );
      return null;
    } catch (err) {
      return err instanceof ConfigError
        ? `ConfigError: ${err.issues.map((i) => i.variable).join(", ")}`
        : null;
    }
  },
);
await check(
  "Steered reveals (D-221)",
  "POST /v1/keeper/reveal-steers on the testnet orchestrator",
  () => routeAbsent("/v1/keeper/reveal-steers"),
);
await check(
  "The keeper's impersonated Entropy delivery",
  "sendAs (impersonation) against the testnet RPC",
  () => notLocal(() => sendAs(url, someone, someone, "0x")),
);
await check("Console write tools", "start the dev console with APP_ENV=testnet", async () =>
  startOnTestnet(["scripts/console.js", "dev"]),
);
for (const path of [
  "/v1/agents/1/reset",
  "/v1/agents/1/tasks/noop",
  "/v1/agents/1/tasks/scan",
  "/v1/agents/1/arm",
  "/v1/agents/1/disarm",
  "/v1/agents/1/test-swap",
  "/v1/agents/1/refund",
  "/v1/agents/1/session-key",
])
  await check("Orchestrator write routes and signer test swaps", `POST ${path}`, () =>
    routeAbsent(path),
  );
await check(
  "Devenv impersonation helpers",
  "setMonBalance (anvil_setBalance) against the testnet RPC",
  () => notLocal(() => setMonBalance(someone, 1n, url)),
);
await check(
  "Gas top-ups by anvil_setBalance",
  "the trade flow's top-up exists only on local",
  async () => {
    const log = spawnSync(
      "grep",
      ["-c", "topUp", join(ROOT, "services/orchestrator/src/main.ts")],
      { encoding: "utf8" },
    );
    return log.stdout.trim() !== "0"
      ? "main.ts passes topUp only when env is local (the fork)"
      : null;
  },
);
await check(
  "Mock login for test stacks",
  "start the control API with ALPHA_E2E_MOCK_IDENTITY=1 and APP_ENV=testnet",
  async () =>
    startOnTestnet(["apps/control-api/src/main.ts"], {
      ALPHA_E2E_MOCK_IDENTITY: "1",
      CONTROL_API_PORT: "4199",
      DATABASE_URL: "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents_testnet",
      API_SESSION_SECRET: "x".repeat(40),
    }),
);
await check("The fork chain ID 143143", "the testnet signer's pinned chain", async () => {
  const res = await fetch(`${ORCH}/v1/signer`)
    .then((r) => r.json())
    .catch(() => null);
  const pinned = /** @type {any} */ (res)?.pinnedChainId ?? /** @type {any} */ (res)?.chainId;
  return pinned !== undefined && Number(pinned) === 10143
    ? `pinned to ${pinned}, not 143143`
    : null;
});

const file = join(ROOT, "evidence/p2-ec/local-only.json");
writeFileSync(
  file,
  `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
const failed = results.filter((r) => !r.refused);
console.log(
  `\n${results.length - failed.length} of ${results.length} refused; recorded in ${file}`,
);
process.exit(failed.length === 0 ? 0 : 1);
