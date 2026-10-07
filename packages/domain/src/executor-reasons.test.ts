import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REJECTION_CODES } from "./reasons.ts";

/**
 * The Executor reverts with `Rejected(Reason)`, and an enum crosses the ABI as
 * its index, so the Solidity order must be exactly REJECTION_CODES' (P2-U2).
 */
const SOURCE = fileURLToPath(
  new URL("../../../chains/monad/src/interfaces/IExecutor.sol", import.meta.url),
);

describe("the Executor's reason codes (P2-U2)", () => {
  it("are REJECTION_CODES, in order", () => {
    const body = /enum Reason \{([^}]*)\}/.exec(readFileSync(SOURCE, "utf8"))?.[1] ?? "";
    const names = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("///"))
      .map((l) => l.replace(",", ""));
    expect(names).toEqual([...REJECTION_CODES]);
  });
});
