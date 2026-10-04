import { spawnSync } from "node:child_process";

/** The LiteLLM admin calls the spike needs, made with the master key from outside any sandbox. */
export class LiteLLMAdmin {
  private readonly baseUrl: string;
  private readonly masterKey: string;

  constructor(baseUrl: string, masterKey: string) {
    this.baseUrl = baseUrl;
    this.masterKey = masterKey;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.masterKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // Error bodies are not echoed: they can name keys.
    if (!res.ok) throw new Error(`LiteLLM ${method} ${path} returned ${res.status}`);
    return JSON.parse(text) as unknown;
  }

  async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health/readiness`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`LiteLLM not ready within ${timeoutMs} ms`);
  }

  /** A virtual key for one agent, limited to the given aliases and budget in USD. */
  async createKey(agentId: string, models: string[], maxBudgetUsd: number): Promise<string> {
    const reply = (await this.call("POST", "/key/generate", {
      models,
      max_budget: maxBudgetUsd,
      key_alias: `${agentId}-${Date.now()}`,
      metadata: { agent_id: agentId, unit: "P1-U1" },
    })) as { key?: string };
    if (typeof reply.key !== "string") throw new Error("LiteLLM /key/generate returned no key");
    return reply.key;
  }

  async keyInfo(
    key: string,
  ): Promise<{ spend: number; maxBudget: number | null; alias: string | null }> {
    const reply = (await this.call("GET", `/key/info?key=${encodeURIComponent(key)}`)) as {
      info?: { spend?: number; max_budget?: number | null; key_alias?: string | null };
    };
    return {
      spend: reply.info?.spend ?? 0,
      maxBudget: reply.info?.max_budget ?? null,
      alias: reply.info?.key_alias ?? null,
    };
  }

  /** Spend log rows for a key: one per model call LiteLLM served for it. */
  async spendLogs(key: string): Promise<{ model: string; spend: number; status: string | null }[]> {
    const rows = (await this.call("GET", `/spend/logs?api_key=${encodeURIComponent(key)}`)) as {
      model?: string;
      spend?: number;
      status?: string;
    }[];
    return rows.map((r) => ({
      model: r.model ?? "",
      spend: r.spend ?? 0,
      status: r.status ?? null,
    }));
  }
}

/** Starts Postgres and LiteLLM from infra/compose.yaml with the root .env (agent profile). */
export function composeUpLiteLLM(composeFile: string, envFile: string): void {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "--env-file",
      envFile,
      "--profile",
      "agent",
      "up",
      "-d",
      "--wait",
      "postgres",
      "litellm",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status !== 0) throw new Error("docker compose up for LiteLLM failed");
}
