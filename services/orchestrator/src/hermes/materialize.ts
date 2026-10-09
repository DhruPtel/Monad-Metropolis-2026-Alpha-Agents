import { type BuiltinSet, loadBuiltinSet } from "@alpha-agents/skills/packages";
import { canonicalJson } from "./layers.ts";
import { type AgentConfig, EQUIPPED_DIR, PLAYBOOKS_DIR } from "./schema.ts";

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

/**
 * The built-in skills and playbooks every agent mounts (P3-U7, D-288), loaded
 * once per process from packages/skills/builtin and checked: a package that
 * fails validation, the audit or the version lock is never mounted.
 */
let builtin: BuiltinSet | null = null;
export function builtinSet(): BuiltinSet {
  if (builtin) return builtin;
  const set = loadBuiltinSet();
  const blocking = set.issues.filter((i) => i.severity === "block");
  if (blocking.length > 0)
    throw new Error(
      `the built-in skills do not pass their checks: ${blocking.map((i) => `${i.id} ${i.rule} ${i.path}`).join("; ")}`,
    );
  builtin = set;
  return set;
}

/** The mounted set as the console and the logs show it. */
export function mountedSkills(set: BuiltinSet = builtinSet()) {
  return {
    setHash: set.setHash,
    packages: set.packages.map((p) => ({
      kind: p.kind,
      id: p.manifest.id,
      name: p.hermesName,
      version: p.manifest.version,
      contentHash: p.contentHash,
      description: p.manifest.description.model,
      tools: p.manifest.required_tools,
      mountedAt: `${p.kind === "skill" ? EQUIPPED_DIR : PLAYBOOKS_DIR}/${p.hermesName}`,
    })),
  };
}

export interface SandboxRuntime {
  /** Base URL of the model gateway as the sandbox sees it, ending in /v1. */
  readonly gatewayBaseUrl: string;
  /** Origin of the tool servers as the sandbox sees it (the gate: /mcp/data, /mcp/platform, /mcp/chain). */
  readonly toolsOrigin: string;
  readonly apiServerKey: string;
}

export interface SandboxFiles {
  /** Paths relative to HERMES_HOME. */
  readonly home: Readonly<Record<string, string>>;
  /**
   * Absolute paths under EQUIPPED_DIR (the launch skills) and PLAYBOOKS_DIR
   * (the stage playbooks), written by root and made read-only: one folder per
   * package named with the platform prefix, SKILL.md with its generated
   * frontmatter, and the package's references, data and evals.
   */
  readonly skills: Readonly<Record<string, string>>;
  /** The set mounted, with each package's version and content hash. */
  readonly mounted: ReturnType<typeof mountedSkills>;
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
      chain: { ...mcp.chain, url: `${runtime.toolsOrigin}/mcp/chain` },
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
  // D-288: every agent mounts the same built-in set until builds exist, whatever its tier's slots.
  const set = builtinSet();
  const skills: Record<string, string> = {};
  for (const p of set.packages) {
    const root = `${p.kind === "skill" ? EQUIPPED_DIR : PLAYBOOKS_DIR}/${p.hermesName}`;
    skills[`${root}/SKILL.md`] = p.skillMd;
    for (const f of p.files)
      if (f.path !== "SKILL.md" && f.path !== "skill.json")
        skills[`${root}/${f.path}`] = f.bytes.toString("utf8");
  }
  return {
    home: {
      "config.yaml": configYaml,
      ".env": env,
      "SOUL.md": config.soul,
      ".no-bundled-skills": "",
    },
    skills,
    mounted: mountedSkills(set),
  };
}
