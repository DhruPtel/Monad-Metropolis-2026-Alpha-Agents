# Phase 0 orientation and shared context

## Our product (Part 1 of brief)

We are building an onchain financial management platform on Monad.

- **Agents are NFTs** (ERC-721 "AgentNFT", three tiers). Each has an ERC-6551 TBA that holds only skill NFTs and identity. TBA permissions are all-or-nothing, so the TBA holds no capital and grants no permissions to platform keys.
- **Three capital accounts:**
  1. PersonalAccount: separate contract holding the owner's money, managed by their agent. Owner can always withdraw directly, even if the platform is down.
  2. StrategyVault: ERC-4626 vault others deposit into. Agent manages it but must never withdraw or redirect depositor funds.
  3. Operating wallet: gas, AI inference credits, small x402 payments.
- **Trade authorization:** a platform-managed session key (Privy server wallet with its own policies) acts for the agent, scoped to approved actions on PersonalAccount and StrategyVault only. Hermes (AI brain) holds no keys; it emits unsigned typed intents -> policy checks -> simulation -> session key signs.
- **Executor hard limits at launch:**
  - Allowed assets: USDC, MON (or WMON), WETH, one LST
  - One swap venue: Uniswap
  - Swap recipient must be the account the funds came from
  - Exact-amount token approvals only, never unlimited
  - Max 10% of account value per trade
  - Max 40% of account value in any non-USDC asset
  - At least 10% kept in USDC
  - Max 0.5% slippage
  - Max 20 trades per day
  - 2-minute transaction deadlines
  - Oracle price < 5 minutes old and within 2% of pool price
  - Circuit breaker: 10% drop from 7-day peak -> reduce-only; 20% -> pause for owner review
  - No delegatecall, no arbitrary calls, no leverage, no lending at launch
- **Epochs:** every action tied to current owner epoch (increments on every NFT transfer) and config epoch (increments on build/policy change). Stale permissions must fail. Old permissions must never come back if an NFT returns to a previous owner.
- **Agent sales:** launch = only our marketplace escrow, re-checks at settlement. OpenSea/Blur later.
- **Tiers:** later tiers may unlock more venues/actions (e.g. lending). Permission sets per tier or per skill should be expressible without redeploying contracts.

## Ground rules (Part 2 of brief)

1. Read only. Do not modify repo files outside `research/zodiac-roles/notes/`. No deploys. Read-only commands OK (git show/log, grep, cat, read-only RPC).
2. Cite everything: file paths and function names for every behavioral claim. Short excerpts (<20 lines) OK.
3. Label statements **Verified** (read in code) or **Inferred**.
4. Be honest about gaps: list open questions.
5. Plain prose and tables. Avoid em dashes.

## Phase 0 findings (Verified unless marked)

**Repo:** `gnosisguild/zodiac-modifier-roles`, HEAD `820e5bc975d1817bdd4bc4a95226f553f7b67b68` on `main`, 2026-08-25 17:37 +0200 (release zodiac-roles-sdk 4.1.3). Last commit touching `packages/evm/contracts`: 2026-02-23 (`1ddde84d fix: Simplify Loop Bounds (#448)`).

**Versions.** Roles v1 is legacy in a separate repo (gnosisguild/zodiac-modifier-roles-v1, per README). This repo's `main` is **Roles v2** (evm package `@gnosis-guild/zodiac-core-modifier-roles` 2.1.0, Solidity 0.8.21, shanghai). There is an unreleased **v3** on remote branch `origin/contracts-v3` (evm 3.0.0, last commit 2026-07-20), relicensed **BUSL-1.1** ("Copyright (c) 2026 GG DAO LLC ... Converts to LGPL-3.0-or-later on 2030-03-01"). v3 adds `WithinRatio` operator, `IPricing` price adapters, priced allowances (`PriceLoader`, `AllowanceConsumer`). Related branches: `feat/chainlink-pricing`, `fix/allowance-rounding`, `codex/pricing-adapters-generic-api`, `proposal/custom-condition-consumptions`. Inspect read-only with `git show origin/contracts-v3:<path>` and `git ls-tree -r --name-only origin/contracts-v3`. Focus on v2 (main) but note v3 where it closes a gap for us.

