import { readFileSync } from "node:fs";
import { inspect, parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  LOCAL_FORK_RPC_URL,
  Secret,
  VARIABLES,
  assertChainId,
  loadConfig,
  renderEnvExample,
  summarizeConfig,
  type EnvSource,
} from "./index.ts";

// Distinctive fake values; a test fails if any of them shows up where it must not.
const MAINNET_RPC = "https://mainnet-rpc.provider.test/LEAKCHECK-mainnet-key";
const TESTNET_RPC = "https://testnet-rpc.provider.test/LEAKCHECK-testnet-key";
const TESTNET_KEY = `0x${"ab".repeat(32)}`;

function loadError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

/** Every rendering of an object a logger or error reporter might produce. */
function renderings(value: unknown): string {
  return [
    String(value),
    JSON.stringify(value),
    inspect(value, { depth: Infinity, showHidden: true }),
  ].join("\n");
}

describe("environment selection", () => {
  it("defaults to local, the anvil fork of chain 143", () => {
    const config = loadConfig({ name: "test" }, {});
    expect(config.environment).toMatchObject({ id: "local", label: "fork", chainId: 143 });
    expect(config.rpcUrl.reveal()).toBe(LOCAL_FORK_RPC_URL);
  });

  it("loads a valid testnet config on chain 10143", () => {
    const config = loadConfig(
      { name: "test" },
      { APP_ENV: "testnet", MONAD_TESTNET_RPC_URL: TESTNET_RPC },
    );
    expect(config.environment).toMatchObject({ id: "testnet", label: "testnet", chainId: 10143 });
    expect(config.rpcUrl.reveal()).toBe(TESTNET_RPC);
  });

  it("loads a valid beta config on chain 143", () => {
    const config = loadConfig({ name: "test" }, { APP_ENV: "beta", MONAD_RPC_URL: MAINNET_RPC });
    expect(config.environment).toMatchObject({ id: "beta", label: "mainnet-beta", chainId: 143 });
    expect(config.rpcUrl.reveal()).toBe(MAINNET_RPC);
  });

  it.each([
    ["", /APP_ENV is set but empty/],
    ["mainnet", /APP_ENV must be one of local, testnet, beta/],
  ])("rejects APP_ENV=%j", (value, message) => {
    expect(() => loadConfig({ name: "test" }, { APP_ENV: value })).toThrow(message);
  });

  it("applies local defaults for the Docker services", () => {
    const { values } = loadConfig({ name: "test" }, {});
    expect(values.DATABASE_URL).toBeInstanceOf(Secret);
    expect((values.DATABASE_URL as Secret).reveal()).toContain("127.0.0.1:5432");
    expect((values.REDIS_URL as Secret).reveal()).toBe("redis://127.0.0.1:6380");
  });

  it("parses typed values", () => {
    const { values } = loadConfig(
      { name: "test" },
      { POSTGRES_PORT: "15432", SEARCH_PROVIDER: "tavily", APP_PUBLIC_URL: "https://app.test" },
    );
    expect(values.POSTGRES_PORT).toBe(15432);
    expect(values.SEARCH_PROVIDER).toBe("tavily");
    expect(values.APP_PUBLIC_URL).toBe("https://app.test");
  });
});

