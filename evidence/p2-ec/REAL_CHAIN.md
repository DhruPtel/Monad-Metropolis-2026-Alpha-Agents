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

# P2-EC part 2: the mainnet canary

Measured on Monad mainnet (chain 143) on 2026-10-08, from block 111700382 to 111701866, against the throwaway canary (`ADDRESSES.md`, part 2). Raw records: `canary-deployment.json` (every deployment transaction, read from the chain), `canary-run.json` (every run transaction with its timings, both swaps with the market before them, both refusals, the final balances), `canary-verification.json` and `canary-local-only.json`. Commands: `pnpm deploy:canary`, `pnpm verify:canary`, `pnpm canary:mainnet` (with `CANARY_SIGNING_ENABLED=true`), `pnpm canary:local-only`, `pnpm test:canary-fork`. Dollar figures use the Chainlink MON/USD answer during the run, 0.02467491 USD (USDC/USD 0.99986).

The canary did what the unit asks: the buy and the sale settled on the real launch pool through the signer and the Executor within the 50 bps floor, reconciled into the canary ledger and settled at `finalized`; the oversized buy and a swap while paused were refused in simulation with nothing signed; the owner withdrew while the Executor was paused, revoked the grant and withdrew everything. The real-chain difference found is lesson L-145.

## Spend

| | MON | USD |
|---|---|---|
| Deployment (8 transactions) | 2.4551 | $0.06058 |
| Run (14 transactions, with the gas given to the guardian and session key and swept back) | 0.4279 | $0.01056 |
| **Total, against the 10 MON budget (D-316)** | **2.8830** | **$0.07114** |
| USDC lost to the round trip (fee and pool offset) | 0.000501 USDC | $0.0005 |

## Gas

