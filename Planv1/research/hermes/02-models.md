# 02. Hermes Agent: Models and Providers

| Field | Value |
|---|---|
| Commit | `085d9ee608893bb0611c2fc339c19d8848af9f2b` |
| Commit date | 2026-09-25 |
| Release tag | `v2026.9.24` (HEAD is past it) |
| License | MIT |
| Scope | Provider abstraction, custom endpoints (our LiteLLM gateway), auxiliary models, per-task routing, token/cost/context management, caching, retries and fallback, request metadata, request contents |

Labels: **Verified** means seen in code or in-repo docs (with path). **Inferred** means my reasoning about likely behavior.

---

## 1. TL;DR

- **Verified.** Hermes has a first-class `custom` provider plus "named custom providers" (`providers:` dict in `config.yaml`) for any OpenAI-compatible endpoint. Base URL, key (literal, `${VAR}`, `key_env`, or a `key_cmd` that mints tokens), extra headers, extra body, per-model context length, and prompt-caching capability are all configurable.
- **Verified.** Auxiliary side tasks (compression, titles, vision, web extract, session search, curator, background review, approval, MCP, etc.) default to `provider: auto`. Since a recent change, `auto` routes to **the main provider and model first**. The built-in "discovery chain" (OpenRouter, Nous, Anthropic, and so on) only runs when no main provider is selected at all (`agent/auxiliary_client.py::_discovery_chain_allowed`). **Exception:** vision auto-routing has no such gate (details in section 4.3).
- **Verified.** Metadata lookups (models.dev, OpenRouter `/api/v1/models`, endpoint `/models`) are HTTP GETs with no prompt content. They leak nothing about skills, but they need egress or they fail open. You can pin `model.context_length` and `models_dev.url` to avoid them.
- **Verified.** There is no Hermes-side spend cap. Cost for a custom endpoint is usually "unknown" locally. LiteLLM must be the source of truth for budgets, and Hermes treats HTTP 402 as non-retryable.
- **Verified.** By default Hermes sends no `user` field and no session header to custom endpoints. You can attach an agent ID through `providers.<name>.extra_headers` (applied to main and auxiliary clients) or `extra_body` (main turn only, see caveat). The per-agent LiteLLM virtual key is itself the most robust meter.
- **Verified.** Every main request carries the full system prompt: SOUL.md, guidance, context files, the skills index (names and descriptions), memory, and auto-loaded skill bodies. It also carries every tool schema and the whole transcript, including skill bodies returned by `skill_view`. Everything that reaches the gateway also reaches the upstream model vendor.

---

## 2. How the provider layer is abstracted

### 2.1 Layers (Verified)

| Layer | Where | Role |
|---|---|---|
| `ProviderProfile` dataclass | `providers/base.py` | Declarative description of a provider: `name`, `api_mode`, `env_vars`, `base_url`, `models_url`, `auth_type`, `default_headers`, `default_aux_model`, `supports_prompt_cache_key`, plus hooks (`prepare_messages`, `build_extra_body`, `build_api_kwargs_extras`, `fetch_models`, `get_max_tokens`, `create_client`, `classify_api_error`, `get_usage_cost`) |
| Registry | `providers/__init__.py` (`register_provider`, `get_provider_profile`, `list_providers`) | Lazily discovers profiles from `plugins/model-providers/<name>/` and user overrides at `$HERMES_HOME/plugins/model-providers/<name>/` (`providers/README.md`) |
| Runtime resolver | `hermes_cli/runtime_provider.py`, `runtime_provider_custom.py`, `runtime_provider_backends.py` | Turns config, env, and CLI args into `{provider, api_mode, base_url, api_key, source, extra_headers, request_overrides, ...}`. Precedence: explicit CLI/runtime, then `config.yaml`, then env, then defaults (`website/docs/developer-guide/provider-runtime.md`) |
| Transports (wire formats) | `agent/transports/` | `chat_completions` (`chat_completions.py`), `anthropic_messages` (`anthropic.py`), `codex_responses` (`codex.py`), `bedrock_converse` (`bedrock.py`), plus a Codex app-server subprocess path. Each is registered via `register_transport(...)` |
| Adapters | `agent/anthropic_adapter.py`, `bedrock_adapter.py`, `gemini_native_adapter.py`, `vertex_adapter.py`, `codex_responses_adapter.py`, `azure_identity_adapter.py` | Native SDK translation |
| Auxiliary router | `agent/auxiliary_client.py` (8.2k lines) | Resolves clients for side tasks (section 4) |
| Main request build | `agent/turn_request_assembly.py` (messages), `agent/turn_api_request.py::build_api_request` (kwargs, headers, middleware, hooks) | Per-attempt assembly |

