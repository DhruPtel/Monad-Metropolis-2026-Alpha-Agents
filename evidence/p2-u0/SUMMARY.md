# P2-U0 Venue and oracle spike: summary

Measured on Monad mainnet (chain 143), read-only. Quotes are pinned at block 110,390,732 (2026-10-04 06:07:27 UTC). Feed and pool history covers the 7 days before it (from block 108,389,571, 2026-09-27 06:07:27 UTC). The full data is in `data.json`, produced by `pnpm spike:venues` (`scripts/spikes/p2-u0/run.ts`). At the pinned block, MON/USD read $0.03465758.

## Recommendations

**Q-01, venue: Uniswap v4, the hookless MON/USDC 0.05% pool** (pool ID `0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954`, currency0 native MON, currency1 USDC, fee 500, tick spacing 10, no hooks). It is the deepest pool and the closest to the oracle:

- It absorbs $22,120 buying MON and $9,743 selling MON within 0.5% of the Chainlink price.
- A $10 or $200 trade would have passed both the 2% deviation rule and the 0.5% slippage rule in 99.0% to 99.2% of the minutes of the last 7 days.
- Its pool price never drifted more than 2% from the oracle. It drifted more than 1% in 0.12% of the minutes.

Two design consequences for P2-U2:

- The pool trades **native MON, not WMON**, so the adapter must wrap and unwrap, or accounts must hold native MON.
- The adapter should call the PoolManager through its own unlock callback rather than the Universal Router, so no Permit2 approval is ever needed. The pool price for the deviation rule comes from `StateView.getSlot0`.

Keep Uniswap v3 USDC/WMON 0.3% (`0x659b...a9da`) as the fallback. It is the route the research de-risked, uses WMON and direct approvals, and holds about $1.52M. But its 0.3% fee uses 30 of the 50 basis points of slippage budget, so a small trade passes only 84% to 86% of the time. Kuru is a close second on execution (98.4% to 98.6% of minutes) with no taker fee. Its drawbacks are that every contract is an upgradeable proxy and its trade prints include outliers up to 13.6% from the oracle. It also needs an orderbook "pool price" definition (A-17), and this report uses the best bid and ask mid.

**Q-02, oracle staleness: the 5-minute rule is met for MON/USD; set staleness per feed.**

- **MON/USD: keep 300 seconds** (strict, D-151). It updated 16,610 times in 7 days, with a median gap of 30 s and a p99 of 91 s. Its age reached 300 s only once (a single 511 s gap), which is 0.035% of the time. The measured deviation trigger is 2 basis points, matching Chainlink's published 0.02%. The 1-hour heartbeat never had to fire.
- **USDC/USD: 3,900 seconds, for the depeg guard only.** It updates only on its 1-hour heartbeat (gaps of 3,601 to 3,609 s, and the 0.05% deviation never triggered). So its age is over 300 s for 91.7% of the time, and the 5-minute rule can never apply to it. This matches the plan (USDC treated as 1, with this feed only for the depeg guard). 3,900 s is the heartbeat plus 5 minutes, and nothing exceeded it in 7 days.
- **ETH/USD: not tradable under the rule.** Its age was over 300 s for 17.5% of the time (gaps up to 3,607 s). Under FINAL_PLAN 4.1.9 the asset stays off the buy list rather than the rule being loosened. It is not a launch asset anyway.

**Q-03, USDC: yes, `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` is Circle's official USDC on Monad.**

- Circle's own address list (https://developers.circle.com/stablecoins/usdc-contract-addresses, checked 2026-10-03) lists this exact address for Monad mainnet. The raw page links it to monadvision.com.
- On chain it is a FiatToken proxy in the ZeppelinOS slot layout. It has name and symbol "USDC", 6 decimals, version "2", a set owner, masterMinter, pauser and blacklister, and `paused` false.
- It does carry blacklist and pause functions. The vault designs that assume one token can fail a transfer (skip or credit on exit) are therefore needed.

**Hard limit and asset list changes the data suggests** (recommendations only; nothing was changed):

1. Make `oracleMaxAgeSeconds` per feed, as FINAL_PLAN 4.1.9 already intends: 300 for MON/USD and 3,900 for USDC/USD's depeg guard. `LAUNCH_LIMITS` holds one global value today.
2. Keep `maxSlippageBps` at 50 if the v4 0.05% pool is chosen. With the v3 0.3% pool, 50 leaves only 20 basis points for the pool-to-oracle gap, and about 1 trade in 7 would be refused. Notably, depth is not the binding constraint at beta sizes; the gap between pool and oracle is.
3. `oracleMaxDeviationBps` at 200 never bound on the chosen pool in 7 days. Tightening it to 100 would refuse about 0.12% of minutes, and would bound manipulated pool prices more tightly. This is optional, for a later decision.
4. The asset list stays USDC and MON.

