# P2-EC part 1: the real-chain checklist on Monad testnet

Measured on Monad testnet (chain 10143) on 2026-10-08, from block 69,281,563 to about 69,298,000, against P2-EC's throwaway deployment (`ADDRESSES.md`). Raw records: `deployment.json` (every deployment transaction, read from the chain), `e2e-run-*.json` (the three end-to-end runs: two found bugs, the third passed), `measurements.json` (finality samples, the nonce gap, RPC limits, the clock, Entropy, credit lag), `local-only.json` and `verification.json`. Commands: `pnpm deploy:testnet`, `pnpm verify:testnet`, `pnpm testnet:e2e`, `pnpm testnet:measure`, `pnpm testnet:local-only`, `pnpm test:testnet-fork`.

Every row of BUILD_PLAN's checklist has a measured value below. Differences from the fork that needed a fix are lessons L-134 to L-139.

## Gas

Monad charges the gas limit, not the gas used, and on testnet a receipt's `gasUsed` equals the transaction's gas limit (checked for every transaction below), so a receipt cannot show what a call really used. The real use comes from `pnpm test:testnet-fork --gas-report` (forge's Monad EVM on a fork of testnet). Fees were constant during the run: base fee 100 gwei in every block (`eth_feeHistory` returned 100 gwei for every block it was asked about), priority fee 2 or 3 gwei, so 102 or 103 gwei paid. Pyth's provider paid 120 gwei for its callback.

| Transaction | Gas limit charged (testnet) | Real use (testnet fork) | Fork figure (`GAS.md`) | MON paid |
|---|---|---|---|---|
| Deploy TestnetFeed (each of 2) | 756,307 and 756,225 | | | 0.0779 each |
| Deploy PoolSeeder | 1,796,843 | | | 0.1851 |
| Pool `initialize` (through the seeder) | 83,348 | | | 0.0086 |
| USDC transfer to the seeder | 110,567 | | | 0.0114 |
| `addLiquidity` (0.5 MON, 0.459 USDC) | 395,672 | | | 0.0408 |
| Deploy AgentNFT | 8,706,974 | | 7,789,441 used | 0.8968 |
| Deploy OracleAdapter | 1,819,687 | | 1,626,102 used | 0.1874 |
| Deploy Executor | 7,147,852 | | 6,394,228 used | 0.7362 |
| Deploy v4 adapter | 1,945,507 | | 1,738,720 used | 0.2004 |
| Deploy ProtocolRegistry (v4 only) | 2,549,665 | | 2,386,106 used (with v3) | 0.2626 |
| Deploy AccountFactory (and the PersonalAccount implementation) | 9,317,303 | | 8,335,628 used | 0.9597 |
| `executor.bind` | 99,057 | | 89,115 used | 0.0102 |
| Owner: `mintWithClaim` | 337,910 | 334,091 in the call | 334,091 | 0.0348 |
| Owner: credits (USDC transfer to the funding address) | 100,516 | | 100,106 to 100,310 (L-122) | 0.0104 |
| Owner: `createPersonalAccount` | 238,449 | 235,413 in the call | 235,194 | 0.0246 |
| Owner: exact USDC `approve` | 87,643 | | | 0.0090 |
| Owner: first `deposit` (0.5 USDC) | 380,653 | 340,643 in the call | 194,096 to 244,224 | 0.0392 |
| Owner: `registerSession` (arm) | 110,853 | 109,834 in the call | 109,123 | 0.0114 |
| Owner: `revokeSession` (disarm) | 55,843 | | | 0.0058 |
| Owner: `withdrawAll` | 272,680 | 170,202 in the call | 171,852 to 309,206 | 0.0281 |
| Keeper: `requestReveal` (plus the Entropy fee) | 172,939 | | | 0.0176 + 0.1282 fee |
| Keeper: `reveal` (one agent) | 54,853 | | | 0.0056 |
| Pyth's callback (paid by Pyth's provider) | 126,324 | | | 0.0152 (not ours) |
| Feed `redate` | 42,601 | | | 0.0043 |
| Plain MON transfer | 21,000 | 21,000 | | 0.0021 |
| Agent: swap through the signer and the Executor | 1,100,000 (the signer's fixed limit) | 1,070,401 in the call for an account's first swap (a buy); 975,571 for a later sale | 1,036,200 (a buy) | 0.1122 |

Forge's estimates on testnet ran about 1.6% above the fork's gas used, then times the 110% multiplier of D-306. All 13 deployment transactions cost 3.65 MON in gas (4.15 MON from the deployer with the 0.4975 MON pool seed).

**What changed.** The swap limit of 1.1M (A-38) left about 3,000 gas of margin on an account's first swap (1,070,401 in the call plus the 21,000 base and calldata), so it is now 1.3M (L-138). The USDC transfer limit of 150,000 (A-41) holds: transfers cost 100,504 to 100,567. A-38's fee caps hold: the signer's 202 gwei maximum fee (twice the base plus the tip) is under its 500 gwei cap, and the trade flow's gas check at that price needs 0.26 MON for a 1.3M swap. A-50's warning moves from 0.05 to 0.1 MON (L-139): a deposit with its approval alone costs 0.048 MON, and a first account, deposit and arming 0.084 MON.

## Contract size

Every deployment succeeded, and every runtime size on testnet equals the fork's: AgentNFT 34,459 bytes (init code about 38.6 KB), Executor 28,590, AccountFactory 12,557, PersonalAccount implementation 23,514, ProtocolRegistry 9,211, v4 adapter 7,589, OracleAdapter 7,076, TestnetFeed 2,125. AgentNFT and the Executor are above Ethereum's 24,576-byte limit and well under Monad's 128 KB.

## Finality

`latest`, `safe` and `finalized` for 14 testnet transactions (9 in the end-to-end runs, 5 self-transfers in `measurements.json`), timed from the send:

| | Fastest | Slowest | Typical |
|---|---|---|---|
| Receipt | 570 ms | 1,038 ms | about 0.9 s |
| `safe` | 661 ms | 1,396 ms | about 1.0 to 1.1 s |
| `finalized` | 1,230 ms | 1,683 ms | about 1.3 to 1.5 s |

No receipt changed or disappeared when read again at `finalized`. Block time was 302 ms (1,000 blocks). A-40 holds: settling a trade only at `finalized` costs about half a second over the receipt, and the signer's outbox went from submitted to reconciled in 1.5 s. The 12.5 s from the owner's approval to `reconciled` is mostly the trade flow's 5-second polling and its re-checks at submission.

## Transaction acceptance

The signer saw no unknown outcome: its one swap went accepted, signed (0.5 s), submitted (0.12 s), confirmed (1.2 s), reconciled (0.3 s). One deliberate nonce-gap send (nonce 17 while the account's next was 14) was accepted by the keyed provider with a transaction hash, and 20 seconds later `eth_getTransactionByHash` and the receipt both answered null: an accepted transaction can be invisible, as the spec expected, so the signer's rule of never treating an absence as a verdict holds. (The gap stays open on the throwaway test wallet; its next three transactions would let this zero-value self-transfer through.)

## RPC limits

| | Keyed provider (`MONAD_TESTNET_RPC_URL`, a free plan) | Public `testnet-rpc.monad.xyz` (the browser's) |
|---|---|---|
| `eth_getLogs` range | at most 10 blocks ("Under the Free tier plan ... up to a 10 block range", code -32600) | 100 blocks (code -32614 above that) |
| A burst of 40 `eth_blockNumber` | 40 of 40 answered | 40 of 40 answered |
| Sustained rate | about 19 requests a second passed for about 40 seconds, then HTTP 429 to most requests for about ten minutes | not measured beyond the burst |
| Historical state | balances 200,000 blocks back and calls 1,000 blocks back answered | the same |
| `eth_feeHistory` | answers; the base fee is 100 gwei in every block | the same |

Two fixes followed. The indexer halved a refused range and grew it back into the refusal on every other step, so it now learns the provider's cap (L-134). The stack's chain polling, tuned for the fork, made about 19 requests (about 650 compute units) a second on testnet and was rate-limited, which stopped every chain tool, the keeper and the trade flow for about ten minutes and made a chain check propose nothing; off the fork the indexer now steps at most every 2 seconds and the keeper, credits and trade flow poll every 5 seconds, which measured 7.5 requests a second with no 429 over two minutes (L-135). The signer's reconciliation, which reads balances before and after the trade's block, worked on the keyed provider. Error classes seen: 429 rate limit (reported by viem as "HTTP request failed"), -32600 range refused, and on the first deploy run only, forge's stale broadcast record (L-136).

## Wallet behavior

Not exercised with MetaMask or OKX in this session (that is the owner's playtest, the next step). The end-to-end run logged in to Privy with Sign-In with Ethereum, as Privy's SDK does, with the throwaway test wallet on chain 10143: Privy accepted the login and linked the wallet, and every owner route of the control API accepted the resulting token.

## Entropy delivery

One reveal batch (agent 1). The keeper waited out its 60-second batch window, then `requestReveal` (block 69,289,294) paid Pyth Entropy's fee of 0.12816 MON; Pyth's provider (`0xeea5...6bf4`) called back 4 blocks and about 1 second later (block 69,289,298); the keeper's `reveal` landed in block 69,289,303, 2.4 seconds after the request. No re-request was needed. Mint to revealed was 71 seconds, of which 60 are the batch window.

## Event indexing

The mint was indexed 1.9 s after it was sent (before the polling was paced); with the paced indexer (one step at most every 2 s, up to 10 blocks a step), a credit was credited 3.7 s after it was sent (receipt at 0.6 s). No reorg or rewind was reported in about 17,000 blocks indexed. Two confirmations on `latest` were enough here; since `finalized` comes about 1.3 s after a receipt, following `finalized` instead would add about a second.

## Clock

Block timestamps are whole seconds. Over 10 samples the wall clock read 55 to 960 ms ahead of the latest block's timestamp, which is that rounding, not drift: no skew beyond a second. The 120-second trade deadline and the 300-second staleness bound have ample room. TestnetFeeds are re-dated by chain time (D-307).

## Explorer verification

All ten contracts verified on Sourcify as `exact_match` with the repository's compiler settings and no optimizer (D-256): creation and runtime both, except the USDC/USD TestnetFeed, whose runtime equals the MON/USD feed's and which Sourcify reports as a runtime match only. Links are in `ADDRESSES.md`; MonadVision reads Sourcify. No Monadscan key was provided, so Monadscan was not tried.

## Local-only features on testnet

All 17 attempts were refused (`local-only.json`): the LocalFeed refresher, impersonation (`sendAs`, which gained its own guard in this unit) and balance writes refuse the testnet RPC before sending; a steered reveal is refused by config; the console and the test stacks' mock login refuse `APP_ENV=testnet`; the orchestrator's dev routes do not exist with dev actions off; the fork's gas top-up is wired only for local (a code check); the signer is pinned to 10143.
