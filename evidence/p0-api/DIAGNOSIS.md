# P0-API: why every model call fails, diagnosed on 2026-10-10

Every model call through LiteLLM has answered `400 invalid_request_error: Your credit balance is too low to access the Anthropic API` since 2026-10-10 03:55 UTC (F-U2 to F-U5 logs). The owner says the key has credit. This records what was checked, in order, with no spending.

## 1. The Anthropic API called directly, not through LiteLLM

The key from `.env` (`ANTHROPIC_API_KEY`, 108 characters, prefix `sk-ant-`, sha256 starting `f4b5b21924ae`) sent to `api.anthropic.com` at 17:3x UTC:

| Request | Result | Request ID |
| --- | --- | --- |
| `POST /v1/messages`, `claude-haiku-4-5`, `max_tokens` 1, one word | 400 `invalid_request_error`: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." | `req_011CftxbcjkW2t2AtSuNHPmu` |
| `POST /v1/messages/count_tokens` (free) | the same 400 | `req_011CftxbeRCE6SCFSN6DR1sm` |
| `GET /v1/models` | 200, 14 models listed | `req_011CftxbfMFfpQE8F25foiiA` |

So the key is valid and authenticates (the model list answers), and the refusal comes from Anthropic's billing check, which runs before the request is even counted. LiteLLM is not in this path.

## 2. The key as LiteLLM loads it

- The container's `ANTHROPIC_API_KEY` (read with `docker exec ... printf "$ANTHROPIC_API_KEY"`, hashed, never printed) has the same sha256 as the trimmed value in `.env`: identical, 108 characters.
- No stray whitespace, no quotes, no trailing carriage return; `.env` has no Windows line endings anywhere.
- `infra/litellm/config.yaml` reads the key as `os.environ/ANTHROPIC_API_KEY` for every alias; `infra/compose.yaml` passes it from the root `.env`. No `api_base` override, so the default `https://api.anthropic.com` is used.
- Model IDs in the config, checked against this key's `GET /v1/models`: `claude-haiku-4-5-20251001` present, `claude-sonnet-5-5` present, `claude-opus-5-5` present. (`claude-haiku-5-5` is also available to the key; the config does not use it.)

## 3. LiteLLM's own budgets and limits

With the master key against the running gateway:

- `/budget/list`: empty. `/global/spend`: `max_budget` 0.0 (none set); 28.93 USD of spend recorded over the project's life.
- `/key/list`: 9 virtual keys, the agent keys with the budgets the orchestrator set from their credits (for example the testnet agent at 7.97 USD with 0.10 spent; the local agent 1 key at 0.00 because it holds no credits), none blocked.
- `/model/info`: the four aliases of the config.
- The smallest request through LiteLLM with the master key (`scan-cheap`, `max_tokens` 1): 400, LiteLLM passing Anthropic's own error through, Anthropic request ID `req_011CftxfKzHkDeVta3MpMiMw`.

LiteLLM's budget refusal has a different shape (`budget_exceeded`, which the gate maps to 402, gate.test.ts); it did not fire. Nothing in LiteLLM blocks these calls.

## 4. Dry run of every request shape (free token counts)

`pnpm test:anthropic:dry-run` (services/orchestrator/src/anthropic-dry-run.ts) builds, for every alias in the LiteLLM config and every model stage of a research cycle, the real request: the cycle's SOUL.md (base soul, tier playbook, the default goal's block and the cycle block) as the system prompt, the stage's prompt as rendered by the orchestrator, and every tool our three tool servers offer (30 tools: chain 11, data 14, platform 5) in Anthropic's tool format, named `mcp__<server>__<tool>` as Hermes names them. It sends each to `/v1/messages/count_tokens`, which costs nothing.

Result on 2026-10-10 17:40 UTC (`evidence/p0-api/dry-run-2026-10-10T17-40-46-895Z.json`): all 16 requests (scan-cheap, narrator, research-strong, research-deep across Scan routine, Scan activation, Dive, Challenge, Zoom out) refused with the same 400 and their own request IDs (`req_011Cfty3vPrAgpsUTPWBvrp5` to `req_011Cfty47WqsBx6CUjzr869B`). The billing check refuses the free endpoint too, so the shapes cannot be proven until the account accepts calls; the script is the first step of `pnpm test:live:pending` and will then record the token count per stage. Hermes' own system text and built-in tools are not reproduced by the dry run.

## 5. Conclusion

The problem is the account, not our configuration: the organization this key belongs to has no usable prepaid credit as Anthropic sees it. The key authenticates, the models exist, the key reaches LiteLLM intact, LiteLLM has no budget of its own in the way, and a direct one-token request with no gateway at all is refused with the same message. Nothing in this repository can change that answer.

## What the owner must do

1. Open console.anthropic.com and look at the organization selector (top left). API keys belong to one organization; credits do too. Find the organization whose Settings > API keys lists the key named for this project (its value starts with `sk-ant-` and its sha256 starts `f4b5b21924ae`; the console shows the key's name and its last characters).
2. In that same organization open Plans & Billing. If the credit balance there is zero or below the minimum, buy credits (or, on an invoiced plan, check that the plan is active). If the credit sits in a different organization than the key, the fix is a key from the organization that holds the credit.
3. If the key sits in a Workspace, open Settings > Workspaces > that workspace > Limits and make sure its monthly spend limit is not zero.
4. If a new key is made: put it in `.env` as `ANTHROPIC_API_KEY=` (no quotes, no spaces), then recreate the gateway so it reads the new value, from the repository root:

   ```
   docker compose -f infra/compose.yaml --env-file .env up -d --force-recreate litellm
   ```

5. Confirm with the free check, then the live run:

   ```
   pnpm test:anthropic:dry-run
   pnpm test:live:pending
   ```

   The first prints a token count per alias and stage instead of the refusal; the second runs every live check that has been waiting.

## 6. No fallback provider

`.env` holds no other model provider's key (its variables: Monad RPC, E2B, Anthropic, LiteLLM, Privy, the chain keys, Tavily, CoinMarketCap, X). OpenRouter would be allowed only for zero-retention routes (D-105, D-353), and no key exists for it, so no fallback was configured. The units continue with recorded model responses in their tests, and every live check waits in `evidence/live-pending.md`, run by `pnpm test:live:pending`.
