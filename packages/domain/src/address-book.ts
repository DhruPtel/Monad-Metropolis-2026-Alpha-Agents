import { type EnvironmentId, LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import type { Address } from "./ids.ts";

/**
 * The address book: every external contract and token the plan references, per
 * environment. Rules (P0-U5):
 * - Only addresses that appear in Planv2 or its research, or in a venue's or feed's
 *   official documentation with the page URL recorded as the source (P2-U0). None is
 *   recalled.
 * - Each entry records its source and a status. An entry is `verified` only if
 *   it had deployed code on the local fork of Monad mainnet at the pinned block
 *   (`pnpm test:fork` re-checks every verified entry). `local` and `beta` share
 *   the mainnet entries because local is a fork of chain 143.
 * - Anything not found or not checked stays `unverified`, with the related open
 *   question where one exists, and `signingAddress` refuses it.
 *
 * Verified means "the code is there", not "the contract is who we think": USDC
 * being Circle's official token is still Q-03, and FINAL_PLAN assumption A-18
 * requires re-verification before deployment.
 */
export const ADDRESS_BOOK_IDS = [
  "usdc",
  "wmon",
  "weth",
  "chainlink_mon_usd",
  "chainlink_usdc_usd",
  "chainlink_eth_usd",
  "erc6551_registry",
  "tokenbound_account_proxy",
  "tokenbound_account_v3_upgradable",
  "tokenbound_account_guardian",
  "tokenbound_safe",
  "multicall3_forwarder",
  "entrypoint_v0_6",
  "create2_deployer",
  "uniswap_v3_swap_router02",
  "uniswap_v3_factory",
  "uniswap_v3_quoter_v2",
  "uniswap_v3_pool_usdc_wmon_3000",
  "uniswap_v3_pool_usdc_weth_3000",
  "uniswap_v4_pool_manager",
  "uniswap_v4_state_view",
  "uniswap_v4_quoter",
  "uniswap_universal_router",
  "permit2",
  "kuru_router",
  "kuru_margin_account",
  "kuru_market_mon_usdc",
  "erc8004_identity_registry",
  "pyth_entropy",
  "agent_nft",
  "account_factory",
  "personal_account_implementation",
] as const;
export type AddressBookId = (typeof ADDRESS_BOOK_IDS)[number];

export type AddressKind =
  | "token"
  | "price_feed"
  | "account_standard"
  | "venue"
  | "pool"
  | "infrastructure"
  | "randomness"
  | "platform";

/** What the fork check observed. */
export interface ForkVerification {
  /**
   * The chain whose state the check observed. Mainnet contracts are checked as
   * Monad mainnet's state at the pinned block (143), which the local fork
   * copies and beta uses. Our own contracts exist only on the local fork, so
   * they record its own chain ID, 143143 (D-195).
   */
  readonly chainId: number;
  readonly block: number;
  readonly codeSize: number;
  /** `decimals()` as read on the fork, for tokens and feeds. */
  readonly decimals?: number;
  /**
   * Set for our own contracts: the command that deploys them to the fork.
   * They do not exist at the pinned block, so the fork check runs that
   * command (it is deterministic and idempotent) and checks the latest block.
   */
  readonly deployedBy?: string;
}

interface EntryCommon {
  readonly id: AddressBookId;
  readonly label: string;
  readonly kind: AddressKind;
  /** Document and section the address was taken from. */
  readonly source: string;
  /** The open question that keeps this entry uncertain, if any. */
  readonly openQuestion: string | null;
  readonly note: string;
}

export interface VerifiedEntry extends EntryCommon {
  readonly status: "verified";
  readonly address: Address;
  readonly verification: ForkVerification;
}

export interface UnverifiedEntry extends EntryCommon {
  readonly status: "unverified";
  readonly address: Address | null;
  readonly verification: null;
}

export type AddressEntry = VerifiedEntry | UnverifiedEntry;

const FORK_BLOCK = 109670000;
const fork = (codeSize: number, decimals?: number): ForkVerification =>
  decimals === undefined
    ? { chainId: 143, block: FORK_BLOCK, codeSize }
    : { chainId: 143, block: FORK_BLOCK, codeSize, decimals };

const FINAL_BOOK = "Planv2/FINAL_PLAN.md > 4. Components > Address book";
const TOKENBOUND = "Planv2/notes/tokenbound.md > 2.6 Deployment and trust";
const MORPHO = "Planv2/notes/morpho-vault.md > 2.5 Monad facts the research verified onchain";
const ZODIAC = "Planv2/notes/zodiac-roles.md > 2. Facts the final plan must carry";
const UNI_V3_DOCS =
  "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments";
const UNI_V4_DOCS = "https://developers.uniswap.org/docs/protocols/v4/deployments";
const KURU_DOCS = "https://docs.kuru.io/contracts/Contract-addresses";
const PYTH_ENTROPY_REGISTRY =
  "https://github.com/pyth-network/pyth-crosschain contract_manager/src/store/contracts/EvmEntropyContracts.json";

/** Monad mainnet, chain 143: used by `beta`, and by `local` through the fork. */
const MAINNET: readonly AddressEntry[] = [
  {
    id: "usdc",
    label: "USDC",
    kind: "token",
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    status: "verified",
    verification: fork(1798, 6),
    source: FINAL_BOOK,
    openQuestion: "Q-03",
    note: "FiatToken proxy; Circle lists this address as Monad USDC (P2-U0)",
  },
  {
    id: "wmon",
    label: "WMON",
    kind: "token",
    address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    status: "verified",
    verification: fork(3249, 18),
    source: FINAL_BOOK,
    openQuestion: null,
    note: "Returned by SwapRouter02 WETH9()",
  },
  {
    id: "weth",
    label: "WETH",
    kind: "token",
    address: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
    status: "verified",
    verification: fork(177, 18),
    source: MORPHO,
    openQuestion: null,
    note: "177-byte proxy; not a launch asset",
  },
  {
    id: "chainlink_mon_usd",
    label: "Chainlink MON/USD",
    kind: "price_feed",
    address: "0xBcD78f76005B7515837af6b50c7C52BCf73822fb",
    status: "verified",
    verification: fork(9571, 8),
    source: FINAL_BOOK,
    openQuestion: "Q-02",
    note: "8 decimals; 1 h heartbeat, 0.02% deviation, updates about every 30 s (P2-U0)",
  },
  {
    id: "chainlink_usdc_usd",
    label: "Chainlink USDC/USD",
    kind: "price_feed",
    address: "0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec",
    status: "verified",
    verification: fork(9571, 8),
    source: FINAL_BOOK,
    openQuestion: "Q-02",
    note: "Depeg guard only; updates on its 1 h heartbeat (P2-U0)",
  },
  {
    id: "chainlink_eth_usd",
    label: "Chainlink ETH/USD",
    kind: "price_feed",
    address: "0x1B1414782B859871781bA3E4B0979b9ca57A0A04",
    status: "verified",
    verification: fork(9571, 8),
    source: MORPHO,
    openQuestion: null,
    note: "8 decimals; not a launch feed",
  },
  {
    id: "erc6551_registry",
    label: "ERC-6551 registry",
    kind: "account_standard",
    address: "0x000000006551c19487814612e58FE06813775758",
    status: "verified",
    verification: fork(571),
    source: FINAL_BOOK,
    openQuestion: null,
    note: "Canonical",
  },
  {
    id: "tokenbound_account_proxy",
    label: "Tokenbound AccountProxy",
    kind: "account_standard",
    address: "0x55266d75D1a14E4572138116aF39863Ed6596E7F",
    status: "verified",
    verification: fork(902),
    source: FINAL_BOOK,
    openQuestion: null,
    note: "The implementation argument for createAccount",
  },
  {
    id: "tokenbound_account_v3_upgradable",
    label: "Tokenbound AccountV3Upgradable",
    kind: "account_standard",
    address: "0x41C8f39463A868d3A88af00cd0fe7102F30E44eC",
    status: "verified",
    verification: fork(14924),
    source: FINAL_BOOK,
    openQuestion: "Q-15",
    note: "Expected implementation in every agent TBA",
  },
  {
    id: "tokenbound_account_guardian",
    label: "Tokenbound AccountGuardian",
    kind: "account_standard",
    address: "0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57",
    status: "verified",
    verification: fork(1211),
    source: FINAL_BOOK,
    openQuestion: "Q-14",
    note: "Owned by the Tokenbound Safe, nonce 0",
  },
  {
    id: "tokenbound_safe",
    label: "Tokenbound Safe (guardian owner)",
    kind: "account_standard",
    address: "0x781b6A527482828bB04F33563797d4b696ddF328",
    status: "verified",
    verification: fork(171),
    source: FINAL_BOOK,
    openQuestion: "Q-14",
    note: "3-of-4 Safe v1.3.0; owns the AccountGuardian",
  },
  {
    id: "multicall3_forwarder",
    label: "Multicall3 forwarder (Tokenbound trust root)",
    kind: "infrastructure",
    address: "0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD",
    status: "verified",
    verification: fork(4126),
    source: TOKENBOUND,
    openQuestion: null,
    note: "Immutable in the TBA implementation",
  },
  {
    id: "entrypoint_v0_6",
    label: "ERC-4337 EntryPoint v0.6",
    kind: "infrastructure",
    address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    status: "verified",
    verification: fork(23689),
    source: TOKENBOUND,
    openQuestion: null,
    note: "The only EntryPoint the TBA trusts",
  },
  {
    id: "create2_deployer",
    label: "CREATE2 deployer",
    kind: "infrastructure",
    address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
    status: "verified",
    verification: fork(69),
    source: TOKENBOUND,
    openQuestion: null,
    note: "Deterministic deployment factory used by Tokenbound",
  },
  {
    id: "uniswap_v3_swap_router02",
    label: "Uniswap v3 SwapRouter02",
    kind: "venue",
    address: "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900",
    status: "verified",
    verification: fork(24497),
    source: FINAL_BOOK,
    openQuestion: "Q-01",
    note: "Candidate venue",
  },
  {
    id: "uniswap_v3_factory",
    label: "Uniswap v3 factory",
    kind: "venue",
    address: "0x204faca1764b154221e35c0d20abb3c525710498",
    status: "verified",
    verification: fork(24535),
    source: FINAL_BOOK,
    openQuestion: "Q-01",
    note: "Candidate venue",
  },
  {
    id: "uniswap_v3_quoter_v2",
    label: "Uniswap v3 QuoterV2",
    kind: "venue",
    address: "0x661e93cca42afacb172121ef892830ca3b70f08d",
    status: "verified",
    verification: fork(8273),
    source: UNI_V3_DOCS,
    openQuestion: "Q-01",
    note: "Read-only quotes; used by the P2-U0 depth spike",
  },
  {
    id: "uniswap_v3_pool_usdc_wmon_3000",
    label: "Uniswap v3 USDC/WMON 0.3% pool",
    kind: "pool",
    address: "0x659bd0bc4167ba25c62e05656f78043e7ed4a9da",
    status: "verified",
    verification: fork(22142),
    source: FINAL_BOOK,
    openQuestion: "Q-01",
    note: "Held about 608,500 USDC on 2026-09-25",
  },
  {
    id: "uniswap_v3_pool_usdc_weth_3000",
    label: "Uniswap v3 USDC/WETH 0.3% pool",
    kind: "pool",
    address: "0x25ef1a210ff55bcee9f8fee979aaff6bd1be5bf1",
    status: "verified",
    verification: fork(22142),
    source: MORPHO,
    openQuestion: null,
    note: "Held about 5,700 USDC on 2026-09-25; not a launch pool",
  },
  {
    id: "uniswap_v4_pool_manager",
    label: "Uniswap v4 PoolManager",
    kind: "venue",
    address: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
    status: "verified",
    verification: fork(24009),
    source: FINAL_BOOK,
    openQuestion: "Q-01",
    note: "Candidate venue; pools unmeasured; hookless only if chosen (Q-35)",
  },
  {
    id: "uniswap_v4_state_view",
    label: "Uniswap v4 StateView",
    kind: "venue",
    address: "0x77395f3b2e73ae90843717371294fa97cc419d64",
    status: "verified",
    verification: fork(3531),
    source: FINAL_BOOK,
    openQuestion: "Q-01",
    note: "Read-only view for v4 pool state",
  },
  {
    id: "uniswap_v4_quoter",
    label: "Uniswap v4 Quoter",
    kind: "venue",
    address: "0xa222dd357a9076d1091ed6aa2e16c9742dd26891",
    status: "verified",
    verification: fork(6118),
    source: UNI_V4_DOCS,
    openQuestion: "Q-01",
    note: "Read-only quotes by pool key; used by the P2-U0 depth spike",
  },
  {
    id: "uniswap_universal_router",
    label: "Uniswap UniversalRouter",
    kind: "venue",
    address: "0x0d97dc33264bfc1c226207428a79b26757fb9dc3",
    status: "verified",
    verification: fork(19499),
    source: ZODIAC,
    openQuestion: "Q-01",
    note: "Routes through Permit2, which no account we control approves; not a planned route",
  },
  {
    id: "permit2",
    label: "Permit2",
    kind: "infrastructure",
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    status: "verified",
    verification: fork(9152),
    source: FINAL_BOOK,
    openQuestion: null,
    note: "Never approved by any account we control",
  },
  {
    id: "kuru_router",
    label: "Kuru Router (market factory)",
    kind: "venue",
    address: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC",
    status: "verified",
    verification: fork(141),
    source: KURU_DOCS,
    openQuestion: "Q-01",
    note: "Upgradeable proxy (implementation in evidence/p2-u0); takes direct ERC-20 approvals",
  },
  {
    id: "kuru_margin_account",
    label: "Kuru MarginAccount",
    kind: "venue",
    address: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
    status: "verified",
    verification: fork(141),
    source: KURU_DOCS,
    openQuestion: "Q-01",
    note: "Upgradeable proxy (implementation in evidence/p2-u0)",
  },
  {
    id: "kuru_market_mon_usdc",
    label: "Kuru MON-USDC market",
    kind: "pool",
    address: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
    status: "verified",
    verification: fork(141),
    source: KURU_DOCS,
    openQuestion: "Q-01",
    note: "Orderbook with an AMM vault; native MON base, USDC quote; upgradeable proxy",
  },
  {
    id: "erc8004_identity_registry",
    label: "ERC-8004 identity registry",
    kind: "account_standard",
    address: null,
    status: "unverified",
    verification: null,
    source: "Planv2/FINAL_PLAN.md > 4.1.12 IdentityBinder",
    openQuestion: "Q-13",
    note: "Address and ABI on Monad unknown",
  },
  {
    id: "pyth_entropy",
    label: "Pyth Entropy v2",
    kind: "randomness",
    address: "0xD458261E832415CFd3BAE5E416FdF3230ce6F134",
    status: "verified",
    verification: fork(177),
    source: PYTH_ENTROPY_REGISTRY,
    openQuestion: null,
    note: "AgentNFT reveal randomness (D-187); default provider 0x52De...6506, fee 1.4 MON",
  },
];

const NOT_IN_RESEARCH = "No testnet address appears in Planv2 or its research; P1-U3 supplies it";

/**
 * Monad testnet, chain 10143. The research found the canonical Tokenbound
 * contracts on testnet too, but this unit makes no testnet calls, so every
 * testnet entry is unverified until P1-U3 checks it.
 */
const TESTNET: readonly AddressEntry[] = MAINNET.map((m): AddressEntry => {
  const sameOnTestnet: readonly AddressBookId[] = [
    "erc6551_registry",
    "tokenbound_account_proxy",
    "tokenbound_account_v3_upgradable",
    "tokenbound_account_guardian",
    "multicall3_forwarder",
    "entrypoint_v0_6",
    "create2_deployer",
  ];
  if (sameOnTestnet.includes(m.id)) {
    return {
      ...m,
      status: "unverified",
      verification: null,
      source: TOKENBOUND,
      note: "The research found code at this address on testnet; not yet checked by this project",
    };
  }
  if (m.id === "tokenbound_safe") {
    return {
      ...m,
      address: null,
      status: "unverified",
      verification: null,
      source: TOKENBOUND,
      note: "The research found no code at the Safe address on testnet; the testnet guardian is frozen at defaults",
    };
  }
  if (m.id === "pyth_entropy") {
    return {
      ...m,
      address: "0x825c0390f379C631f3Cf11A82a37D20BddF93c07",
      status: "unverified",
      verification: null,
      note: "Pyth's registry entry monad_testnet; code and the testnet default provider seen by a read-only call in P1-U3, not fork-checked",
    };
  }
  return { ...m, address: null, status: "unverified", verification: null, note: NOT_IN_RESEARCH };
});

/**
 * Our own contracts, per environment. A local deployment is verified only for
 * `local`, never for `beta`, so a fork address can never be signed for on
 * mainnet.
 */
const AGENT_NFT_SOURCE = "Planv2/FINAL_PLAN.md > 4.1.1 AgentNFT";
const AGENT_NFT_LOCAL: AddressEntry = {
  id: "agent_nft",
  label: "AgentNFT",
  kind: "platform",
  address: "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E",
  status: "verified",
  verification: {
    chainId: LOCAL_FORK_CHAIN_ID,
    block: FORK_BLOCK,
    codeSize: 34459,
    deployedBy: "pnpm deploy:agent-nft",
  },
  source: AGENT_NFT_SOURCE,
  openQuestion: null,
  note: "Deterministic CREATE2 deployment with anvil roles (P1-U3); local fork only",
};
const agentNftUndeployed = (note: string): AddressEntry => ({
  id: "agent_nft",
  label: "AgentNFT",
  kind: "platform",
  address: null,
  status: "unverified",
  verification: null,
  source: AGENT_NFT_SOURCE,
  openQuestion: null,
  note,
});

/**
 * P2-U1: the custody contracts. AccountFactory deploys the PersonalAccount
 * implementation in its constructor, so both addresses follow from the
 * factory's deterministic CREATE2 deployment with the local roles, caps and
 * allowlist (scripts/lib/account-factory.js).
 */
const CUSTODY_SOURCE = "Planv2/FINAL_PLAN.md > 4.1.6 Custody core and 4.1.13 AccountFactory";
const custodyLocal = (
  id: "account_factory" | "personal_account_implementation",
  label: string,
  address: Address,
  codeSize: number,
  note: string,
): AddressEntry => ({
  id,
  label,
  kind: "platform",
  address,
  status: "verified",
  verification: {
    chainId: LOCAL_FORK_CHAIN_ID,
    block: FORK_BLOCK,
    codeSize,
    deployedBy: "pnpm deploy:account-factory",
  },
  source: CUSTODY_SOURCE,
  openQuestion: null,
  note,
});
const CUSTODY_LOCAL: readonly AddressEntry[] = [
  custodyLocal(
    "account_factory",
    "AccountFactory",
    "0x8AE572168220B86116478f817609d3d97c467074" as Address,
    12304,
    "Deterministic CREATE2 deployment with anvil roles, 100/2,000 USDC caps (P2-U1); local fork only",
  ),
  custodyLocal(
    "personal_account_implementation",
    "PersonalAccount implementation",
    "0x60d9a16B44C8287eC197FfC90f75fe4F9aA6C6D1" as Address,
    18692,
    "Deployed by AccountFactory's constructor; every PersonalAccount is a clone of it",
  ),
];
const custodyUndeployed = (note: string): AddressEntry[] =>
  (
    [
      ["account_factory", "AccountFactory"],
      ["personal_account_implementation", "PersonalAccount implementation"],
    ] as const
  ).map(([id, label]) => ({
    id,
    label,
    kind: "platform",
    address: null,
    status: "unverified",
    verification: null,
    source: CUSTODY_SOURCE,
    openQuestion: null,
    note,
  }));

export const ADDRESS_BOOK: Readonly<Record<EnvironmentId, readonly AddressEntry[]>> = {
  local: [...MAINNET, AGENT_NFT_LOCAL, ...CUSTODY_LOCAL],
  testnet: [
    ...TESTNET,
    agentNftUndeployed(
      "Not deployed: needs MONAD_TESTNET_RPC_URL and a funded TESTNET_DEPLOYER_PRIVATE_KEY",
    ),
    ...custodyUndeployed("Not deployed: custody stays on the local fork until a unit deploys it"),
  ],
  beta: [
    ...MAINNET,
    agentNftUndeployed("Mainnet deployment belongs to PB-U1"),
    ...custodyUndeployed("Mainnet deployment belongs to PB-U1"),
  ],
};

export function addressEntry(environment: EnvironmentId, id: AddressBookId): AddressEntry {
  const entry = ADDRESS_BOOK[environment].find((e) => e.id === id);
  if (!entry) throw new Error(`address book has no ${id} for ${environment}`);
  return entry;
}

declare const verifiedBrand: unique symbol;
/** An address that passed the fork check. Only `signingAddress` creates one. */
export type VerifiedAddress = Address & { readonly [verifiedBrand]: true };

export class UnverifiedAddressError extends Error {
  readonly id: AddressBookId;
  readonly environment: EnvironmentId;
  readonly openQuestion: string | null;

  constructor(entry: UnverifiedEntry, environment: EnvironmentId) {
    super(
      `${entry.id} is unverified in ${environment} and cannot be used for signing` +
        (entry.openQuestion ? ` (open question ${entry.openQuestion})` : "") +
        (entry.address === null ? "; it has no known address" : ""),
    );
    this.name = "UnverifiedAddressError";
    this.id = entry.id;
    this.environment = environment;
    this.openQuestion = entry.openQuestion;
  }
}

/**
 * The only way to get an address for anything that will be signed. Throws
 * UnverifiedAddressError for an unverified entry; signing types (for example
 * ExecutorSwapIntent) accept only the VerifiedAddress this returns.
 */
export function signingAddress(environment: EnvironmentId, id: AddressBookId): VerifiedAddress {
  const entry = addressEntry(environment, id);
  if (entry.status !== "verified") throw new UnverifiedAddressError(entry, environment);
  return entry.address as VerifiedAddress;
}
