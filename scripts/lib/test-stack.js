// @ts-check
// The live test stack (P1-U4, D-200): an anvil fork of its own, a throwaway
// database, AgentNFT deployed, the mock wallet on the allowlist, and the real
// indexer and control API as child processes, all pointed at them. The
// playtest fork on 8545 and the development database are never touched.
//
// With `orchestrator` (P1-U9, the My Agents live run) it also starts the
// orchestrator in a namespace of its own: the reveal keeper, provisioning,
// credits, the tool servers and Scans, with real LiteLLM, E2B and Tavily. Its
// LiteLLM keys and any tagged sandbox are removed when the stack stops.
//
// The caller sets LOCAL_FORK_PORT before importing anything that reads the
// fork's address (scripts/lib/config.js reads it when it loads).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestDatabase } from "@alpha-agents/db/testing";
import { startTestFork } from "@alpha-agents/devenv";
import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ANVIL_MNEMONIC } from "./agent-mint.js";
import { deployLocal } from "./agent-nft.js";
import { ROOT } from "./paths.js";

const MOCK_WALLET = "0x00000000000000000000000000000000000e2e01";

/** AgentNFT's local claim signer, anvil account 1: a public development key, derived here, never printed. */
function localClaimSignerKey() {
  const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 }).getHdKey().privateKey;
  if (!key) throw new Error("could not derive the local claim signer");
  return bytesToHex(key);
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000} seconds`);
}

/**
 * @param {{ forkPort: number, apiPort: number, orchestrator?: { port: number, namespace: string } }} options
 */
export async function startTestStack({ forkPort, apiPort, orchestrator }) {
  if (process.env.LOCAL_FORK_PORT !== String(forkPort)) {
    throw new Error(`set LOCAL_FORK_PORT=${forkPort} before starting the test stack`);
  }
  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];
  const stop = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  };
  try {
    const fork = await startTestFork({ port: forkPort });
    cleanups.push(() => fork.stop());
    const db = await createTestDatabase("live");
    cleanups.push(() => db.drop());
    const nft = await deployLocal({ quiet: true });
    await db.db
      .insertInto("platform.mint_allowlist")
      .values({ wallet: MOCK_WALLET, note: "live suite mock wallet" })
      .execute();

    const env = {
      ...process.env,
      APP_ENV: "local",
      LOCAL_FORK_PORT: String(forkPort),
      DATABASE_URL: db.url,
      CONTROL_API_PORT: String(apiPort),
      CLAIM_SIGNER_PRIVATE_KEY: localClaimSignerKey(),
      ALPHA_E2E_MOCK_IDENTITY: "1",
    };
    const logDir = join(ROOT, ".dev");
    mkdirSync(logDir, { recursive: true });
    /** @type {[string, string[]][]} */
    const children = [
      ["indexer", ["services/indexer/src/main.ts"]],
      ["control-api", ["apps/control-api/src/main.ts"]],
    ];
    if (orchestrator) {
      const { LiteLLMAdmin } = await import("../../services/orchestrator/src/gateway-admin.ts");
      const { aliasPrefix } = await import("../../services/orchestrator/src/provisioner.ts");
      const { E2BProvider } = await import("../../services/orchestrator/src/sandbox.ts");
      const gateway = new LiteLLMAdmin(
        process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000",
        process.env.LITELLM_MASTER_KEY ?? "",
      );
      if (!(await gateway.ready())) throw new Error("LiteLLM is not running: pnpm dev:litellm");
      // Registered before the orchestrator starts, so it runs after the orchestrator has stopped.
      cleanups.push(async () => {
        await gateway.deleteAliases(await gateway.listAliases(aliasPrefix(orchestrator.namespace)));
        const e2b = process.env.E2B_API_KEY ? new E2BProvider(process.env.E2B_API_KEY) : null;
        for (const sbx of (await e2b?.list({
          app: "alpha-agents",
          namespace: orchestrator.namespace,
        })) ?? [])
          await e2b?.kill(sbx.id);
      });
      children.push([
        "orchestrator",
        ["services/orchestrator/src/main.ts", `--namespace=${orchestrator.namespace}`],
      ]);
    }
    for (const [name, args] of children) {
      const log = createWriteStream(join(logDir, `test-${name}.log`), { flags: "w" });
      const child = spawn("node", args, {
        cwd: ROOT,
        env: orchestrator ? { ...env, ORCHESTRATOR_PORT: String(orchestrator.port) } : env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      cleanups.push(async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once("exit", r)));
        log.end();
      });
      // A runner killed by a signal must not leave these running (L-22).
      for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"]))
        process.once(sig, () => child.kill("SIGTERM"));
      process.once("exit", () => child.kill("SIGTERM"));
    }
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitFor(`${apiUrl}/health`, 60_000);
    if (orchestrator) await waitFor(`http://127.0.0.1:${orchestrator.port}/health`, 90_000);
    return { fork, db, nft, apiUrl, databaseUrl: db.url, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
