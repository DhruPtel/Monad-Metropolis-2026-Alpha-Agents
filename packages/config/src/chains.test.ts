import { describe, expect, it } from "vitest";
import {
  APP_CHAINS,
  appChain,
  ENVIRONMENT_IDS,
  ENVIRONMENTS,
  LOCAL_FORK_CHAIN_ID,
  LOCAL_FORK_RPC_URL,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  webEnvironment,
} from "./index.ts";

describe("the web app's chain per environment", () => {
  it.each([
    ["local", LOCAL_FORK_CHAIN_ID, LOCAL_FORK_RPC_URL, "Monad (local fork)"],
    ["testnet", MONAD_TESTNET_CHAIN_ID, "https://testnet-rpc.monad.xyz", "Monad Testnet"],
    ["beta", MONAD_MAINNET_CHAIN_ID, "https://rpc.monad.xyz", "Monad"],
  ] as const)("%s targets chain %i at %s", (env, id, rpc, name) => {
    expect(appChain(env)).toMatchObject({ id, browserRpcUrl: rpc, name, environment: env });
  });

  it("agrees with the environment table on every chain ID", () => {
    for (const env of ENVIRONMENT_IDS) expect(APP_CHAINS[env].id).toBe(ENVIRONMENTS[env].chainId);
  });

  it("never ships a keyed RPC to the browser", () => {
    // Keyed provider URLs carry their key in the path or query; the public ones have neither.
    for (const env of ENVIRONMENT_IDS) {
      const url = new URL(APP_CHAINS[env].browserRpcUrl);
      expect(url.pathname === "/" || url.pathname === "", env).toBe(true);
      expect(url.search, env).toBe("");
      expect(url.hostname, env).not.toMatch(/alchemy|infura|quiknode|ankr|drpc/);
    }
  });

  it("only marks the mainnet beta as not a testnet", () => {
    expect(ENVIRONMENT_IDS.filter((env) => !APP_CHAINS[env].testnet)).toEqual(["beta"]);
  });
});

describe("webEnvironment", () => {
  it.each([
    [undefined, "local"],
    ["", "local"],
    ["  ", "local"],
    ["local", "local"],
    ["testnet", "testnet"],
    [" beta ", "beta"],
  ] as const)("APP_ENV %j selects %s", (value, env) => {
    expect(webEnvironment(value)).toBe(env);
  });

  it("refuses an unknown APP_ENV instead of guessing a chain", () => {
    expect(() => webEnvironment("mainnet")).toThrow(/APP_ENV "mainnet"/);
  });
});

describe("the local fork's port (D-200)", () => {
  it("is the playtest fork unless LOCAL_FORK_PORT says otherwise", async () => {
    const { localForkRpcUrl, LOCAL_FORK_RPC_URL, LOCAL_TEST_FORK_PORT } =
      await import("./index.ts");
    expect(localForkRpcUrl({})).toBe(LOCAL_FORK_RPC_URL);
    expect(localForkRpcUrl({ LOCAL_FORK_PORT: String(LOCAL_TEST_FORK_PORT) })).toBe(
      "http://127.0.0.1:8546",
    );
    expect(() => localForkRpcUrl({ LOCAL_FORK_PORT: "x" })).toThrow(/LOCAL_FORK_PORT/);
    expect(() => localForkRpcUrl({ LOCAL_FORK_PORT: "70000" })).toThrow(/LOCAL_FORK_PORT/);
  });

  it("moves the local service RPC and the local browser chain, and nothing else", async () => {
    const { appChain, loadConfig } = await import("./index.ts");
    expect(loadConfig({ name: "t" }, { LOCAL_FORK_PORT: "8546" }).rpcUrl?.reveal()).toBe(
      "http://127.0.0.1:8546",
    );
    expect(appChain("local", "http://127.0.0.1:8546").browserRpcUrl).toBe("http://127.0.0.1:8546");
    expect(appChain("testnet", "http://127.0.0.1:8546").browserRpcUrl).toBe(
      "https://testnet-rpc.monad.xyz",
    );
  });
});
