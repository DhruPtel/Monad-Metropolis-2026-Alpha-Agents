// @ts-check
// pnpm canary:local-only: P2-EC part 2's check that no local-only feature can
// run in the mainnet canary (BUILD_PLAN P2-EC item 10, acceptance test 8).
// The canary runs no orchestrator, indexer, API, web app or console (D-251),
// so each is started with APP_ENV=canary and must refuse at start; each
// fork-only helper is tried against the mainnet RPC and must refuse before
// sending. Nothing here can change mainnet state. Writes
// evidence/p2-ec/canary-local-only.json. Prints no key and no RPC URL.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, webEnvironment } from "@alpha-agents/config";
import {
  NotLocalForkError,
  redact,
  refreshLocalFeeds,
  sendAs,
  setMonBalance,
} from "@alpha-agents/devenv";
import { CHAIN_PINS } from "@alpha-agents/signer";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";

loadRootEnv();
const url = process.env.MONAD_RPC_URL?.trim();
if (!url) {
  console.error("error: MONAD_RPC_URL is not set in .env");
  process.exit(1);
}
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
  answer = redact(answer, [url])
    .replace(/https?:\/\/\S+/g, "<rpc>")
    .slice(0, 300);
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

/**
 * Starts a node entry point with APP_ENV=canary on ports of its own and
 * returns how it refused, or null if it did not exit with an error.
 */
const startInCanary = (
  /** @type {string[]} */ args,
  /** @type {RegExp} */ expected,
  /** @type {Record<string, string>} */ env = {},
) => {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      APP_ENV: "canary",
      CANARY_SIGNING_ENABLED: "true",
      CONTROL_API_PORT: "4198",
      ORCHESTRATOR_PORT: "4199",
      ...env,
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const line = out.split("\n").find((l) => expected.test(l)) ?? "";
  return r.status !== 0 && line ? `exit ${r.status}: ${line.trim()}` : null;
};

const CANARY_REFUSAL = /APP_ENV is canary|only pnpm canary:mainnet/;

for (const [name, args] of /** @type {const} */ ([
  [
    "orchestrator (reveal keeper, signer worker, trade flow, dev actions)",
    ["services/orchestrator/src/main.ts"],
  ],
  ["indexer", ["services/indexer/src/main.ts"]],
  ["control API (mock login, claims, portfolio)", ["apps/control-api/src/main.ts"]],
]))
  await check(
    `The ${name.split(" (")[0]} in the canary`,
    `start ${args[0]} with APP_ENV=canary`,
    async () => startInCanary([...args], CANARY_REFUSAL, { ALPHA_E2E_MOCK_IDENTITY: "1" }),
  );
await check("Console write tools", "start the dev console with APP_ENV=canary", async () =>
  startInCanary(["scripts/console.js", "dev"], /local/i),
);
await check(
  "The web app on mainnet (D-252)",
  "webEnvironment('canary'), which every web build calls",
  async () => {
    try {
      webEnvironment("canary");
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : null;
    }
  },
);
await check(
  "Local feed refresher (LocalFeed, D-237)",
  "refreshLocalFeeds against the mainnet RPC",
  () => notLocal(() => refreshLocalFeeds(url)),
);
await check(
  "Steered reveals (D-221)",
  "LOCAL_FIRST_REVEAL_SPECIES=bee for the canary runner",
  async () => {
    try {
      loadConfig(
        { name: "canary runner", signs: true, canary: true },
        {
          ...process.env,
          APP_ENV: "canary",
          CANARY_SIGNING_ENABLED: "true",
          LOCAL_FIRST_REVEAL_SPECIES: "bee",
        },
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
  "The keeper's impersonated Entropy delivery",
  "sendAs (impersonation) against the mainnet RPC",
  () => notLocal(() => sendAs(url, someone, someone, "0x")),
);
await check(
  "Devenv impersonation helpers and gas top-ups",
  "setMonBalance (anvil_setBalance) against the mainnet RPC",
  () => notLocal(() => setMonBalance(someone, 1n, url)),
);
await check(
  "Gas top-ups by anvil_setBalance",
  "the canary runner's signer has no top-up",
  async () =>
    /topUpGas/.test(readFileSync(join(ROOT, "scripts/canary-mainnet.js"), "utf8"))
      ? null
      : "pnpm canary:mainnet builds its signer without topUpGas",
);
await check("The fork chain ID 143143", "the canary signer's pinned chain", async () =>
  CHAIN_PINS.canary === 143 ? `pinned to ${CHAIN_PINS.canary}, not 143143` : null,
);
await check("A beta signer gate", "BETA_SIGNING_ENABLED=true with APP_ENV=canary", async () => {
  try {
    loadConfig(
      { name: "canary runner", signs: true, canary: true },
      {
        ...process.env,
        APP_ENV: "canary",
        CANARY_SIGNING_ENABLED: "true",
        BETA_SIGNING_ENABLED: "true",
      },
    );
    return null;
  } catch (err) {
    return err instanceof ConfigError
      ? `ConfigError: ${err.issues.map((i) => i.variable).join(", ")}`
      : null;
  }
});

const file = join(ROOT, "evidence/p2-ec/canary-local-only.json");
writeFileSync(
  file,
  `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
const failed = results.filter((r) => !r.refused);
console.log(
  `\n${results.length - failed.length} of ${results.length} refused; recorded in ${file}`,
);
process.exit(failed.length === 0 ? 0 : 1);