## Method

- **Addresses:** every address has a recorded source (`sources.ts`). All 14 had code on the fork at the pinned block. The five added to the address book were also checked at block 109,670,000 by `pnpm test:fork`.
  - Planv2's address book supplied USDC, WMON, the feeds, the v3 factory and router, the v4 PoolManager and StateView.
  - Uniswap's deployment pages supplied QuoterV2 (`0x661e...f08d`) and the v4 Quoter (`0xa222...6891`).
  - Kuru's contract page supplied the Router (`0xd651...95CC`), MarginAccount (`0x2A68...90c5`) and MON-USDC market (`0x065C...C394`).
  - Chainlink's reference data (`feeds-monad-mainnet.json`) supplied each feed's aggregator, heartbeat and threshold.
- **Pools:**
  - Uniswap v3: `getPool` for the 0.01%, 0.05%, 0.3% and 1% tiers.
  - Uniswap v4: every `Initialize` event since genesis with currency0 native MON or WMON and currency1 USDC. That found 71 pools: 54 have no liquidity, 12 are hookless with liquidity, and 5 are hooked.
  - Kuru: the Router's `verifiedMarket`.
- **Quotes:**
  - Uniswap: QuoterV2 and the v4 Quoter, as `eth_call` at the pinned block.
  - Kuru: no quote function exists, so the Router's `anyToAnySwap` was simulated with `eth_call` on a local anvil fork, from a test account funded on the fork. USDC was minted through the real FiatToken master minter, and only a direct ERC-20 approval to the Router was given; Kuru's Router needs no Permit2.
  - For each quote, slippage is measured against the Chainlink-implied output (USDC taken as 1), and impact against the pool's own mid price.
- **History:**
  - Feeds: `AnswerUpdated` events from each feed's aggregator, read from Monad's public RPC (`rpc1.monad.xyz`, which serves 100,000-block log ranges; the keyed RPC allows 10). Each event carries its own `updatedAt`. The last 20 rounds of every feed were cross-checked against the aggregator's stored `getRoundData`, with no mismatch.
  - Pools: post-swap prices from `Swap` events (Uniswap) and fill prices from `Trade` events (Kuru), timed by block times interpolated between headers every 50,000 blocks.
  - Pool and oracle were sampled every 60 seconds (10,081 samples).

## Venue depth

Slippage against Chainlink in basis points at the pinned block. Positive is worse than the oracle; negative means the pool was paying more than the oracle price. Impact against the pool mid, including the fee, is in brackets.

| Venue and pool | Fee | Direction | $10 | $100 | $1,000 | $5,000 | Max within 0.5% |
|---|---|---|---|---|---|---|---|
| Uniswap v4 MON/USDC 0.05%, hookless | 5 bp | USDC to MON | -12.2 (5.0) | -12.0 (5.3) | -9.4 (7.9) | 2.1 (19.3) | $22,120 |
| | | MON to USDC | 22.2 (5.0) | 22.5 (5.3) | 25.1 (7.9) | 36.5 (19.3) | $9,743 |
| Uniswap v3 USDC/WMON 0.3% | 30 bp | USDC to MON | 41.8 (30.0) | 42.0 (30.2) | 44.1 (32.3) | 53.4 (41.7) | $3,545 |
| | | MON to USDC | 18.3 (30.0) | 18.5 (30.2) | 20.6 (32.3) | 30.0 (41.7) | $13,620 |
| Kuru MON-USDC orderbook | 0 bp taker | USDC to MON | -4.8 (12.0) | -4.8 (12.0) | 3.1 (19.9) | 12.0 (28.8) | $10,760 |
| | | MON to USDC | 28.7 (12.0) | 28.7 (12.0) | 32.0 (15.3) | 35.9 (19.1) | $9,456 |

The rest of what was found, all in `data.json`:

- **Uniswap v3 0.01% and 0.05% pools:** about $1 and $7 of liquidity, so nothing fits within 0.5%. The 1% pool holds about $2,395 and fails at every size buying MON.
- **Uniswap v4 hookless pools other than the chosen one:** the 0.3% pool (spacing 60) fits only $15 selling MON, and $10 buying already costs 76 basis points. The 1% and 0.9% pools fit at most $7 and $36. The 3%, 0.25% and 0.01% pools fit nothing (their prices sit 0.8% to 4.5% from the oracle). Five pools charge 85% to 99% fees at prices up to 52% from the oracle, and are unusable.
- **Uniswap v4 hooked pools** (excluded by the hookless rule, `notes/morpho-vault.md > 3.3`): one dynamic-fee pool fits $1,619 and $467. The others are thin or far from the oracle.

