# P0-SPEND: where model spend went (2026-10-04 to 2026-10-10)

From LiteLLM's own spend logs (schema `litellm`, 1,644 calls), read on 2026-10-10 with `pnpm spend:report --days=14`. Amounts are LiteLLM's cost per call in USD. Key aliases only; no key is printed anywhere.

## Totals

| | Calls | USD |
| --- | --- | --- |
| All | 1,644 | 28.93 |
| Live checks (keys `aa-live-*`, each run its own namespace) | 1,241 | 27.69 |
| Scripts on the master key (the skill selection check, probes) | 350 | 0.63 |
| Testnet agents (2026-10-08) | 25 | 0.40 |
| Local development (keys `aa-local-*`) | 10 | 0.17 |
| Spikes and probes (2026-10-04 and 10-06) | 18 | 0.04 |

## By day (UTC)

| Day | Calls | USD |
| --- | --- | --- |
| 2026-10-04 | 14 | 0.04 |
| 2026-10-06 | 108 | 1.70 |
| 2026-10-07 | 82 | 1.46 |
| 2026-10-08 | 335 | 5.53 |
| 2026-10-09 | 1,100 | 20.20 |
| 2026-10-10 | 5 | 0.00 (refused) |

## By model alias

| Alias | Model | Calls | USD | Average prompt tokens |
| --- | --- | --- | --- | --- |
| scan-cheap | Claude Haiku 4.5 | 1,228 | 27.98 | 21,985 |
| research-strong | Claude Sonnet 5.5 | 156 | 0.81 | 5,252 |
| narrator | Claude Haiku 4.5 | 234 | 0.14 | 292 |

## By task type

The live checks keep their own test databases, so the platform's records cannot attribute their calls to a lease; the attribution comes from the key alias and the step order of the live script. In each live run the costly steps were the scheduled Scan and the token check (F-U1), which run on `scan-cheap` with the whole tool set and the registry in the prompt: 60 to 90 calls of 22,000 to 47,000 prompt tokens each, none of them a cache read as the spend logs record them. The research cycle's reasoning stages (`research-strong`) cost under 0.10 USD per run. Local development's own scheduled Scans cost 0.17 USD in total; nothing ran locally on a schedule after 2026-10-07.

## The biggest consumers

1. The eight live runs of 2026-10-09 (F-U1 to F-U5), 1.3 to 2.9 USD each, in the hours 15:00, 16:00, 21:00 and 22:00 UTC: namespaces 8bded7 (2.94 in one hour), 13f71c (2.84), f5cc3f (2.12 and 0.85), 8a02f7 (2.12 and 0.40), 5c870f (1.96), c07c74 (1.74), 656dc5 (1.69), db837a (1.32). Together 17.6 USD: the "earlier 20 USD used up quickly".
2. The live run of 2026-10-08 02:00 UTC (namespace 4a1254): 1.98 USD.
3. The costliest single calls were Scan turns with 42,000 to 47,000 prompt tokens: 0.056 to 0.066 USD each.

## What changed (D-369)

- Every task's model calls stop at 10 USD (the gate's `task_cap`), the live run and the pending list stop between steps at 10 USD, the gateway refuses everything past 15 USD a day, scheduled research is off locally unless `SCHEDULED_RESEARCH=on`, and live checks run on the Low tier.
- `pnpm spend:report` prints this report for any window (`--days=N`).
