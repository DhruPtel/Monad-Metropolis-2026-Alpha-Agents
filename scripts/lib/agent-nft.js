// @ts-check
// AgentNFT deployment (P1-U3): the local and testnet roles and the call into
// chains/monad/script/DeployAgentNFT.s.sol. Used by scripts/deploy-agent-nft.js
// and by scripts/test-fork.js, which deploys to the local fork before checking
// the address book. The deployment is deterministic (CREATE2, fixed salt), so
// running it again finds the existing contract.
import { spawnSync } from "node:child_process";
import { variableSpec } from "@alpha-agents/config";
import { assertLocalFork, hexToNumber, rpc } from "@alpha-agents/devenv";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_URL } from "./config.js";
import { MONAD_DIR } from "./paths.js";

/**
 * Anvil's well-known development accounts (public test keys, never funded on
 * a real network). Local roles: deployer and admin, claim signer, treasury.
 */
/** @type {{ admin: `0x${string}`, claimSigner: `0x${string}`, treasury: `0x${string}` }} */
export const LOCAL_ROLES = {
  admin: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  claimSigner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  treasury: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
};

/** Placeholder until the 25 species images and the placeholder are on IPFS. */
export const PENDING_IMAGE_BASE_URI = "ipfs://alpha-agents-images-pending/";

/** @type {{ local: `0x${string}`, testnet: `0x${string}` }} */
export const ENTROPY = {
  local: "0xD458261E832415CFd3BAE5E416FdF3230ce6F134",
  testnet: "0x825c0390f379C631f3Cf11A82a37D20BddF93c07",
};

/** @param {string} name */
function configured(name) {
  const value = process.env[name];
  if (!value) return undefined;
  if (value === variableSpec(name)?.example) return undefined;
  return value;
}

/** How many times a local deploy runs before a transient fork error fails it. */
export const LOCAL_DEPLOY_ATTEMPTS = 3;

/**
 * True for forge output that failed on the fork's upstream RPC rather than on
 * the deployment: anvil fetches fork state lazily, and the upstream sometimes
 * fails a fetch ("could not get block data", "failed to fetch grandparent
 * block", "Resource not found", a rate limit or a timeout). Running the deploy again can clear these (L-43).
 * @param {string} output
 */
export function isTransientForkError(output) {
  return /could not get block data|failed to fetch (grand)?parent block|resource not found|\b429\b|too many requests|timed? ?out/i.test(
    output,
  );
}

/**
 * Explicit fees for a local deploy: a legacy gas price of twice the latest
 * block's base fee plus 2 gwei, read from anvil itself. With them forge never
 * calls eth_feeHistory, which makes anvil fetch old blocks from the upstream
 * and was the call that failed on a fresh fork (L-43). Even with both EIP-1559
 * fee flags set, forge 1.8 still called it once.
 * @returns {Promise<string[]>}
 */
export async function localFeeArgs() {
  const block = /** @type {{ baseFeePerGas?: string } | null} */ (
    await rpc(ANVIL_URL, "eth_getBlockByNumber", ["latest", false])
  );
  const baseFee = BigInt(block?.baseFeePerGas ?? "0x0");
  return ["--legacy", "--with-gas-price", String(baseFee * 2n + 2_000_000_000n)];
}

/**
 * Runs a deploy script with forge and returns its output. A run that fails
 * with a transient fork error is repeated, up to `attempts` runs in all; our
 * deploy scripts find a contract an earlier run already deployed, so a repeat
 * is safe.
 * @param {string} script e.g. "script/DeployAgentNFT.s.sol:DeployAgentNFT"
 * @param {string[]} extraArgs
 * @param {Record<string, string>} env
 */
export function runForgeDeploy(script, extraArgs, env, quiet = false, attempts = 1) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("forge", ["script", script, "--broadcast", ...extraArgs], {
      cwd: MONAD_DIR,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const retry = result.status !== 0 && attempt < attempts && isTransientForkError(output);
    // Print forge's output, minus any line that could echo a key.
    if ((!quiet || result.status !== 0) && !retry) {
      for (const line of output.split("\n")) {
        if (!/private.?key/i.test(line)) console.log(line);
      }
    }
    if (retry) {
      console.log(
        `forge script hit a transient fork error; retrying (${attempt + 1} of ${attempts})`,
      );
      continue;
    }
    if (result.status !== 0) throw new Error("forge script failed");
    return output;
  }
}

