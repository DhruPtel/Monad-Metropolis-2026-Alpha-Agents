import { describe, expect, it } from "vitest";
import { isManagedAccount, managedAccountOf } from "./managed-account.ts";

const VAULT = "0x0000000000000000000000000000000000000a11" as const;
const PERSONAL = "0x0000000000000000000000000000000000000b22" as const;

describe("the account an agent manages (Step 0, 2026-10-12)", () => {
  it("manages the vault once it exists unless the owner chose the personal account", () => {
    expect(managedAccountOf({ vault: VAULT, personal: PERSONAL, choice: null })).toEqual({
      account: VAULT,
      isVault: true,
      managed: "vault",
    });
    expect(managedAccountOf({ vault: VAULT, personal: PERSONAL, choice: "vault" }).account).toBe(
      VAULT,
    );
    expect(managedAccountOf({ vault: VAULT, personal: PERSONAL, choice: "personal" })).toEqual({
      account: PERSONAL,
      isVault: false,
      managed: "personal",
    });
  });

  it("manages the personal account without a vault, whatever was chosen, and none before either exists", () => {
    expect(managedAccountOf({ vault: null, personal: PERSONAL, choice: "vault" })).toEqual({
      account: PERSONAL,
      isVault: false,
      managed: "personal",
    });
    expect(managedAccountOf({ vault: null, personal: null, choice: null })).toEqual({
      account: null,
      isVault: false,
      managed: "personal",
    });
    // A vault chosen with no personal account yet: the vault, since the choice names it.
    expect(managedAccountOf({ vault: VAULT, personal: null, choice: "personal" }).account).toBe(
      null,
    );
  });

  it("recognizes the two choices and nothing else", () => {
    expect(isManagedAccount("vault")).toBe(true);
    expect(isManagedAccount("personal")).toBe(true);
    expect(isManagedAccount("both")).toBe(false);
    expect(isManagedAccount(undefined)).toBe(false);
  });
});