Pool liquidity at the pinned block:

- Uniswap v3 0.3%: in-range liquidity 2.28e19, holding 1,149,948 USDC and 10,621,894 WMON (about $1.52M).
- Uniswap v4 0.05%: in-range liquidity 1.87e19. The v4 PoolManager holds every pool's tokens together, so per-pool balances are not measured.
- Kuru: best bid 0.034558, best ask 0.034641, a 24-basis-point spread. The market has an AMM vault (`0x838c...34d7`).

## Chainlink feeds (7 days)

| Feed | Published heartbeat and deviation | Updates | Gap p50, p90, p99, max (s) | Measured deviation trigger | Time aged 300 s or more | Time aged 3,900 s or more |
|---|---|---|---|---|---|---|
| MON/USD (`0xBcD7...22fb`) | 3,600 s, 0.02% | 16,610 | 30, 60, 91, 511 | 2.0 bp minimum, 2.5 bp p5 | 0.035% (1 episode) | 0% |
| USDC/USD (`0xf5F1...ebec`) | 3,600 s, 0.05% | 168 | 3,606, 3,607, 3,608, 3,609 | never triggered | 91.7% | 0% |
| ETH/USD (`0x1B14...0A04`) | 3,600 s, 0.05% | 5,663 | 51, 240, 811, 3,607 | 5.0 bp minimum | 17.5% (384 episodes) | 0% |

## Pool against oracle (7 days, every minute)

| Pool | Events | Above 0.5% | Above 1% | Above 2% | Median gap | p99 gap | Max gap | $10 trade passes both rules (buy, sell) |
|---|---|---|---|---|---|---|---|---|
| Uniswap v4 MON/USDC 0.05% | 252,819 | 1.28% | 0.12% | 0% | 5.8 bp | 53.5 bp | 160 bp | 99.1%, 99.2% |
| Uniswap v3 USDC/WMON 0.3% | 35,795 | 0.43% | 0.09% | 0% | 13.6 bp | 35.5 bp | 160 bp | 86.2%, 85.0% |
| Kuru MON-USDC (fill prices) | 329,647 | 1.36% | 0.18% | 0.08% | 7.1 bp | 56.6 bp | 1,359 bp | 98.4%, 98.6% |
| Uniswap v4 MON/USDC 0.3% | 4,702 | 0.40% | 0.06% | 0% | 19.0 bp | 45.3 bp | 161 bp | 42.0%, 40.3% |

"Passes both rules" combines each minute's pool-to-oracle gap with the size's impact at the pinned block. It is an estimate: impact is taken from one block, not re-quoted each minute. On Kuru, the share above 2% comes from individual fills that walked the book (the longest run above 2% was 2 minutes). The pool mid, which the deviation rule would read, is tighter than fill prices.

## Beta caps

At $100 per account and 10% per trade, a trade is at most $10. If every account traded the same way in the same minute, the burst would be at most $200 (10% of the $2,000 platform cap).

- **Uniswap v4 0.05%:** both sizes execute within 0.5% at the pinned block. Over 7 days they would have passed in 99.0% to 99.2% of minutes, with the misses coming from the pool-to-oracle gap, not from depth.
- **Kuru:** both sizes execute; 98.4% to 98.6% of minutes.
- **Uniswap v3 0.3%:** both sizes execute; 84.4% to 86.2% of minutes, because the fee leaves little room for the gap.
- **Headroom:** the largest size inside 0.5% is $3,545 or more on every one of the three venues, so the beta caps are far inside measured depth.

## Limits of this measurement

- **Single block and single week:** quotes come from one block, and history from one week. Depth and the pool-to-oracle gap move over time. P2-U2 should re-quote before pinning its adapter.
- **Liquidity concentration:** not assessed. One or a few LPs can withdraw the v4 0.05% pool's liquidity, and per-pool balances are not readable from the v4 singleton.
- **Timestamps:** pool event times are interpolated between block headers 50,000 blocks apart (about 4 hours). Monad's block time was steady at 0.30 s, so the error is seconds. Feed times are exact.
- **USDC price:** slippage treats USDC as $1, as the plan does. USDC/USD read 0.99995 at the pinned block.
- **Not covered here:** fork fidelity (TB-0, MV-V26) and EIP-1153 (ZR-Z12) are scheduled for W-1. The Permit2 route (TB-T04) is answered in passing: v3 SwapRouter02 and Kuru's Router take direct approvals, and v4 needs none through our own unlock callback.