/**
 * Runs DeployAgentNFT and returns the deployed address.
 * @param {string[]} extraArgs
 * @param {Record<string, string>} env
 */
function runForgeScript(extraArgs, env, quiet = false, attempts = 1) {
  const output = runForgeDeploy(
    "script/DeployAgentNFT.s.sol:DeployAgentNFT",
    extraArgs,
    env,
    quiet,
    attempts,
  );
  const address = /AGENT_NFT_ADDRESS\s+(0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  if (!address) throw new Error("forge script did not report the AgentNFT address");
  return address;
}

/**
 * @param {{ quiet?: boolean }} [options] quiet prints only the summary
 * @returns {Promise<string>} the AgentNFT address
 */
export async function deployLocal(options = {}) {
  await assertLocalFork(ANVIL_URL);
  const address = runForgeScript(
    [
      "--rpc-url",
      ANVIL_URL,
      "--unlocked",
      "--sender",
      LOCAL_ROLES.admin,
      ...(await localFeeArgs()),
    ],
    {
      AGENT_NFT_ADMIN: LOCAL_ROLES.admin,
      AGENT_NFT_CLAIM_SIGNER: LOCAL_ROLES.claimSigner,
      AGENT_NFT_TREASURY: LOCAL_ROLES.treasury,
      AGENT_NFT_IMAGE_BASE_URI: PENDING_IMAGE_BASE_URI,
      AGENT_NFT_ENTROPY: ENTROPY.local,
    },
    options.quiet,
    LOCAL_DEPLOY_ATTEMPTS,
  );
  if (options.quiet) return address;
  console.log(`\nAgentNFT on the local fork: ${address}`);
  console.log(`admin ${LOCAL_ROLES.admin} (anvil account 0)`);
  console.log(`claim signer ${LOCAL_ROLES.claimSigner} (anvil account 1)`);
  console.log(`treasury ${LOCAL_ROLES.treasury} (anvil account 2)`);
  console.log("Try it: pnpm agent-nft:local mint, then reveal, then show 1");
  return address;
}

/** @returns {Promise<string>} the AgentNFT address */
export async function deployTestnet() {
  const rpcUrl = configured("MONAD_TESTNET_RPC_URL");
  const key = configured("TESTNET_DEPLOYER_PRIVATE_KEY");
  const missing = [
    !rpcUrl && "MONAD_TESTNET_RPC_URL",
    !key && "TESTNET_DEPLOYER_PRIVATE_KEY (funded with testnet MON from the faucet)",
  ].filter(Boolean);
  if (!rpcUrl || !key) {
    throw new Error(`testnet deployment needs ${missing.join(" and ")} in .env`);
  }
  const chainId = hexToNumber(await rpc(rpcUrl, "eth_chainId", [], 10_000));
  if (chainId !== 10143) {
    throw new Error(`MONAD_TESTNET_RPC_URL serves chain ${chainId}, not 10143`);
  }
  const deployer = privateKeyToAccount(/** @type {`0x${string}`} */ (key)).address;
  const admin = configured("TESTNET_ADMIN_SAFE_ADDRESS") ?? deployer;
  const address = runForgeScript(["--rpc-url", rpcUrl], {
    DEPLOYER_PRIVATE_KEY: key,
    AGENT_NFT_ADMIN: admin,
    AGENT_NFT_CLAIM_SIGNER: deployer,
    AGENT_NFT_TREASURY: admin,
    AGENT_NFT_IMAGE_BASE_URI: PENDING_IMAGE_BASE_URI,
    AGENT_NFT_ENTROPY: ENTROPY.testnet,
  });
  console.log(`\nAgentNFT on Monad testnet: ${address} (admin ${admin}, claim signer ${deployer})`);
  return address;
}
