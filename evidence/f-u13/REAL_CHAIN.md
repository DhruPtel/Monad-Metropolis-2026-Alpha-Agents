# F-U13: the current contracts on the real chains

Measured on 2026-10-12 against two throwaway deployments of the current (v3) stack: the mainnet canary rerun on P2-EC's CanaryAgent (chain 143, blocks 112870069 to 112873872) and the testnet v3 deployment (chain 10143, from block 70511453), which stopped after its fourth step for funds. Raw records: `canary-deployment.json` (every deployment transaction, read from the chain), `canary-verification.json` (Sourcify), `canary-run.json` (the round trip, step by step), `testnet-run.json` (the testnet run's start; the broadcast records under chains/monad/broadcast hold its transactions). Commands: `pnpm deploy:canary:v3`, `pnpm verify:canary:v3`, `pnpm canary:mainnet:v3`, `pnpm deploy:testnet:v3`, `pnpm test:canary-fork`, `pnpm test:testnet-fork`. P2-EC's readings (evidence/p2-ec/REAL_CHAIN.md) stand where this file does not repeat them: RPC limits, the clock, Entropy, event indexing, the wallet behavior.

## Spend

| | MON | USD at 0.0246 |
| --- | --- | --- |
| Canary v3 deployment (9 transactions, legacy 110 gwei) | 7.4289 | 0.183 |
| Canary round trip (14 transactions, 102 gwei paid) | 0.5727 | 0.014 |
| Canary rerun, total, of its 10 MON budget (D-316, A-96) | 8.0016 | 0.197 |
| Testnet v3 deployment so far (15 transactions, 103 to 105 gwei) | 3.1843 in gas, about 1.00 seeded into the two pools | testnet |
| Testnet v3 deployment, the three steps left (estimated at 110 gwei) | about 6.9 (step 5 Executor v3 and its set 2.85; step 6 AccountFactoryV3 and the binding 3.76; step 7 the verifier and the SET_VERIFIER proposal 0.3) | testnet |

The canary owner ends with 29.1108 MON and 4.999049 USDC: the two swaps cost 0.00045 USDC between them (0.45 USDC bought 18.2313 WMON, sold back for 0.44955 USDC). The testnet deployer holds 4.0950 MON against the 6.9 MON its remaining steps need, so the testnet part is blocked on about 3 MON (HANDOFF.md names the address).

## Gas

Monad charges the gas limit, not the gas used, on both chains (`gasUsed` equals the limit in every receipt below, as in P2-EC). Forge's deployments were sent with a legacy price of 110 gwei on mainnet (the canary) and 103 to 105 gwei on testnet; the round trip's signer and owner transactions paid 102 gwei (base 100 plus a 2 gwei tip, with a 202 gwei cap). The deployments' figures are forge's estimates times D-306's 110% (the canary's "estimates" in `canary-deployment.json`); the real use is close to the testnet fork's `forge --gas-report`.

