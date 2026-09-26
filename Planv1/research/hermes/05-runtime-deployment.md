# 05. Runtime, Scheduling, Gateways, Configuration, and Deployment

| Field | Value |
|---|---|
| Commit | `085d9ee608893bb0611c2fc339c19d8848af9f2b` |
| Commit date | 2026-09-25 |
| Release tag | `v2026.9.24` (HEAD is past it) |
| License | MIT |
| Scope | `cron/`, `tools/cronjob_tools.py`, `gateway/` (run loop, API server, webhook, shutdown, recovery, scale-to-zero), programmatic surfaces (`run_agent.py`, `hermes_cli/oneshot.py`, `hermes_cli/stream_json.py`, `acp_adapter/`, `mcp_serve.py`, `tui_gateway/`), config (`hermes_cli/config_defaults.py`, `hermes_constants.py`), profiles, Docker |

Labels: **Verified** means seen in code or in-repo docs (code wins when they disagree, and disagreements are called out). **Inferred** means my reasoning.

---

## 1. Summary

- Hermes has a real, durable scheduler (cron) with per-job model, provider, toolsets, skills, pre-run scripts, script-only jobs, chaining, and delivery. It is ticked by the **gateway process** every 60 s, or on demand by `hermes cron tick`, or by a pluggable external trigger (`cron.provider`). It could run our five discovery stages on a cadence, but chaining is time-based rather than event-based, so our orchestrator is a better driver for the Scan to Zoom out pipeline.
- Hermes runs fine **headless**: a gateway with zero messaging platforms keeps running for cron, and the OpenAI-compatible **API server** is itself just a gateway "platform". The Python `AIAgent` class needs no gateway at all.
- There is **no native structured output** (no `response_format` or JSON-schema mode) for the main agent on any surface. The practical way to get structured results is to have the agent call one of our MCP tools whose input schema is the structure we want.
- All state lives under one directory, `HERMES_HOME`. One Hermes per E2B sandbox maps cleanly onto one `HERMES_HOME` per sandbox. Templating is done by writing `config.yaml`, `.env`, `SOUL.md`, `skills/`, `cron/jobs.json` (and optionally a "profile distribution" repo).
- The official Docker image is Debian 13.4, Python 3.14, Node 26, Chromium, FFmpeg, ripgrep, s6-overlay. Documented minimums: 1 GB RAM (2 GB with browser), 1 CPU, 500 MB data volume.
- Crash behavior is well engineered: tool results are flushed to SQLite after every tool round, gateway restarts auto-resume recently interrupted chat sessions, cron is at-most-once per occurrence, `/v1/runs` persists `interrupted`. A killed process never replays half-done tool side effects, and never rolls them back either.

---

## 2. Scheduled tasks (cron)

### 2.1 Where things live (Verified)

| Item | Location | Source |
|---|---|---|
| Job store | `$HERMES_HOME/cron/jobs.json` (atomic temp-file-then-rename writes) | `cron/jobs.py` module docstring, `JOBS_FILE = CRON_DIR / "jobs.json"` |
| Run outputs | `$HERMES_HOME/cron/output/{job_id}/{timestamp}.md`, last 50 kept (`cron.output_retention`) | `cron/jobs.py`, `hermes_cli/config_defaults.py` `cron.output_retention` |
| Executions ledger | `$HERMES_HOME/cron/executions.db` (SQLite, `synchronous_full=True`), with a `scheduled_instant` column used for de-duplication | `cron/executions.py` |
| Tick lock | `$HERMES_HOME/cron/.tick.lock` (fcntl/msvcrt) | `cron/AGENTS.md`, `cron-internals.md` |
| Scripts | must resolve inside `$HERMES_HOME/scripts/` | `website/docs/user-guide/features/cron.md` "No-agent mode" |

Cron is per profile by design: the store is anchored at `get_hermes_home()`, never a shared root (`cron/jobs.py` comment near line 62).

### 2.2 Job definition fields (Verified)

The authored fields are listed in `cron/job_definition.py::JOB_DEFINITION_FIELDS` and the signature of `cron/jobs.py::create_job`:

| Field | Meaning |
|---|---|
| `name`, `prompt` | Job label and the self-contained task prompt |
| `schedule` | String, parsed by `cron/jobs.py::parse_schedule` into `{"kind": "once" \| "interval" \| "cron", ...}` |
| `repeat` | `None` = forever; one-shots default to 1 |
| `skills` (legacy `skill`) | Skills loaded, in order, into the fresh session |
| `model`, `provider`, `base_url`, `reasoning_effort` | Per-job pins. Resolution order: per-job pin, then `cron.model`, then `model.default` (`config_defaults.py` `cron.model` comment) |
| `enabled_toolsets` | Per-job toolset allowlist; wins over the `cron` platform toolset config (`cron.md` "Toolsets available to cron jobs") |
| `script` | Pre-run script; stdout is injected into the prompt. A last line `{"wakeAgent": false}` skips the LLM for that tick |
| `no_agent` | Script-only job: stdout is delivered verbatim, no model call at all |
| `monitor_script` / `monitor_url` | Cheap change detector run first; unchanged output suppresses the agent run |
| `context_from` | Job ids or names whose most recent output is prepended. The reserved entry `self` implements `continuity` (the job sees its own last output) |
| `workdir` | Absolute cwd; also turns on loading `AGENTS.md`/`CLAUDE.md` from it |
| `deliver`, `failure_deliver`, `origin`, `attach_to_session` | Delivery target(s); defaults to `origin` if created from a chat, else `local` |
| `paused`, `paused_reason`, `pinned` | Create-paused canary, etc. |

