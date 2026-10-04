import { describe, expect, it } from "vitest";
import { privyAppId } from "./privy-app-id";

describe("privyAppId", () => {
  it("accepts a 25-character app ID", () => {
    expect(privyAppId(" clabcdefghijklmnopqrstuvw ")).toBe("clabcdefghijklmnopqrstuvw");
  });

  it.each([undefined, "", "   ", "your-privy-app-id", "too-short", "x".repeat(26)])(
    "treats %j as not configured",
    (value) => {
      expect(privyAppId(value)).toBeUndefined();
    },
  );
});
