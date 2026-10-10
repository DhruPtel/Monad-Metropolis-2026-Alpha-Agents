import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REJECTION_CODES } from "./reasons.ts";

/**
 * The Executors revert with `Rejected(reason)`, and an enum crosses the ABI as
 * its index, so the Solidity order must be exactly REJECTION_CODES' (P2-U2):
 * v2's `Reason` is the list's first twenty-three, and v3's `ReasonV3` (F-U4)
 * is the whole list.
 */
const V2_SOURCE = fileURLToPath(
  new URL("../../../chains/monad/src/interfaces/IExecutor.sol", import.meta.url),
);
const V3_SOURCE = fileURLToPath(
  new URL("../../../chains/monad/src/interfaces/IExecutorV3.sol", import.meta.url),
);

const enumNames = (source: string, name: string) =>
  (new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(readFileSync(source, "utf8"))?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("///"))
    .map((l) => l.replace(",", ""));

describe("the Executors' reason codes (P2-U2, F-U4)", () => {
  it("v2's Reason is the first part of REJECTION_CODES, in order", () => {
    const names = enumNames(V2_SOURCE, "Reason");
    expect(names).toEqual(REJECTION_CODES.slice(0, names.length));
    expect(names.length).toBe(23);
  });

  it("v3's ReasonV3 is REJECTION_CODES, in order", () => {
    expect(enumNames(V3_SOURCE, "ReasonV3")).toEqual([...REJECTION_CODES]);
  });
});
