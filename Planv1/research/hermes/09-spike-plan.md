# 09. Spike Plan, Risks, and Open Questions

| Field | Value |
|---|---|
| Commit | `085d9ee608893bb0611c2fc339c19d8848af9f2b` |
| Commit date | 2026-09-25 |
| Release tag | `v2026.9.24` (HEAD is past it) |
| License | MIT |
| Status | Plan only. Nothing below has been run. Commands and keys come from the cited code and docs (reports 02 to 06); anything not proven in code is marked **Inferred**. |

---

## 1. Minimal proof of concept

**Goal.** Show that one Hermes instance, unmodified and pinned, can do all of the following:
- run headless
- use our OpenAI-compatible gateway with a per-agent key
- connect to one MCP server
- load one skill from a folder we control
- run one scheduled task
- return one structured output

**Where.** Run on a Linux dev box or in one E2B sandbox. Put everything in a scratch directory, never in the research clone.

### Step 0. Environment and pinning

```bash
# Separate checkout, pinned
git clone https://github.com/NousResearch/hermes-agent.git ~/spike/hermes && cd ~/spike/hermes
git checkout 085d9ee608893bb0611c2fc339c19d8848af9f2b
source ./activate                      # PM-prepared source env (website/docs/guides/python-library.md)
export HERMES_HOME=~/spike/home        # isolates all state (hermes_constants.py::get_hermes_home)
mkdir -p $HERMES_HOME /tmp/agent-skills
touch $HERMES_HOME/.no-bundled-skills  # only essential skills get seeded (tools/skills_sync.py)
```

**Success:** `hermes --help` runs, and `$HERMES_HOME` contains nothing unexpected after `hermes doctor`.

### Step 1. Gateway with a per-agent key (LiteLLM)

```bash
pip install 'litellm[proxy]'   # in a separate venv, not the Hermes env
cat > ~/spike/litellm.yaml <<'EOF'
model_list:
  - model_name: research-strong
    litellm_params: { model: anthropic/claude-sonnet-4-5, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: scan-cheap
    litellm_params: { model: anthropic/claude-haiku-4-5, api_key: os.environ/ANTHROPIC_API_KEY }
general_settings: { master_key: sk-master-spike }
EOF
litellm --config ~/spike/litellm.yaml --port 4000   # plus a Postgres URL if virtual keys need a DB
# Create a per-agent virtual key with a small budget
curl -s localhost:4000/key/generate -H 'Authorization: Bearer sk-master-spike' \
  -H 'Content-Type: application/json' \
  -d '{"models":["research-strong","scan-cheap"],"max_budget":0.50,"metadata":{"agent_id":"agent-spike-1"}}'
```

Write `$HERMES_HOME/.env`:

```bash
AGENT_LLM_KEY=sk-<virtual key from above>
AGENT_MCP_TOKEN=spike-mcp-token
API_SERVER_ENABLED=true
API_SERVER_KEY=<32 random hex chars>     # 16+ chars required (api_server.py::_api_key_passes_startup_guard)
```

**Success:** later steps show spend on this virtual key in LiteLLM (`/key/info`), carrying the `x-agent-id` header.

### Step 2. Mock MCP server with a structured-output tool

A small FastMCP server over Streamable HTTP, in its own venv:

```python
# ~/spike/mcp_platform.py
import json, time
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("platform")
LOG = "/tmp/spike-actions.jsonl"

@mcp.tool()
def get_goals_and_limits() -> dict:
    """Return the owner's structured goals and risk limits."""
    return {"base_asset": "USDC", "max_drawdown_bps": 800, "allowed_assets": ["WETH", "WBTC", "USDC"], "horizon_days": 30}

@mcp.tool()
def propose_allocation(weights: list[dict], max_drawdown_bps: int, rationale_code: str) -> dict:
    """Propose a portfolio allocation. weights: [{asset, bps}], must sum to 10000."""
    if sum(w["bps"] for w in weights) != 10000:
        return {"error": "weights must sum to 10000 bps"}
    rec = {"ts": time.time(), "weights": weights, "max_drawdown_bps": max_drawdown_bps, "rationale_code": rationale_code}
    open(LOG, "a").write(json.dumps(rec) + "\n")
    return {"proposal_id": f"p-{int(rec['ts'])}", "status": "pending_policy"}

if __name__ == "__main__":
    mcp.settings.port = 8765
    mcp.run(transport="streamable-http")
```

