// @ts-check
// AccountFactory deployment (P2-U1): the local roles, caps and allowlist, and
// the call into chains/monad/script/DeployAccountFactory.s.sol. Local fork
// only: no unit has authorized a testnet or mainnet deployment of custody.
// The deployment is deterministic (CREATE2, fixed salt and arguments), so
// running it again finds the existing contract.
import { assertLocalFork } from "@alpha-agents/devenv";
import { addressEntry, UNISWAP_V4_MON_USDC_POOL } from "@alpha-agents/domain";
import {
  deployLocal as deployAgentNftLocal,
  localFeeArgs,
  LOCAL_DEPLOY_ATTEMPTS,
  LOCAL_ROLES,
  runForgeDeploy,
} from "./agent-nft.js";
import { ANVIL_URL } from "./config.js";

/**
 * Anvil's well-known development accounts (public test keys, never funded on
 * a real network). Local custody roles: the admin is AgentNFT's (account 0),
 * the guardian account 4, the sentinel key account 5.
 */
export const CUSTODY_ROLES = {
  admin: LOCAL_ROLES.admin,
  guardian: /** @type {`0x${string}`} */ ("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"),
  sentinel: /** @type {`0x${string}`} */ ("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"),
};

/**
 * The local beta allowlist: anvil accounts 6 to 9, the local test owners
 * (`pnpm custody:local` uses account 6). The admin can add another wallet at
 * once with `addDepositor` (Q-46, D-231); both caps still bound it.
 * @type {`0x${string}`[]}
 */
export const LOCAL_TEST_OWNERS = [
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8F",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
];

/** The beta caps (D-133, P2-U1): 100 USDC per account, 2,000 USDC across the platform. */
export const BETA_CAPS = { personalE6: 100_000_000n, platformE6: 2_000_000_000n };

/**
 * A verified mainnet address from the address book (the local fork shares them).
 * @param {import("@alpha-agents/domain").AddressBookId} id
 */
function verified(id) {
  const e = addressEntry("local", id);
  if (e.status !== "verified")
    throw new Error(`the address book has no verified ${id} for the local fork`);
  return e.address;
}

/**
 * Deploys the oracle adapter and AccountFactory, or finds them. A new factory
 * takes the adapter in its constructor (Q-47, D-235).
 * @param {{ quiet?: boolean }} [options] quiet prints only the summary
 * @returns {Promise<{ factory: `0x${string}`, implementation: `0x${string}`, oracle: `0x${string}` }>}
 */
export async function deployAccountFactoryLocal(options = {}) {
  await assertLocalFork(ANVIL_URL);
  const agentNft = await deployAgentNftLocal({ quiet: true });
  const usdc = addressEntry("local", "usdc");
  const wmon = addressEntry("local", "wmon");
  if (usdc.status !== "verified" || wmon.status !== "verified")
    throw new Error("the address book has no verified USDC or WMON for the local fork");
  const output = runForgeDeploy(
    "script/DeployAccountFactory.s.sol:DeployAccountFactory",
    [
      "--rpc-url",
      ANVIL_URL,
      "--unlocked",
      "--sender",
      CUSTODY_ROLES.admin,
      ...(await localFeeArgs()),
    ],
    {
      ACCOUNT_FACTORY_ADMIN: CUSTODY_ROLES.admin,
      ACCOUNT_FACTORY_GUARDIAN: CUSTODY_ROLES.guardian,
      ACCOUNT_FACTORY_SENTINEL: CUSTODY_ROLES.sentinel,
      ACCOUNT_FACTORY_AGENT_NFT: agentNft,
      ACCOUNT_FACTORY_USDC: usdc.address,
      ACCOUNT_FACTORY_WMON: wmon.address,
      ACCOUNT_FACTORY_PERSONAL_CAP: BETA_CAPS.personalE6.toString(),
      ACCOUNT_FACTORY_PLATFORM_CAP: BETA_CAPS.platformE6.toString(),
      ACCOUNT_FACTORY_ALLOWLIST: LOCAL_TEST_OWNERS.join(","),
      ORACLE_MON_USD_FEED: verified("chainlink_mon_usd"),
      ORACLE_USDC_USD_FEED: verified("chainlink_usdc_usd"),
      ORACLE_STATE_VIEW: verified("uniswap_v4_state_view"),
      ORACLE_POOL_ID: UNISWAP_V4_MON_USDC_POOL.id,
    },
    options.quiet,
    LOCAL_DEPLOY_ATTEMPTS,
  );
  const factory = /ACCOUNT_FACTORY_ADDRESS\s+(0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  const implementation = /PERSONAL_ACCOUNT_IMPLEMENTATION\s+(0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  const oracle = /ORACLE_ADAPTER_ADDRESS\s+(0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  if (!factory || !implementation || !oracle)
    throw new Error("forge script did not report the AccountFactory and oracle adapter addresses");
  const result = {
    factory: /** @type {`0x${string}`} */ (factory),
    implementation: /** @type {`0x${string}`} */ (implementation),
    oracle: /** @type {`0x${string}`} */ (oracle),
  };
  if (options.quiet) return result;
  console.log(`\nAccountFactory on the local fork: ${factory}`);
  console.log(`PersonalAccount implementation: ${implementation}`);
  console.log(`oracle adapter: ${oracle} (the factory's oracle from deployment, D-235)`);
  console.log(`admin ${CUSTODY_ROLES.admin} (anvil account 0)`);
  console.log(`guardian ${CUSTODY_ROLES.guardian} (anvil account 4)`);
  console.log(`sentinel key ${CUSTODY_ROLES.sentinel} (anvil account 5)`);
  console.log(
    "caps: 100 USDC per account, 2,000 USDC across the platform; allowlist: anvil accounts 6 to 9",
  );
  console.log("Try it: pnpm custody:local demo");
  return result;
}
