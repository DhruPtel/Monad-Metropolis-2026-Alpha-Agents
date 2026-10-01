// @ts-check
import { ConfigError } from "@alpha-agents/config";
import { describe, expect, it } from "vitest";
import {
  ANVIL_HOST,
  ANVIL_PORT,
  MIN_PLAUSIBLE_BLOCK,
  loadLocalConfig,
  parseForkConfig,
  parseFoundryVersion,
} from "./config.js";

describe("parseForkConfig", () => {
  it("accepts a Monad mainnet pin", () => {
    expect(parseForkConfig('{"chainId":143,"blockNumber":109670000}')).toEqual({
      chainId: 143,
      blockNumber: 109670000,
    });
  });

  it("rejects another chain", () => {
    expect(() => parseForkConfig('{"chainId":10143,"blockNumber":109670000}')).toThrow(/chainId/);
  });

  it.each(['"109670000"', "109670000.5", "0", "1", String(MIN_PLAUSIBLE_BLOCK - 1)])(
    "rejects blockNumber %s",
    (bad) => {
      expect(() => parseForkConfig(`{"chainId":143,"blockNumber":${bad}}`)).toThrow(/blockNumber/);
    },
  );

  it("accepts the floor itself", () => {
    expect(
      parseForkConfig(`{"chainId":143,"blockNumber":${MIN_PLAUSIBLE_BLOCK}}`).blockNumber,
    ).toBe(MIN_PLAUSIBLE_BLOCK);
  });
});

describe("parseFoundryVersion", () => {
  it("reads the version from forge output", () => {
    expect(parseFoundryVersion("forge Version: 1.8.3\nCommit SHA: cae51ad")).toBe("1.8.3");
  });

  it("returns undefined for unexpected output", () => {
    expect(parseFoundryVersion("command not found")).toBeUndefined();
  });
});

describe("anvil address", () => {
  it("comes from the shared local fork URL", () => {
    expect([ANVIL_HOST, ANVIL_PORT]).toEqual(["127.0.0.1", 8545]);
  });
});

describe("loadLocalConfig", () => {
  const RPC = "https://rpc.provider.test/LEAKCHECK-key";

  it("loads with MONAD_RPC_URL set", () => {
    const config = loadLocalConfig({ MONAD_RPC_URL: RPC });
    expect(config.environment.id).toBe("local");
  });

  it.each([
    [{}, "MONAD_RPC_URL is not set"],
    [{ MONAD_RPC_URL: "" }, "MONAD_RPC_URL is set but empty"],
    [{ MONAD_RPC_URL: "https://your-monad-mainnet-rpc.example/your-api-key" }, "placeholder"],
    [{ MONAD_RPC_URL: "ws://LEAKCHECK" }, "MONAD_RPC_URL is invalid"],
    [{ MONAD_RPC_URL: RPC, APP_ENV: "beta" }, "APP_ENV must be local or unset"],
  ])("rejects %j", (source, message) => {
    expect(() => loadLocalConfig(source)).toThrow(ConfigError);
    expect(() => loadLocalConfig(source)).toThrow(message);
    try {
      loadLocalConfig(source);
    } catch (err) {
      expect(String(err)).not.toContain("LEAKCHECK");
    }
  });
});