**Success:** `curl localhost:8765/mcp` responds. Add a bearer check in a middleware, then confirm a missing header is rejected.

### Step 3. One skill from our folder

```bash
mkdir -p /tmp/agent-skills/research/mnd-usdc-allocation
cat > /tmp/agent-skills/research/mnd-usdc-allocation/SKILL.md <<'EOF'
---
name: mnd-usdc-allocation
description: "Use for: USDC-based allocation with downside limits"
---
# USDC allocation procedure
1. Call mcp__platform__get_goals_and_limits.
2. Allocate only to allowed_assets. Keep at least 4000 bps in USDC if max_drawdown_bps < 1000.
3. Call mcp__platform__propose_allocation with weights summing to 10000 and rationale_code "SPIKE_V1".
4. Reply with only the proposal_id.
SPIKE-CANARY-7f3a
EOF
chmod -R a-w /tmp/agent-skills      # read-only, as in production
```

The canary string lets later steps search every artifact for leaked skill text.

### Step 4. `config.yaml`

```yaml
model:
  provider: "custom:gw"
  default: "scan-cheap"
providers:
  gw:
    base_url: "http://localhost:4000/v1"
    key_env: AGENT_LLM_KEY
    api_mode: chat_completions
    discover_models: false
    models:
      scan-cheap: { context_length: 200000 }
      research-strong: { context_length: 200000 }
    extra_headers: { x-agent-id: "agent-spike-1" }
    session_affinity_header: x-litellm-session-id
auxiliary:
  compression:      { provider: "custom:gw", model: "scan-cheap" }
  vision:           { provider: "custom:gw", model: "scan-cheap" }
  title_generation: { enabled: false }
  background_review: { enabled: false }
agent:
  max_turns: 20
  run_budget_seconds: 300
  disabled_toolsets: [terminal, code_execution, file, browser, web, search, x_search, delegation,
                      cronjob, connections, computer_use, clarify, image_gen, video, video_gen, tts,
                      vision, kanban, session_search]
platform_toolsets:
  api_server: [todo, skills, platform]
  cron: [todo, skills, platform]
tool_loop_guardrails: { hard_stop_enabled: true }
tools:
  tool_search: { enabled: off }
  connectors: { enabled: false }
skills:
  external_dirs: ["/tmp/agent-skills"]
  creation_nudge_interval: 0
  write_approval: true
  ledger: false
memory: { nudge_interval: 0, user_profile_enabled: false }
curator: { enabled: false }
approvals: { mode: manual, unattended_mode: deny, cron_mode: deny, single_query_mode: deny }
security: { allow_lazy_installs: false, tirith_enabled: false }
updates: { check: false }
model_catalog: { enabled: false }
web: { keyless_fallback: false }
cron: { allow_agent_scheduling: false }
mcp_servers:
  platform:
    url: "http://localhost:8765/mcp"
    headers: { Authorization: "Bearer ${AGENT_MCP_TOKEN}" }
    sampling: { enabled: false }
    elicitation: { enabled: false }
    tools: { resources: false, prompts: false }
```

**Success:**
- `hermes config get model.provider` prints `custom:gw`.
- `hermes mcp test platform` lists `get_goals_and_limits` and `propose_allocation`.
- `hermes tools --summary` (or `GET /v1/toolsets` later) shows only `todo`, `skills` and `mcp-platform` tools.

### Step 5. Headless run with structured output

```bash
hermes gateway run &          # no chat platforms configured; API server only
curl -s localhost:8642/health
curl -s localhost:8642/v1/skills -H "Authorization: Bearer $API_SERVER_KEY"   # expect mnd-usdc-allocation
RUN=$(curl -s localhost:8642/v1/runs -H "Authorization: Bearer $API_SERVER_KEY" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: agent-spike-1:cycle-1:zoomout' \
  -d '{"input":"Stage: ZOOM_OUT. Produce an allocation proposal per your skills.","session_id":"spike-s1"}' | jq -r .run_id)
curl -sN localhost:8642/v1/runs/$RUN/events -H "Authorization: Bearer $API_SERVER_KEY"
curl -s localhost:8642/v1/runs/$RUN -H "Authorization: Bearer $API_SERVER_KEY" | jq '{status, usage, runtime}'
tail -1 /tmp/spike-actions.jsonl   # the structured output
```

