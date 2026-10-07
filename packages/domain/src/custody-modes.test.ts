import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCOUNT_MODES } from "./modes.ts";

/**
 * The custody core's `AccountMode` enum is the canonical account mode
 * (FINAL_PLAN 4.12, D-137), and an enum crosses the ABI as its index, so the
 * Solidity order must be exactly ACCOUNT_MODES' order.
 */
const SOURCE = fileURLToPath(
  new URL("../../../chains/monad/src/interfaces/ICustody.sol", import.meta.url),
);

describe("the custody core's account modes (P2-U1)", () => {
  it("lists the canonical modes in the canonical order", () => {
    const body = /enum AccountMode \{([^}]*)\}/.exec(readFileSync(SOURCE, "utf8"))?.[1];
    expect(body).toBeDefined();
    const names = (body ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names).toEqual([...ACCOUNT_MODES]);
  });
});
