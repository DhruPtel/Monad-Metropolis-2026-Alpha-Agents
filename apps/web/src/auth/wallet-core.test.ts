import { describe, expect, it } from "vitest";
import { mismatchNotice } from "./wallet-core";

describe("the notice when the wallet no longer matches the login", () => {
  const login = "0x00000000000000000000000000000000000e2e01";
  const other = "0x00000000000000000000000000000000000e2e02";

  it("names both accounts and the wallet after an account switch", () => {
    expect(mismatchNotice(other, login, "OKX Wallet")).toBe(
      "OKX Wallet switched to 0x0000...2e02. You were logged in as 0x0000...2e01, so that session has ended. Connect again to use 0x0000...2e02.",
    );
  });

  it("says the wallet stopped sharing an account when it is locked or disconnected", () => {
    expect(mismatchNotice(null, login, "MetaMask")).toMatch(
      /^MetaMask stopped sharing an account with this site/,
    );
  });
});