describe("missing and invalid variables", () => {
  it("names a missing required variable", () => {
    const err = loadError(() => loadConfig({ name: "chain tools" }, { APP_ENV: "beta" }));
    expect(err.message).toContain("Configuration for chain tools (APP_ENV=beta) is invalid:");
    expect(err.issues).toEqual([{ variable: "MONAD_RPC_URL", problem: "is not set" }]);
  });

  it("names a missing variable a service requires", () => {
    const err = loadError(() => loadConfig({ name: "sandbox", requires: ["E2B_API_KEY"] }, {}));
    expect(err.issues).toEqual([{ variable: "E2B_API_KEY", problem: "is not set" }]);
  });

  it("reports every problem at once", () => {
    const err = loadError(() =>
      loadConfig(
        { name: "test", requires: ["E2B_API_KEY", "PRIVY_APP_SECRET"] },
        { APP_ENV: "testnet", PRIVY_APP_SECRET: "" },
      ),
    );
    expect(err.issues.map((i) => i.variable)).toEqual([
      "MONAD_TESTNET_RPC_URL",
      "E2B_API_KEY",
      "PRIVY_APP_SECRET",
    ]);
  });

  it("treats an empty required value as an error, not as set", () => {
    const err = loadError(() =>
      loadConfig({ name: "test" }, { APP_ENV: "beta", MONAD_RPC_URL: "  " }),
    );
    expect(err.issues).toEqual([{ variable: "MONAD_RPC_URL", problem: "is set but empty" }]);
  });

  it("rejects an empty value that would silently replace a local default", () => {
    const err = loadError(() => loadConfig({ name: "test" }, { DATABASE_URL: "" }));
    expect(err.issues[0]?.variable).toBe("DATABASE_URL");
  });

  it("treats a required placeholder as an error", () => {
    const err = loadError(() =>
      loadConfig(
        { name: "test", requires: ["MONAD_RPC_URL"] },
        { MONAD_RPC_URL: "https://your-monad-mainnet-rpc.example/your-api-key" },
      ),
    );
    expect(err.issues[0]?.problem).toMatch(/placeholder/);
  });

  it("treats an optional placeholder as not set", () => {
    const { values } = loadConfig({ name: "test" }, { E2B_API_KEY: "your-e2b-api-key" });
    expect(values.E2B_API_KEY).toBeUndefined();
  });

  it.each([
    ["MONAD_RPC_URL", "ftp://rpc.test/x", "an http(s) URL"],
    ["POSTGRES_PORT", "99999", "a port number"],
    ["SEARCH_PROVIDER", "google", "one of exa, tavily"],
    ["HERMES_API_SERVER_KEY", "too-short", "32 or more characters"],
  ])("names invalid %s and the expected format", (name, value, expected) => {
    const err = loadError(() => loadConfig({ name: "test" }, { [name]: value }));
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]?.variable).toBe(name);
    expect(err.issues[0]?.problem).toContain(expected);
    expect(err.message).not.toContain(value);
  });

  it("refuses a requirement the environment does not use", () => {
    expect(() =>
      loadConfig(
        { name: "test", requires: ["TESTNET_DEPLOYER_PRIVATE_KEY"] },
        { APP_ENV: "beta", MONAD_RPC_URL: MAINNET_RPC },
      ),
    ).toThrow(/TESTNET_DEPLOYER_PRIVATE_KEY is not used by the beta environment/);
  });
});

