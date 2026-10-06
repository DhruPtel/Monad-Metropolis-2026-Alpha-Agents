import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "./layers.ts";
import { type AgentConfig, PLAYBOOKS_DIR } from "./schema.ts";

/**
 * Turns a stored agent configuration into the files a sandbox needs, adding
 * what is only known at sandbox start: the gateway URL and this sandbox's API
 * server key (D-204). Nothing written here is a credential for the gateway or
 * a tool server: the model key variable holds a fixed placeholder, and the
 * gate attaches the agent's real key outside the sandbox (D-203). The API
 * server key only opens this sandbox's own Hermes, on its loopback.
 */
export const MODEL_KEY_PLACEHOLDER = "injected-outside-the-sandbox";
export const HERMES_HOME = "/home/user/hermes-home";
export const API_SERVER_PORT = 8642;

const PLAYBOOK_SOURCE = resolve(import.meta.dirname, "../../playbooks");

export interface SandboxRuntime {
  /** Base URL of the model gateway as the sandbox sees it, ending in /v1. */
  readonly gatewayBaseUrl: string;
  /** Origin of the tool servers as the sandbox sees it (the gate: /mcp/data, /mcp/platform). */
  readonly toolsOrigin: string;
  readonly apiServerKey: string;
}

export interface SandboxFiles {
  /** Paths relative to HERMES_HOME. */
  readonly home: Readonly<Record<string, string>>;
  /** Absolute paths under PLAYBOOKS_DIR, written by root and made read-only. */
  readonly playbooks: Readonly<Record<string, string>>;
}

/** The playbook skill text for one folder, from services/orchestrator/playbooks. */
export function playbookSkill(name: string, root: string = PLAYBOOK_SOURCE): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid playbook name ${name}`);
  return readFileSync(join(root, name, "SKILL.md"), "utf8");
}

export function materialize(config: AgentConfig, runtime: SandboxRuntime): SandboxFiles {
  if (runtime.apiServerKey.length < 32)
    throw new Error("the API server key must be 32+ characters");
  if (!/^https?:\/\/[^\s]+\/v1$/.test(runtime.gatewayBaseUrl))
    throw new Error("the gateway URL must be an http(s) URL ending in /v1");
  if (!/^https?:\/\/[^\s/]+$/.test(runtime.toolsOrigin))
    throw new Error("the tools origin must be an http(s) origin with no path");
  const mcp = config.hermes.mcp_servers;
  const hermes = {
    ...config.hermes,
    providers: {
      gw: { ...config.hermes.providers.gw, base_url: runtime.gatewayBaseUrl },
    },
    mcp_servers: {
      data: { ...mcp.data, url: `${runtime.toolsOrigin}/mcp/data` },
      platform: { ...mcp.platform, url: `${runtime.toolsOrigin}/mcp/platform` },
    },
  };
  // JSON is valid YAML, so Hermes reads this as config.yaml without a YAML library here.
  const configYaml =
    `# Rendered by services/orchestrator for agent ${config.agent.agentId} ` +
    `(generation ${config.agent.generation}, ${config.tier.playbook.version}). Do not edit.\n` +
    `${JSON.stringify(JSON.parse(canonicalJson(hermes)), null, 2)}\n`;
  const env = [
    `AGENT_LLM_KEY=${MODEL_KEY_PLACEHOLDER}`,
    "API_SERVER_ENABLED=true",
    `API_SERVER_KEY=${runtime.apiServerKey}`,
    "API_SERVER_HOST=127.0.0.1",
    `API_SERVER_PORT=${API_SERVER_PORT}`,
    "",
  ].join("\n");
  const playbooks: Record<string, string> = {};
  for (const name of config.tier.playbook.skills)
    playbooks[`${PLAYBOOKS_DIR}/${name}/SKILL.md`] = playbookSkill(name);
  return {
    home: {
      "config.yaml": configYaml,
      ".env": env,
      "SOUL.md": config.soul,
      ".no-bundled-skills": "",
    },
    playbooks,
  };
}