**License.** main: LGPL-3.0+ (root `LICENSE`, `package.json`). v3 branch: BUSL-1.1 until 2030-03-01.

**Packages (`packages/`):**
- `evm`: Solidity contracts (Hardhat). `contracts/` Roles.sol, _Core.sol, _Periphery.sol, PermissionBuilder.sol, PermissionChecker.sol, PermissionLoader.sol, AllowanceTracker.sol, Consumptions.sol, AbiDecoder.sol, Integrity.sol, Topology.sol, WriteOnce.sol, Types.sol, packers/, periphery/ (MultiSendUnwrapper, MorphoBundler3Unwrapper, AvatarIsOwnerOfERC721, EIP712Encoder, SignTypedMessageLib, SafeStorage). Tests in `test/`. Audits in `docs/` (4 PDFs: G0 Apr 2023, Omniscia May 2023, Omniscia Nov 2023 v2.1, G0 Nov 2023 v2.1). `mastercopies.json`, `tasks/` (deploy/verify mastercopy tasks).
- `sdk`: `zodiac-roles-sdk` 4.1.3. `src/main` (conditions, permissions, targets, diffing, postRole, chains, licensing), `src/kit` (eth-sdk typed permission builder), `src/annotations`, `src/swaps` (CoW order signing helpers). Note `src/main/licensing.ts` `fetchLicense` calls `https://app.zodiac.eco/system/get-plan/...` and is used in `src/swaps/appData.ts`.
- `app`: Next.js webapp (roles.gnosisguild.org).
- `docs`: Next.js docs site, content in `packages/docs/content` (general, sdk, tutorials).
- `integration-tests`: Hardhat integration tests.
- README mentions `subgraph` and `deployments` packages, but they are **not present** in this checkout.

**Deployment addresses.** README (updated in commit 2db58108, 2026-06-19) lists Roles mastercopy `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5`, Integrity `0x6a6A...1049`, Packer `0x8697...09f0`, MultiSendUnwrapper `0xB4Cd...efD`, AvatarIsOwnerOfERC721 `0x91B1...d1`, MorphoBundler3Unwrapper `0x7533...E8`. `packages/evm/mastercopies.json` still lists Roles 2.1.0 at `0x9646fDAD06d3e24444381f44362a3B0eB343D337` and Packer at `0x61C5...8C` (inconsistency: two Roles mastercopy addresses, both via singleton factory `0xce0042b868300000d44a59004da54a005ffdcf9f`, salt 0).

**Monad.** No mention of Monad / chain 143 / 10143 anywhere in the repo, and chain 143 is not in `packages/sdk/src/main/chains.ts`. However, read-only `eth_getCode` against `https://rpc.monad.xyz` (eth_chainId returned 0x8f = 143) shows code at:
- Roles `0xF2964C...83D5` (24409 bytes) and `0x9646fD...D337` (24401 bytes)
- Integrity `0x6a6A...1049`, both Packers, both MultiSendUnwrappers, MorphoBundler3Unwrapper, AvatarIsOwnerOfERC721
- Singleton factory `0xce0042b8...cf9f`, Zodiac ModuleProxyFactory `0x000000000000aDdB49795b0f9bA5BC298cDda236`
- Safe 1.4.1 singleton `0x41675C09...461a`, SafeL2 `0x29fcB43b...C762`, SafeProxyFactory `0x4e1DCf7A...ec67`, MultiSend/MultiSendCallOnly (1.3.0 and 1.4.1)
Bytecode equality with the canonical build is not yet verified (Inferred: same CREATE2 address + salt implies same initcode).