describe("mainnet guard", () => {
  const beta: EnvSource = { APP_ENV: "beta", MONAD_RPC_URL: MAINNET_RPC };

  it("refuses a signing service in beta without BETA_SIGNING_ENABLED", () => {
    const err = loadError(() => loadConfig({ name: "signer", signs: true }, beta));
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]?.variable).toBe("BETA_SIGNING_ENABLED");
    expect(err.message).toMatch(/must be "true" for signer to sign on Monad mainnet/);
  });

  it.each(["false", "TRUE", "1", "yes"])("refuses BETA_SIGNING_ENABLED=%s", (flag) => {
    expect(() =>
      loadConfig({ name: "signer", signs: true }, { ...beta, BETA_SIGNING_ENABLED: flag }),
    ).toThrow(/BETA_SIGNING_ENABLED/);
  });

  it('starts a signing service in beta with BETA_SIGNING_ENABLED="true"', () => {
    const config = loadConfig(
      { name: "signer", signs: true },
      { ...beta, BETA_SIGNING_ENABLED: "true" },
    );
    expect(config.signing).toBe(true);
  });

  it("starts a non-signing service in beta without the flag", () => {
    expect(loadConfig({ name: "api" }, beta).signing).toBe(false);
  });

  it.each(["local", "testnet"])("rejects BETA_SIGNING_ENABLED=true with APP_ENV=%s", (env) => {
    const err = loadError(() =>
      loadConfig(
        { name: "api" },
        { APP_ENV: env, MONAD_TESTNET_RPC_URL: TESTNET_RPC, BETA_SIGNING_ENABLED: "true" },
      ),
    );
    expect(err.issues).toEqual([
      {
        variable: "BETA_SIGNING_ENABLED",
        problem: 'is "true", which is only allowed with APP_ENV=beta',
      },
    ]);
  });

  it("local signing always targets the loopback fork, even with a mainnet RPC set", () => {
    const config = loadConfig({ name: "signer", signs: true }, { MONAD_RPC_URL: MAINNET_RPC });
    expect(config.signing).toBe(true);
    expect(config.rpcUrl.reveal()).toBe(LOCAL_FORK_RPC_URL);
  });

  it("refuses a testnet RPC that is the mainnet URL", () => {
    const err = loadError(() =>
      loadConfig(
        { name: "signer", signs: true },
        { APP_ENV: "testnet", MONAD_TESTNET_RPC_URL: MAINNET_RPC, MONAD_RPC_URL: MAINNET_RPC },
      ),
    );
    expect(err.issues[0]?.variable).toBe("MONAD_TESTNET_RPC_URL");
    expect(err.message).not.toContain(MAINNET_RPC);
  });

  it("never loads a key from another environment", () => {
    const everything: EnvSource = {
      MONAD_RPC_URL: MAINNET_RPC,
      MONAD_TESTNET_RPC_URL: TESTNET_RPC,
      TESTNET_DEPLOYER_PRIVATE_KEY: TESTNET_KEY,
      BETA_DEPLOYER_KMS_KEY_ID: "beta-deployer-key",
      BETA_KMS_KEY_RING: "beta-ring",
    };
    const local = loadConfig({ name: "signer", signs: true }, everything);
    const testnet = loadConfig(
      { name: "signer", signs: true },
      { ...everything, APP_ENV: "testnet" },
    );
    const betaConfig = loadConfig(
      { name: "signer", signs: true },
      { ...everything, APP_ENV: "beta", BETA_SIGNING_ENABLED: "true" },
    );
    const keys = (c: typeof local) => Object.keys(c.values);
    expect(keys(local).filter((k) => k.startsWith("TESTNET_") || k.startsWith("BETA_"))).toEqual(
      [],
    );
    expect(keys(testnet).filter((k) => k.startsWith("BETA_") || k === "MONAD_RPC_URL")).toEqual([]);
    expect(keys(testnet)).toContain("TESTNET_DEPLOYER_PRIVATE_KEY");
    expect(keys(betaConfig).filter((k) => k.startsWith("TESTNET_"))).toEqual([]);
    expect(keys(betaConfig)).toContain("BETA_DEPLOYER_KMS_KEY_ID");
  });

  it("assertChainId accepts the environment's chain and rejects any other", () => {
    const testnet = loadConfig(
      { name: "signer" },
      { APP_ENV: "testnet", MONAD_TESTNET_RPC_URL: TESTNET_RPC },
    );
    expect(() => assertChainId(testnet, 10143)).not.toThrow();
    expect(() => assertChainId(testnet, 143)).toThrow(
      /MONAD_TESTNET_RPC_URL reports chain ID 143, but testnet is chain 10143/,
    );
  });
});