Monad charges the gas limit; every receipt's `gasUsed` equals the transaction's limit, as on testnet (L-136). Fees were the same as testnet's: base fee 100 gwei in every block, priority 2 gwei, so 102 gwei paid, and the signer's maximum of 202 gwei (twice the base plus the tip) stayed under A-38's 500 gwei cap. Owner and guardian limits are 110% of `eth_estimateGas` (D-306); the signer's swap limit is its fixed 1.3M (D-308). Real use is from `pnpm test:canary-fork --gas-report` (forge's Monad EVM on a fork of mainnet).

| Deployment | Gas limit charged (mainnet) | Testnet limit | MON paid | USD | Transaction |
|---|---|---|---|---|---|
| Deploy CanaryAgent | 271,513 |  | 0.0277 | $0.00068 | [`0x30a0e635…`](https://monadvision.com/tx/0x30a0e635b79f3e2621e5368e7b4b991727636c10ea4c4fa059dcd7c3e16c5410) |
| Deploy OracleAdapter | 1,819,673 | 1,819,687 | 0.1856 | $0.00458 | [`0xbd362c81…`](https://monadvision.com/tx/0xbd362c81cba590178966dbb2aabdc00947c0d7122fed063c036aa9b56cc70b5e) |
| Deploy Executor | 7,147,852 | 7,147,852 | 0.7291 | $0.01799 | [`0xb1e87d8d…`](https://monadvision.com/tx/0xb1e87d8d4dcd6e1819f1bdfda65e18cb10a5c4c4543139e6e90cb018535e9072) |
| Deploy UniswapV4MonUsdcAdapter | 1,945,520 | 1,945,507 | 0.1984 | $0.00490 | [`0xaef461c8…`](https://monadvision.com/tx/0xaef461c88769b5019ca9f0528177d3223b4ddff849d5126f9a01e7f84d0c6430) |
| Deploy UniswapV3UsdcWmonAdapter | 922,752 |  | 0.0941 | $0.00232 | [`0xd441753a…`](https://monadvision.com/tx/0xd441753ad6f672d8b5ea4da6981e09c6dcb99f0b8a673588024118b0e4dace2f) |
| Deploy ProtocolRegistry | 2,668,948 | 2,549,665 (v4 only) | 0.2722 | $0.00672 | [`0xb32bf370…`](https://monadvision.com/tx/0xb32bf370a52c3ee9a234e07e4c35307d3e4a0feff020012dc4a58ba9ea4320af) |
| Deploy AccountFactory | 9,194,458 | 9,317,303 | 0.9378 | $0.02314 | [`0x78fbf11b…`](https://monadvision.com/tx/0x78fbf11b2e2f9c6624d46e85ff6d5f82979bad53d85be79b59ff9e84e1612ca6) |
| `executor.bind` | 99,057 | 99,057 | 0.0101 | $0.00025 | [`0x09979d97…`](https://monadvision.com/tx/0x09979d9781b0cdf50b4c3e68432dbc5981b8b716dc89dc583e97300a85baa2be) |

| Run | Gas limit charged (mainnet) | Testnet limit | Real use (mainnet fork, in the call) | MON paid | USD | Transaction |
|---|---|---|---|---|---|---|
| Owner: fund session | 23,100 |  |  | 0.0024 | $0.00006 | [`0x0ffd8e8e…`](https://monadvision.com/tx/0x0ffd8e8e59c42502bb7ecaf4351573c50cbc3562363ec4ff53a8174075ac959e) |
| Owner: fund guardian | 23,100 |  |  | 0.0024 | $0.00006 | [`0x536c2c8b…`](https://monadvision.com/tx/0x536c2c8b61846b22e7a91bcf6b2703b9d1ea23192873849cc4e3e5928f97129d) |
| Owner: createPersonalAccount | 252,948 | 238,449 | 226,983 | 0.0258 | $0.00064 | [`0xbc237f16…`](https://monadvision.com/tx/0xbc237f1632ca3632c3af6bf53a96f3f1cc52182b54a29a0041f81d7ad8b7a79b) |
| Owner: approve (exact) | 96,395 | 87,643 |  | 0.0098 | $0.00024 | [`0x2e188223…`](https://monadvision.com/tx/0x2e188223817e887a07e2ab35a95798f947dc80002536689f701a6a7762a84c27) |
| Owner: deposit | 449,993 | 380,653 | 368,630 | 0.0459 | $0.00113 | [`0x8609119e…`](https://monadvision.com/tx/0x8609119efe7f455c1becf49cbea3c708c9be87c2d4f30d89be55dc3557525a99) |
| Owner: registerSession | 103,042 | 110,853 | 92,723 | 0.0105 | $0.00026 | [`0x08cf24bf…`](https://monadvision.com/tx/0x08cf24bf40d984fe989cb70c98c73dcc720fcf90456a0ef1b4db9f91fe09df24) |
| Session key (signer): buy | 1,300,000 | 1,100,000 (old limit) | 1,094,684 (the account's first swap) | 0.1326 | $0.00327 | [`0xfb4845b0…`](https://monadvision.com/tx/0xfb4845b039fae73be2a848ac791381fc0ef4ad140ca53b2460b333a3c926cb81) |
| Session key (signer): sell | 1,300,000 | 1,100,000 (old limit) |  | 0.1326 | $0.00327 | [`0xe413fa21…`](https://monadvision.com/tx/0xe413fa2123b368b70d4758a671282465b9d8559970700caa500228904e7213fe) |
| Guardian: pauseAll | 57,264 |  | 51,665 | 0.0058 | $0.00014 | [`0xe0b565c9…`](https://monadvision.com/tx/0xe0b565c9978e590500d7a82c15ecc4491419269d0b2b91b4e247175440169ce3) |
| Owner: withdraw 1 USDC while paused | 262,713 |  |  | 0.0268 | $0.00066 | [`0xcd542c3b…`](https://monadvision.com/tx/0xcd542c3b6aff1571efecb61352c5cd16ee3dff1d617daf98581098d6ec9da465) |
| Owner: revokeSession | 52,118 | 55,843 | 46,612 | 0.0053 | $0.00013 | [`0x2d417fa3…`](https://monadvision.com/tx/0x2d417fa3aa8b668ab31d23ab46b460d670316872cba1ffce73675968b1f5b2ce) |
| Owner: withdrawAll | 228,071 | 272,680 | 187,202 | 0.0233 | $0.00057 | [`0x9caa4507…`](https://monadvision.com/tx/0x9caa4507f22e32ae1449bcefc99bd4351096df05e621d15db35909299a219b36) |
| Session: sweep session | 23,100 |  |  | 0.0024 | $0.00006 | [`0xe6b3d8a2…`](https://monadvision.com/tx/0xe6b3d8a23dbc3878917d09ddd4c41575f3f8d6966d43f4a44e295d976ea89049) |
| Guardian: sweep guardian | 23,100 |  |  | 0.0024 | $0.00006 | [`0x957e2e61…`](https://monadvision.com/tx/0x957e2e61d4f71b6f4c1d5d937deb36e7da028546cd7780b1d22344951d7f2071) |

The account's first swap used 1,094,684 gas in the call on the mainnet fork (more than testnet's 1,070,401 on the P2-EC pool; the cause was not measured), about 1.12M with the base and calldata, so the 1.3M limit of D-308 keeps about 14% of margin. Registering a v3 adapter makes the canary's ProtocolRegistry 2,668,948 against testnet's 2,549,665 with one adapter. A 0.45 USDC round trip costs 0.265 MON in gas (about $0.0065), more than ten times what it loses to the pool.

## Slippage and the pool against Chainlink

| | Buy (0.45 USDC for WMON) | Sale (the WMON back) |
|---|---|---|
| Amount in | 0.45 USDC | 18.214812 WMON |
| Amount out | 18.214812 WMON | 0.449499 USDC |
| At the Chainlink price | 18.237149 WMON | 0.449448 USDC |
| Floor (`minAmountOut`, 50 bps under the oracle) | 18.145963 WMON | 0.447200 USDC |
| Slippage against Chainlink | 12.24 bps | -1.13 bps (better than the oracle) |
| Pool against the oracle just before | +7.25 bps | +7.26 bps |
| MON/USD age / USDC/USD age | 21 s / 2755 s | 24 s / 2758 s |

The launch pool sat 7.25 bps above Chainlink during the swaps (it read -4.1 and -6.5 bps in the checks a few minutes earlier), so the buy paid the 5 bps fee plus that offset, 12.24 bps, and the sale came out 1.13 bps better than the oracle. Both stayed well inside the 50 bps floor and the oracle adapter's 200 bps deviation bound. The round trip lost 0.000501 USDC (11 bps).

## Chainlink feeds

| Feed | Update interval (last 12 rounds) | Ages seen during the canary | Adapter bound |
|---|---|---|---|
| MON/USD `0xBcD7...22fb` | 29 to 31 s | 2 to 76 s | 300 s |
| USDC/USD `0xf5F1...Cebec` | 3,605 to 3,607 s | 1,506 to 3,076 s | 3,900 s |

USDC/USD updates once an hour, so its age climbs to about 3,606 s before each update; the 3,900 s bound (A-34) leaves under five minutes for a late round before every deposit and trade is refused as stale (L-145).

## Finality

Timed from the send for the 12 owner, guardian and sweep transactions, and from the outbox's acceptance for the two swaps:

| | Fastest | Slowest |
|---|---|---|
| Receipt | 555 ms | 888 ms |
| `safe` | 902 ms | 1,709 ms |
| `finalized` | 1,150 ms | 1,709 ms |

The signer's outbox, from the canary database: the buy went accepted, signed (+403 ms), submitted (+510 ms), confirmed (+1,109 ms), reconciled (+1,410 ms); the sale signed +371 ms, submitted +474 ms, confirmed +827 ms, reconciled +1,118 ms; both reached `finalized` about 1.7 s after acceptance. No receipt changed when read again at `finalized`. A-40 holds on mainnet as on testnet (D-312).

## Transaction acceptance and refusals

No unknown outcome: every send was taken by the provider and its receipt arrived within 0.9 s. The oversized buy (1 USDC, over 10% of the 5 USDC account) failed in the signer's simulation with `TRADE_SIZE_EXCEEDED` 282 ms after acceptance, and the swap while paused with `PAUSED` after 287 ms; neither has a nonce or a hash in the outbox, and the session key's nonce stayed at 2. The Executor's pause did not touch custody: the owner's 1 USDC withdrawal and `withdrawAll` went through while it was paused.

## RPC

One provider (`MONAD_RPC_URL`, archive-capable, D-314); there is no second mainnet provider, and none was needed. The signer's reconciliation, which reads balances at the trade's block and the one before, worked on it. No RPC error was seen.

## Explorer verification

All eight contracts verified on Sourcify as `exact_match`, creation and runtime (`canary-verification.json`); MonadVision reads Sourcify. Monadscan was not tried: no key is set (D-316).

## Local-only features in the canary

All 12 attempts were refused (`canary-local-only.json`): the orchestrator, indexer and control API refuse `APP_ENV=canary` at start (D-251), the console refuses anything but local, the web app's environment check refuses the canary, the LocalFeed refresher, impersonation and balance writes refuse the mainnet RPC before sending, a steered reveal and a set `BETA_SIGNING_ENABLED` are refused by config, the canary runner's signer has no gas top-up, and the canary signer is pinned to 143.

## End state

| | MON | USDC | WMON |
|---|---|---|---|
| Canary owner `0x170921ED4D5E221CB2294a8a2f8c4afd4FDA2Fa8` | 37.112378866 | 4.999499 | 0 |
| Guardian | 0.00231 (dust) | 0 | 0 |
| Session key | 0.00231 (dust) | 0 | 0 |
| PersonalAccount `0x3c9E54b975EF60EC71989bdA6679bD8a000D6BF8` | 0 | 0 | 0 |

The guardian and session key each keep 0.00231 MON: a send needs its limit times its maximum fee on hand (23,100 at 202 gwei), and Monad charges the limit at the price paid (102 gwei), so the difference stays behind. The Executor is left paused and the grant revoked.