The transport's `_build_kwargs_from_profile` in `agent/transports/chat_completions.py` calls `profile.prepare_messages()`, `profile.build_extra_body()` and `profile.build_api_kwargs_extras()`. It then merges `request_overrides` (which is where a custom provider's `extra_body` lands) and finally adds `prompt_cache_key` only if the profile opts in (Verified).

### 2.2 Supported providers (Verified: `plugins/model-providers/*/__init__.py`, `cli-config.yaml.example` lines 62-94)

| Provider id(s) | api_mode | Credential env vars |
|---|---|---|
| `custom` (aliases `ollama`, `local`, `vllm`, `llamacpp`) and named `custom:<name>` | chat_completions (configurable) | user-configured (`api_key`, `key_env`, `key_cmd`) |
| `openrouter` | chat_completions | `OPENROUTER_API_KEY` |
| `nous` | chat_completions, or anthropic_messages for Portal Claude | `NOUS_API_KEY` or OAuth |
| `anthropic` | anthropic_messages | `ANTHROPIC_API_KEY`, `ANTHROPIC_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| `openai-codex` | codex_responses | OAuth |
| `gemini` | chat_completions (native Gemini client on Google host) | `GOOGLE_API_KEY`, `GEMINI_API_KEY` |
| `vertex` | chat_completions | GCP auth |
| `bedrock` | bedrock_converse (or AnthropicBedrock / Mantle) | boto3 |
| `azure-foundry` | chat_completions or anthropic_messages | `AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_BASE_URL`, Entra ID |
| `xai` | codex_responses | `XAI_API_KEY` |
| `meta-ai` | codex_responses | `MODEL_API_KEY`, `META_API_KEY` |
| `router` (Ramp) | codex_responses | `RAMP_ROUTER_API_KEY` |
| `ai-gateway` (Vercel) | chat_completions | `AI_GATEWAY_API_KEY` |
| `copilot`, `copilot-acp` | chat_completions / external process | GitHub tokens / CLI |
| `minimax`, `minimax-cn`, `minimax-oauth` | anthropic_messages | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` |
| `commandcode`, `commandcode-anthropic` | chat_completions / anthropic_messages | `COMMANDCODE_API_KEY` |
| `alibaba` (+cn, token-plan), `alibaba-coding-plan` (+cn) | chat_completions | `DASHSCOPE_API_KEY`, etc. |
| `deepseek`, `deepinfra`, `fireworks`, `gmi`, `huggingface`, `kilocode`, `kimi-coding` (+cn), `nebius-token-factory`, `novita`, `nvidia`, `ollama-cloud`, `opencode-zen`, `opencode-go`, `qwen-oauth`, `stepfun`, `upstage`, `xiaomi`, `zai`, `arcee`, `actual` | chat_completions | one `<VENDOR>_API_KEY` each |
| `lmstudio`, `tencent-tokenhub`, `tencent-tokenplan` | chat_completions | registered in `hermes_cli/auth.py` rather than as plugins (per the docs lists) |
| `moa` | virtual (Mixture of Agents preset) | the preset's slots |

---

## 3. Pointing Hermes at our LiteLLM gateway

### 3.1 Two supported shapes (Verified)

**A. Bare `custom` on the `model:` block** (`hermes_cli/runtime_provider_backends.py::_resolve_openrouter_runtime`, the "bare custom" branch). The base URL comes from `model.base_url`, and the key from `model.api_key` (supports `${VAR}`), `model.key_env`, or host-gated env keys. `OPENAI_BASE_URL` never selects the endpoint. The code comment says "config.yaml is the single source of truth for endpoint URLs". `CUSTOM_BASE_URL` does override it.

**B. Named custom provider** (recommended). This is the `providers:` dict (`hermes_cli/runtime_provider_custom.py::_match_new_style_provider`, `_resolve_named_custom_runtime`). Recognized keys (`hermes_cli/config_providers.py::_KNOWN_PROVIDER_KEYS`): `name, api/url/base_url, api_key, key_env, api_key_env, key_cmd, api_mode/transport, model/default_model, models, context_length, rate_limit_delay, request_timeout_seconds, stale_timeout_seconds, discover_models, extra_body, extra_headers, capabilities, ssl_ca_cert, ssl_verify, catalog_provider, session_affinity_header`. You reference it from `model.provider` as `custom:<key>` (`hermes_cli/providers.py::custom_provider_slug`) or by the bare key when that key does not shadow a built-in (`_shadowed_by_builtin`).