describe("no secret value leaks", () => {
  // A distinct marker per secret, so a leak names the variable that leaked.
  const secretSpecs = VARIABLES.filter((v) => v.secret);
  const markerFor = (name: string) => `LEAKCHECK${name.replace(/_/g, "")}`;
  const validSecret = (name: string): string => {
    const marker = markerFor(name);
    if (name.endsWith("PRIVATE_KEY"))
      return `0x${Buffer.from(marker).toString("hex").padEnd(64, "0").slice(0, 64)}`;
    if (name.startsWith("DATABASE")) return `postgres://u:${marker}@db.test:5432/db`;
    if (name.startsWith("REDIS")) return `redis://:${marker}@cache.test:6379`;
    if (name.includes("_URL")) return `https://rpc.test/${marker}`;
    return `${marker}${"x".repeat(32)}`;
  };

  function loadAll(env: "local" | "testnet" | "beta") {
    const source: Record<string, string> = { APP_ENV: env };
    for (const spec of secretSpecs) source[spec.name] = validSecret(spec.name);
    source.MONAD_TESTNET_RPC_URL = TESTNET_RPC; // must differ from MONAD_RPC_URL
    if (env === "beta") source.BETA_SIGNING_ENABLED = "true";
    return { source, config: loadConfig({ name: "test", signs: true }, source) };
  }

  it.each(["local", "testnet", "beta"] as const)(
    "config object and summary hide every secret (%s)",
    (env) => {
      const { source, config } = loadAll(env);
      const out =
        renderings(config) + renderings(summarizeConfig(config)) + renderings(config.values);
      for (const spec of secretSpecs) {
        const value = source[spec.name];
        if (value) expect(out, spec.name).not.toContain(value);
        expect(out, spec.name).not.toContain(markerFor(spec.name));
      }
      expect(out).not.toContain("LEAKCHECK");
    },
  );

  it("summary reports secrets as set (redacted) and public values in full", () => {
    const { config } = loadAll("local");
    const summary = summarizeConfig(config);
    expect(summary.variables.MONAD_RPC_URL).toBe("set (redacted)");
    expect(summary.variables.APP_PUBLIC_URL).toBe("http://localhost:3000");
    expect(summary).toMatchObject({
      appEnv: "local",
      environment: "fork",
      chainId: 143,
      signing: true,
    });
  });

  it.each(secretSpecs.map((s) => s.name))("an invalid %s never appears in the error", (name) => {
    const spec = secretSpecs.find((s) => s.name === name);
    const env = spec?.environments[0] ?? "local";
    const bad = `${markerFor(name)} has spaces and is not valid`;
    const source = {
      APP_ENV: env,
      MONAD_TESTNET_RPC_URL: TESTNET_RPC,
      MONAD_RPC_URL: MAINNET_RPC,
      [name]: bad,
    };
    const err = loadError(() => loadConfig({ name: "test" }, source));
    expect(err.issues.map((i) => i.variable)).toContain(name);
    const out = renderings(err) + err.stack + JSON.stringify(err.issues);
    expect(out).not.toContain(markerFor(name));
    expect(out).not.toContain("LEAKCHECK");
    expect(err.cause).toBeUndefined();
  });

  it("Secret hides its value from every string conversion", () => {
    const secret = new Secret("LEAKCHECK-raw");
    expect(renderings(secret)).not.toContain("LEAKCHECK");
    expect(`${secret}`).toBe("[redacted]");
    expect(secret.reveal()).toBe("LEAKCHECK-raw");
  });
});

describe("registry and .env.example", () => {
  const committed = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");

  it("the committed .env.example matches the registry (run pnpm run env:example)", () => {
    expect(committed).toBe(renderEnvExample());
  });

  it("lists every variable exactly once, with its first unit", () => {
    const names = VARIABLES.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of VARIABLES) {
      expect(v.firstUsedBy, v.name).toMatch(/^P(\d|B)-U\d+$/);
      expect(committed).toContain(`${v.name}=`);
    }
    expect(names).toContain("MONAD_TESTNET_RPC_URL");
    expect(names).toContain("MONAD_RPC_URL");
  });

  it("every commented default is a valid value", () => {
    for (const v of VARIABLES) {
      if ("commented" in v && v.commented)
        expect(v.schema.safeParse(v.example).success, v.name).toBe(true);
    }
  });

  it("an uncommented copy of the template loads in every environment as not configured", () => {
    const uncommented = committed.replace(/^# ([A-Z0-9_]+=)/gm, "$1");
    const template = parseEnv(uncommented);
    expect(Object.keys(template).sort()).toEqual(VARIABLES.map((v) => v.name).sort());
    // Local needs no remote RPC, so the template alone is a valid local config.
    expect(() => loadConfig({ name: "test" }, template)).not.toThrow();
    for (const [env, rpc] of [
      ["testnet", "MONAD_TESTNET_RPC_URL"],
      ["beta", "MONAD_RPC_URL"],
    ] as const) {
      const err = loadError(() => loadConfig({ name: "test" }, { ...template, APP_ENV: env }));
      expect(err.issues).toEqual([
        { variable: rpc, problem: "is still the .env.example placeholder; set a real value" },
      ]);
    }
  });
});
