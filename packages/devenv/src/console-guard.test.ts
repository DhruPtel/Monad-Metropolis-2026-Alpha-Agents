import { describe, expect, it } from "vitest";
import {
  ConsoleRefusedError,
  assertConsoleEnvironment,
  consoleNextArgs,
  isLocalHostHeader,
} from "./index.ts";

describe("console start guard", () => {
  it.each([[{}], [{ APP_ENV: "local" }], [{ APP_ENV: " local " }]])("starts with %j", (env) => {
    expect(() => assertConsoleEnvironment(env)).not.toThrow();
  });

  it.each([["testnet"], ["beta"], ["mainnet"], [""], ["LOCAL"]])("refuses APP_ENV=%j", (value) => {
    expect(() => assertConsoleEnvironment({ APP_ENV: value })).toThrow(ConsoleRefusedError);
  });

  it("always binds to 127.0.0.1", () => {
    expect(consoleNextArgs("dev")).toEqual(["dev", "--hostname", "127.0.0.1", "--port", "3001"]);
    expect(consoleNextArgs("start", 3101)).toEqual([
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3101",
    ]);
  });

  it.each([
    ["127.0.0.1:3001", true],
    ["localhost:3001", true],
    ["LOCALHOST", true],
    ["192.168.1.20:3001", false],
    ["0.0.0.0:3001", false],
    ["evil.example:3001", false],
    ["127.0.0.1.evil.example", false],
    ["", false],
    [null, false],
  ])("Host %j is local: %s", (host, local) => {
    expect(isLocalHostHeader(host)).toBe(local);
  });
});