Key precedence for a named entry (Verified, `_resolve_named_custom_runtime`): explicit `--api-key`, then `api_key`, then the `key_env` variable, then host-gated env keys. `key_cmd` (a command that prints a token, cached until expiry) wins over inline keys and is applied to main and auxiliary calls (`cli-config.yaml.example` lines 212-228, `agent/command_token_source.py`).

Key leak guard (Verified, `hermes_cli/runtime_provider.py::_host_gated_env_key_candidates`): `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `OLLAMA_API_KEY` are only sent to their own hosts, or `OPENAI_API_KEY` to the exact `OPENAI_BASE_URL`. A `<VENDOR>_API_KEY` is derived from the hostname label, for example `LITELLM_API_KEY` for `litellm.example.com` (`_host_derived_api_key`).

### 3.2 Example config for one agent sandbox (Inferred composition of Verified keys)

```yaml
model:
  provider: "custom:gw"            # named entry below
  default: "research-strong"       # LiteLLM model alias
  # streaming: true                # default

providers:
  gw:
    base_url: "https://llm-gw.internal.example/v1"
    key_env: "AGENT_LLM_KEY"       # per-agent LiteLLM virtual key, injected into sandbox env
    api_mode: chat_completions
    discover_models: false         # do not probe /models for the picker
    models:
      research-strong: { context_length: 200000, prompt_caching: true }
      scan-cheap:      { context_length: 128000 }
    extra_headers:                 # main + auxiliary clients on this route
      x-agent-id: "agent-0xabc"
      x-agent-tier: "pro"
    session_affinity_header: x-litellm-session-id
    extra_body:                    # main turn only (see 3.4)
      user: "agent-0xabc"
      metadata: { agent_id: "agent-0xabc" }

auxiliary:                         # pin every side task to the gateway explicitly
  compression:      { provider: "custom:gw", model: "scan-cheap" }
  title_generation: { enabled: false }
  vision:           { provider: "custom:gw", model: "scan-cheap" }
  web_extract:      { provider: "custom:gw", model: "scan-cheap" }
  session_search:   { provider: "custom:gw", model: "scan-cheap" }
  curator:          { provider: "custom:gw", model: "scan-cheap" }
  background_review: { enabled: false }

delegation:
  provider: "custom:gw"
  model: "scan-cheap"

models_dev:
  url: "https://llm-gw.internal.example/models-dev.json"   # or an unreachable URL; lookups fail open

fallback_providers:
  - provider: "custom:gw"
    model: "scan-cheap"
