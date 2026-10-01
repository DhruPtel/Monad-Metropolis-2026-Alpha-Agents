# @alpha-agents/policy

The launch hard limits as typed constants (`LAUNCH_LIMITS`) and pure functions that pre-check a proposed intent against an account snapshot: `checkSwap`, `checkRebalance` (which also plans the legs), `checkDeadline`, `checkOracle`, `windowUsage`, `breakerMode` and `drawdownBps`.

**These are offchain pre-checks. The Executor contract is the final authority** and re-checks every limit onchain. The pre-checks exist to fail fast with a typed reason before anything is signed, and their reason codes feed "why the agent did not trade". At runtime the limits come from the Executor's views for the agent's config epoch; `LAUNCH_LIMITS` is the default.

| Limit                                       | Constant                     | Reason code                            |
| ------------------------------------------- | ---------------------------- | -------------------------------------- |
| Max 10% of account value per trade          | `maxTradeBps` 1,000          | `TRADE_SIZE_EXCEEDED`                  |
| Max 40% in any non-USDC asset after a trade | `maxAssetBps` 4,000          | `CONCENTRATION_CAP`                    |
| At least 10% in USDC after a trade          | `minUsdcBps` 1,000           | `USDC_FLOOR`                           |
| Max 0.5% slippage against the oracle        | `maxSlippageBps` 50          | `SLIPPAGE_TOO_HIGH`                    |
| Rolling 20 trades per 24 hours              | `maxTradesPerWindow` 20      | `DAILY_TRADE_LIMIT`                    |
| Rolling 24-hour turnover, 100% of NAV       | `maxTurnoverBps` 10,000      | `TURNOVER_CAP`                         |
| 2-minute deadlines                          | `deadlineSeconds` 120        | `DEADLINE_EXPIRED`, `DEADLINE_TOO_FAR` |
| Oracle under 5 minutes old                  | `oracleMaxAgeSeconds` 300    | `ORACLE_STALE`                         |
| Oracle within 2% of the pool price          | `oracleMaxDeviationBps` 200  | `ORACLE_POOL_DEVIATION`                |
| Breaker: 10% drop from the 7-day peak       | `breakerReduceOnlyBps` 1,000 | account becomes `REDUCE_ONLY`          |
| Breaker: 20% drop from the 7-day peak       | `breakerPauseBps` 2,000      | account becomes `PAUSED`               |

Rules every check follows:

- A maximum passes at exactly its value and fails one unit above; a minimum passes at exactly its value and fails one unit below. Oracle age is the exception: a price must be strictly under 300 seconds old, so exactly 300 fails (D-151).
- A swap whose output is USDC is exempt from the 40% and 10% checks, and is the only swap allowed in `REDUCE_ONLY` and `WIND_DOWN`. Nothing trades in `PAUSED`, and the agent does not trade a vault in `HANDOVER` (`VAULT_IN_HANDOVER`, D-152).
- A missing, future-dated, non-positive or stale oracle price fails closed.
- Every failing rule is reported, each with a code, the owner-facing message from `REJECTION_MESSAGES` in packages/domain, and a detail line.
- All arithmetic is bigint; no amount passes through floating point.

`BREACH_FIXTURES` holds one swap per limit that breaches exactly that limit by one unit, for the server pre-checks and, later, the contract tests.
