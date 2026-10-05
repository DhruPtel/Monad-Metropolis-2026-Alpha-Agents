import { describe, expect, it } from "vitest";
import { MOCK_WALLET_FLAG, walletBuildMode } from "./wallet-mode";

describe("the wallet a web build contains", () => {
  it.each([{}, { [MOCK_WALLET_FLAG]: "" }, { [MOCK_WALLET_FLAG]: "0" }, { APP_ENV: "beta" }])(
    "is the real Privy provider in .next by default (%j)",
    (env) => {
      expect(walletBuildMode(env)).toEqual({
        mock: false,
        providerModule: "./src/auth/privy-wallet-provider.tsx",
        distDir: ".next",
      });
    },
  );

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