```

Notes:
- The `models.<id>.context_length` and `prompt_caching` per-model keys are Verified in docs (`website/docs/user-guide/configuring-models.md`, "Per-provider request options") and code (`get_custom_provider_context_length`, `get_custom_provider_model_capability`).
- Whether a named provider key works verbatim as an `auxiliary.<task>.provider` value is Verified at the resolver level (`_resolve_named_custom_branch` in `auxiliary_client.py`). Exact end-to-end behavior per task is not tested here. This belongs in a spike.
- LiteLLM prompt caching for Claude: `agent/agent_runtime_helpers.py::anthropic_prompt_cache_policy` auto-enables envelope-style `cache_control` markers when the model name contains `claude` and the route is LiteLLM. "LiteLLM" means the token `litellm` appears in the provider id or hostname (`_is_litellm_route`). Otherwise set `prompt_caching: true` per model.

### 3.3 Env vars (Verified)

| Var | Effect |
|---|---|
| `CUSTOM_BASE_URL` | Overrides the base URL for the bare custom resolver (`runtime_provider_backends.py`) |
| `OPENAI_BASE_URL` | Does NOT pick the endpoint. It only scopes which host may receive `OPENAI_API_KEY`. It is still read by some non-chat tools (TTS `tools/tts_streaming.py`, mem0 plugin `plugins/memory/mem0/_openai_llm.py`) |
| `OPENAI_API_KEY` | Sent to OpenAI hosts or the exact `OPENAI_BASE_URL` only |
| `HERMES_INFERENCE_PROVIDER` | Lowest-precedence provider request (`runtime_provider.py` line ~487) |
| `HERMES_API_TIMEOUT` (1800s), `HERMES_API_CALL_STALE_TIMEOUT` (90s) | Legacy timeouts, overridden by `providers.<name>.request_timeout_seconds` / `stale_timeout_seconds` |
| `HERMES_DUMP_REQUESTS` | Dumps full request payloads to disk (`agent/turn_api_request.py`) |

Programmatic: `AIAgent(base_url=..., api_key=..., provider=..., api_mode=..., model=..., request_overrides=..., fallback_model=...)` (Verified, `agent/agent_init.py::init_agent` signature).

### 3.4 What could bypass the configured endpoint

| Path | Default behavior | Risk for us | Evidence |
|---|---|---|---|
| Auxiliary text tasks with `provider: auto` | Main provider and model first, then `auxiliary.<task>.fallback_chain`, then top-level `fallback_providers`. The discovery chain (OpenRouter, Nous, custom, Codex, API-key providers) runs **only if** the main provider is empty or `auto` | Low if `model.provider` is set. Pin tasks explicitly anyway | Verified: `auxiliary_client.py::_resolve_auto_route`, `_discovery_chain_allowed` |
| Aux payment/connection fallback (402) | Same discovery gate | Low | Verified: `_try_payment_fallback` |
| **Vision `auto`** | Main provider if it is a vision backend and the model supports vision, else **OpenRouter, then Nous, then DeepInfra**, with no discovery gate | Only fires if those credentials exist. Pin `auxiliary.vision` and keep no other provider keys in the sandbox | Verified: `_vision_auto_route` |
| Iteration-limit summary | Uses the primary client (`_ensure_primary_openai_client`) | None | Verified: `chat_completion_helpers.py::_chat_summary_attempt` |
| Curator, background review | Resolved like an auxiliary slot (`curator`, `background_review`) | Pin or disable | Verified: `agent/curator.py::_resolve_review_provider` |
| Subagents (`delegate_task`) | Inherit the parent's provider unless `delegation.provider/model/base_url/api_key` is set. The LLM cannot choose a model per call (task schema fields are `goal, context, output_schema, images, group`) | None | Verified: `tools/delegate_tool.py` (schema), `tools/delegate_tool_config.py` |
| Cron jobs | Per-job `model`, `provider`, `base_url` fields. Otherwise the main config | Only if a job is created with another provider | Verified: `cron/jobs.py` (field normalizers ~line 1670) |
| MoA (`moa` provider) | Reference and aggregator slots may name any provider | Do not enable | Verified: `agent/moa_*`, `auxiliary_client.py::_resolve_moa_aggregator` |
| models.dev catalog | GET `https://models.dev/api.json` (override `models_dev.url`). Hot paths use `allow_network=False`. Vision-capability checks and `/model` pickers may fetch | Metadata only, no prompts. Needs egress or fails open | Verified: `agent/models_dev.py` (`MODELS_DEV_URL`, `_get_models_dev_url`, `fetch_models_dev`), `agent/image_routing.py::_probe_models_dev` |
| OpenRouter model catalog | GET `OPENROUTER_MODELS_URL` from `fetch_model_metadata()`. Used for context length only when the provider is unknown or openrouter/nous, and for OpenRouter pricing | Metadata only. For `custom` it is skipped when an endpoint or config value answers first | Verified: `agent/model_metadata.py::fetch_model_metadata`, `get_model_context_length` steps 0-9 |
| Endpoint `/models` probe | GET `{base_url}/models` with the Bearer key, for context length and pricing. Also local-server probes (`/props`, `/api/show`) for local endpoints | Goes to our gateway. Harmless | Verified: `fetch_endpoint_model_metadata`, `_resolve_custom_endpoint_context_length` |
| Non-LLM model APIs (TTS, STT, image/video gen, embeddings in memory plugins) | Own clients and base URLs | Out of scope for chat, but these bypass the gateway if enabled. Disable those toolsets or plugins | Verified: `tools/tts_streaming.py`, `tools/transcription_cloud.py`, `plugins/image_gen/*`, `plugins/memory/mem0/_openai_llm.py` |
| OpenRouter attribution headers | `HTTP-Referer`, `X-Title`, `X-OpenRouter-Categories` only for OpenRouter | None | Verified: `auxiliary_client.py` `_OR_HEADERS_BASE` |
| Nous Portal tags | `extra_body.tags = ["product=hermes-agent", ...]` only for Nous | None | Verified: `agent/portal_tags.py` |

**Inferred.** Our design has deny-by-default egress with only the gateway allowlisted, no other provider credentials in the sandbox, and `model.provider` pinned. Under that design, no chat or auxiliary LLM call can reach another vendor. The worst case is a failed metadata GET (fail-open) or a skipped side task (logged warning).