**Success:**
- The run reaches `completed`.
- The event stream shows `skill_view(mnd-usdc-allocation)`, `get_goals_and_limits` and `propose_allocation`.
- `/tmp/spike-actions.jsonl` contains a schema-valid proposal.
- Sending the same `Idempotency-Key` again returns the same `run_id` with `Idempotency-Replayed: true`.

### Step 6. One scheduled task

```bash
hermes cron create "every 5m" "Stage: SCAN. Call get_goals_and_limits and propose an allocation per your skills." \
  --name spike-scan --deliver local --skill mnd-usdc-allocation --model scan-cheap
hermes cron list
hermes cron tick              # or wait for the gateway's 60 s ticker
ls $HERMES_HOME/cron/output/*/
```

**Success:**
- A second line appears in `/tmp/spike-actions.jsonl`.
- `hermes cron runs` shows `ok`.
- LiteLLM shows the spend on the same virtual key.

### Step 7. Measurements and negative tests

The success criteria are listed after the table.

| Test | How | Pass condition |
|---|---|---|
| Egress | Run steps 5 and 6 with a firewall (or E2B allowlist) permitting only `localhost:4000` and `localhost:8765`, logging denials | Runs succeed; list every denied host (expect none or only fail-soft ones such as `models.dev`) |
| No other vendor | Inspect LiteLLM logs | Every model request, including compression when forced with a tiny `context_length`, arrives at LiteLLM with `x-agent-id` |
| Budget exhaustion | Set virtual key `max_budget` to 0.0001 and run | Run ends with a `billing` failure reason (not retried and not classified as `format_error`); record LiteLLM's exact status and body |
| Skill read-only | Ask in a run: "fix a typo in the mnd-usdc-allocation skill" | No change on disk; `pending/skills/` holds at most a staged proposal; the tool error is clean |
| Tool allowlist | Ask it to run a shell command or read `/etc/passwd` | Tool not available; no execution |
| Leak scan | `grep -r SPIKE-CANARY-7f3a $HERMES_HOME /tmp` after runs, plus a forced 400 (for example an invalid model alias) | Record every hit. Expect `state.db`, and `sessions/request_dump_*` after the forced error. Anything else is a new finding |
| Export and restore | Stop the gateway, copy `state.db` via `sqlite3 .backup`, `memories/`, then start a fresh HERMES_HOME from templates plus these files | `session_id: spike-s1` continues in a new run |
| Footprint | `ps -o rss` after boot and after 20 tool calls; `du -sh $HERMES_HOME` | Record numbers for E2B template sizing |
| Hook blocking | Add a `pre_tool_call` shell hook with `fail_closed: true` and a matcher for `skill_manage`; set `hooks_auto_accept: true` | `skill_manage` is blocked; confirm matcher semantics |

**Overall success.** All the following hold:
- Steps 5 and 6 produce schema-valid proposals.
- All model traffic goes through the virtual key.
- The only egress is our two hosts.
- The skill is not modified.
- Budget exhaustion ends the run cleanly with a reason the orchestrator can detect.

---

## 2. Risks, ranked

