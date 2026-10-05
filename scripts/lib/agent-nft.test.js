// @ts-check
import { describe, expect, it } from "vitest";
import { isTransientForkError } from "./agent-nft.js";

describe("isTransientForkError", () => {
  it.each([
    // Seen on a fresh fork (L-43): forge's fee estimate and anvil's lazy fetches.
    "Error: Failed to get EIP-1559 fees; Failed to fetch fee history for EIP-1559 estimation; server returned an error response: error code -32603: Internal error: could not get block data",
    "Error: Failed to deploy script:\nfailed to fetch grandparent block 0xab; block 0xcd does not exist",
    "Error: Resource not found",
    "server returned an error response: error code 429: Too Many Requests",
    "error sending request: operation timed out",
  ])("retries %j", (output) => {
    expect(isTransientForkError(output)).toBe(true);
  });

  it.each([
    "Error: script failed: deployed address differs from prediction",
    "Error: script failed: Tokenbound contracts missing",
    "error: Refused: the target RPC is not the local anvil fork",
    "Compiler run failed",
  ])("does not retry %j", (output) => {
    expect(isTransientForkError(output)).toBe(false);
  });
});