**Caveat (Inferred from absence):** a custom provider's `extra_body` becomes `request_overrides` on the main agent (`runtime_provider_custom.py::_custom_provider_request_overrides`, `agent/agent_init.py::_merge_custom_provider_extra_body`). The auxiliary call builder, however, only merges `auxiliary.<task>.extra_body` (`auxiliary_client.py::_get_task_extra_body`, `_build_call_kwargs`). I found no path that carries the provider-level `extra_body` into aux calls. Use headers for anything that must be on every call, or repeat it under each `auxiliary.<task>.extra_body`.

---

## 4. Different models for different tasks

### 4.1 Main model (Verified)
One per session, from `model.default` / `model.provider`. `/model <name> [--once|--global]` switches mid-session (`hermes_cli/model_switch.py`). A switch resets the prompt cache (`website/docs/user-guide/configuring-models.md`). `model_aliases:` can bind a name to `(model, provider, base_url, api_key|key_env)`.

### 4.2 Auxiliary slots (Verified: `hermes_cli/main_provider_setup.py::_AUX_TASKS`, `cli-config.yaml.example` lines 831-972)
`vision, compression, approval, mcp, title_generation, review, memory_query_rewrite, tts_audio_tags, skills_hub, triage_specifier, kanban_decomposer, profile_describer, curator`. The code also has `web_extract, session_search, background_review, goal_judge, monitor, moa_reference, moa_aggregator, kanban_estimator`. Plugins can register more (`PluginContext.register_auxiliary_task`). Each slot accepts `provider, model, base_url, api_key, timeout, extra_body, reasoning_effort, fallback_chain, max_concurrency`.

Note: the comment in `cli-config.yaml.example` ("auto: OpenRouter, then Nous Portal, then main endpoint") is stale. The code puts the main route first (`_resolve_auto_route` docstring).

### 4.3 Mapping to our discovery loop (Inferred)
Hermes has no notion of "Scan uses a cheap model, Dive uses a strong one" within the main loop. Options:
- Run Scan and Dive as separate Hermes sessions or cron jobs with a per-job `model`. Cron jobs support per-job model/provider/base_url (Verified). A pinned job gets no fallback chain (Verified, `provider-runtime.md`).
- Use `delegation.model` for cheap child agents while the parent stays on a strong model (Verified config, `cli-config.yaml.example` line ~1778).
- Use `/model ... --once` or `llm_request` middleware to rewrite `model` per request (Verified that middleware can replace kwargs, `hermes_cli/middleware.py::apply_llm_request_middleware`). This breaks prompt caching.
- LiteLLM-side routing by alias (the Hermes model name is just a string the gateway maps).

---

## 5. Tokens, cost, context window, caching

### 5.1 Token counting (Verified)
- Provider-reported usage is authoritative. `agent/usage_pricing.py::normalize_usage` maps the OpenAI, Anthropic, Codex and DeepSeek shapes into `CanonicalUsage` (input, output, cache read, cache write, reasoning). Streaming requests set `stream_options: {include_usage: true}` (`chat_completion_helpers.py` ~line 2990, `auxiliary_client.py` ~line 6918).
- Pre-request estimates use a chars/4 heuristic with CJK weighting (`agent/model_metadata.py`, `CHARS_PER_TOKEN`, `estimate_messages_tokens_rough`) and a "usage anchor" (the last real count plus an estimate of appended messages) (`agent/usage_anchor.py`, `context-compression-and-caching.md`).
- Persisted per session, model and task in SQLite table `session_model_usage` (`hermes_state_common.py` line 431). Auxiliary usage is recorded under its task name (`agent/aux_accounting.py`).

### 5.2 Cost tracking (Verified)
- `usage_pricing.py::get_pricing_entry` checks in order: subscription-included, OpenRouter catalog pricing, a bundled official-docs snapshot, pricing fields in the endpoint's `/models` response, then models.dev (only for direct first-party hosts such as openai.com and anthropic.com). For a LiteLLM endpoint whose `/models` lacks pricing, cost status will be `unknown` (Inferred).
- `agent/credits_tracker.py` parses `x-nous-credits-*` headers (Nous only). `agent/rate_limit_tracker.py` parses `x-ratelimit-*` headers, which also work for OpenAI-compatible gateways, for `/usage` display.
- LiteLLM's `x-litellm-model-id` and `x-litellm-model-api-base` response headers are captured as `agent.last_served_model` (`agent/served_model.py`). No capture of `x-litellm-response-cost` was found.
- **No Hermes-side budget or spend cap** (grep for `max_cost`, `budget_usd`, `spend_limit` in `agent/` finds only session-filter UI fields). Budgets must live in LiteLLM.