Scheduler-owned state fields (`next_run_at`, `last_run_at`, `last_status` in {`ok`, `error`, `delivery_failed`, `blocked_config`}, `pending_slot`, `fire_claim`) are described in `website/docs/developer-guide/cron-internals.md`.

### 2.3 Schedule syntax (Verified in `cron/jobs.py::parse_schedule`)

| Form | Example | Kind |
|---|---|---|
| Bare duration | `30m`, `2h`, `1d` | **Recurring interval** |
| `every` + duration | `every 2h` | Recurring interval |
| Natural phrase | `every monday 9am`, `weekdays at 9am` | Cron (needs `croniter`) |
| 5-field cron | `0 9 * * *` | Cron |
| ISO timestamp | `2026-06-01T09:00:00Z` (naive times use `HERMES_TIMEZONE`) | One-shot |
| `in` + duration | `in 30m` | One-shot |

Doc discrepancy: `cron-internals.md` says a bare `30m` is a one-shot. The code comment says the opposite ("a bare duration ("30m") is a RECURRING interval per the documented tool contract"). Trust the code: use `in 30m` for one-shots.

### 2.4 Who runs the ticker (Verified)

- **Gateway process.** `hermes gateway run` starts the scheduler. The trigger is pluggable: `cron/scheduler_provider.py::resolve_cron_scheduler()` returns the built-in `InProcessCronScheduler` (60 s loop calling `scheduler.tick()`) unless `cron.provider` names a plugin, for example `chronos` (Nous-managed one-shots that call back `POST /api/cron/fire`). A missing or broken provider falls back to the built-in (`cron-internals.md` "Gateway Integration").
- **One process can tick many homes.** `scheduler_provider.py::_start_multiplex` iterates `profiles_to_serve()` under `_profile_cron_scope(home)` (`cron/AGENTS.md`).
- **Standalone, on demand.** `hermes cron tick` runs due jobs once and exits (`hermes_cli/cron.py::cron_tick`). `hermes cron run <id>` fires one job. This means an external scheduler (our orchestrator) can own the clock without a gateway. **Inferred**: `hermes cron tick` from our orchestrator is the simplest way to get cron semantics inside a short-lived sandbox.
- In plain CLI mode, jobs only fire when `hermes cron` commands run (`cron-internals.md`).
- Under systemd, each due job runs in a separate worker (`python -m cron.scheduler`) inside a transient user scope so a gateway restart does not kill it; without a user systemd session (containers) it degrades to a plain subprocess (`cron.md` "Restart-safe workers under systemd", `cron.require_restart_safe_scope`).

### 2.5 How a job runs (Verified)

`cron/scheduler.py` (around line 2410) builds a fresh `AIAgent` per fire with `platform="cron"`, `quiet_mode=True`, `enabled_toolsets=_resolve_cron_enabled_toolsets(job, cfg)`, `skip_context_files=not bool(workdir)`, `load_soul_identity=True`, `skip_memory=False`, `skip_background_review=True`, plus the fallback chain and credential pool.

- Doc discrepancy: `cron/AGENTS.md` says "Cron sessions pass `skip_memory=True`". The code passes `skip_memory=False`, and `cron-internals.md` says MEMORY.md/USER.md do load. Trust the code.
- The `cronjob` toolset is denied in cron runs unless `cron.allow_agent_scheduling: true` (recursion guard, `config_defaults.py`).
- Approvals in cron: `approvals.cron_mode: "deny"` by default (dangerous commands are blocked, not prompted).
- Timeouts: agent jobs are killed after `HERMES_CRON_TIMEOUT` seconds of **inactivity** (default 600, `0` unlimited), not wall-clock. Scripts are bounded by `HERMES_CRON_SCRIPT_TIMEOUT` / `cron.script_timeout_seconds` (default 3600).
- Parallelism: `cron.max_parallel_jobs` / `HERMES_CRON_MAX_PARALLEL` (default unbounded; `1` = serial), per profile.
- Pre-dispatch validation (`cron.preflight: true`) refuses to burn a run when the provider key, skills, or delivery targets are not ready, and records `blocked_config`.
- Cost gates: `script` + `{"wakeAgent": false}` and `monitor_script` skip the LLM when nothing changed.

### 2.6 Delivery (Verified)

`deliver` accepts `local` (file only), `origin`, a bare platform (home channel), `platform:<target>[:<thread>]`, `bot-chat[:<profile>]`, or multiple targets. A response starting with `[SILENT]` suppresses delivery. `cron.wrap_response` adds a header/footer. Delivery failures are a distinct `last_status=delivery_failed` (`cron-internals.md` "Delivery Model").

**Inferred:** for us, `deliver: local` is the right setting; our orchestrator reads results itself (output files, the jobs API, or better, the MCP tool calls the job made).

### 2.7 Management surfaces (Verified)

- Model tool: `cronjob_manage` in toolset `cronjob` (`tools/cronjob_tools.py`, `registry.register(name="cronjob_manage", toolset="cronjob")`), actions `create, list, update, pause, resume, run, remove`. `run` accepts a transient `prompt` that is appended under `## Run Context` for that fire only (`cron.md` "Manual runs are asynchronous").
- CLI: `hermes cron list|create|edit|pause|resume|run|remove|tick|status|doctor|runs|incidents` (`hermes_cli/cron.py`, flags in `hermes_cli/subcommands/cron.py`).
- HTTP (API server): `GET/POST /api/jobs`, `GET/PATCH/DELETE /api/jobs/{id}`, `POST /api/jobs/{id}/pause|resume|run`, `POST /api/cron/fire` (route table in `gateway/platforms/api_server.py::_http_route_table`).

