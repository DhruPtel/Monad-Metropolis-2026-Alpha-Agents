# Shared brief for sub-agents (Parts 1 and 2) and Phase 0 findings

## Part 1: Our product

We are building an onchain financial management platform on Monad.

**Agents are NFTs.** Each agent is an ERC-721 "AgentNFT" with an ERC-6551 token-bound account that holds only skills and identity. The agent owner is the "manager" of any vault the agent runs.

**Three separate capital accounts** (required by a risk review):
1. PersonalAccount: the owner's own money, managed by their agent.
2. StrategyVault: the subject of this research. Other users deposit USDC, the agent manages it, depositors share the results.
3. Operating wallet: pays gas, AI inference credits, small x402 payments. Never funded from vault assets.

**How the vault is managed.** The agent never holds keys. A platform session key calls our own **Executor** contract, which accepts typed intents (e.g. "swap X USDC for WETH on Uniswap") and enforces hard limits. We build our own Executor (not Zodiac Roles) because Roles cannot express percentage-of-account limits, oracle checks, or ownership epochs. The vault must only let the Executor move assets, and only in ways that keep them inside the vault.

**Launch strategy.** Spot tokens only: USDC, MON (or wrapped MON), WETH, maybe one liquid staking token, traded on Uniswap. No leverage, lending, or perps at launch. USDC is the accounting base.

**Executor hard limits at launch:** max 10% of vault value per trade; max 40% of vault value in any non-USDC asset; at least 10% in USDC; max 0.5% slippage; exact approvals reset after each swap; rolling 20 trades per 24h; 2-minute deadlines; oracle price under 5 minutes old and within 2% of pool price; circuit breaker (10% drop from 7-day peak -> reduce-only; 20% -> pause for owner review).

**Epochs.** Every Executor action is tied to the agent's ownership epoch (increments on every NFT transfer) and configuration epoch (increments on every policy change). Stale permissions fail.

**Agent sales.** Only through our own marketplace escrow at launch. When an agent managing a vault is sold, the vault enters handover mode (reduce-only, depositors can exit) before the new owner can trade.

**Non-negotiable rule.** Depositors must always be able to withdraw directly from the vault contract, even if our platform, Executor, and session keys are all offline.

### Hyperliquid user vault behavior (product spec)
- Leader stake: leader keeps at least 5% of the vault at all times.
- Performance fee: leader earns 10% of profits.
- Custody: leader can trade depositor funds but never withdraw them.
- Lockup: default 1-day deposit lockup, leader can extend (protocol vault uses 4 days).
- Withdrawals: if enough free balance, withdrawals do not affect positions; otherwise a proportional share of positions is closed to pay.
- Controls: leader can close the vault to new deposits and can choose to always close positions on withdrawal.
- Transparency: every trade, position, drawdown, and the leader's share are public.

Fees are deferred for the first build phases, but the design must support a performance fee above a high-water mark later.