### 5.3 Context window management (Verified: `website/docs/developer-guide/context-compression-and-caching.md`, `agent/context_compressor.py`)
- Context length resolution (`model_metadata.py::get_model_context_length`): explicit config wins (`model.context_length` or per-model `providers.<n>.models.<m>.context_length`). After that come endpoint-scoped metadata, the persistent cache, the endpoint `/models` probe (custom endpoints), provider-aware lookups (models.dev / OpenRouter), the hardcoded `DEFAULT_CONTEXT_LENGTHS`, and finally a 256K default with a warning.
- Compression: the `ContextCompressor` fires at `compression.threshold` (default 0.50 of the window, floored at 0.75 below 512K, capped by `threshold_tokens` 256000). It prunes old tool results (no LLM call), then makes one auxiliary `compression` call for a structured summary. The `lean` tail mode keeps 2.5% of the window (10K to 25K tokens), quotes user messages verbatim, and adds a `session_search` recovery pointer. `in_place: true` keeps one session id. A gateway session-hygiene pass runs at 85%.
- The context engine is pluggable (`context.engine`, `agent/context_engine.py`).
- Context overflow and 413 errors trigger compression, not failover (`agent/error_classifier.py::FailoverReason.context_overflow`, `payload_too_large`).

### 5.4 Prompt caching (Verified)
- The system prompt is byte-stable per session. It is rebuilt only after compression (`agent/system_prompt.py::build_system_prompt`, `invalidate_system_prompt`).
- Anthropic-style `cache_control` uses a "system_and_3" layout (`agent/prompt_caching.py`). The policy in `agent_runtime_helpers.py::anthropic_prompt_cache_policy` enables it for native Anthropic, OpenRouter/Nous Claude/Kimi, third-party Anthropic-wire gateways, LiteLLM + Claude on the OpenAI wire, or a per-model `prompt_caching` capability. TTL comes from `prompt_caching.cache_ttl` (`5m`, `1h`, or `auto`).
- `prompt_cache_key` is sent only to endpoints that opt in (`supports_prompt_cache_key`, or exact `api.openai.com`) (`chat_completions.py::_add_prompt_cache_key`).

---

## 6. Streaming, retries, rate limits, errors, fallback (Verified)

