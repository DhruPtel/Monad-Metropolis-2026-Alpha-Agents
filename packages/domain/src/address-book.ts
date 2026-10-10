import {
  type EnvironmentId,
  LOCAL_FORK_CHAIN_ID,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
} from "@alpha-agents/config";
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
  "uniswap_v3_position_manager",
  "pancakeswap_v3_factory",
  "pancakeswap_v3_swap_router",
  "pancakeswap_v3_quoter_v2",
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
  "oracle_adapter",
  "executor",
  "protocol_registry",
  "venue_uniswap_v4_mon_usdc",
  "venue_uniswap_v3_usdc_wmon",
  "token_registry_v3",
  "protocol_registry_v3",
  "oracle_adapter_v3",
  "route_adapter_v3",
  "account_factory_v3",
  "personal_account_v3_implementation",
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
  /**
   * Set for an observation on a real chain (P2-EC, D-254): the entry was read
   * on that chain itself, not through the fork. Our own contracts also record
   * their deployment transaction and Sourcify match.
   */
  readonly chain?: ChainObservation;
}

/** What a real chain served for an entry (D-254). */
export interface ChainObservation {
  readonly codeHash: `0x${string}`;
  readonly explorer: string;
  readonly transaction?: `0x${string}`;
  readonly sourcify?: string;
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
const MONAD_PROTOCOLS =
  "https://github.com/monad-crypto/protocols mainnet/uniswap.jsonc and mainnet/pancakeswap.jsonc";
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
    id: "uniswap_v3_position_manager",
    label: "Uniswap v3 NonfungiblePositionManager",
    kind: "venue",
    address: "0x7197e214c0b767cfb76fb734ab638e2c192f4e53",
    status: "verified",
    verification: fork(24384),
    source: MONAD_PROTOCOLS,
    openQuestion: null,
    note: "Its factory() is the v3 factory above and WETH9() is WMON (F-U1); seeds test pools on throwaway forks only",
  },
  {
    id: "pancakeswap_v3_factory",
    label: "PancakeSwap v3 factory",
    kind: "venue",
    address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    status: "verified",
    verification: fork(3859),
    source: MONAD_PROTOCOLS,
    openQuestion: null,
    note: "Token discovery venue (F-U1); the router and quoter below name it as their factory",
  },
  {
    id: "pancakeswap_v3_swap_router",
    label: "PancakeSwap v3 SwapRouter",
    kind: "venue",
    address: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    status: "verified",
    verification: fork(12154),
    source: MONAD_PROTOCOLS,
    openQuestion: null,
    note: "factory() is the PancakeSwap v3 factory and WETH9() is WMON (F-U1); the token screen's route on forks",
  },
  {
    id: "pancakeswap_v3_quoter_v2",
    label: "PancakeSwap v3 QuoterV2",
    kind: "venue",
    address: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    status: "verified",
    verification: fork(8331),
    source: MONAD_PROTOCOLS,
    openQuestion: null,
    note: "Read-only quotes; factory() is the PancakeSwap v3 factory (F-U1)",
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

const NOT_ON_TESTNET = "Not found on Monad testnet when P2-EC checked it (D-248)";
const P2EC_TESTNET = "evidence/p2-ec/REAL_CHAIN.md; Planv2/DECISIONS_AND_OPEN_QUESTIONS.md D-248";
const UNI_V4_TESTNET =
  "https://github.com/monad-crypto/protocols testnet/uniswap_v4.jsonc (not an official Uniswap deployment)";

/**
 * What P2-EC read on Monad testnet (chain 10143) for each external entry
 * (D-248 re-checked, D-254). Testnet was reset on 2025-12-16, so only these
 * observations count there.
 */
const TESTNET_OBSERVED: Partial<
  Record<AddressBookId, { readonly address: Address; readonly verification: ForkVerification }>
> = {
  usdc: {
    address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 1798,
      decimals: 6,
      chain: {
        codeHash: "0x96215e6049ed615cdc22fea7701e85458a8e51a2df3e7d45e8f9fa1d521b5a78",
        explorer:
          "https://testnet.monadvision.com/address/0x534b2f3A21130d7a60830c2Df862319e593943A3",
      },
    },
  },
  wmon: {
    address: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 3249,
      decimals: 18,
      chain: {
        codeHash: "0xa32df4f1226f1bb0d6ce9b917752ed687857899a35ebf902c9992edb73b138b6",
        explorer:
          "https://testnet.monadvision.com/address/0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
      },
    },
  },
  erc6551_registry: {
    address: "0x000000006551c19487814612e58FE06813775758",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 571,
      chain: {
        codeHash: "0xda1d5b06e579f9e42e59b00fbc22939896ecb38dc8830d40de0a2508fecd6735",
        explorer:
          "https://testnet.monadvision.com/address/0x000000006551c19487814612e58FE06813775758",
      },
    },
  },
  tokenbound_account_proxy: {
    address: "0x55266d75D1a14E4572138116aF39863Ed6596E7F",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 902,
      chain: {
        codeHash: "0x7f2b4bea519ba5fe0e8e3cf054654f18480c4416fc71370b31f37848688afdb0",
        explorer:
          "https://testnet.monadvision.com/address/0x55266d75D1a14E4572138116aF39863Ed6596E7F",
      },
    },
  },
  tokenbound_account_v3_upgradable: {
    address: "0x41C8f39463A868d3A88af00cd0fe7102F30E44eC",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 14924,
      chain: {
        codeHash: "0xdf5eeb80b53e48dfd667fff5264976de4004fdd27eef4f6b954d182109f0f85b",
        explorer:
          "https://testnet.monadvision.com/address/0x41C8f39463A868d3A88af00cd0fe7102F30E44eC",
      },
    },
  },
  tokenbound_account_guardian: {
    address: "0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 1211,
      chain: {
        codeHash: "0x852cc93231fd7a7d35a225fb5f357e69db966935de05627095f906f7d88093f2",
        explorer:
          "https://testnet.monadvision.com/address/0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57",
      },
    },
  },
  multicall3_forwarder: {
    address: "0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 4126,
      chain: {
        codeHash: "0xb074cd81f36845a40a1136f7d599dadb52c3e7486eab525722d38e6696c8895c",
        explorer:
          "https://testnet.monadvision.com/address/0xcA1167915584462449EE5b4Ea51c37fE81eCDCCD",
      },
    },
  },
  entrypoint_v0_6: {
    address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 23689,
      chain: {
        codeHash: "0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70",
        explorer:
          "https://testnet.monadvision.com/address/0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
      },
    },
  },
  create2_deployer: {
    address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 69,
      chain: {
        codeHash: "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989",
        explorer:
          "https://testnet.monadvision.com/address/0x4e59b44847b379578588920cA78FbF26c0B4956C",
      },
    },
  },
  permit2: {
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 9152,
      chain: {
        codeHash: "0xe8ca368abb6fa7f5d31b388b14e16d3654281140695486df9a22d7d9b75df310",
        explorer:
          "https://testnet.monadvision.com/address/0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
    },
  },
  pyth_entropy: {
    address: "0x825c0390f379C631f3Cf11A82a37D20BddF93c07",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 177,
      chain: {
        codeHash: "0x7e693eea60500e1d5c5984a4cc54ec0b371d9ad29e8bb09c543cb7be447963df",
        explorer:
          "https://testnet.monadvision.com/address/0x825c0390f379C631f3Cf11A82a37D20BddF93c07",
      },
    },
  },
  uniswap_v4_pool_manager: {
    address: "0x451D64ab3b650040d2aE1886602b97ed6eDc643d",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 34582,
      chain: {
        codeHash: "0x61199025286997b715457c68f86dbc42c847753f01e0773668394a405d53d579",
        explorer:
          "https://testnet.monadvision.com/address/0x451D64ab3b650040d2aE1886602b97ed6eDc643d",
      },
    },
  },
  uniswap_v4_state_view: {
    address: "0xB639209539c61BaF67AC04876315786F8D0b153c",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 3531,
      chain: {
        codeHash: "0xeedadde80f69c3b89437996025759b839a65e12db6c8379a7327a34aa269fa5e",
        explorer:
          "https://testnet.monadvision.com/address/0xB639209539c61BaF67AC04876315786F8D0b153c",
      },
    },
  },
  uniswap_v4_quoter: {
    address: "0x869834d127b230283fe63E0d0A9bEB67216a94C7",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69283030,
      codeSize: 6118,
      chain: {
        codeHash: "0xdc1a524cd6108e0d1d90c5de1b594b2f953feaf9dc6c2387ecd1b4232ea0e521",
        explorer:
          "https://testnet.monadvision.com/address/0x869834d127b230283fe63E0d0A9bEB67216a94C7",
      },
    },
  },
};

