// @ts-check
import { advanceTime, assertLocalFork, sendAs } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
  zeroAddress,
} from "viem";
import { CUSTODY_ROLES } from "./account-factory.js";
import { LOCAL_DEPLOY_ATTEMPTS, isTransientForkError } from "./agent-nft.js";
import { ANVIL_URL } from "./config.js";
import { feeArgs, runForge } from "./fund.js";

/**
 * The class A attestation verifier on the local fork (F-U12): deployed at its
 * CREATE2 address for the attestor key, then set in the TokenRegistry through
 * the registry's own timelock (SET_VERIFIER): the admin proposes, the fork's
 * clock moves past the 9-day delay, and the change is executed. The time
 * warp is the one thing a real chain does not have; there the admin proposes
 * and anyone executes after the delay.
 *
 * The local attestor key is anvil account 2 (`0x3C44…93BC`, mnemonic index
 * 2); the testnet key is TESTNET_ATTESTOR_PRIVATE_KEY.
 */
export const ATTESTOR_ROLES = {
  local: /** @type {`0x${string}`} */ ("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
};

const REGISTRY_ABI = parseAbi([
  "function verifier() view returns (address)",
  "function SET_VERIFIER() view returns (uint8)",
  "function RISK_TIMELOCK() view returns (uint256)",
  "function propose(uint8 action, bytes data) returns (bytes32)",
  "function execute(uint8 action, bytes data)",
  "function changeId(uint8 action, bytes data) view returns (bytes32)",
  "function pending(bytes32 id) view returns (uint64 executableAt, uint64 expiresAt)",
]);
const VERIFIER_ABI = parseAbi(["function ATTESTOR() view returns (address)"]);

/** @param {import("@alpha-agents/domain").AddressBookId} id */
function verified(id) {
  const e = addressEntry("local", id);
  if (e.status !== "verified")
    throw new Error(`the address book has no verified ${id} for the local fork`);
  return e.address;
}

const redact = (/** @type {string} */ s) =>
  s
    .split("\n")
    .filter((l) => !/private.?key/i.test(l))
    .join("\n")
    .replace(/https?:\/\/(?!127\.0\.0\.1)\S+/g, "[url]");

/**
 * Deploys the verifier for `attestor` (or finds it) and sets it in the
 * registry through the timelock when it is not the verifier already.
 * @param {{ url?: string, attestor?: `0x${string}`, tokenRegistry?: `0x${string}`, quiet?: boolean }} [options]
 */
export async function deployAttestationVerifierLocal(options = {}) {
  const url = options.url ?? ANVIL_URL;
  await assertLocalFork(url);
  const attestor = options.attestor ?? ATTESTOR_ROLES.local;
  const registry = options.tokenRegistry ?? verified("token_registry_v3");
  const client = createPublicClient({ transport: http(url) });
  if ((await client.getCode({ address: registry })) === undefined)
    throw new Error(
      `the TokenRegistry ${registry} has no code on this fork; run pnpm deploy:fund first`,
    );
  const args = [
    "script",
    "script/DeployAttestor.s.sol:DeployAttestor",
    "--broadcast",
    "--rpc-url",
    url,
    "--unlocked",
    "--sender",
    CUSTODY_ROLES.admin,
    ...(await feeArgs(url)),
  ];
  /** @returns {Promise<string>} the forge script's output */
  const deploy = async () => {
    for (let attempt = 1; ; attempt++) {
      const r = await runForge(args, { ATTESTOR_ADDRESS: attestor });
      if (r.status === 0) return r.output;
      if (attempt < LOCAL_DEPLOY_ATTEMPTS && isTransientForkError(r.output)) continue;
      console.log(redact(r.output));
      throw new Error("forge script failed: DeployAttestor");
    }
  };
  const output = await deploy();
  const found = /ATTESTATION_VERIFIER_ADDRESS\s+(0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  if (!found) throw new Error("forge script did not report ATTESTATION_VERIFIER_ADDRESS");
  const verifier = /** @type {`0x${string}`} */ (found);
  const onChain = await client.readContract({
    address: verifier,
    abi: VERIFIER_ABI,
    functionName: "ATTESTOR",
  });
  if (onChain.toLowerCase() !== attestor.toLowerCase())
    throw new Error(`the verifier at ${verifier} names another attestor`);

  const current = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "verifier",
  });
  let set = false;
  let warpedSeconds = 0;
  if (current.toLowerCase() !== verifier.toLowerCase()) {
    const action = await client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "SET_VERIFIER",
    });
    const delay = await client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "RISK_TIMELOCK",
    });
    const data = encodeAbiParameters([{ type: "address" }], [verifier]);
    const id = await client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "changeId",
      args: [action, data],
    });
    const [executableAt] = await client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "pending",
      args: [id],
    });
    if (executableAt === 0n)
      await sendAs(
        url,
        CUSTODY_ROLES.admin,
        registry,
        encodeFunctionData({ abi: REGISTRY_ABI, functionName: "propose", args: [action, data] }),
      );
    // The timelock's delay, on the fork's clock (never on a real chain).
    warpedSeconds = Number(delay) + 1;
    await advanceTime(warpedSeconds, url);
    await sendAs(
      url,
      CUSTODY_ROLES.admin,
      registry,
      encodeFunctionData({ abi: REGISTRY_ABI, functionName: "execute", args: [action, data] }),
    );
    const after = await client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "verifier",
    });
    if (after.toLowerCase() !== verifier.toLowerCase())
      throw new Error("the registry did not take the verifier");
    set = true;
  }
  const result = { verifier, attestor, registry, set, warpedSeconds, previous: current };
  if (!options.quiet) {
    console.log(`AttestationVerifier: ${verifier} (attestor ${attestor}, anvil account 2)`);
    console.log(
      set
        ? `TokenRegistry ${registry}: verifier set through the timelock (the fork's clock moved ${warpedSeconds} s)`
        : current === zeroAddress
          ? `TokenRegistry ${registry}: no verifier set`
          : `TokenRegistry ${registry}: verifier already ${current}`,
    );
  }
  return result;
}