### 2.8 Could cron drive our discovery loop? (Inferred)

| Stage | Cron fit |
|---|---|
| Scan | Good fit. Recurring job, `continuity=true` to dedupe against the last scan, `monitor_script`/`wakeAgent` gate to skip idle ticks, narrow `enabled_toolsets`, cheap model pin. |
| Dive (budgeted) | Partial. `context_from=[scan]` injects the last Scan output, but chaining reads "the most recent completed output" and does **not** wait for upstream runs (`cron.md` "Chaining jobs"). There is no per-job token or dollar budget; budget has to come from our LiteLLM virtual key, `agent.run_budget_seconds` (global), and `HERMES_CRON_TIMEOUT` (idle only). |
| Challenge (skeptic) | Works as a separate job with a different model pin and `context_from=[dive]`, same timing caveat. |
| Test | Depends on our backtest service; the job can only request it through our MCP tool. The result arrives asynchronously, so a later job or an orchestrator trigger has to pick it up. |
| Zoom out | Good fit: weekly recurring job with `continuity`. |

Recommendation: let our orchestrator drive stage transitions (event-driven, with budget and credit checks), and use either `POST /api/jobs/{id}/run` with run context or direct `/v1/runs` calls per stage. Keep Hermes cron for the simple recurring Scan and Zoom out cadences, or skip it entirely and have the orchestrator call `hermes cron tick`. Disable the `cronjob` toolset for the agent so it cannot create its own schedules.

---

## 3. Gateways and interfaces

### 3.1 What exists (Verified)

- Built-in `Platform` enum (`gateway/config.py::Platform`): `local, telegram, discord, whatsapp, whatsapp_cloud, slack, signal, mattermost, matrix, homeassistant, email, sms, dingtalk, api_server, webhook, msgraph_webhook, feishu, wecom, wecom_callback, weixin, bluebubbles, qqbot, yuanbao, relay`, plus plugin platforms in `plugins/platforms/` (a2a, buzz, google_chat, irc, line, ntfy, photon, raft, simplex, teams, and plugin copies of several above).
- Non-chat interfaces relevant to us:
  - **API server** (`gateway/platforms/api_server.py`, default `127.0.0.1:8642`): OpenAI Chat Completions, Responses, Runs, Sessions, Jobs, skills/toolsets discovery.
  - **Webhook platform** (`gateway/platforms/webhook.py`, default port 8644): HMAC-signed POSTs rendered into prompts via route templates; a route can fire an existing cron job (`cron_job`), deliver elsewhere, or be `deliver_only`.
  - **ACP** (`hermes acp`, `acp_adapter/`): JSON-RPC over stdio for editors.
  - **TUI gateway JSON-RPC** (`tui_gateway/server.py`): stdio or WebSocket, the richest control surface.
  - **MCP serve** (`hermes mcp serve`, `mcp_serve.py`): exposes Hermes's messaging conversations (list, read, send, events, approvals) to an MCP client. It does **not** expose "run the agent on this task"; it is a channel bridge.

### 3.2 Headless operation (Verified)

- `gateway/run_startup.py::_start_handle_no_connections`: with zero enabled platforms it logs "No messaging platforms enabled." and "Gateway will continue running for cron job execution." and keeps running.
- The API server is just another adapter, so "API server only" is a valid headless gateway.
- The Python library path (`from run_agent import AIAgent`) needs no gateway process at all.

Conclusion: yes, Hermes can run fully headless, driven by schedules and programmatic input, with no chat platform configured.

---

## 4. Programmatic API and SDK

### 4.1 Python library (Verified)

`run_agent.py::AIAgent.__init__` forwards to `agent/agent_init.py::init_agent`. Relevant keyword parameters include `model`, `base_url`, `api_key`, `provider`, `enabled_toolsets`, `disabled_toolsets`, `quiet_mode`, `ephemeral_system_prompt`, `max_iterations` (default `sys.maxsize`, i.e. unlimited), `iteration_budget`, `run_budget_seconds`, `session_id`, `session_db`, `skip_context_files`, `load_soul_identity`, `skip_memory`, `skip_background_review`, `fallback_model`, `request_overrides`, `prefill_messages`, `checkpoints_enabled`, `platform`, `cwd`, plus many callbacks (`stream_delta_callback`, `tool_start_callback`, `tool_complete_callback`, `event_callback`, `clarify_callback`, ...).

`agent/turn_facade.py::TurnFacadeMixin.run_conversation(user_message, system_message=None, conversation_history=None, task_id=None, stream_callback=None, ...)` returns a dict built in `agent/turn_finalizer.py` with keys: `final_response`, `last_reasoning`, `messages`, `api_calls`, `completed`, `turn_exit_reason`, `failed`, `partial`, `interrupted`, `model`, `provider`, `base_url`, session token and cost counters, `last_prompt_tokens`, `service_tier`, `session_id`, and optionally `error`, `failure_reason`, `guardrail`, `pending_steer`. `chat(message)` returns only `final_response`.

Example from `website/docs/guides/python-library.md`:

```python
from run_agent import AIAgent

agent = AIAgent(model="anthropic/claude-sonnet-4.6", quiet_mode=True,
                enabled_toolsets=["web"], skip_memory=True)
result = agent.run_conversation(user_message="Search for recent Python 3.13 features",
                                task_id="my-task-1")
print(result["final_response"], len(result["messages"]))
```

Caveats (Verified): one `AIAgent` per thread or task, never shared (`python-library.md`). The docs say `max_iterations` defaults to 500; the code default is unlimited (`run_agent.py` signature, `config_defaults.py` `agent.max_turns: None`). Hermes does not publish a wheel; you run from a PM-prepared source checkout (`python-library.md` "Installation").

### 4.2 One-shot CLI (Verified)

- `hermes -z "<prompt>" [-m model] [--provider p] [-t toolsets] [-s skills] [-r session] [--usage-file PATH]` (`hermes_cli/_parser.py::_add_top_level_flags`, `hermes_cli/oneshot.py::run_oneshot`). Prints only the final text. Exit codes (`_oneshot_exit_code`): `0` completed, `130` interrupted, `2` failed/partial/incomplete, `1` empty response. `--usage-file` writes JSON with cost, tokens, model, `completed`, `partial`, `interrupted`, `turn_exit_reason`, and an `auxiliary` breakdown, even on failure.
- **Security note:** `run_oneshot` sets `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1` ("Non-interactive by definition"). Approvals are bypassed in `-z` mode.
- `hermes chat -q "<prompt>" -Q` or `--query-file PATH` answers and exits. `--format stream-json` emits JSONL events (`system/init`, `text`, `tool_use`, `tool_result`, terminal `result` with exit code and token stats) (`hermes_cli/stream_json.py::StreamJsonEmitter`). For `-q`, dangerous commands follow `approvals.single_query_mode` (default `deny`).
- `hermes chat --run-budget 850 -q "..."` sets a wall-clock budget with an 80% wrap-up notice (`configuration.md` "Wall-Clock Run Budget").

### 4.3 OpenAI-compatible API server (Verified)

Enable with `API_SERVER_ENABLED=true` and `API_SERVER_KEY` in `.env`, then `hermes gateway run`. The startup guard refuses keys shorter than 16 characters or placeholders (`api_server.py::_api_key_passes_startup_guard`, `has_usable_secret(min_length=16)`); the Docker doc's "minimum 8 characters" is stale.

Routes (from `_http_route_table`, plus `/v1/runs*` in `api_server_runs.py`):

| Route | Use for us |
|---|---|
| `POST /v1/runs` (+ `GET /v1/runs/{id}`, `/events` SSE, `/stop`, `/steer`, `/approval`) | Best fit for orchestrator-driven stages. Accepts `input`, `session_id`, `instructions`, `conversation_history`, `previous_response_id`, and an `Idempotency-Key` header that survives restarts. Status includes `output`, `usage` (with cache tokens), and `runtime` (served provider/model). |
| `POST /v1/chat/completions`, `POST /v1/responses` | Stateless or `previous_response_id`-chained turns |
| `POST /api/sessions/{id}/chat` and `/chat/stream` | One synchronous turn on a durable session |
| `/api/jobs*`, `POST /api/cron/fire` | Cron management and external fire |
| `GET /v1/skills`, `GET /v1/toolsets`, `GET /v1/capabilities`, `GET /health`, `/health/detailed` | Discovery and liveness |

Request fields actually read (grep of `body.get(...)` in `api_server_openai_routes.py` and `api_server_runs.py`): `input`, `messages`, `instructions`, `model`, `stream`, `store`, `conversation`, `conversation_history`, `previous_response_id`, `session_id`, `truncation`, and a few internal ones. There is **no** per-request `toolsets`, `skills`, or `response_format`. Frontend `system` / `instructions` text is **layered on top of** the core system prompt, not a replacement (`api-server.md` "System Prompt Handling"). Concurrency cap `gateway.api_server.max_concurrent_runs` (default 10, HTTP 429 when full).

Example (`api-server.md`):

