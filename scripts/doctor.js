// @ts-check
// Checks that every prerequisite of the local environment is in place.
// Validates the local config through packages/config, which names problem
// variables but never prints a value.
import { readFileSync } from "node:fs";
import { ConfigError, Secret } from "@alpha-agents/config";
import {
  MONAD_MAINNET_CHAIN_ID,
  loadLocalConfig,
  loadRootEnv,
  parseFoundryVersion,
  readForkConfig,
  readFoundryVersion,
} from "./lib/config.js";
import { NVMRC_PATH } from "./lib/paths.js";
import { RpcError, hexToNumber, rpc, run } from "@alpha-agents/devenv";

loadRootEnv();

let failures = 0;
/**
 * @param {boolean} ok
 * @param {string} label
 * @param {string} detail
 */
function report(ok, label, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(26)} ${detail}`);
}

// Node
const wantNode = readFileSync(NVMRC_PATH, "utf8").trim();
const nodeMajor = process.versions.node.split(".")[0];
report(nodeMajor === wantNode, "node", `${process.versions.node} (want ${wantNode}.x)`);

// pnpm
const pnpm = run("pnpm", ["--version"]);
const pnpmVersion = pnpm.stdout.trim();
report(
  pnpm.ok && pnpmVersion.startsWith("9."),
  "pnpm",
  pnpm.ok ? `${pnpmVersion} (want 9.x)` : "not found",
);

// Foundry
const wantFoundry = readFoundryVersion();
for (const tool of ["forge", "anvil"]) {
  const out = run(tool, ["--version"]);
  const version = out.ok ? parseFoundryVersion(out.stdout) : undefined;
  report(
    version === wantFoundry,
    tool,
    !out.ok
      ? "not on PATH (add ~/.foundry/bin to PATH)"
      : `${version ?? "unknown"} (want ${wantFoundry} from .foundry-version)`,
  );
}

// Docker
const dockerCli = run("docker", ["--version"]);
report(dockerCli.ok, "docker CLI", dockerCli.ok ? dockerCli.stdout.trim() : "not found");
const compose = run("docker", ["compose", "version", "--short"]);
report(compose.ok, "docker compose", compose.ok ? compose.stdout.trim() : "not available");
const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
report(
  daemon.ok,
  "docker daemon reachable",
  daemon.ok
    ? `server ${daemon.stdout.trim()}`
    : /permission denied/i.test(daemon.stderr)
      ? "permission denied on the Docker socket"
      : "not reachable (is Docker Desktop running?)",
);

// Shared config for APP_ENV=local, including MONAD_RPC_URL as the fork upstream.
/** @type {string | undefined} */
let rpcUrl;
try {
  const config = loadLocalConfig();
  const upstream = config.values.MONAD_RPC_URL;
  rpcUrl = upstream instanceof Secret ? upstream.reveal() : undefined;
  report(true, "config (APP_ENV=local)", "valid; MONAD_RPC_URL set");
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  report(false, "config (APP_ENV=local)", "invalid:");
  for (const issue of err.issues) console.log(`      - ${issue.variable} ${issue.problem}`);
}

/** @type {number | undefined} */
let blockNumber;
try {
  blockNumber = readForkConfig().blockNumber;
  report(true, "fork pin", `block ${blockNumber} in chains/monad/fork.json`);
} catch (err) {
  report(false, "fork pin", err instanceof Error ? err.message : "unreadable");
}

if (rpcUrl && blockNumber !== undefined) {
  try {
    const chainId = hexToNumber(await rpc(rpcUrl, "eth_chainId"));
    report(
      chainId === MONAD_MAINNET_CHAIN_ID,
      "RPC chain ID",
      `${chainId} (want ${MONAD_MAINNET_CHAIN_ID})`,
    );
  } catch (err) {
    report(false, "RPC chain ID", err instanceof RpcError ? err.message : "request failed");
  }
  try {
    const latest = hexToNumber(await rpc(rpcUrl, "eth_blockNumber"));
    report(true, "RPC latest block", `${latest} (pinned ${blockNumber})`);
  } catch (err) {
    report(false, "RPC latest block", err instanceof RpcError ? err.message : "request failed");
  }
  // eth_getBalance is valid for every address at every block, so an error here
  // means the RPC no longer serves state at the pinned block, never "no contract".
  try {
    await rpc(rpcUrl, "eth_getBalance", [
      "0x0000000000000000000000000000000000000000",
      `0x${blockNumber.toString(16)}`,
    ]);
    report(true, "RPC serves pinned block", String(blockNumber));
  } catch (err) {
    report(
      false,
      "RPC serves pinned block",
      `${blockNumber}: ${err instanceof RpcError ? err.message : "request failed"}; re-pin (see README)`,
    );
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
