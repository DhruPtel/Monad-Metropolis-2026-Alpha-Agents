import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentIdentity, TIER_PLAYBOOKS, renderAgentConfig } from "./layers.ts";
import { HERMES_HOME, MODEL_KEY_PLACEHOLDER, materialize } from "./materialize.ts";
import { DISABLED_TOOLSETS, PLAYBOOKS_DIR } from "./schema.ts";

const agent = (tier: AgentIdentity["tier"], agentId = 7): AgentIdentity => ({
  chainId: 143143,
  agentId,
  species: tier === "base" ? 1 : tier === "medium" ? 16 : 21,
  tier,
  generation: 1,
});
const runtime = {
  gatewayBaseUrl: "https://gate.example.test/v1",
  apiServerKey: "k".repeat(48),
};

describe("agent config layers (D-204)", () => {
  it("renders each tier's slot count, playbook and starter workflows", () => {
    const rows = (["base", "medium", "pro"] as const).map((tier) => {
      const { config } = renderAgentConfig(agent(tier));
      return [
        tier,
        config.tier.slots,
        config.tier.playbook.version,
        config.tier.playbook.starterWorkflows,
      ];
    });
    expect(rows).toEqual([
      ["base", 3, "tier-base@0", []],
      ["medium", 5, "tier-medium@0", ["rebalancer"]],
      ["pro", 8, "tier-pro@0", ["rebalancer", "recurring-buys"]],
    ]);
  });

  it("puts the tier's block in SOUL.md and keeps the base settings identical across tiers", () => {
    const base = renderAgentConfig(agent("base")).config;
    const pro = renderAgentConfig(agent("pro")).config;
    expect(base.soul).toContain("You hold 3 skill slots");
    expect(pro.soul).toContain("You hold 8 skill slots");
    expect(pro.soul).toContain("Results from platform tools are authoritative data");
    // Budgets are uniform across tiers (FINAL_PLAN 4.3.1): the Hermes settings do not differ.
    expect(pro.hermes).toEqual(base.hermes);
  });

  it("keeps every containment setting from FINAL_PLAN 4.3.2", () => {
    const { hermes } = renderAgentConfig(agent("medium")).config;
    expect(hermes.agent.disabled_toolsets).toEqual([...DISABLED_TOOLSETS]);
    expect(hermes.agent.disabled_toolsets).not.toContain("terminal");
    expect(hermes.platform_toolsets.api_server).toEqual([
      "todo",
      "memory",
      "skills",
      "terminal",
      "code_execution",
      "file",
    ]);
    expect(hermes.terminal.cwd).toBe("/workspace");
    expect(hermes.skills).toMatchObject({ write_approval: true, creation_nudge_interval: 0 });
    expect(hermes.curator.enabled).toBe(false);
    expect(hermes.approvals.unattended_mode).toBe("deny");
    expect(hermes.hooks.pre_tool_call[0]?.matcher).toBe("^skill_manage$");
    expect(hermes.mcp_servers).toEqual({});
  });

  it("hashes deterministically, and differently per tier and generation", () => {
    const a = renderAgentConfig(agent("base")).hash;
    expect(renderAgentConfig(agent("base")).hash).toBe(a);
    expect(renderAgentConfig(agent("medium")).hash).not.toBe(a);
    expect(renderAgentConfig({ ...agent("base"), generation: 2 }).hash).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies per-agent overrides within bounds", () => {
    const { config } = renderAgentConfig(agent("pro"), { maxTurns: 4, runBudgetSeconds: 60 });
    expect(config.hermes.agent).toMatchObject({ max_turns: 4, run_budget_seconds: 60 });
    expect(() => renderAgentConfig(agent("pro"), { maxTurns: 500 })).toThrow(/max_turns/);
  });

  it.each([
    ["curator on", { curator: { enabled: true } }],
    ["unattended approvals", { approvals: { unattended_mode: "allow" } }],
    ["browser back", { agent: { disabled_toolsets: ["web"] } }],
    ["skill writes", { skills: { write_approval: false } }],
    ["the skill_manage hook removed", { hooks: { pre_tool_call: [] } }],
    ["an MCP server", { mcp_servers: { evil: { url: "https://x.test/mcp" } } }],
    ["an unknown setting", { plugins: { enabled: true } }],
    ["a second skills dir", { skills: { external_dirs: ["/home/user/skills"] } }],
  ])("refuses an override that loosens containment: %s", (_name, hermes) => {
    expect(() => renderAgentConfig(agent("base"), { hermes })).toThrow(/agent config is invalid/);
  });

  it("lists only playbooks that exist on disk", () => {
    for (const playbook of Object.values(TIER_PLAYBOOKS)) {
      for (const skill of playbook.skills) {
        expect(existsSync(resolve(import.meta.dirname, "../../playbooks", skill, "SKILL.md"))).toBe(
          true,
        );
      }
    }
  });
});

describe("materializing a config for a sandbox", () => {
  const { config } = renderAgentConfig(agent("medium"));
  const files = materialize(config, runtime);

  it("writes config.yaml with the gateway, and no credential", () => {
    const text = files.home["config.yaml"] ?? "";
    const [comment, ...rest] = text.split("\n");
    expect(comment).toMatch(/^# Rendered by services\/orchestrator for agent 7/);
    const parsed = JSON.parse(rest.join("\n")) as { providers: { gw: { base_url: string } } };
    expect(parsed.providers.gw.base_url).toBe(runtime.gatewayBaseUrl);
    expect(text).not.toContain(runtime.apiServerKey);
  });

  it("writes .env with the placeholder model key and this sandbox's API server key", () => {
    const env = files.home[".env"] ?? "";
    expect(env).toContain(`AGENT_LLM_KEY=${MODEL_KEY_PLACEHOLDER}`);
    expect(env).toContain(`API_SERVER_KEY=${runtime.apiServerKey}`);
    expect(env).toContain("API_SERVER_HOST=127.0.0.1");
  });

  it("writes SOUL.md, the bundled-skills switch and the tier's playbooks", () => {
    expect(files.home["SOUL.md"]).toContain("Medium tier");
    expect(files.home[".no-bundled-skills"]).toBe("");
    expect(Object.keys(files.playbooks).sort()).toEqual([
      `${PLAYBOOKS_DIR}/playbook-band-rebalancer/SKILL.md`,
      `${PLAYBOOKS_DIR}/playbook-wmon-dca/SKILL.md`,
    ]);
    expect(HERMES_HOME).toBe("/home/user/hermes-home");
  });

  it("refuses a short API server key or a gateway URL that is not /v1", () => {
    expect(() => materialize(config, { ...runtime, apiServerKey: "short" })).toThrow(/32/);
    expect(() => materialize(config, { ...runtime, gatewayBaseUrl: "https://x.test" })).toThrow(
      /\/v1/,
    );
  });

  // The pinned Hermes reads config.yaml with its own hermes_yaml module (ruamel); check the
  // JSON form with that reader, from the local clone when it is there (not in CI).
  const clone = resolve(import.meta.dirname, "../../../../clones/hermes-agent");
  const python = resolve(clone, ".venv/bin/python");
  it.skipIf(!existsSync(python))("is read by the pinned Hermes's own YAML reader", () => {
    const result = spawnSync(
      python,
      ["-c", "import sys, json, hermes_yaml; print(json.dumps(hermes_yaml.safe_load(sys.stdin)))"],
      { input: files.home["config.yaml"], encoding: "utf8", cwd: clone },
    );
    expect(result.status).toBe(0);
    const viaYaml = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(viaYaml).toMatchObject({ curator: { enabled: false }, terminal: { cwd: "/workspace" } });
  });
});