## Part 2: Ground rules
1. Read only. Do not modify the repository (other than writing your notes file) or deploy anything. Foundry is NOT installed, so tests cannot be run; describe tests instead.
2. Cite everything: file paths and function names for every behavioral claim. Short code excerpts (under 20 lines) are fine.
3. Label statements **Verified** (read in code) or **Inferred**.
4. Focus on Vault V2. MetaMorpho (V1) submodules are NOT checked out (lib/* are empty), so V1 comparisons must be labeled Inferred / from general knowledge.
5. Morpho vaults allocate into lending markets; ours trades spot tokens. Be explicit about which patterns transfer directly and which do not.
6. Put anything the code cannot answer in an "Open questions" section.
7. Write plainly. Clear prose and tables. Avoid em dashes.

## Phase 0 findings (done by lead)

**Repository:** `morpho-org/vault-v2`, at `/home/dhrupatel/agent_tool/vaults`.
- Commit `9ee4dbdcc9b261eef60768e3997e328224b68395` (merge of PR #1010), commit date 2026-09-25 11:01:44 +0200. Last change to `src/VaultV2.sol`: `640c6b54` on 2026-08-31.
- `git describe`: `2026-08-13-85-g9ee4dbdc`. Tags are dates: 2025-12-04, 2026-07-08, 2026-07-29, 2026-08-12, 2026-08-13.
- License: `GPL-2.0-or-later` (all 39 `src` files, LICENSE is GPL v2 text). Solidity 0.8.28, via_ir, cancun.
- Submodules (forge-std, metamorpho, metamorpho-v1.1, morpho-blue, morpho-blue-irm, openzeppelin) are not initialized. MetaMorpho source is not present.
- Foundry (forge/anvil/cast) is not installed. python3 with pypdf 6.10.2 is available for reading audit PDFs.

**Contract map:**
- `src/VaultV2.sol` (945 lines): the vault. ERC-4626 + ERC-2612, roles (owner, curator, allocators, sentinels), timelocks, abdication, caps by id, gates, fees, maxRate, liquidity adapter, forceDeallocate.
- `src/VaultV2Factory.sol`: CREATE2 factory, `isVaultV2` mapping.
- `src/adapters/`: `MorphoMarketV1AdapterV2.sol` (+Factory), `MorphoVaultV1Adapter.sol` (+Factory; wraps MetaMorpho or arbitrary ERC4626).
- `src/interfaces/`: `IAdapter.sol`, `IAdapterRegistry.sol`, `IGate.sol`, `IVaultV2.sol`, `IERC4626.sol`, etc.
- `src/libraries/`: ConstantsLib, ErrorsLib, EventsLib, MathLib, SafeERC20Lib.
- `src/periphery/`: `gates/WhitelistSendAssetsGate.sol`, `gates/WhitelistReceiveSharesGate.sol`, `blue-public-allocator/BluePublicAllocator.sol`, `registries/*` (RegistryList, MorphoMarketV1RegistryV2, MorphoVaultV1Registry).
- `test/`: unit tests (ForceDeallocateTest, ExchangeRateTest, RealizeLossTest, AccrueInterestTest, GatingTest, etc.), `test/integration/*`, `test/periphery/*`, `test/mocks/*`.
- `certora/`: README, confs (Invariants, OwnerSafety, Liveness, SentinelLiveness, ExchangeRate, RoundTrip, Reentrancy, PreviewFunctions, RelativeCaps, ForceDeallocate, Gates, AbdicatedFunctions, etc.), specs.
- `audits/`: 15 PDFs (Spearbit 2025-05, 2025-08, 2025-09; Zellic 2025-07; competition 2025-07; Blackthorn 2025-09; ChainSecurity 2025-09; fee-wrapper, market-v1-adapter-v2 (Blackthorn, Certora, Spearbit), vault-v1-adapter arbitrary ERC4626 (Spearbit) 2025-12; gates Blackthorn 2026-07; blue public allocator Blackthorn + Spearbit 2026-08).

**Monad (chain 143) deployment status.** RPC `https://rpc.monad.xyz` answers `eth_chainId = 0x8f`, block ~0x670b1c1. Addresses from docs.morpho.org/get-started/resources/addresses (fetched 2026-09-25), bytecode confirmed present via `eth_getCode`:
| Contract | Address | Code size (bytes) |
|---|---|---|
| Morpho (Blue) | 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee | 15582 |
| VaultV2Factory | 0x8B2F922162FBb60A6a072cC784A2E4168fB0bb0c | 23124 |
| MorphoVaultV1AdapterFactory | 0x9f3c0999425656fD189C69a8aD68cB64986D644A | 5775 |
| MorphoMarketV1AdapterV2Factory | 0xa00666E86C7e2FA8d2c78d9481E687e098340180 | 13633 |
| Morpho registry (vault-v2 registries) | 0x6a42f8b46224baA4DbBBc2F860F4675eeA7bd52B | 1377 |
| Blue Public Allocator | 0x0A503aB026EFACBC0F7feE7795F34B80b5B9a662 | 7697 |
| MetaMorpho Factory V1.1 | 0x33f20973275B2F574488b18929cd7DCBf1AbF275 | 24400 |
Whether the deployed bytecode matches this exact commit is not verified.
