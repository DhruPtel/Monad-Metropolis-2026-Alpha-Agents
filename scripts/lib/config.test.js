// @ts-check
import { describe, expect, it } from "vitest";
import { classifyRpcUrl, parseForkConfig, parseFoundryVersion } from "./config.js";

describe("parseForkConfig", () => {
  it("accepts a Monad mainnet pin", () => {
    expect(parseForkConfig('{"chainId":143,"blockNumber":42}')).toEqual({
      chainId: 143,
      blockNumber: 42,
    });
  });

  it("rejects another chain", () => {
    expect(() => parseForkConfig('{"chainId":10143,"blockNumber":42}')).toThrow(/chainId/);
  });

  it.each(['"42"', "0", "-1", "1.5"])("rejects blockNumber %s", (bad) => {
    expect(() => parseForkConfig(`{"chainId":143,"blockNumber":${bad}}`)).toThrow(/blockNumber/);
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

describe("classifyRpcUrl", () => {
  it.each([
    [undefined, "unset"],
    ["", "unset"],
    ["   ", "unset"],
    ["https://your-monad-rpc.example/your-api-key", "placeholder"],
    ["not a url", "invalid"],
    ["ws://rpc.test", "invalid"],
    ["https://rpc.provider.test/abc123", "ok"],
  ])("classifies %j as %s", (value, expected) => {
    expect(classifyRpcUrl(value)).toBe(expected);
  });
});
