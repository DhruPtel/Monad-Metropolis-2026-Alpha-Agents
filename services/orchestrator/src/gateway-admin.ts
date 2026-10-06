/**
 * LiteLLM admin calls the orchestrator makes with the master key (FINAL_PLAN
 * 4.3.4). Keys are found by alias through /key/list: /key/info answers from a
 * cache and still returned a deleted key in this unit's probe, so it is never
 * used to decide whether a key exists. Error bodies are never echoed, because
 * LiteLLM names keys in them.
 */
export interface CreateKeyRequest {
  /** The virtual key value, chosen by the orchestrator so a retry can find it. */
  readonly key: string;
  readonly alias: string;
  readonly models: readonly string[];
  readonly maxBudgetUsd: number;
  readonly metadata: Readonly<Record<string, string | number>>;
}

export interface GatewayAdmin {
  createKey(request: CreateKeyRequest): Promise<void>;
  /** True when a key with this alias exists. */
  hasAlias(alias: string): Promise<boolean>;
  /** Every alias that starts with the prefix. */
  listAliases(prefix: string): Promise<string[]>;
  /** Deletes keys by alias; aliases that do not exist are ignored. */
  deleteAliases(aliases: readonly string[]): Promise<void>;
}

export class GatewayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

export class LiteLLMAdmin implements GatewayAdmin {
  private readonly baseUrl: string;
  private readonly masterKey: string;

  constructor(baseUrl: string, masterKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.masterKey = masterKey;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.masterKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return { status: res.status, json: () => JSON.parse(text) as unknown, text };
  }

  async ready(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health/readiness`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createKey(r: CreateKeyRequest): Promise<void> {
    const reply = await this.call("POST", "/key/generate", {
      key: r.key,
      key_alias: r.alias,
      models: r.models,
      max_budget: r.maxBudgetUsd,
      metadata: r.metadata,
    });
    if (reply.status !== 200)
      throw new GatewayError(`LiteLLM /key/generate returned ${reply.status}`, reply.status);
  }

  async hasAlias(alias: string): Promise<boolean> {
    const reply = await this.call(
      "GET",
      `/key/list?return_full_object=true&size=10&key_alias=${encodeURIComponent(alias)}`,
    );
    if (reply.status !== 200)
      throw new GatewayError(`LiteLLM /key/list returned ${reply.status}`, reply.status);
    const body = reply.json() as { keys?: { key_alias?: string | null }[] };
    return (body.keys ?? []).some((k) => k.key_alias === alias);
  }

  async listAliases(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const reply = await this.call(
        "GET",
        `/key/list?return_full_object=true&size=100&page=${page}`,
      );
      if (reply.status !== 200)
        throw new GatewayError(`LiteLLM /key/list returned ${reply.status}`, reply.status);
      const body = reply.json() as {
        keys?: { key_alias?: string | null }[];
        total_pages?: number;
      };
      for (const k of body.keys ?? []) if (k.key_alias?.startsWith(prefix)) out.push(k.key_alias);
      if (page >= (body.total_pages ?? 1)) break;
    }
    return out;
  }

  async deleteAliases(aliases: readonly string[]): Promise<void> {
    if (aliases.length === 0) return;
    const reply = await this.call("POST", "/key/delete", { key_aliases: aliases });
    // 404 "No keys found": already gone, which is what a delete wants.
    if (reply.status !== 200 && reply.status !== 404)
      throw new GatewayError(`LiteLLM /key/delete returned ${reply.status}`, reply.status);
  }
}

/** An in-memory gateway for tests: aliases are unique, as LiteLLM enforces. */
export class MemoryGateway implements GatewayAdmin {
  readonly keys = new Map<string, CreateKeyRequest>();
  readonly calls: string[] = [];
  /** Set to make the next createKey fail after storing the key (a lost reply). */
  failAfterCreate = false;

  async createKey(r: CreateKeyRequest): Promise<void> {
    this.calls.push(`create ${r.alias}`);
    if (this.keys.has(r.alias))
      throw new GatewayError("Unique key aliases across all keys are required.", 400);
    this.keys.set(r.alias, r);
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new GatewayError("connection reset after create", 502);
    }
  }

  async hasAlias(alias: string): Promise<boolean> {
    return this.keys.has(alias);
  }

  async listAliases(prefix: string): Promise<string[]> {
    return [...this.keys.keys()].filter((a) => a.startsWith(prefix));
  }

  async deleteAliases(aliases: readonly string[]): Promise<void> {
    for (const a of aliases) {
      this.calls.push(`delete ${a}`);
      this.keys.delete(a);
    }
  }
}