- **Streaming** is on by default for every turn, subagents included (`model.streaming`). A stream monitor and stale detectors apply (`agent/chat_completion_stream_monitor.py`, `stale_timeout_seconds`).
- **Retries:** `agent.api_max_retries` (default 3, `agent/agent_init.py` ~line 1425). Backoff is jittered exponential (`agent/retry_utils.py::jittered_backoff`, base 5s, max 120s) and honors `Retry-After` and reset hints (`parse_retry_after_seconds`, `reset_delay_from_message`).
- **Error taxonomy:** `agent/error_classifier.py::FailoverReason` covers auth, billing (402), rate_limit (429), upstream_rate_limit, overloaded, server_error, timeout, context_overflow, model_not_found, content_policy_blocked, format_error, and more. **402/billing is non-retryable** (`agent/turn_api_error.py`, comment references #31273). Profiles can override classification (`ProviderProfile.classify_api_error`).
- **Credential pools:** multiple keys for the same provider rotate first (`agent/credential_pool.py`). Custom pools are matched by base URL (`_try_resolve_from_custom_pool`).
- **Fallback providers:** `fallback_providers:` is a list of `{provider, model, [base_url, key_env]}` entries. It triggers after max retries on 429/5xx, and immediately on 401/403/404 and repeated invalid responses. It is turn-scoped: the primary is restored on the next user turn, and a rate-limit reset arms a cooldown (`agent/fallback_cooldown.py`, `website/docs/user-guide/features/fallback-providers.md`). Fallback resets the prompt cache.
- **Auxiliary fallback** is independent: task `fallback_chain`, then top-level chain, then (only with no main provider) the discovery chain. Compression candidates are screened by context size (`_context_too_small`).

---

## 7. Request metadata and attaching an agent ID

### 7.1 What is sent by default to a custom endpoint (Verified)
- OpenAI Python SDK default headers (`User-Agent: OpenAI/Python ...`, `X-Stainless-*`). `model.default_headers` can override them (`cli-config.yaml.example` lines 139-156).
- `Authorization: Bearer <key>`.
- No `user` field. `AIAgent` accepts `user_id`, but it is not written into requests (grep of transports finds no use).
- No session identifier unless `session_affinity_header` is configured (`agent/opencode_affinity.py`, `config_providers.py::get_custom_provider_session_affinity_header`). That opt-in header carries the conversation id on main and auxiliary calls.
- `extra_body` from the profile. `CustomProfile.build_api_kwargs_extras` adds a top-level `reasoning_effort` (default `medium` via `default_reasoning_config`, clamped).

### 7.2 Ways to attach an agent ID for LiteLLM metering

| Mechanism | Scope | Evidence | Notes |
|---|---|---|---|
| Per-agent virtual key (`key_env` / `key_cmd`) | All calls on the route, main + aux + fallback | Verified | Most robust. LiteLLM attributes spend by key natively |
| `providers.<name>.extra_headers` | Main client (`agent_init.py` ~line 944, `client_lifecycle.py` ~line 932), aux named-custom clients (`auxiliary_client.py::_named_custom_openai_wire_client`), Anthropic-wire (`anthropic_adapter.py::_custom_provider_extra_headers`) | Verified | Static per process, which fits one Hermes per agent. Not applied on `bedrock_converse` |
| `model.default_headers` / `model.extra_headers` | Main + aux (`auxiliary_client.py::_apply_user_default_headers`) | Verified | OpenAI wire only |
| `providers.<name>.extra_body` (e.g. `user`, `metadata`) | Main turn only | Verified main; aux gap Inferred | Repeat under `auxiliary.<task>.extra_body` for aux |
| `auxiliary.<task>.extra_body` | That aux task | Verified | Good for per-task tags (`metadata.task=compression`) |
| `llm_request` middleware plugin | Main turn requests only; can rewrite any kwarg including `extra_headers`, `user`, `model` | Verified: `hermes_cli/middleware.py`, called in `turn_api_request.py::build_api_request` | Not applied to auxiliary calls. `pre_auxiliary_call` is observer-only (`agent/auxiliary_hooks.py`) |
| `session_affinity_header: x-litellm-session-id` | Main + aux | Verified | Gives per-session correlation in LiteLLM logs |

`agent/api_request_hooks.py` is **not** a way to add headers. It builds sanitized, read-only payloads (secrets redacted, size-capped) for the observer hooks `pre_api_request`, `post_api_request`, and `api_request_error`, whose return values are ignored (Verified: `ApiRequestHooksMixin`, `turn_api_request.py::_fire_pre_api_request_hook`). Note the risk: these hook payloads include the full system prompt and messages, so any observability plugin (for example `plugins/observability/langfuse`) would receive skill content.

---

## 8. Exactly what goes into a main-model request

### 8.1 System prompt (Verified: `agent/system_prompt.py::build_system_prompt_parts`)
Assembled once per session in three tiers, joined in the order stable, context, volatile:

| Tier | Contents |
|---|---|
| stable | Identity: `SOUL.md` from `$HERMES_HOME` (or `DEFAULT_AGENT_IDENTITY` when `skip_context_files`), Hermes help guidance, tool/memory/skill guidance (`_guidance_parts`), provider-specific identity blocks, **`skills.auto_load` skills as full bodies** (`_auto_load_parts` via `agent/skill_commands.py::build_auto_load_prompt`), coding operating brief, platform hints |
| context | Caller `system_message`, project context files (`.hermes.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules` from cwd, size-capped), git workspace snapshot |
| volatile | **Skills index** (category, name, description per skill, from `agent/prompt_builder.py::build_skills_system_prompt`, only when skill tools are enabled), `MEMORY.md` and `USER.md` snapshots, external memory-provider block, plugin prompt sections, timestamp/session/model line, runtime environment (host, home, cwd) |

Note: `website/docs/developer-guide/prompt-assembly.md` contradicts itself on whether skills sit in the stable or volatile tier. The code puts the index first in volatile and auto-loaded bodies in stable.

### 8.2 Messages and tools (Verified)
- The full transcript (post-compression), rebuilt per call by `agent/turn_context.py::build_api_messages`. Ephemeral additions happen at API time only: memory-provider prefetch, `pre_llm_call` plugin context, `ephemeral_system_prompt`, and prefill messages.
- **Skill bodies enter the transcript** when the model calls `skill_view` (the tool result is the SKILL.md content and linked files) or when a skill is invoked as a slash command. Once there, they are resent on every later call until compressed. The compression summary is itself generated by an LLM from that content.
- **All tool schemas** on every call, including MCP server tools (`AGENTS.md` invariant: "every model tool is sent on every API call").
- Reasoning params, `max_tokens` where required, `cache_control` markers, and `extra_body` (section 7).

### 8.3 Auxiliary requests that carry sensitive content (Verified task list; content Inferred from task purpose)
- `compression`: middle of the transcript, including skill bodies.
- `curator` / `background_review`: skill files and conversation, used to rewrite skills.
- `title_generation`: first exchange.
- `session_search`: past sessions.
- `web_extract`: page text.
- `approval`: shell commands.
- `vision`: images.
- `mcp`: tool reasoning.

---

## Implications for our platform

1. **Use a named custom provider for the gateway**, with a per-agent virtual key via `key_env` (or `key_cmd` if keys rotate). Set `discover_models: false` and explicit per-model `context_length`. With no other provider credentials in the sandbox env, and deny-by-default egress, this keeps all chat and auxiliary LLM traffic on LiteLLM.
2. **Pin every auxiliary task explicitly** rather than trusting `auto`. `vision` in particular falls back to OpenRouter, Nous, or DeepInfra without a gate when those keys exist. Disable tasks we do not need: `title_generation.enabled: false`, `background_review.enabled: false`, and curator/skill self-improvement (see the skills report), because those rewrite or read skill files.
3. **Meter by virtual key first.** Add `extra_headers` (`x-agent-id`, tier) for LiteLLM tagging and `session_affinity_header: x-litellm-session-id` for per-session correlation. Put per-task tags in `auxiliary.<task>.extra_body`. Do not rely on `providers.<n>.extra_body` alone for aux calls.
4. **Enforce budgets in LiteLLM.** Hermes has no spend cap, and cost for our endpoint will read "unknown". When credits run out, LiteLLM should return 402 or 429. Hermes will not retry a 402, so the turn ends cleanly. The orchestrator should watch for that and pause the sandbox.
5. **Skill privacy vs. vendors:** skill bodies necessarily reach the upstream model (via `skill_view` results, auto-load, compression and curator calls). Our gateway must not persist prompts: turn off LiteLLM request/response logging or store logs encrypted and access-controlled. Do not enable Hermes observability plugins or `HERMES_DUMP_REQUESTS` in production sandboxes.
6. **Discovery-loop model tiers** are best done as separate sessions or cron jobs with per-job `model` (Scan cheap, Dive strong), or `delegation.model` for cheap workers. Per-request model swapping inside one session defeats prompt caching.
7. **Allowlist only the gateway.** Point `models_dev.url` at our own mirror (or leave it unreachable; failures fail open). This avoids needing `models.dev` or `openrouter.ai` in the egress allowlist.
8. For Claude via LiteLLM, include `litellm` in the provider key or hostname, or set `prompt_caching: true` per model, so cache markers are sent. The caching savings go to our credits bill.

## Open questions

1. Does LiteLLM's `/models` (or `/v1/models`) response include context length or pricing that Hermes can parse (`_context_length_from_model_payload`, `_extract_pricing`)? If not, cost stays "unknown". Spike: point Hermes at a LiteLLM dev proxy and inspect `session_model_usage`.
2. Confirm by spike that `auxiliary.<task>.provider: "custom:gw"` resolves for every task, including `curator`, `background_review`, `session_search`, and `web_extract`. Capture traffic with LiteLLM logs to prove no request leaves the gateway.
3. Confirm the Inferred gap that provider-level `extra_body` is not applied to auxiliary calls. Spike: set `extra_body.user` and compare main vs compression requests at the proxy.
4. What exactly does LiteLLM return on budget exhaustion (status code and body), and does `error_classifier` map it to `billing` (non-retryable) or `rate_limit` (retried, then fallback)? A 400 with "budget" text may be classified as `format_error`.
5. Does anything at startup (update checks, telemetry, pm installers) make network calls independent of the model path? This belongs to the runtime and security reports (areas E and F).
6. Does the default `custom` reasoning default (`reasoning_effort: medium` top-level) cause 400s on LiteLLM routes for non-reasoning models? Hermes has a rejection ladder that drops the field (`is_reasoning_field_rejection`), but each rejection costs an extra request.
7. Can `llm_execution` middleware be used to enforce a per-agent spend guard inside Hermes (count tokens and refuse calls), as a second line of defense behind LiteLLM budgets? It is not applied to auxiliary calls, so coverage would be partial.
