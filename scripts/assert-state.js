// @ts-check
// MV-S15: asserts the local fork's deployed v3 set against the intended
// configuration (P7-U4): every role, delay, oracle, route, fee, cap and
// allowlist flag of AccountFactoryV3, both implementations, Executor v3, the
// RouteAdapter, ProtocolRegistryV3, OracleAdapterV3 and the TokenRegistry.
// Exits 1 on any mismatch, naming each. Read-only; prints no key and no URL.
//
//   pnpm assert:state          the fork LOCAL_FORK_PORT names (8545 by default)
import { NotLocalForkError, assertLocalFork } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { ANVIL_URL, loadRootEnv } from "./lib/config.js";
import { assertState } from "./lib/state-assert.js";

loadRootEnv();

/** @param {import("@alpha-agents/domain").AddressBookId} id */
function verified(id) {
  const e = addressEntry("local", id);
  if (e.status !== "verified")
    throw new Error(`the address book has no verified ${id} for the local fork`);
  return e.address;
}

try {
  await assertLocalFork(ANVIL_URL);
  const addresses = {
    factory: verified("account_factory_v3"),
    executor: verified("executor_v3"),
    routeAdapter: verified("executor_route_adapter_v3"),
    protocolRegistry: verified("protocol_registry_v3"),
    oracle: verified("oracle_adapter_v3"),
    tokenRegistry: verified("token_registry_v3"),
    agentNft: verified("agent_nft"),
    usdc: verified("usdc"),
  };
  const result = await assertState(ANVIL_URL, addresses);
  for (const m of result.mismatches) {
    console.log(`FAIL  ${m.path}: expected ${m.expected}, found ${m.actual}`);
  }
  console.log(
    result.ok
      ? `PASS  MV-S15: ${result.checked} values of the v3 set match the intended configuration`
      : `FAIL  MV-S15: ${result.mismatches.length} of ${result.checked} values differ from the intended configuration`,
  );
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
