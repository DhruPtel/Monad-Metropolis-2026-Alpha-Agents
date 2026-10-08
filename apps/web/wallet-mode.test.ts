import { describe, expect, it } from "vitest";
import { MOCK_WALLET_FLAG, requireControlApiUrl, walletBuildMode } from "./wallet-mode";

describe("the wallet a web build contains", () => {
  it.each([{}, { [MOCK_WALLET_FLAG]: "" }, { [MOCK_WALLET_FLAG]: "0" }, { APP_ENV: "local" }])(
    "is the real Privy provider in .next by default (%j)",
    (env) => {
      expect(walletBuildMode(env)).toEqual({
        mock: false,
        providerModule: "./src/auth/privy-wallet-provider.tsx",
        distDir: ".next",
      });
    },
  );

  it.each([
    ["testnet", ".next-testnet"],
    ["beta", ".next-beta"],
  ])("builds %s into its own %s, never over the local build", (appEnv, distDir) => {
    expect(walletBuildMode({ APP_ENV: appEnv }).distDir).toBe(distDir);
  });

  it("requires CONTROL_API_URL for every build but local (D-254)", () => {
    expect(() => requireControlApiUrl({})).not.toThrow();
    expect(() => requireControlApiUrl({ APP_ENV: "local" })).not.toThrow();
    for (const appEnv of ["testnet", "beta"]) {
      expect(() => requireControlApiUrl({ APP_ENV: appEnv })).toThrow(
        /CONTROL_API_URL must be set/,
      );
      expect(() =>
        requireControlApiUrl({ APP_ENV: appEnv, CONTROL_API_URL: "http://127.0.0.1:4200" }),
      ).not.toThrow();
    }
  });

  it("is the mock wallet in a separate .next-e2e only for an explicit local test build", () => {
    for (const env of [
      { [MOCK_WALLET_FLAG]: "1" },
      { [MOCK_WALLET_FLAG]: "1", APP_ENV: "local" },
    ]) {
      expect(walletBuildMode(env)).toEqual({
        mock: true,
        providerModule: "./src/auth/mock-wallet-provider.tsx",
        distDir: ".next-e2e",
      });
    }
  });

  it.each(["testnet", "beta"])("refuses the mock wallet in a %s build", (appEnv) => {
    expect(() => walletBuildMode({ [MOCK_WALLET_FLAG]: "1", APP_ENV: appEnv })).toThrow(
      /local test builds only/,
    );
  });

  it.each(["true", "yes", "mock"])("refuses an unclear flag value %j", (value) => {
    expect(() => walletBuildMode({ [MOCK_WALLET_FLAG]: value })).toThrow(/must be 1 or unset/);
  });
});
