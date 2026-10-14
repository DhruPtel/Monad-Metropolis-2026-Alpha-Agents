# Vivarium's smart contracts

This page explains every contract Vivarium deploys, in plain words, for judges and new readers. The source is in `chains/monad/src` (the product contracts) and `chains/monad/script` (testnet helpers and deploy scripts). Every number below is read from the contracts or the deploy scripts; the addresses come from the address book (`packages/domain/src/address-book.ts` and `packages/domain/src/deployments/`).

The short version: an agent is an NFT. Its owner's money sits in a custody account that only the owner can withdraw from. The agent's AI never touches that money directly: it can only ask the Executor to make a swap, and the Executor and the account each check hard limits onchain before and after every trade.

## At a glance

| Contract                                            | What it does                                                                                         | Monad testnet            | Base Sepolia          | Arbitrum Sepolia |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------ | --------------------- | ---------------- |
| AgentNFT                                            | The agent itself: one ERC-721 token per agent, with a random species and tier revealed after mint.   | Yes                      | No                    | No               |
| AgentCopyNFT                                        | An agent's copy on an L2, minted and moved only by the platform, with the same id, tier and species. | No                       | Yes                   | Not yet deployed |
| ERC-6551 token-bound account (Tokenbound, not ours) | A smart account owned by each agent NFT, created in the mint transaction.                            | Yes                      | No                    | No               |
| PersonalAccountV3                                   | One owner's trading money for one agent; only the owner can withdraw, at any time.                   | Yes                      | Yes                   | Not yet deployed |
| StrategyVaultV3                                     | One agent's public vault with shares, managed by the agent's owner.                                  | Yes (known issue below)  | No                    | No               |
| AccountFactoryV3                                    | Creates personal accounts and vaults and holds their shared settings and deposit caps.               | Yes                      | Yes                   | Not yet deployed |
| CustodyCoreV3                                       | The shared custody code inside every account and vault: withdrawals, backstops, circuit breaker.     | Yes (inside accounts)    | Yes (inside accounts) | Not yet deployed |
| ExecutorV3                                          | The only contract that can trade an account, and only within its hard limits.                        | Yes                      | Yes                   | Not yet deployed |
| RouteAdapter                                        | Runs a swap of up to three hops through registered pools and pays the output back to the account.    | Yes                      | Yes                   | Not yet deployed |
| TokenRegistry                                       | The list of tokens accounts may hold or buy, in two lanes (core and screened).                       | Yes                      | Yes                   | Not yet deployed |
| OracleAdapterV3                                     | Prices every token in USDC, from Chainlink-style feeds (class F) or signed attestations (class A).   | Yes                      | Yes                   | Not yet deployed |
| AttestationVerifier                                 | Checks a price attestation signed by the platform's attestor key.                                    | Deployed, not yet active | No                    | No               |
| ProtocolRegistryV3                                  | The deny-by-default list of pools and route adapters trades may use.                                 | Yes                      | Yes                   | Not yet deployed |
| TestnetToken                                        | A plain test ERC-20 (TALPHA, TBETA) so testnet has tokens beyond USDC and WMON to trade.             | Yes                      | No                    | No               |
| TestnetFeed                                         | A Chainlink-shaped price feed with an operator-set price, because Monad testnet has no Chainlink.    | Yes                      | No                    | No               |
| PoolSeeder                                          | A throwaway helper that created and seeded the MON/USDC pool on Monad testnet's Uniswap v4.          | Yes                      | No                    | No               |
| TestUSDC                                            | The platform's test USDC on the L2 testnets, with a faucet of 100 a day.                             | No                       | Yes                   | Not yet deployed |

Arbitrum Sepolia is supported by the deploy script (`pnpm deploy:l2 arbitrum-sepolia`), but its address book entry is still empty, so nothing is deployed there yet.

## Identity

### AgentNFT (`src/AgentNFT.sol`, Monad)

Every agent is one token of this ERC-721 contract.