```bash
curl http://localhost:8642/v1/chat/completions \
  -H "Authorization: Bearer $API_SERVER_KEY" -H "Content-Type: application/json" \
  -d '{"model": "hermes-agent", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### 4.4 ACP and TUI gateway (Verified)

- ACP (`hermes acp`) uses the curated `hermes-acp` toolset (no messaging delivery, no cron). The host can pass MCP servers per session in `session/new`, and `HERMES_ACP_SKIP_CONFIGURED_MCP=1` skips the globally configured ones (`acp.md` "Host integration"). ACP does not implement `/goal`.
- TUI gateway JSON-RPC offers `prompt.submit`, `session.create` (with per-session model/provider), `session.interrupt`, `session.steer`, `session.history`, `command.dispatch`, and server-to-client requests for approvals and clarify (`programmatic-integration.md`).

### 4.5 Structured input and output

- **Input** (Verified): plain text only on every surface (`input` / `messages` / prompt). Structure must be serialized into the prompt (for example a JSON block of goals and limits), or better, fetched by the agent from our platform MCP tool ("read goals and limits").
- **Output** (Verified absence): `response_format` / `json_schema` handling exists only for auxiliary calls (`agent/auxiliary_structured_output.py`, `agent/auxiliary_client.py`); nothing in the main loop or API server accepts it. **Inferred:** `request_overrides` is merged into provider kwargs and could technically carry extra body fields, but forcing a JSON schema on a tool-calling loop is untested and likely to break tool use. The robust pattern is: our MCP tools (`write_thesis`, `propose_allocation`, ...) define JSON input schemas, and the agent's "output" is its tool calls. The final text response is then only a log line.
- **Metadata** (Verified): usage and cost come back in `run_conversation`'s dict, `-z --usage-file`, `stream-json`'s `result` event, and `/v1/runs` `usage`/`runtime`.
- `/goal` completion contracts (`outcome`, `verification`, `constraints`, `boundaries`, `stop_when`) are a judged loop inside one session (`goals.md`); the judge returns strict one-line JSON internally. Not an output schema for us, but a possible "keep going until the Dive deliverable exists" mechanism.

---

## 5. Configuration, env vars, and HERMES_HOME

### 5.1 Resolution (Verified)

- `hermes_constants.py::get_hermes_home()`: context-local override, then `HERMES_HOME`, then platform default (`~/.hermes` on POSIX). The Docker image sets `HERMES_HOME=/opt/data` and `HERMES_WRITE_SAFE_ROOT=/opt/data` (`Dockerfile` lines 448-449).
- Precedence: CLI flags, then `config.yaml`, then `.env`, then built-in defaults (`configuration.md` "Configuration Precedence"). Secrets belong in `.env`. `config.yaml` supports `${VAR}` substitution.
- Defaults live in `hermes_cli/config_defaults.py::DEFAULT_CONFIG` (top-level sections include `model`, `providers`, `agent`, `terminal`, `web`, `browser`, `checkpoints`, `mcp`, `tool_output`, `tool_loop_guardrails`, `compression`, `auxiliary`, `display`, `memory`, `delegation`, `goals`, `loops`, `skills`, `curator`, `approvals`, `security`, `cron`, `kanban`, `code_execution`, `tools`, `logging`, `gateway`, `sessions`, `telemetry`, `updates`, `secrets`, `proxy`, `nous`, and platform blocks).
- Managed scope: an admin can pin config and secret values a user cannot override (`configuration.md` tip linking `managed-scope.md`). Not investigated further.

### 5.2 HERMES_HOME layout (Verified, compiled from `configuration.md`, `docker.md` "Persistent volumes", the distribution `.gitignore` in `profile-distributions.md`, and code paths above)

| Path | Contents | Template per agent? |
|---|---|---|
| `config.yaml` | All non-secret settings | Yes (tier template + agent overrides) |
| `.env` | Secrets and `UPPER_SNAKE` env vars (API server key, LiteLLM virtual key) | Yes, generated per agent, never exported to owner |
| `auth.json`, `auth.lock` | OAuth provider credentials | Not used if we only use our gateway key |
| `SOUL.md` | Identity, slot 1 of the system prompt | Yes, per tier playbook |
| `memories/MEMORY.md`, `memories/USER.md` | Agent-written memory | Persist and restore per agent |
| `skills/` | Installed skills | Per agent (decrypted equipped skills) |
| `cron/jobs.json` (+ `output/`, `executions.db`, `.tick.lock`) | Schedules and run records | `jobs.json` templated; rest is runtime state |
| `scripts/` | Cron scripts | Templated if we use script gates |
| `state.db` (+ `-wal`, `-shm`) | Sessions, messages, FTS, goal/heartbeat state | Persist and restore |
| `response_store.db` | `/v1/responses` history (max 100) | Runtime |
| `sessions/`, `pending_messages/` | Gateway session files, shutdown flush spool | Runtime (persist if resuming) |
| `gateway.pid`, `gateway.lock`, `gateway_state.json`, `processes.json` | Process and runtime status | Never copy |
| `logs/` | `agent.log`, `errors.log`, `gateway.log` | Export for audit |
| `checkpoints/` | Shadow git store for file rollback (off by default) | Not needed |
| `home/` | Per-profile HOME for tool subprocesses | Runtime |
| `plugins/`, `hooks/`, `skins/`, `mcp.json` | Extensions | Template `plugins/` only if we ship one |
| `state-snapshots/`, `backups/`, `installs/`, `*_cache/`, `sandboxes/`, `workspace/`, `plans/` | Caches, backups, PM lazy installs | Runtime |
| `profiles/<name>/` | Named profiles (each is a full home) | Not needed with one home per sandbox |

Outside `HERMES_HOME` (Verified, `gateway/status.py::_get_lock_dir`): machine-local gateway locks and the host rendezvous record live in `$HERMES_GATEWAY_LOCK_DIR`, else `$XDG_STATE_HOME/hermes/gateway-locks`, else `~/.local/state/hermes/gateway-locks`.

### 5.3 Most important env vars (Verified that each is read in code unless noted)

| Variable | Purpose | Template level |
|---|---|---|
| `HERMES_HOME` | Selects the whole state directory | Per agent |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | **Corrected in synthesis (report 07 §5 row 1):** `OPENAI_BASE_URL` does not select the endpoint (`hermes_cli/runtime_provider_backends.py` line 121). Configure our LiteLLM proxy under `providers:` in `config.yaml` with `key_env` pointing at a per-agent variable such as `AGENT_LLM_KEY` (report 02 §3) | Per agent |
| `HERMES_INFERENCE_MODEL` | Process-level model override for `-z` / `chat` | Per run |
| `API_SERVER_ENABLED`, `API_SERVER_KEY` (>=16 chars), `API_SERVER_HOST`, `API_SERVER_PORT`, `API_SERVER_MODEL_NAME` | API server | Per agent |
| `HERMES_CRON_TIMEOUT` | Cron agent idle timeout (default 600 s) | Per tier |
| `HERMES_CRON_SCRIPT_TIMEOUT`, `HERMES_CRON_MAX_PARALLEL` | Script timeout, cron parallelism | Per tier |
| `HERMES_AGENT_TIMEOUT` | Gateway inactivity timeout for a running agent (default 1800 s) | Per tier |
| `HERMES_API_TIMEOUT`, `HERMES_API_CALL_STALE_TIMEOUT`, `HERMES_STREAM_READ_TIMEOUT` | LLM call timeouts | Global |
| `HERMES_TIMEZONE` | IANA zone for schedules | Per agent (owner locale) |
| `HERMES_WRITE_SAFE_ROOT` | Hard-block file writes outside listed roots | Global |
| `HERMES_REDACT_SECRETS` (default true), `HERMES_ALLOW_PRIVATE_URLS` | Redaction, private URL fetches | Global |
| `HERMES_EPHEMERAL_SYSTEM_PROMPT` | Extra system prompt text, never persisted | Per tier (playbook) |
| `HERMES_IGNORE_RULES`, `HERMES_BUNDLED_SKILLS` | Skip auto-injected context files; restrict bundled skills | Global |
| `HERMES_YOLO_MODE` | Bypass approvals. Set implicitly by `-z`. Never set in our env | Never |
| `HERMES_GATEWAY_LOCK_DIR` / `XDG_STATE_HOME` | Where host-wide gateway locks live | Per instance on shared hosts |
| `HERMES_STARTUP_WATCHDOG`, `HERMES_STARTUP_WATCHDOG_TIMEOUT_S` | Startup liveness watchdog (default 300 s, exit 75) | Global |
| `HERMES_GATEWAY_NO_SUPERVISE` | Docker: run gateway as the container main process | Global |
| `TERMINAL_ENV` | Terminal backend (`local`, `docker`, `ssh`, `modal`, `daytona`, ...) | Global (`local` inside E2B) |

Config keys worth templating per tier (Verified in `config_defaults.py`): `model.*`, `cron.model`, `cron.max_parallel_jobs`, `cron.preflight`, `cron.allow_agent_scheduling: false`, `agent.max_turns`, `agent.run_budget_seconds`, `agent.restart_drain_timeout`, `agent.cron_drain_timeout`, `goals.max_turns`, `loops.max_ticks`, `approvals.cron_mode` / `single_query_mode` / `unattended_mode` (all `deny` by default), `platform_toolsets`, `mcp_servers`, `security.allow_lazy_installs: false`, `updates.check: false`, `telemetry.shared_metrics.enabled: false` (default already false), `gateway.api_server.max_concurrent_runs`.

### 5.4 Templating mechanisms (Verified)

- **Profile distributions** (`profile-distributions.md`): a git repo with `distribution.yaml`, `SOUL.md`, `config.yaml`, `skills/`, `cron/jobs.json`, `mcp.json`. Installer hard-excludes `.env`, `auth.json`, `memories/`, `sessions/`, `state.db*`, `logs/`, etc. On update, `cron/jobs.json` merges by job id and **newly shipped jobs arrive paused** (`cron/job_definition.py::import_job_definitions`, `paused_reason`). A natural fit for "tier template" repos, but it needs git in the sandbox.
- **Export/import** (`hermes profile export/import`, `hermes backup`): `hermes backup` snapshots SQLite with `sqlite3.backup()` (`hermes_cli/backup.py`, `hermes_cli/backup_sqlite.py`), which is the safe way to copy a live `state.db`.
- **Inferred:** for our orchestrator, writing the files directly into a fresh `HERMES_HOME` before boot is simpler than either mechanism.

---

## 6. Docker and runtime requirements

Verified from `Dockerfile`, `docker-compose.yml`, `website/docs/user-guide/docker.md`, `getting-started/installation.md`, `pyproject.toml`:

| Item | Value |
|---|---|
| Python | `requires-python >=3.11,<3.15`; `.python-version` is 3.14; image uses Python 3.14 from `uv.lock` |
| Base | `debian:13.4` pinned by digest, plus a custom-built SQLite 3.53.x (works around a WAL-reset corruption bug) |
| Baked extras | `all, messaging, otlp, anthropic, bedrock, azure-identity, matrix, google-chat` (not `--all-extras`) |
| System tools | Node.js 26 and npm, full Chromium (Playwright path `/opt/hermes/tools`), FFmpeg, ripgrep, uv, git, openssh-client, docker-cli, gcc/g++/make/cmake |
| Layout | Code at `/opt/hermes` (root-owned, read-only), state at `/opt/data` (`VOLUME`), runs as UID 10000 `hermes` |
| PID 1 | s6-overlay `/init` via `docker/entrypoint-dispatch.sh`; supervises gateway, dashboard, per-profile gateways; reaps zombies. Falls back to no supervision when another init owns PID 1 |
| Resources (documented) | Memory 1 GB min, 2 to 4 GB recommended (browser needs 2 GB+); CPU 1 min, 2 recommended; data disk 500 MB min, 2 GB+ recommended |
| Image size | Not documented as a number; doc only says the full Chromium makes it larger |
| Lazy installs | Optional SDKs install on first use into `/opt/data/installs`; disable with `security.allow_lazy_installs: false` |
| Ports | 8642 API server, 8644 webhook, 9119 dashboard |

**Inferred:** in E2B we should build our own template image from the official image or the Dockerfile, bake every extra we need, set `security.allow_lazy_installs: false` and `updates.check: false`, and drop Chromium if we never enable browser tools (saves the largest chunk of image size and RAM). Firecracker microVMs usually run our process as PID 1 or under E2B's own init, so s6 supervision may not apply; plan to supervise from the orchestrator.

---

## 7. Multiple instances on one host

Verified:

- Isolation unit is `HERMES_HOME`. Profiles are just homes under `<root>/profiles/<name>/` (`profiles.md`). Never point two agent processes at one home (`profiles.md` caution; `docker.md` warning about concurrent writers).
- **Host-wide singleton:** only one `hermes gateway run` per host **per OS user**. A second one loses the host lock in `$HERMES_GATEWAY_LOCK_DIR` / `$XDG_STATE_HOME/hermes/gateway-locks` and exits 75, or attaches to the owner (`gateway/host_rendezvous.py` docstring, `gateway/run.py` around line 5340). `--force` overrides.
- Token-scoped locks (one Telegram token across homes) live in the same lock dir (`gateway/status.py::acquire_scoped_lock`).
- One multiplexing gateway ticks cron for every profile under its root (`cron/AGENTS.md` "Cron ownership is not gated on `gateway.multiplex_profiles`").
- OAuth logins for some providers are shared from the root `auth.json` across profiles (`profiles.md` "OAuth logins are shared, not copied").

**Inferred** recipe for local tests or dense hosting: give each instance its own `HERMES_HOME` that is **not** under another instance's `profiles/` directory, its own `HERMES_GATEWAY_LOCK_DIR` (or `XDG_STATE_HOME`, or its own OS user / `HOME`), its own API server port, and API-key-only providers. In production this is moot because each E2B sandbox is its own VM.

---

## 8. Startup, shutdown, crash recovery, checkpoints

### 8.1 Startup (Verified)

- `hermes_bootstrap.py`: stdio/encoding and import-path hardening, imported first by every entry point.
- `hermes_startup_watchdog.py`: if `gateway run` does not reach a live event loop within `HERMES_STARTUP_WATCHDOG_TIMEOUT_S` (300 s) it dumps stacks to `logs/gateway-startup-watchdog.log` and exits 75 for the supervisor to restart.
- Respawn-storm breaker: `HERMES_GATEWAY_MAX_STARTS` (5) within `HERMES_GATEWAY_START_WINDOW_S` (120).
- Fatal config errors exit 78 (`EX_CONFIG`) so supervisors stop restarting (`gateway-internals.md`, `gateway/restart.py`).
- Docker boot: `stage2-hook.sh` seeds `.env`/`config.yaml`/`SOUL.md`, runs config migrations (skip with `HERMES_SKIP_CONFIG_MIGRATION=1`), syncs bundled skills; the reconciler restarts profiles whose `gateway_state.json` said `running` (`docker.md` "What the Dockerfile does").

### 8.2 Shutdown (Verified)

- `gateway/run_shutdown.py`: refuses new work, drains in-flight agents for `agent.restart_drain_timeout` (default 0 s) with a cron floor `agent.cron_drain_timeout` (default 30 s), then interrupts. A shutdown watchdog bounds the whole stop.
- `/v1/runs` active at shutdown are persisted as `interrupted` before the agent is interrupted, and carry `shutdown_requested_at` while draining (`programmatic-integration.md` "Terminal run status").
- `gateway/shutdown_flush.py`: pending messages and live transcripts are spooled to `$HERMES_HOME/pending_messages/` as atomic JSON and replayed into `state.db` on next start (`recover_pending_to_db`).

### 8.3 Killed mid-turn (Verified unless noted)

- **Transcript durability:** after every tool round, `agent/tool_executor.py::_flush_session_db_after_tool_progress` writes the messages to `state.db` before the result is shown anywhere ("tool side effects can kill/restart the process before turn-end persistence runs"). If that flush fails, the turn ends with `turn_exit_reason="session_persistence_failed"` instead of continuing (`agent/turn_tool_round.py`).
- **Chat sessions in the gateway:** sessions interrupted by a restart are marked `resume_pending`; on start, `gateway/run_startup.py::_schedule_resume_pending_sessions` auto-continues them if they are within a freshness window and the adapter is up.
- **Cron:** `tick()` advances `next_run_at` before dispatch (at-most-once), stamps `pending_slot`, and a later scan restores a lost occurrence once if its owner is provably dead; the executions ledger blocks a second fire of the same `scheduled_instant`. A job mid-run at a crash is recorded `unknown` and is not retried; the next occurrence runs normally (`cron-internals.md` "Missed-occurrence contract", `cron.md` "Job storage").
- **API runs:** `Idempotency-Key` replay survives restarts; a killed run ends `interrupted`, not `running`.
- **Heartbeats, loops, goals:** state persists in `SessionDB.state_meta` and resumes after restart (`heartbeat.md`, `goals.md`, `loops.md`).
- **Background `delegate_task`** is process-local and is lost on restart (`cron/AGENTS.md`).
- **Inferred:** a tool call in flight at `SIGKILL` may or may not have taken effect, and Hermes has no way to know. For our MCP tools (intents, thesis writes) we need idempotency keys on our side. Python-embedded runs have no automatic resume; our orchestrator would reload history (by `session_id` from `state.db`) and send a new turn.

### 8.4 Checkpoints (Verified)

`tools/checkpoint_manager.py` is a filesystem snapshot system (shadow git store at `$HERMES_HOME/checkpoints/`) taken before file-mutating tool calls, for rollback. It is off by default (`checkpoints.enabled: false`) and is **not** a process or conversation checkpoint. Batch runs have their own resume checkpoint (`batch_runner.py`, `batch-processing.md` "Checkpointing"), which is for dataset generation, not for us.

### 8.5 Scale-to-zero (Verified)

`gateway/scale_to_zero.py` is Fly.io specific: it quiesces the relay and suspends the machine via the Fly Machines API when idle (default 2 minutes); suspend preserves RAM, so it does not mark sessions for resume. Enabled only by a NAS-stamped env (`HERMES_SCALE_TO_ZERO`). **Inferred:** the pattern (quiesce, then snapshot the VM) is analogous to E2B pause/resume, but the code does not apply to E2B as is.

---

## Implications for our platform

1. **Run mode:** run `hermes gateway run` headless in each sandbox with only the API server enabled (no chat platforms), bound to localhost or the sandbox's private interface, with a per-agent `API_SERVER_KEY` of 32+ hex chars. Drive each discovery stage from the orchestrator with `POST /v1/runs` plus `Idempotency-Key`, and poll `/v1/runs/{id}` or subscribe to `/events`. The Python `AIAgent` embed is the alternative if we want in-process callbacks, but it gives up the gateway's restart resume and run bookkeeping.
2. **Scheduling:** the orchestrator owns the clock and stage transitions. Hermes cron is optional; if used, keep it to simple recurring Scan and Zoom out jobs with `deliver: local`, `continuity`, script gates, and pinned cheap models. Set `cron.allow_agent_scheduling: false` and remove the `cronjob` toolset from the agent's toolsets so the agent cannot create schedules.
3. **Structured output:** do not rely on the final text. Every deliverable (thesis card, allocation proposal, parameter tweak) should be a call to our platform MCP tool with a strict input schema. Treat `final_response` as a private log that only the narrator pipeline may read.
4. **Owner input:** goals and limits reach the agent through our "read goals and limits" MCP tool or as a serialized block in `instructions`. Note that `instructions` are layered on top of Hermes's own system prompt (SOUL.md and friends), which we must template.
5. **Never use `hermes -z`** for agent work: it silently sets `HERMES_YOLO_MODE=1`. Keep `approvals.*_mode: deny`.
6. **Per-agent template:** `config.yaml` (tier section values), `.env` (LiteLLM base URL and virtual key, API server key), `SOUL.md` (tier playbook), `skills/` (decrypted equipped skills), optional `cron/jobs.json` and `scripts/`. Everything else is runtime state.
7. **Persistence across sandbox sessions:** export `state.db` (via `sqlite3.backup()` or `hermes backup --quick`), `memories/`, `cron/jobs.json` plus `cron/executions.db`, and `logs/`. Do not export or restore `gateway.pid`, `gateway_state.json`, or lock files. Encrypt skills at rest and re-inject them on restore instead of exporting `skills/`.
8. **Image:** build a custom E2B template from the Hermes Dockerfile with extras baked in, `security.allow_lazy_installs: false`, `updates.check: false`, browser tools removed unless needed, and a 2 GB RAM floor. Plan our own supervision since s6 may not be PID 1 in Firecracker.
9. **Crash safety:** Hermes will not double-fire cron or duplicate runs with idempotency keys, but in-flight MCP side effects are unknowable after a kill. Our MCP servers need idempotency keys and should record intents as proposals, which fits the "Hermes never signs" design.
10. **Budgets:** Hermes has no per-run dollar cap. Enforce spend in LiteLLM per virtual key; use `agent.run_budget_seconds` and `agent.max_turns` (unlimited by default) as wall-clock and iteration backstops, and `HERMES_CRON_TIMEOUT` for idle kills.

## Open questions

1. Does `GET /api/jobs/{id}` return the last run's output text, or only status? The docs say "definition and last-run state"; the handler was not read. This matters if we let Hermes cron run stages and read results over HTTP.
2. How does the gateway behave inside an E2B Firecracker VM where s6 is not PID 1 and there is no user systemd: does cron fall back cleanly to direct subprocess workers, and do orphaned tool processes get reaped? Suggested spike: boot the image in an E2B sandbox and run a cron job plus a `terminal` tool call, then inspect `ps`.
3. Actual RAM and disk footprint of one idle gateway with only the API server enabled and no browser. Not documented. Suggested spike: measure RSS after boot and after a 20-tool-call run.
4. Which startup and runtime paths make outbound network calls by default (update checks, model catalog refresh, models.dev, Nous portal) that our deny-by-default egress must allow or that we must disable? Report 06 (security) should confirm the full list.
5. Can `request_overrides` safely carry a `response_format` for the main loop on our LiteLLM route without breaking tool calls? Untested; my recommendation avoids needing it.
6. Is there a supported way to set per-request toolsets or skills on the API server (for stage-specific tool narrowing), or do we need one Hermes profile or config per stage? Code shows no such request field; `platform_toolsets.api_server` is global per home.
7. How large does `state.db` grow for an agent running several stages per day, and how quickly does compression and pruning keep it bounded? This drives our export size per sandbox session.
8. Doc and code disagree in four places (bare `30m` schedule meaning, cron `skip_memory`, default `max_iterations` 500 vs unlimited, API key minimum length 8 vs 16). We followed the code; any other stale docs we rely on should be re-verified.