/** Testnet notes that differ from mainnet's. */
const TESTNET_NOTES: Partial<Record<AddressBookId, string>> = {
  usdc: "Circle's testnet USDC (D-248)",
  wmon: "Testnet WMON; not the mainnet address",
  pyth_entropy: "Pyth Entropy v2 on testnet; default provider 0x6CC1...6344, fee 0.128 MON",
  uniswap_v4_pool_manager:
    "Unofficial testnet v4 PoolManager; P2-EC's pool is the only MON/USDC pool on it (D-257)",
  uniswap_v4_state_view: "StateView of the unofficial testnet v4 deployment",
  uniswap_v4_quoter: "V4Quoter of the unofficial testnet v4 deployment",
};

/**
 * Monad testnet, chain 10143: verified only where P2-EC observed code on
 * testnet itself. Entries with no testnet counterpart stay unverified.
 */
const TESTNET: readonly AddressEntry[] = MAINNET.map((m): AddressEntry => {
  const seen = TESTNET_OBSERVED[m.id];
  if (seen) {
    return {
      ...m,
      address: seen.address,
      status: "verified",
      verification: seen.verification,
      source: m.id.startsWith("uniswap_v4") ? UNI_V4_TESTNET : P2EC_TESTNET,
      note: TESTNET_NOTES[m.id] ?? m.note,
    };
  }
  return { ...m, address: null, status: "unverified", verification: null, note: NOT_ON_TESTNET };
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
const CUSTODY_SOURCE =
  "Planv2/FINAL_PLAN.md > 4.1.6 Custody core, 4.1.7 Executor, 4.1.8 ProtocolRegistry, 4.1.9 Oracle adapter and 4.1.13 AccountFactory";
const custodyLocal = (
  id:
    | "account_factory"
    | "personal_account_implementation"
    | "oracle_adapter"
    | "executor"
    | "protocol_registry"
    | "venue_uniswap_v4_mon_usdc"
    | "venue_uniswap_v3_usdc_wmon",
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
    "0xC898A55c814a629653f6CD7aC007edd6b63ac0De" as Address,
    12557,
    "Deterministic CREATE2 deployment with anvil roles, 100/2,000 USDC caps (P2-U1), salt v2 since the USDC/USD age moved to 7,200 s (D-317); local fork only",
  ),
  custodyLocal(
    "personal_account_implementation",
    "PersonalAccount implementation",
    "0x9eF149aBb30600d4ab196adE079726A25F8657f6" as Address,
    23514,
    "Deployed by AccountFactory's constructor; every PersonalAccount is a clone of it",
  ),
  custodyLocal(
    "oracle_adapter",
    "Oracle adapter",
    "0xa9D5E28dfeca6eAA252092ED8f3F9a36cEB30f34" as Address,
    7076,
    "Deterministic CREATE2 deployment over the real feeds and v4 pool (P2-U3), USDC/USD stale at 7,200 s (D-317); the factory's oracle from its constructor (D-235)",
  ),
  custodyLocal(
    "executor",
    "Executor",
    "0x570575BC185d1B0aE93F641479fdEdDf76b91fdB" as Address,
    28590,
    "Deterministic CREATE2 deployment with the launch policy (P2-U2); bound to the factory and registry",
  ),
  custodyLocal(
    "protocol_registry",
    "ProtocolRegistry",
    "0xfce7851e01bD4380b246CB9B79EB36402cB5CC68" as Address,
    9211,
    "Lists the v4 adapter as active and the v3 fallback as paused (P2-U2)",
  ),
  custodyLocal(
    "venue_uniswap_v4_mon_usdc",
    "Uniswap v4 MON/USDC 0.05% adapter",
    "0x8fAfb9fF3b735A116F8D72EC2BDa45cB6a157ff1" as Address,
    7589,
    "The launch venue (D-166): unwraps, swaps native MON and rewraps (D-167)",
  ),
  custodyLocal(
    "venue_uniswap_v3_usdc_wmon",
    "Uniswap v3 USDC/WMON 0.3% adapter",
    "0x251A00a8DBA2e49524254ba5b9F624E6c2d50a7C" as Address,
    3394,
    "The fallback venue (D-166), registered paused; activating it waits the timelock",
  ),
];
const custodyUndeployed = (note: string): AddressEntry[] =>
  (
    [
      ["account_factory", "AccountFactory"],
      ["personal_account_implementation", "PersonalAccount implementation"],
      ["oracle_adapter", "Oracle adapter"],
      ["executor", "Executor"],
      ["protocol_registry", "ProtocolRegistry"],
      ["venue_uniswap_v4_mon_usdc", "Uniswap v4 MON/USDC 0.05% adapter"],
      ["venue_uniswap_v3_usdc_wmon", "Uniswap v3 USDC/WMON 0.3% adapter"],
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

/**
 * P2-EC part 1's throwaway testnet deployment (D-247, D-249), as observed on
 * testnet after `pnpm deploy:testnet` and verified on Sourcify (D-256). The
 * deployment block is where the indexer starts and the wallet guard's fixed
 * block (D-254); every transaction is in evidence/p2-ec/deployment.json.
 */
const P2EC_SOURCE = "evidence/p2-ec/ADDRESSES.md (P2-EC part 1, testnet, throwaway)";
const TESTNET_DEPLOYED: readonly AddressEntry[] = [
  {
    id: "chainlink_mon_usd",
    label: "TestnetFeed MON/USD",
    kind: "price_feed",
    address: "0x4F257aD5E3AE49E0934813c23F5940448d20965E",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281610,
      codeSize: 2125,
      decimals: 8,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0xa7086b366328ed7733de1d09036297a99892b0dcc452c68bb98e059de256bde1",
        explorer:
          "https://testnet.monadvision.com/address/0x4F257aD5E3AE49E0934813c23F5940448d20965E",
        transaction: "0xf73c11c9166637269475dea9ee810d58a305ac802b21a4406e8ad102cd0b2da5",
        sourcify: "https://repo.sourcify.dev/10143/0x4F257aD5E3AE49E0934813c23F5940448d20965E",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "Operator price 1.00 USD (D-253, D-304), refreshed on demand (D-307); written only by TESTNET_FEED_PRIVATE_KEY",
  },
  {
    id: "chainlink_usdc_usd",
    label: "TestnetFeed USDC/USD",
    kind: "price_feed",
    address: "0x94f797988a94c86dF85bC457027eDF7b4673fD9D",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281612,
      codeSize: 2125,
      decimals: 8,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0xa7086b366328ed7733de1d09036297a99892b0dcc452c68bb98e059de256bde1",
        explorer:
          "https://testnet.monadvision.com/address/0x94f797988a94c86dF85bC457027eDF7b4673fD9D",
        transaction: "0xff249dc0d85f701e130c1f6237a3b55f9525ae04f9ffc71638eb6ace52aae5a1",
        sourcify: "https://repo.sourcify.dev/10143/0x94f797988a94c86dF85bC457027eDF7b4673fD9D",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "Operator price 1.00 USD for the depeg guard (D-253), refreshed on demand (D-307)",
  },
  {
    id: "agent_nft",
    label: "AgentNFT",
    kind: "platform",
    address: "0x0c2472Ed555836F22FB3eAB7aBC2Cc3AebeaC9ea",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281679,
      codeSize: 34459,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0xb357594863407c9f8a9aa570a79b09300a006a54f3ec6072fcd389026ceac143",
        explorer:
          "https://testnet.monadvision.com/address/0x0c2472Ed555836F22FB3eAB7aBC2Cc3AebeaC9ea",
        transaction: "0x994f5ffd5626083b2d74cc440d113449b6ca71cef7c29fc8a8db3aa958dc0333",
        sourcify: "https://repo.sourcify.dev/10143/0x0c2472Ed555836F22FB3eAB7aBC2Cc3AebeaC9ea",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "P2-EC testnet, throwaway (D-249): p2ec.testnet salt, pending image base, never frozen, claim required",
  },
  {
    id: "account_factory",
    label: "AccountFactory",
    kind: "platform",
    address: "0x960c0421c5FEac805187F25D7abc04D971D334B6",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281745,
      codeSize: 12557,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0x8257abfa5c62307450f68b5366bd68ddfe6933eb88e5d6ac4ff0cd1e8d22dd60",
        explorer:
          "https://testnet.monadvision.com/address/0x960c0421c5FEac805187F25D7abc04D971D334B6",
        transaction: "0xea6e63ed0baadbf0db367af9ccd2eef93a87d52251d5a955e15ee826b026affe",
        sourcify: "https://repo.sourcify.dev/10143/0x960c0421c5FEac805187F25D7abc04D971D334B6",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "P2-EC testnet, throwaway: caps 100/2,000 USDC; allowlist the owner's playtest wallets and the test wallet",
  },
  {
    id: "personal_account_implementation",
    label: "PersonalAccount implementation",
    kind: "platform",
    address: "0x740D148C9419977f5F7d7965B706b05Ce7Af4376",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281745,
      codeSize: 23514,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0xb868a8ed7eaa63fef888415d468aa494604c80d40937ec4433d79ed1cd1ddcd4",
        explorer:
          "https://testnet.monadvision.com/address/0x740D148C9419977f5F7d7965B706b05Ce7Af4376",
        transaction: "0xea6e63ed0baadbf0db367af9ccd2eef93a87d52251d5a955e15ee826b026affe",
        sourcify: "https://repo.sourcify.dev/10143/0x740D148C9419977f5F7d7965B706b05Ce7Af4376",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "Deployed by the testnet AccountFactory's constructor",
  },
  {
    id: "oracle_adapter",
    label: "Oracle adapter",
    kind: "platform",
    address: "0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281723,
      codeSize: 7076,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0x82f754adfe5bf9f50ef10375b2e5b0e6a9c54c38f51c1a5fe96dce2ac20f553c",
        explorer:
          "https://testnet.monadvision.com/address/0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647",
        transaction: "0x37631075976e28b236984a881f7b4422d633268f1296b9903ee406477a6b3b12",
        sourcify: "https://repo.sourcify.dev/10143/0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "Over the two TestnetFeeds and the P2-EC pool (D-253, D-257)",
  },
  {
    id: "executor",
    label: "Executor",
    kind: "platform",
    address: "0xc127997711a3D26a0967724897BCc365934DeC7c",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281727,
      codeSize: 28590,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0x95fbbfed08947644a601ba0cd7eb69702e4344b7972463154a55137203d15523",
        explorer:
          "https://testnet.monadvision.com/address/0xc127997711a3D26a0967724897BCc365934DeC7c",
        transaction: "0xfb5f89c1526c361147b35f7694f7e1be3a5670a61a9d6c78de54171634e9bba4",
        sourcify: "https://repo.sourcify.dev/10143/0xc127997711a3D26a0967724897BCc365934DeC7c",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "P2-EC testnet, throwaway: launch policy; bound to the testnet factory and registry",
  },
  {
    id: "protocol_registry",
    label: "ProtocolRegistry",
    kind: "platform",
    address: "0xddE58ce63f029503804c68B84FF4a1cB81d3081c",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281741,
      codeSize: 9211,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0x303165fb752fe494a9c935bbd56b46453e4ec26cc55d5a247f6b97728fa60fdb",
        explorer:
          "https://testnet.monadvision.com/address/0xddE58ce63f029503804c68B84FF4a1cB81d3081c",
        transaction: "0x594e341abe4c506be29c350cf753dca07ed72e3e4b6f46c2960554d1448d4b9c",
        sourcify: "https://repo.sourcify.dev/10143/0xddE58ce63f029503804c68B84FF4a1cB81d3081c",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "Lists only the v4 adapter, active; testnet has no Uniswap v3",
  },
  {
    id: "venue_uniswap_v4_mon_usdc",
    label: "Uniswap v4 MON/USDC 0.05% adapter",
    kind: "platform",
    address: "0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1",
    status: "verified",
    verification: {
      chainId: MONAD_TESTNET_CHAIN_ID,
      block: 69281734,
      codeSize: 7589,
      deployedBy: "pnpm deploy:testnet",
      chain: {
        codeHash: "0xbc1c90c8f8691441e5ab866f8fbfc35778fa514995cdf0ad64cddfb0ab4a3f4b",
        explorer:
          "https://testnet.monadvision.com/address/0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1",
        transaction: "0x118b754e2d91b735928ab3e1898fa10e64a4cce278ac44bcd5b728cbf0d5f57d",
        sourcify: "https://repo.sourcify.dev/10143/0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1",
      },
    },
    source: P2EC_SOURCE,
    openQuestion: null,
    note: "On the P2-EC pool of the unofficial testnet PoolManager (D-257)",
  },
];

/**
 * P2-EC part 2's throwaway mainnet canary (D-247, D-249, D-250), as observed
 * on Monad mainnet after `pnpm deploy:canary` and verified on Sourcify (D-256,
 * D-316): `agent_nft` is CanaryAgent, which knows one agent and is not an
 * ERC-721. Every salt carries the p2ec.canary scope; nothing here carries
 * into the beta. Every transaction is in evidence/p2-ec/canary-deployment.json.
 */
const CANARY_SOURCE = "evidence/p2-ec/ADDRESSES.md (P2-EC part 2, mainnet canary, throwaway)";
const CANARY_DEPLOYED: readonly AddressEntry[] = [
  {
    id: "agent_nft",
    label: "CanaryAgent",
    kind: "platform",
    address: "0x22A4790313067278B0d15C9C5a7Df4e4613b9cA8",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700435,
      codeSize: 848,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0xc2eb3e6523ab953bd9533aac33a3ad08bb8a3eaa51413209d83e95192fa8404c",
        explorer: "https://monadvision.com/address/0x22A4790313067278B0d15C9C5a7Df4e4613b9cA8",
        transaction: "0x30a0e635b79f3e2621e5368e7b4b991727636c10ea4c4fa059dcd7c3e16c5410",
        sourcify: "https://repo.sourcify.dev/143/0x22A4790313067278B0d15C9C5a7Df4e4613b9cA8",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "P2-EC mainnet canary, throwaway (D-250): stands in for AgentNFT; knows one agent (ID 1) owned by the canary owner; not an ERC-721",
  },
  {
    id: "account_factory",
    label: "AccountFactory",
    kind: "platform",
    address: "0xE93c0E9dbEDB26919761e371F27BBf1863FB94FD",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700508,
      codeSize: 12557,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0x3d0844b2844f2f5ab91d4330964f93444b338ce3088ec9d950176c5ad41aadff",
        explorer: "https://monadvision.com/address/0xE93c0E9dbEDB26919761e371F27BBf1863FB94FD",
        transaction: "0x78fbf11b2e2f9c6624d46e85ff6d5f82979bad53d85be79b59ff9e84e1612ca6",
        sourcify: "https://repo.sourcify.dev/143/0xE93c0E9dbEDB26919761e371F27BBf1863FB94FD",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "P2-EC mainnet canary, throwaway: caps 10 and 10 USDC; allowlist the canary owner only; sentinel zero",
  },
  {
    id: "personal_account_implementation",
    label: "PersonalAccount implementation",
    kind: "platform",
    address: "0xD2419E99Cc3b555eeCB11713e24d714030504A7d",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700508,
      codeSize: 23514,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0x1b226a3ff69d5bd25ab4f97dabe68bc27f9cb259651a6a8702e138bf3c516c6f",
        explorer: "https://monadvision.com/address/0xD2419E99Cc3b555eeCB11713e24d714030504A7d",
        transaction: "0x78fbf11b2e2f9c6624d46e85ff6d5f82979bad53d85be79b59ff9e84e1612ca6",
        sourcify: "https://repo.sourcify.dev/143/0xD2419E99Cc3b555eeCB11713e24d714030504A7d",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "Deployed by the canary AccountFactory constructor",
  },
  {
    id: "oracle_adapter",
    label: "Oracle adapter",
    kind: "platform",
    address: "0x4d607DED5A5b3f2ea7A46fF3d85563c01138Afa0",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700482,
      codeSize: 7076,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0x4064c3bd808e3ebb31b3ec6634ba777d608a1138f1077232da13fd6d3181dad9",
        explorer: "https://monadvision.com/address/0x4d607DED5A5b3f2ea7A46fF3d85563c01138Afa0",
        transaction: "0xbd362c81cba590178966dbb2aabdc00947c0d7122fed063c036aa9b56cc70b5e",
        sourcify: "https://repo.sourcify.dev/143/0x4d607DED5A5b3f2ea7A46fF3d85563c01138Afa0",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "Over the real Chainlink MON/USD and USDC/USD feeds and the launch pool, with the launch bounds",
  },
  {
    id: "executor",
    label: "Executor",
    kind: "platform",
    address: "0x7a74C37F5fe4cb92db6304Fe77568B0D1FFcA4f1",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700486,
      codeSize: 28590,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0x442ab8404dbb75a02f9ecd4956515fa89e3dae18cb09f7a847c848cde0badc59",
        explorer: "https://monadvision.com/address/0x7a74C37F5fe4cb92db6304Fe77568B0D1FFcA4f1",
        transaction: "0xb1e87d8d4dcd6e1819f1bdfda65e18cb10a5c4c4543139e6e90cb018535e9072",
        sourcify: "https://repo.sourcify.dev/143/0x7a74C37F5fe4cb92db6304Fe77568B0D1FFcA4f1",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "P2-EC mainnet canary, throwaway: launch policy; admin the canary owner, guardian the canary guardian; bound to the canary factory and registry",
  },
  {
    id: "protocol_registry",
    label: "ProtocolRegistry",
    kind: "platform",
    address: "0xa68A2d81666C69eB206B91A3EC0d3C9f4f9d2243",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700505,
      codeSize: 9211,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0x463d8c302305a67b3a4aa99c1c074058d56b5fa7ca69a72d0c585f19ae92ac3f",
        explorer: "https://monadvision.com/address/0xa68A2d81666C69eB206B91A3EC0d3C9f4f9d2243",
        transaction: "0xb32bf370a52c3ee9a234e07e4c35307d3e4a0feff020012dc4a58ba9ea4320af",
        sourcify: "https://repo.sourcify.dev/143/0xa68A2d81666C69eB206B91A3EC0d3C9f4f9d2243",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "Lists the v4 adapter (active) and the v3 adapter (paused)",
  },
  {
    id: "venue_uniswap_v4_mon_usdc",
    label: "Uniswap v4 MON/USDC 0.05% adapter",
    kind: "platform",
    address: "0x38E035433c7a500f0ebc1FDcCcd42213446C511f",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700494,
      codeSize: 7589,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0x7cbf59b4000e99e1b84f673555a79f0546d17bda548f7006bcb61ed8eb7d8e4b",
        explorer: "https://monadvision.com/address/0x38E035433c7a500f0ebc1FDcCcd42213446C511f",
        transaction: "0xaef461c88769b5019ca9f0528177d3223b4ddff849d5126f9a01e7f84d0c6430",
        sourcify: "https://repo.sourcify.dev/143/0x38E035433c7a500f0ebc1FDcCcd42213446C511f",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "On the real launch pool (D-166)",
  },
  {
    id: "venue_uniswap_v3_usdc_wmon",
    label: "Uniswap v3 USDC/WMON 0.3% adapter",
    kind: "platform",
    address: "0x3b7a5882584fF31e2E96877f8D3A68b539796e8E",
    status: "verified",
    verification: {
      chainId: MONAD_MAINNET_CHAIN_ID,
      block: 111700497,
      codeSize: 3394,
      deployedBy: "pnpm deploy:canary",
      chain: {
        codeHash: "0xc8b4f91f3c469fb542cf7f1c41f1b901cf4093f7776091668f1d490541095ade",
        explorer: "https://monadvision.com/address/0x3b7a5882584fF31e2E96877f8D3A68b539796e8E",
        transaction: "0xd441753ad6f672d8b5ea4da6981e09c6dcb99f0b8a673588024118b0e4dace2f",
        sourcify: "https://repo.sourcify.dev/143/0x3b7a5882584fF31e2E96877f8D3A68b539796e8E",
      },
    },
    source: CANARY_SOURCE,
    openQuestion: null,
    note: "On SwapRouter02; registered paused, as the beta will have it",
  },
];

/**
 * F-U2: the fund agent's v3 set, beside v1 and v2. Deterministic CREATE2 with
 * the `fund-<name>.v3` salts; the addresses follow from the seeds, all seven
 * core candidates having passed their screens at deploy time
 * (scripts/lib/fund.js). F-U3 step 0 moved the daily exchange-rate legs' bound
 * from 86,700 to 90,000 seconds (A-67), which changed the seeds and so every
 * address: the set is deployed again beside F-U2's, which stays on the playtest
 * fork unused. The RouteAdapter's executor is anvil account 0 until F-U4
 * deploys the adapter bound to Executor v3.
 */
const FUND_SOURCE = "Planv2/FINAL_PLAN.md > 0.4 Contract changes on Monad";
const FUND_IDS = [
  ["token_registry_v3", "TokenRegistry (v3)"],
  ["protocol_registry_v3", "ProtocolRegistryV3"],
  ["oracle_adapter_v3", "OracleAdapterV3"],
  ["route_adapter_v3", "RouteAdapter (v3)"],
] as const;
const FUND_LOCAL_FACTS: Readonly<
  Record<(typeof FUND_IDS)[number][0], readonly [Address, number, string]>
> = {
  token_registry_v3: [
    "0x171F36056B2449F0FBB9923676AffAb14A1cf55C",
    19517,
    "Core lane seeded with USDC, WMON, AUSD, WBTC, cbBTC, WETH and shMON, each re-screened at deploy time, with the A-67 feed bounds; screener anvil account 3",
  ],
  protocol_registry_v3: [
    "0x4eB383cA21819119fB9852a23F4f173208CAC098",
    19718,
    "Eight core pools on Uniswap v3, PancakeSwap v3 and hookless Uniswap v4, each confirmed by its venue",
  ],
  oracle_adapter_v3: [
    "0x82df37a295f0387e9d83788213CfC70E944EEaBD",
    10235,
    "One feed per class F token with its own staleness bound; on the fork every class F feed is kept fresh (D-237, F-U3 step 0)",
  ],
  route_adapter_v3: [
    "0x509450abceD1123007F1DafCeFe4F38B9817dFb7",
    12727,
    "Demo executor anvil account 0, not registered; F-U4 deploys and registers the adapter bound to Executor v3",
  ],
};
const FUND_LOCAL: readonly AddressEntry[] = FUND_IDS.map(([id, label]) => {
  const [address, codeSize, note] = FUND_LOCAL_FACTS[id];
  return {
    id,
    label,
    kind: "platform",
    address,
    status: "verified",
    verification: {
      chainId: LOCAL_FORK_CHAIN_ID,
      block: FORK_BLOCK,
      codeSize,
      deployedBy: "pnpm deploy:fund",
    },
    source: FUND_SOURCE,
    openQuestion: null,
    note,
  };
});
/**
 * F-U3: the custody core v3, AccountFactoryV3 and its PersonalAccountV3
 * implementation, bound to the v3 set above. Deterministic CREATE2 with the
 * `account-factory.v3` salt (scripts/lib/custody-v3.js); the Executor is unset
 * until F-U4 deploys Executor v3 and this factory again with it given.
 */
const CUSTODY_V3_SOURCE =
  "Planv2/FINAL_PLAN.md > 0.4 Contract changes on Monad, 4.1.6 Custody core";
const CUSTODY_V3_IDS = [
  ["account_factory_v3", "AccountFactoryV3"],
  ["personal_account_v3_implementation", "PersonalAccountV3 implementation"],
] as const;
const CUSTODY_V3_LOCAL_FACTS: Readonly<
  Record<(typeof CUSTODY_V3_IDS)[number][0], readonly [Address, number, string]>
> = {
  account_factory_v3: [
    "0x8A7F8C0bc4C8f00Cbdab8EAAa130B8767058B9d5",
    11645,
    "Bound to the v3 TokenRegistry and OracleAdapterV3 with anvil roles, 100/2,000 USDC caps and anvil accounts 6 to 9 allowed; Executor unset until F-U4",
  ],
  personal_account_v3_implementation: [
    "0x84a1233476BC5F494Cf15BF4d9fc161EB1E278aD",
    41205,
    "Deployed by AccountFactoryV3's constructor; every PersonalAccountV3 is a clone of it, holding up to 16 registered tokens",
  ],
};
const CUSTODY_V3_LOCAL: readonly AddressEntry[] = CUSTODY_V3_IDS.map(([id, label]) => {
  const [address, codeSize, note] = CUSTODY_V3_LOCAL_FACTS[id];
  return {
    id,
    label,
    kind: "platform",
    address,
    status: "verified",
    verification: {
      chainId: LOCAL_FORK_CHAIN_ID,
      block: FORK_BLOCK,
      codeSize,
      deployedBy: "pnpm deploy:custody-v3",
    },
    source: CUSTODY_V3_SOURCE,
    openQuestion: null,
    note,
  };
});
const custodyV3Undeployed = (note: string): AddressEntry[] =>
  CUSTODY_V3_IDS.map(([id, label]) => ({
    id,
    label,
    kind: "platform",
    address: null,
    status: "unverified",
    verification: null,
    source: CUSTODY_V3_SOURCE,
    openQuestion: null,
    note,
  }));
const fundUndeployed = (note: string): AddressEntry[] =>
  FUND_IDS.map(([id, label]) => ({
    id,
    label,
    kind: "platform",
    address: null,
    status: "unverified",
    verification: null,
    source: FUND_SOURCE,
    openQuestion: null,
    note,
  }));

export const ADDRESS_BOOK: Readonly<Record<EnvironmentId, readonly AddressEntry[]>> = {
  local: [...MAINNET, AGENT_NFT_LOCAL, ...CUSTODY_LOCAL, ...FUND_LOCAL, ...CUSTODY_V3_LOCAL],
  testnet: [
    ...TESTNET.filter((e) => !TESTNET_DEPLOYED.some((d) => d.id === e.id)),
    ...TESTNET_DEPLOYED,
    {
      id: "venue_uniswap_v3_usdc_wmon",
      label: "Uniswap v3 USDC/WMON 0.3% adapter",
      kind: "platform",
      address: null,
      status: "unverified",
      verification: null,
      source: CUSTODY_SOURCE,
      openQuestion: null,
      note: "Not deployed on testnet: testnet has no Uniswap v3 (D-248)",
    },
    ...fundUndeployed("The v3 set reaches testnet in F-U13"),
    ...custodyV3Undeployed("The custody core v3 reaches testnet in F-U13"),
  ],
  beta: [
    ...MAINNET,
    agentNftUndeployed("Mainnet deployment belongs to PB-U1"),
    ...custodyUndeployed("Mainnet deployment belongs to PB-U1"),
    ...fundUndeployed("Mainnet deployment belongs to PB-U1"),
    ...custodyV3Undeployed("Mainnet deployment belongs to PB-U1"),
  ],
  // The P2-EC mainnet canary (D-250, D-251): mainnet's external entries and its own throwaway contracts.
  canary: [
    ...MAINNET,
    ...CANARY_DEPLOYED,
    ...fundUndeployed("Not part of P2-EC's canary; F-U13 reruns the canary with the v3 set"),
    ...custodyV3Undeployed("Not part of P2-EC's canary; F-U13 reruns the canary with the v3 set"),
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