| Transaction | Mainnet canary gas (limit charged) | MON | Testnet gas (limit charged) | MON |
| --- | --- | --- | --- | --- |
| TestnetToken (each of 2, with its mint) | | | 1,091,599 and 71,391 | 0.1124 and 0.0074 |
| TestnetFeed (each of 2) | | | 756,253 | 0.0779 |
| Pool `initialize` and `addLiquidity` (each of 2 pools) | | | 82,980 and 402,154 | 0.0085 and 0.0414 |
| AgentNFT (NFT-U1's, 34 species) | | | 9,026,204 | 0.9252 |
| TokenRegistry | 5,258,697 | 0.5785 | 5,507,784 | 0.5783 |
| ProtocolRegistryV3 (the fund set's) | 5,617,288 | 0.6179 | 5,548,169 | 0.5826 |
| OracleAdapterV3 (the fund set's) | 2,561,256 | 0.2817 | 2,561,269 | 0.2689 |
| RouteAdapter (the fund set's) | 3,180,609 | 0.3499 | 3,180,581 | 0.3340 |
| ExecutorV3 | 10,209,939 | 1.1231 | not yet | |
| ExecutorSetDeployer (its RouteAdapter and ProtocolRegistryV3 inside) | 9,144,820 | 1.0059 | not yet | |
| OracleAdapterV3 (Executor v3's) | 2,561,256 | 0.2817 | not yet | |
| AccountFactoryV3 (the two implementations inside) | 28,902,740 | 3.1793 | not yet | |
| `executor.bind` | 99,213 | 0.0109 | not yet | |
| Owner: `createPersonalAccount` (v3) | 368,851 | 0.0376 | | |
| Owner: exact USDC `approve` | 96,408 | 0.0098 | | |
| Owner: `deposit` 4.99 USDC (the first deposit) | 481,299 | 0.0491 | | |
| Owner: `registerSession` (Executor v3) | 102,943 | 0.0105 | | |
| Agent: v3 swap through the signer (buy, one hop, two tokens held) | 1,950,000 (F-U4's rule for one hop and two held tokens) | 0.1989 | | |
| Agent: v3 swap (sell) | 1,950,000 | 0.1989 | | |
| Guardian: `pauseAll` | 57,313 | 0.0058 | | |
| Owner: `withdraw` 1 USDC while paused | 235,516 | 0.0240 | | |
| Owner: `revokeSession` | 52,118 | 0.0053 | | |
| Owner: `withdrawAll` | 227,706 | 0.0233 | | |
| Plain MON transfer | 23,100 (21,000 at 110%) | 0.0024 | | |

What differs from P2-EC's v2 set: the custody core is far larger (AccountFactoryV3 with its two implementations 28.9M against 9.3M for the v2 factory), a v3 account's first deposit costs about 100k more (481k against 381k, the deposit ledger and the registered token list), and a swap's limit is 1.95M under F-U4's rule against the v2 signer's fixed 1.3M. The rule's figure held with room: both swaps settled under it; on Monad the limit is what is paid, so a tighter per-route figure would save about 0.05 MON a trade at today's prices (a suggestion for W-2, not a change here).

## Contract size

Every runtime size on mainnet equals the playtest fork's: TokenRegistry 19,517 bytes, ProtocolRegistryV3 19,718, OracleAdapterV3 10,235, RouteAdapter 12,727, ExecutorV3 41,210, AccountFactoryV3 14,231, PersonalAccountV3 41,232, StrategyVaultV3 61,812, ExecutorSetDeployer 463. Four are above Ethereum's 24,576-byte limit and all are under Monad's 128 KB; AgentNFT on testnet is 34,459 bytes as in P2-EC.

## Slippage and the pool against Chainlink

The v4 native MON/USDC pool stood 0.67 bps from the oracle at the start and 17.2 bps when the swaps went. The buy of 0.45 USDC gave 18.2313 WMON, 22.19 bps under the Chainlink price (the pool's 17 bps plus the 5 bps fee), against a floor of 18.1805 (50 bps); the sale of all of it gave 0.44955 USDC, 12.22 bps above the Chainlink price (the pool had been above the oracle), against a floor of 0.446755. Executor v3's floor arithmetic (`floorFor` from OracleAdapterV3's two USD prices at the launch policy's 50 bps) agreed with what the signer sent; both swaps reconciled against the IntentExecuted record and the account's balance deltas.

## Chainlink feeds

MON/USD answered 0.024596 to 0.024628 USD, 3 to 85 seconds old against the registry's 300-second bound. USDC/USD answered 0.99986275 and was 3,119 to 3,204 seconds old against its 3,900-second bound: the feed updates about hourly, so a swap tried in the last twelve minutes of its hour would be refused ORACLE_STALE in simulation (nothing signed) until the next update. The bound of 3,900 seconds is tight for a feed with an hour's heartbeat; PB-U1 should take it from the feed's documented heartbeat plus a margin, or the sentinel will see hourly stale windows (a suggestion, not changed here).

## Finality

`latest`, `safe` and `finalized` for the 14 round-trip transactions, timed from the send:

| | Fastest | Slowest | Typical |
| --- | --- | --- | --- |
| Receipt | 572 ms | 919 ms | about 0.6 to 0.9 s |
| `safe` | 923 ms | 1,243 ms | about 1.0 s |
| `finalized` | 1,174 ms | 1,766 ms | about 1.2 to 1.5 s |

The same as P2-EC's testnet and canary readings. The signer's outbox went accepted, signed, submitted, confirmed, reconciled for both swaps; the run's "confirmed" timer read nothing because the row went from submitted to reconciled between two of the run's 150 ms polls (finalized at 1.4 and 1.8 s stands as the measurement).

## Transaction acceptance and refusals

Every transaction sent was mined in the next block or the one after; none reverted on chain. The two refusals happened in the signer's simulation before anything was signed: the oversized buy (1 USDC on a 4.99 USDC account) as TRADE_SIZE_EXCEEDED and the swap after the guardian's `pauseAll` as PAUSED, both decoded from Executor v3's `Rejected(uint8)` with the v3 reason table (the first 19 reasons are v2's in the same order, so the signer's decoder needed no change). The session key's nonce stayed at 5 through both. The owner's withdrawal of 1 USDC went through while Executor v3 was paused, and `withdrawAll` emptied the account after the grant was revoked.

## The timelock on real chains

The testnet deployment's seventh step deploys the AttestationVerifier and proposes SET_VERIFIER on the TokenRegistry, which executes after the registry's nine-day timelock; on the playtest fork `pnpm deploy:attestor` warps the clock (L-213), on a real chain nothing can, so a class A round trip on testnet or on the canary waits nine days after the proposal. The canary rerun therefore covers class F only; its verifier and proposal were not sent (A-96).

## What testnet lacks

Testnet has no Uniswap v3 and no PancakeSwap v3 (D-248), so the testnet fund set takes the CREATE2 deployer's address as the placeholder for both v3 factories (the registry's constructor refuses the zero address) and registers v4 pools only; the chain tools' v3 quoters resolve to the zero address there and `quoteHop` refuses such a venue. The testnet feeds (TestnetFeed, written by TESTNET_FEED_PRIVATE_KEY on demand, D-307) carry a 30-day maximum age so a deposit or trade does not need a refresh first.

## Explorer verification

All twelve canary v3 contracts verified on Sourcify as `exact_match`, creation and runtime (`canary-verification.json`): the eight CREATE2 deployments from their creation transactions, and the four made inside a constructor (Executor v3's RouteAdapter and ProtocolRegistryV3 by the ExecutorSetDeployer, the two implementations by AccountFactoryV3) from forge's broadcast record of the same transaction, each init code checked to start with our compiled creation code. The testnet v3 contracts are verified once the deployment completes (`pnpm verify:testnet` needs the F-U13 record, a small follow-up).

## End state

The canary account 0x1885a9f8a545382CBfc3d7fFC0E01296D968D873 holds nothing; the guardian and session keys hold 0.00231 MON each (their gas reserve); Executor v3 on the canary stays paused (the admin's UNPAUSE goes through the timelock; the canary is throwaway). On testnet, the tokens TALPHA and TBETA with their feeds and seeded pools, the new AgentNFT, and the fund set are on chain and recorded in the broadcast records; Executor v3, AccountFactoryV3, the binding and the verifier wait for funds.