- **Fixed supply.** 1,000 agents in total: 500 base, 300 medium and 200 pro. The counts per species are packed into one fixed "deck"; only the final catalog of 25 species is drawn, and nothing can change the deck after deployment.
- **Two-step mint.** `mintWithClaim` (with a claim the platform's signer made for that wallet) or, once the admin turns claim-required mode off, plain `mint` creates an unrevealed agent. Anyone can then call `requestReveal`, paying Pyth Entropy's fee, and `reveal` assigns each waiting agent its species, and with it its tier, from Entropy's random number. A request whose number has not arrived after one hour can be replaced; a delivered number never is.
- **Limits.** One wallet mints at most two agents. The tier sets the skill slots: 3 for base, 5 for medium, 8 for pro.
- **Its own account.** The mint transaction creates the agent's ERC-6551 token-bound account (below) and reverts if that account is not running the canonical Tokenbound implementation.
- **Transfers.** Agents can change hands only through the marketplace escrow, once the admin has set one, and never into an agent's own account. Every transfer bumps the agent's **ownership epoch**, a counter the trading contracts read so that a sale ends the old owner's trading rights at once.
- 5% ERC-2981 royalty; the admin is two-step and cannot be renounced.

### AgentCopyNFT (`src/AgentCopyNFT.sol`, Base Sepolia; Arbitrum Sepolia once deployed)

Agents are minted on Monad only. On an L2, the platform checks the Monad owner and mints a copy of the same agent (same id, tier and species) to that owner with `mintCopy`, and moves it with `moveCopy` when the Monad agent changes hands. There is no cross-chain messaging: the platform's minter key is the only thing that can mint or move a copy, and holders cannot transfer or approve it themselves. It exposes `ownerOf` and `ownerEpoch` exactly as AgentNFT does, so the same trading contracts work on the L2s unchanged.

### ERC-6551 token-bound account (Tokenbound v3, not our code)

Each agent owns a smart account through the standard ERC-6551 registry, using Tokenbound's audited AccountV3 implementation. Vivarium does not deploy or modify these contracts: AgentNFT only calls the registry at mint and checks the result. Whoever holds the agent NFT controls its account. The agent's trading money does **not** live here; it lives in the custody accounts below.

## Money

### CustodyCoreV3 (`src/fund/CustodyCoreV3.sol`)

The shared code inside every personal account and vault, and the only code that holds user capital. It is abstract: it is deployed as part of PersonalAccountV3 and StrategyVaultV3.

- **Money leaves in exactly two ways.** (1) The owner's withdrawal, which is always on: no pause, mode, oracle, registry or platform call can block it, and a token whose transfer fails is skipped and kept as a claimable credit. (2) `executeSwap`, callable only by the Executor the factory names.
- **Backstops of its own**, slightly looser than the Executor's limits, so they hold even if the Executor or its key were compromised: at most 25% of the account in one trade, 60% in one token, 2% slippage, and a USDC depeg guard of 1%. Positions in class A (attested-price) tokens are capped by cost basis, at 15% each and 50% together, so a wrong price cannot raise them.
- **Up to 16 tokens held**, USDC first, each registered in the TokenRegistry.
- **Circuit breaker.** It tracks the account's value per unit against its peak over the last 7 to 8 days: a 10% drop switches the account to reduce-only, a 20% drop pauses trading. Deposits and withdrawals never move the breaker.
- It never approves a spender, accepts no native coin, and has no generic call path.

### PersonalAccountV3 (`src/fund/PersonalAccountV3.sol`)

One owner's own trading money for one agent, across up to 16 tokens. No shares and no lockup.

- One account per (agent, owner) pair, created by AccountFactoryV3. If the agent is sold, the seller keeps the account and can still withdraw; trading stops by itself, because a trade requires the agent's current owner and the current ownership epoch.
- Deposits are USDC or a buyable core-lane class F token, checked against the factory's allowlist and caps; a fee-on-transfer token is refused.
- The owner can opt in to the screened lane (newer, higher-risk tokens) with their own transaction, and opt out at once.
- Withdrawals: always on, owner only.

### StrategyVaultV3 (`src/fund/StrategyVaultV3.sol`, Monad only)

One agent's public vault: other wallets deposit USDC and receive shares that nobody can transfer at launch.

- The manager is the agent's current owner, read live, and must keep a leader stake of at least 5% of the shares.
- Deposits are locked for one day by default (seven at most). Deposits are priced 0.5% above the vault's value and USDC exits 0.5% below it, so the spread stays in the vault.
- Exits never depend on the Executor, the platform or a pause: a USDC exit pays from the USDC above a 10% floor, and `redeemInKind` pays each holder's share of every token with no oracle at all.
- Vaults hold only USDC and core-lane class F tokens, never screened or class A tokens. A sale of the agent puts the vault in a 3-day handover; `closeVault` winds it down. Fees are zero at launch.
- **Known issue, testnet only.** Under the 60% position cap, a token sent straight to a vault followed by deposits can lower the share price (the `StrategyVaultV3ManyTokensInvariant` test finds the counterexample). The vault ships on Monad testnet with this issue, and it must be fixed before any mainnet vault. Base Sepolia and Arbitrum Sepolia have no vaults.

### AccountFactoryV3 (`src/fund/AccountFactoryV3.sol`)

Creates personal accounts and vaults (as clones of deployed implementations) and holds what they all read: the Executor and oracle addresses, the guardian and sentinel, the depositor allowlist, and the per-account, per-vault and platform-wide deposit caps.

- It can never move account money: its only call into an account is `initialize` at creation.
- Tightening is instant (lower a cap, remove a depositor, clear the Executor). Loosening waits a 9-day timelock that anyone can execute once it matures, and lapses if left for more than 7 days after. Adding a depositor to the allowlist is the one instant loosening, since the caps still bind them.
- Exits never consult the factory.
- Deployed without a vault implementation, it creates no vaults; that is how the L2 testnets run personal accounts only.

## Trading

### ExecutorV3 (`src/fund/ExecutorV3.sol`)

The only contract that can trade an account.

- **Session keys.** The agent's owner registers a session key for the agent (`registerSession`, at most 30 days). The grant records the ownership and configuration epochs, so a sale or a settings change ends it; the owner can revoke it or bump the configuration epoch at any time.
- **Typed intents only.** The agent's key submits a swap intent: account, tokens, amounts, minimum output, deadline, route of registered pool IDs, and the epochs and policy it was signed under. The Executor never takes calldata, targets or native value, and the output always goes to the account.
- **Hard limits** (the policy deployed by `script/DeployExecutorV3.s.sol`): at most 25% of the account in one trade, at most 60% in one token, at least 5% kept in USDC, at most 1.5% slippage against oracle prices (2% for class A tokens), class A positions at 15% each and 50% together, 48 trades and 200% turnover in any 24 hours, and a deadline at most 120 seconds ahead. The pool's own price must also be within 2% of the oracle's on Monad testnet (5% on the L2 testnets, set at deployment).
- A refusal reverts with a named reason (for example `TRADE_SIZE_EXCEEDED` or `USDC_FLOOR`), the same codes the app shows in "why the agent did not trade".
- Loosening the policy or unpausing waits a 9-day timelock; tightening and pausing are instant for the admin or the guardian.
- An agent's vault trades under the same limits with a grant that has no fixed expiry, and never buys class A or screened tokens.

### RouteAdapter (`src/fund/RouteAdapter.sol`)

Runs one exact-input swap of up to three hops through pools the ProtocolRegistryV3 lists, on Uniswap v3, PancakeSwap v3 or hookless Uniswap v4. Only its Executor may call it. It never gives an approval: v3 pools are paid inside their own callback and v4 hops settle by transfer. Accounts hold wrapped MON, never native MON, so a v4 hop through a native pool wraps and unwraps as needed. Before returning it checks that it kept nothing of any token the route touched.

The address book lists two RouteAdapters per chain: "Executor v3's", which is bound to the Executor and carries every trade, and the "fund set" one from the token registry's own deployment.

### TokenRegistry (`src/fund/TokenRegistry.sol`)

Every token accounts may hold or trade, with its lane, status, price class, decimals, cap and (for class F) its feeds. Up to 256 tokens.

- **Core lane.** Added through the 9-day timelock or at deployment; usable by every account.
- **Screened lane.** Added at once by the screener after a passing screen at most six hours old; always class A, capped at 15% of an account; usable only by personal accounts whose owner opted in.
- Any token can be moved to sell-only or frozen at once by the screener, the guardian or the admin. Nothing becomes buyable at once: restoring a token, setting a feed, raising a cap or promoting a screened token to core all wait the timelock.

### OracleAdapterV3 (`src/fund/OracleAdapterV3.sol`)

Prices every token as the USDC value of one whole token, with USDC exactly 1.

- **Class F (feed) tokens** are priced from their registered feeds, each checked for a complete, positive, fresh answer with the recorded decimals. One stale feed blocks only the tokens it prices.
- **Class A (attested) tokens** have no feed: a trade must carry a price attestation, which the oracle checks through the AttestationVerifier the registry names.
- A trade also needs its pool's price close to the oracle price: within 2% on Monad testnet, 5% on the L2 testnets (a deployment setting).
- Withdrawals never read the oracle.

### AttestationVerifier (`src/fund/AttestationVerifier.sol`)

Checks that a class A price attestation was signed by the platform's attestor key (EIP-712, bound to this chain and this verifier), names a token and a positive price, and is valid for at most 60 seconds. The attestor key signs prices and nothing else; nothing here moves money, and the custody core's cost-basis caps hold whatever the price says. It becomes active only when the TokenRegistry sets it through its 9-day timelock. On Monad testnet it is deployed but not yet active, so class A trades are refused by name until then.

### ProtocolRegistryV3 (`src/fund/ProtocolRegistryV3.sol`)

The deny-by-default list of route adapters and pools (up to 256) that trades may use. Adapters and pools are pinned by code hash, and each venue's code is pinned too, so an upgraded or changed contract fails closed. A v3 pool must be what its own factory returns; a v4 pool must be hookless. Pools come in the same two lanes as tokens: core pools through the timelock, screened pools added at once and usable only by opted-in accounts. Pausing a pool or making it exit-only is instant.

## Testnet helpers

These exist only to make the testnets usable. The first three refuse to deploy on any chain but Monad testnet (10143).

- **TestnetToken** (`script/TestnetToken.sol`): a plain ERC-20 with its whole supply minted to the deployer, no owner, no later mint and no pause. Testnet's TALPHA and TBETA are TestnetTokens, listed as core class F tokens.
- **TestnetFeed** (`script/TestnetFeed.sol`): Chainlink's aggregator read interface with an answer set by one writer key, plus `redate`, which keeps the answer and refreshes its timestamp before an action that needs a fresh price. MON/USD and USDC/USD on testnet are TestnetFeeds at an operator price of 1.00 USD, not the market's; TALPHA and TBETA each have one too.
- **PoolSeeder** (`script/PoolSeeder.sol`): a throwaway contract that created and seeded the hookless native MON/USDC pool on testnet's unofficial Uniswap v4, settling by transfer, never by approval. Only its owner can add or remove liquidity.
- **TestUSDC** (`script/TestUSDC.sol`, Base Sepolia): the platform's 6-decimal test USDC on the L2 testnets; anyone can take 100 a day from its faucet. It refuses every mainnet.

## How a trade flows

1. **The plan.** The agent researches and proposes a plan; the owner approves it in the app. Nothing onchain yet.
2. **The session.** Earlier, the agent's owner registered the agent's session key on ExecutorV3 (`registerSession`). The grant records the current ownership and configuration epochs.
3. **The intent.** The agent's key calls `ExecutorV3.swap` with a typed intent. The Executor checks, in a fixed order: the policy is not paused and the intent is well formed; the route is registered (ProtocolRegistryV3) and the tokens are allowed (TokenRegistry: buyable, not frozen or sell-only, opted in if screened); the session key, epochs and action id are current and unused; the deadline is within 120 seconds; the account is not reduce-only or in vault handover; prices are fresh (OracleAdapterV3, with an attestation for class A); and the trade's size, the daily trade count and turnover are within limits.
4. **The pull.** The Executor calls the account's `executeSwap`. Inside it, the Executor pulls exactly the intent's `amountIn` once and hands it to the RouteAdapter.
5. **The swap.** The RouteAdapter swaps through the registered pools and pays the output straight to the account, keeping nothing. The Executor checks that what arrived meets the intent's minimum.
6. **The account's own checks.** CustodyCoreV3 checks its backstops (25% a trade, 60% a token, 2% slippage, the depeg guard) and the class A cost-basis caps, updates its held tokens, and updates the circuit breaker.
7. **The Executor's post-trade checks.** The 60% position limit, the 5% USDC floor and the class A caps are checked on the new balances. If any check in steps 3 to 7 fails, the whole transaction reverts and the account is unchanged.
8. **The record.** The Executor emits `IntentExecuted` with the amounts, prices and the account's value before and after, which the indexer and the app read.

## Deployed addresses

Explorers: Monad testnet on [MonadVision](https://testnet.monadvision.com), Base Sepolia on [BaseScan](https://sepolia.basescan.org).

### Monad testnet (chain 10143): current set (Colosseum)

The clean redeploy from block 71,070,547, recorded by `scripts/record-monad-deployment.js` in `packages/domain/src/deployments/monad.ts`.

| Contract                         | Address                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| AgentNFT                         | [`0xf5a2Aa3Da4f937fe46c8387266293ef9c5d25E9A`](https://testnet.monadvision.com/address/0xf5a2Aa3Da4f937fe46c8387266293ef9c5d25E9A) |
| ExecutorV3                       | [`0xd34a0842BCc88bca0a311Dec017C896ecf128935`](https://testnet.monadvision.com/address/0xd34a0842BCc88bca0a311Dec017C896ecf128935) |
| RouteAdapter (Executor v3's)     | [`0xa4C449C53b402F1FFD090bd7205594E3D1ac58C6`](https://testnet.monadvision.com/address/0xa4C449C53b402F1FFD090bd7205594E3D1ac58C6) |
| RouteAdapter (fund set)          | [`0x2B601bBab005d83fDa58dAFae2cD9C57AB35bBC6`](https://testnet.monadvision.com/address/0x2B601bBab005d83fDa58dAFae2cD9C57AB35bBC6) |
| TokenRegistry                    | [`0x9003b6bcBa1f749C0287FB95bA9f404a7b34074A`](https://testnet.monadvision.com/address/0x9003b6bcBa1f749C0287FB95bA9f404a7b34074A) |
| ProtocolRegistryV3               | [`0xb16fa2b30478e4554B14Fe20df859C355Cd01EE3`](https://testnet.monadvision.com/address/0xb16fa2b30478e4554B14Fe20df859C355Cd01EE3) |
| OracleAdapterV3                  | [`0x2015dfBB6797B0464482224a52F1Dc60e460ce20`](https://testnet.monadvision.com/address/0x2015dfBB6797B0464482224a52F1Dc60e460ce20) |
| AccountFactoryV3                 | [`0x5dB47FA63814049000BD10eAcE5A9075A919D9DF`](https://testnet.monadvision.com/address/0x5dB47FA63814049000BD10eAcE5A9075A919D9DF) |
| PersonalAccountV3 implementation | [`0xB79e6c6a84662450d105F3c2c47450fA37034F62`](https://testnet.monadvision.com/address/0xB79e6c6a84662450d105F3c2c47450fA37034F62) |
| StrategyVaultV3 implementation   | [`0x8b2127eaad8ba9ad383FEC85502C7c56c385d20A`](https://testnet.monadvision.com/address/0x8b2127eaad8ba9ad383FEC85502C7c56c385d20A) |

Testnet helpers and external contracts this set uses (the helpers are recorded in `evidence/co-u1-monad/testnet-deployment.json` and `evidence/p2-ec/ADDRESSES.md`, not in the address book):

| Contract                                               | Address                                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| AttestationVerifier (not yet active)                   | [`0x4F606Eb32A158eA4a94aDf5aD61b8D1f63198f5C`](https://testnet.monadvision.com/address/0x4F606Eb32A158eA4a94aDf5aD61b8D1f63198f5C) |
| TestnetFeed MON/USD                                    | [`0x4F257aD5E3AE49E0934813c23F5940448d20965E`](https://testnet.monadvision.com/address/0x4F257aD5E3AE49E0934813c23F5940448d20965E) |
| TestnetFeed USDC/USD                                   | [`0x94f797988a94c86dF85bC457027eDF7b4673fD9D`](https://testnet.monadvision.com/address/0x94f797988a94c86dF85bC457027eDF7b4673fD9D) |
| TestnetToken TALPHA                                    | [`0xD4EB3FeF2A9eBE27D59D4188B6D20Bb21220c03c`](https://testnet.monadvision.com/address/0xD4EB3FeF2A9eBE27D59D4188B6D20Bb21220c03c) |
| TestnetFeed TALPHA/USD                                 | [`0x14B6Eb96776a5dbD4DfBB73F931edc86Fa17037A`](https://testnet.monadvision.com/address/0x14B6Eb96776a5dbD4DfBB73F931edc86Fa17037A) |
| TestnetToken TBETA                                     | [`0x57ca16ca75E968Bd3FF712C729e6e5F6940Cc010`](https://testnet.monadvision.com/address/0x57ca16ca75E968Bd3FF712C729e6e5F6940Cc010) |
| TestnetFeed TBETA/USD                                  | [`0x2896cD952b1b5A101e2ad9cCb17b9AE4050DE65a`](https://testnet.monadvision.com/address/0x2896cD952b1b5A101e2ad9cCb17b9AE4050DE65a) |
| PoolSeeder                                             | [`0xA4adD8Adbb6C04De71dC313322913b7084a9424A`](https://testnet.monadvision.com/address/0xA4adD8Adbb6C04De71dC313322913b7084a9424A) |
| USDC (Circle's testnet USDC)                           | [`0x534b2f3A21130d7a60830c2Df862319e593943A3`](https://testnet.monadvision.com/address/0x534b2f3A21130d7a60830c2Df862319e593943A3) |
| WMON                                                   | [`0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`](https://testnet.monadvision.com/address/0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541) |
| ERC-6551 registry                                      | [`0x000000006551c19487814612e58FE06813775758`](https://testnet.monadvision.com/address/0x000000006551c19487814612e58FE06813775758) |
| Tokenbound AccountV3Upgradable                         | [`0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`](https://testnet.monadvision.com/address/0x41C8f39463A868d3A88af00cd0fe7102F30E44eC) |
| Uniswap v4 PoolManager (unofficial testnet deployment) | [`0x451D64ab3b650040d2aE1886602b97ed6eDc643d`](https://testnet.monadvision.com/address/0x451D64ab3b650040d2aE1886602b97ed6eDc643d) |
| Pyth Entropy                                           | [`0x825c0390f379C631f3Cf11A82a37D20BddF93c07`](https://testnet.monadvision.com/address/0x825c0390f379C631f3Cf11A82a37D20BddF93c07) |

### Monad testnet: old Metropolis set

The set the Monad Metropolis submission used, from the `metropolis-hotfix` branch's address book. It includes the earlier v2 contracts (PersonalAccount, AccountFactory, Executor, OracleAdapter, ProtocolRegistry and a Uniswap v4 venue), which the current set leaves out.

| Contract                            | Address                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| AgentNFT                            | [`0x53704d94AF23CF04D2b6212cc071c6Bda6A4DFEF`](https://testnet.monadvision.com/address/0x53704d94AF23CF04D2b6212cc071c6Bda6A4DFEF) |
| ExecutorV3                          | [`0x8727b75ffF16483A462347cF829BF3ffBBcAbfA6`](https://testnet.monadvision.com/address/0x8727b75ffF16483A462347cF829BF3ffBBcAbfA6) |
| RouteAdapter (Executor v3's)        | [`0x6F729E50B7A2Ba738a6a86B595B692cBC2E1a18a`](https://testnet.monadvision.com/address/0x6F729E50B7A2Ba738a6a86B595B692cBC2E1a18a) |
| RouteAdapter (fund set)             | [`0x98954C62ECfcB9ce111a404745EED17b806aD073`](https://testnet.monadvision.com/address/0x98954C62ECfcB9ce111a404745EED17b806aD073) |
| TokenRegistry                       | [`0xDe0997ABe3dd6c79f64FeAfd69CCF3FaE58ed5a0`](https://testnet.monadvision.com/address/0xDe0997ABe3dd6c79f64FeAfd69CCF3FaE58ed5a0) |
| ProtocolRegistryV3                  | [`0x5101D2f94B002e53658aB15Bba411a3Ee16b1650`](https://testnet.monadvision.com/address/0x5101D2f94B002e53658aB15Bba411a3Ee16b1650) |
| OracleAdapterV3                     | [`0xC8b178126a25A4dA9b2E7cc9faF7492051866707`](https://testnet.monadvision.com/address/0xC8b178126a25A4dA9b2E7cc9faF7492051866707) |
| AccountFactoryV3                    | [`0xD8422359414939b365E12caaE3C5f08A3360b7Aa`](https://testnet.monadvision.com/address/0xD8422359414939b365E12caaE3C5f08A3360b7Aa) |
| PersonalAccountV3 implementation    | [`0xDD92990D765d3553CfC35EbC19f487e7d1D9819C`](https://testnet.monadvision.com/address/0xDD92990D765d3553CfC35EbC19f487e7d1D9819C) |
| StrategyVaultV3 implementation      | [`0xeF7890Ce15F50715CD5617D12f97deb7DEbD80D7`](https://testnet.monadvision.com/address/0xeF7890Ce15F50715CD5617D12f97deb7DEbD80D7) |
| AccountFactory (v2)                 | [`0x960c0421c5FEac805187F25D7abc04D971D334B6`](https://testnet.monadvision.com/address/0x960c0421c5FEac805187F25D7abc04D971D334B6) |
| PersonalAccount implementation (v2) | [`0x740D148C9419977f5F7d7965B706b05Ce7Af4376`](https://testnet.monadvision.com/address/0x740D148C9419977f5F7d7965B706b05Ce7Af4376) |
| Executor (v2)                       | [`0xc127997711a3D26a0967724897BCc365934DeC7c`](https://testnet.monadvision.com/address/0xc127997711a3D26a0967724897BCc365934DeC7c) |
| OracleAdapter (v2)                  | [`0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647`](https://testnet.monadvision.com/address/0xa040cAa0529e5dfa48B5d61b78d75967BdBbb647) |
| ProtocolRegistry (v2)               | [`0xddE58ce63f029503804c68B84FF4a1cB81d3081c`](https://testnet.monadvision.com/address/0xddE58ce63f029503804c68B84FF4a1cB81d3081c) |
| Uniswap v4 MON/USDC venue (v2)      | [`0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1`](https://testnet.monadvision.com/address/0xe99aF4DC0E5dF691065D7CC8eb11070BD5B281b1) |

### Base Sepolia (chain 84532)

Deployed by `pnpm deploy:l2 base-sepolia` from block 48,119,589, recorded in `packages/domain/src/deployments/base-sepolia.ts`. Personal accounts only (no vault implementation), priced by Chainlink's ETH/USD and USDC/USD feeds, trading WETH against TestUSDC through one Uniswap v3 pool.

| Contract                            | Address                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| AgentCopyNFT                        | [`0x6Fbf9065B5aE69a9618F898ba6A89C9c0b1397db`](https://sepolia.basescan.org/address/0x6Fbf9065B5aE69a9618F898ba6A89C9c0b1397db) |
| TestUSDC                            | [`0xB9f81f8aD949Ed369f56003Da3d98d097224Ebda`](https://sepolia.basescan.org/address/0xB9f81f8aD949Ed369f56003Da3d98d097224Ebda) |
| ExecutorV3                          | [`0x1335d659Fb202366ded6E7c089d9FAea618081A4`](https://sepolia.basescan.org/address/0x1335d659Fb202366ded6E7c089d9FAea618081A4) |
| RouteAdapter (Executor v3's)        | [`0x0D91231485B1EE60cd589335AB06bBA6f954CAA9`](https://sepolia.basescan.org/address/0x0D91231485B1EE60cd589335AB06bBA6f954CAA9) |
| RouteAdapter (fund set)             | [`0xe21c4B9BBde1EfE617D2eC77226599c66b1EA81A`](https://sepolia.basescan.org/address/0xe21c4B9BBde1EfE617D2eC77226599c66b1EA81A) |
| TokenRegistry                       | [`0xD66f145B8B6c4fc44133d6F1EA48cD41BAf21008`](https://sepolia.basescan.org/address/0xD66f145B8B6c4fc44133d6F1EA48cD41BAf21008) |
| ProtocolRegistryV3                  | [`0x6685695b095AD533162f4498858F659D5bc17f19`](https://sepolia.basescan.org/address/0x6685695b095AD533162f4498858F659D5bc17f19) |
| OracleAdapterV3                     | [`0x7BCa2CAA53605BDF8f3264F2F94Cd8B4FC412220`](https://sepolia.basescan.org/address/0x7BCa2CAA53605BDF8f3264F2F94Cd8B4FC412220) |
| AccountFactoryV3                    | [`0x43E5F10d94CA395D0d466F5170b448784a181cfC`](https://sepolia.basescan.org/address/0x43E5F10d94CA395D0d466F5170b448784a181cfC) |
| PersonalAccountV3 implementation    | [`0x96A882E2Bcc7936b944FE0d4ecB7794a6C2b8d82`](https://sepolia.basescan.org/address/0x96A882E2Bcc7936b944FE0d4ecB7794a6C2b8d82) |
| Uniswap v3 WETH/TestUSDC 0.05% pool | [`0x6DF3a6ddaF73C9EDCea165e0eCA9f4006c00bb8f`](https://sepolia.basescan.org/address/0x6DF3a6ddaF73C9EDCea165e0eCA9f4006c00bb8f) |

### Arbitrum Sepolia (chain 421614)

Not deployed yet: `packages/domain/src/deployments/arbitrum-sepolia.ts` is empty. The same `pnpm deploy:l2` script deploys the Base Sepolia set there.