| # | Risk | Likelihood | Impact | Fallback |
|---|---|---|---|---|
| 1 | **Private skill leakage** through agent text, persisted state or vendor logs (reports 04 §7, 06 §8). The agent can always read and quote its skills | High (inherent) | High (core product promise) | Narrator reads actions only; encrypt all exports; zero-retention vendor terms; move secret logic into MCP tools so skills are thin; contractually define "skill privacy" as privacy from owners, not from the model vendor |
| 2 | **Upstream churn**: config keys or defaults change between releases, silently widening tools or egress (2,142 commits past the last tag; stale docs in 5+ places) | High | Medium | Pin a commit; a contract test suite runs the step 7 checks on every upgrade; Managed Scope pins security keys |
| 3 | **Self-improvement or tool behavior we cannot fully disable** (for example an unknown path that writes skills or memory) | Medium | High | Read-only skills mount; `write_approval`; exporter allowlist drops unknown files; diff `HERMES_HOME` at shutdown |
| 4 | **Budget error misclassified** (LiteLLM budget error parsed as `format_error` or retried) | Medium | Medium | Orchestrator also subscribes to LiteLLM budget alerts and stops runs itself; custom error mapping in LiteLLM to return 402 |
| 5 | **Resource footprint too large** for many concurrent E2B sandboxes (docs: 1 GB minimum, Chromium in the image) | Medium | Medium (cost) | Slim image without browser extras; short sessions; pause sandboxes between stages |
| 6 | **Quality of multi-stage research** is poor with short sessions and no memory of previous stages | Medium | High | Thesis Board digest tools; per-stage playbooks; evaluate with a fixed set of market scenarios before launch |
| 7 | **Startup latency** of Hermes plus gateway in a fresh sandbox is too slow for a per-stage lifecycle | Medium | Low to medium | Keep the sandbox alive across a full cycle; E2B snapshot or resume of a warmed template |
| 8 | **Prompt injection** from web or X data steering proposals | Medium | Medium (Hermes cannot sign; policy layer and approvals catch it) | Untrusted wrapping already applies to MCP results; policy checks on every proposal; Challenge stage on a separate session |
| 9 | **Request dumps and `state.db` growth** fill the disk or bloat exports | Low | Low | tmpfs for `sessions/`; periodic `state.db` pruning or JSON export of recent sessions only |
| 10 | **License or trademark issues** | Low | Low | MIT notice in image and notices file; no Nous branding |

If risks 1 to 3 prove unmanageable, the fallback is a **thin custom agent loop**: our own tool-calling loop over LiteLLM with our MCP servers and SKILL.md loader, borrowing Hermes' design patterns (progressive skill disclosure, untrusted-result wrapping, loop guards) under MIT.

---

## 3. Open questions

These questions could not be answered by reading the code. Each has a spike step in section 1 or needs a direct test.

**Models and gateway**
1. What does LiteLLM's `/v1/models` return, and does Hermes parse context length or pricing from it? Cost may show as "unknown" (report 02).
2. Does every auxiliary task (`compression`, `curator`, `session_search`, `web_extract`, `approval`, `mcp`) resolve `provider: "custom:gw"` end to end (report 02)?
3. Is provider-level `extra_body` really absent from auxiliary calls (report 02, Inferred)?
4. Which exact status and body does LiteLLM return on budget exhaustion, and how does `agent/error_classifier.py` classify it?
5. Does the top-level `reasoning_effort: medium` sent to custom endpoints cause 400s on non-reasoning LiteLLM routes, costing an extra request each time?

**Tools and approvals**

6. Shell hook `matcher` semantics (search vs full match) and whether it sees the MCP-prefixed name (report 03).
7. Do `/v1/runs` approval requests wait for `POST /v1/runs/{id}/approval`, or deny instantly under `approvals.unattended_mode: deny`? Code suggests they wait (report 07 §5 row 4).
8. Is there any directory jail for `read_file` if we ever re-enable file tools (report 03)?

**Skills, memory, state**

9. Does the API-server gateway path run `sync_skills` at startup (report 04)?
10. What exactly happens when `skill_manage` targets a read-only mount (report 04)?
11. Are compression summaries or background review transcripts stored in `state.db` with skill text (report 04)?
12. How fast does `state.db` grow for several stages per day (report 05)?

**Runtime and security**

13. Which hosts are contacted in API-server-only mode with a custom provider, and does the gateway run the passive update check (report 06)?
14. Can `request_dump_*.json` writes be turned off? None found (report 06).
15. How does the gateway behave inside Firecracker without s6 as PID 1 or user systemd, and are cron worker subprocesses reaped (report 05)?
16. Actual RSS, disk and startup time of a slim image (report 05).
17. Does `pm` contact PyPI when `allow_lazy_installs: false`, for example during an update (report 06)?

**Behavior and product**

18. How reliably does the model load the right skill from a 60-character description when 5 to 10 private skills are equipped? This needs an evaluation, not code reading.
19. Can the `/goal` judge loop usefully drive "keep diving until the thesis has N sources" inside one run (report 01 did not audit it)?
20. Product decision: do agent-created skills or memory derived from a private skill survive unequip or NFT sale?
