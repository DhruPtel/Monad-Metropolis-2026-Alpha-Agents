/**
 * Renders the HERMES_HOME files for one agent run: config.yaml and .env.
 *
 * Nothing rendered here is a credential for the gateway or the tool servers. The model key
 * variable holds a fixed placeholder; the real per-agent credentials are injected into the
 * request headers outside the sandbox (E2B's egress proxy in the cloud, the test harness
 * locally). The only secret in .env is the Hermes API server key, which authorizes calls into
 * this sandbox's own Hermes and nothing else.
 *
 * Switches follow FINAL_PLAN 4.3.2 and D-143, narrowed for the thin spike: no in-sandbox
 * toolsets yet (terminal, code execution and file tools come with P1-U5), self-improvement off.
 */

export const MODEL_KEY_PLACEHOLDER = "injected-outside-the-sandbox";

export interface HermesRenderInput {
  /** Base URL of the model gateway as the sandbox sees it, ending in /v1. */
  readonly gatewayBaseUrl: string;
  /** URL of the platform tools MCP endpoint as the sandbox sees it. */
  readonly platformToolsUrl: string;
  readonly agentId: string;
  readonly skillsDir: string;
  readonly model: string;
  readonly apiServerKey: string;
  readonly apiServerPort: number;
}

export interface HermesFiles {
  readonly "config.yaml": string;
  readonly ".env": string;
}

// Every toolset that is not needed for the thin spike, removed from the schema entirely.
const DISABLED_TOOLSETS = [
  "terminal",
  "code_execution",
  "file",
  "browser",
  "web",
  "search",
  "x_search",
  "delegation",
  "cronjob",
  "connections",
  "computer_use",
  "clarify",
  "image_gen",
  "video",
  "video_gen",
  "tts",
  "vision",
  "kanban",
  "session_search",
  "memory",
];

const q = (value: string): string => JSON.stringify(value);

export function renderHermesFiles(input: HermesRenderInput): HermesFiles {
  if (input.apiServerKey.length < 32) throw new Error("the API server key must be 32+ characters");
  const config = `# Rendered per run by services/orchestrator. Do not edit inside a sandbox.
model:
  provider: "custom:gw"
  default: ${q(input.model)}
providers:
  gw:
    base_url: ${q(input.gatewayBaseUrl)}
    key_env: AGENT_LLM_KEY
    api_mode: chat_completions
    discover_models: false
    models:
      ${input.model}: { context_length: 200000 }
    extra_headers: { x-agent-id: ${q(input.agentId)} }
auxiliary:
  compression: { provider: "custom:gw", model: ${q(input.model)} }
  vision: { provider: "custom:gw", model: ${q(input.model)} }
  title_generation: { enabled: false }
  background_review: { enabled: false }
agent:
  max_turns: 12
  run_budget_seconds: 240
  disabled_toolsets: [${DISABLED_TOOLSETS.join(", ")}]
platform_toolsets:
  api_server: [skills, platform]
tool_loop_guardrails: { hard_stop_enabled: true }
tools:
  tool_search: { enabled: off }
  connectors: { enabled: false }
skills:
  external_dirs: [${q(input.skillsDir)}]
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
# Self-improvement off, third layer (after the read-only mount and write_approval): a
# fail-closed hook blocks every skill_manage call before it runs. skill_manage cannot be dropped
# from the skills toolset by config at this commit, so the hook is what keeps it inert.
hooks:
  pre_tool_call:
    - matcher: "^skill_manage$"
      command: "/bin/sh -c 'echo skill writes are disabled for agents >&2; exit 2'"
      timeout: 10
      fail_closed: true
hooks_auto_accept: true
mcp_servers:
  platform:
    url: ${q(input.platformToolsUrl)}
    sampling: { enabled: false }
    elicitation: { enabled: false }
    tools: { resources: false, prompts: false }
`;
  const env = [
    `AGENT_LLM_KEY=${MODEL_KEY_PLACEHOLDER}`,
    "API_SERVER_ENABLED=true",
    `API_SERVER_KEY=${input.apiServerKey}`,
    "API_SERVER_HOST=127.0.0.1",
    `API_SERVER_PORT=${input.apiServerPort}`,
    "",
  ].join("\n");
  return { "config.yaml": config, ".env": env };
}
