import { describe, expect, it } from "vitest";
import * as web from "../../web/src/auth/mock-wallet-constants.ts";
import {
  MOCK_ACCESS_TOKEN,
  MOCK_WALLET_ADDRESS,
  MOCK_WALLET_MARKER,
  mockIdentity,
} from "./identity.ts";

describe("the mock identity (local test stacks only)", () => {
  it("matches the web test build's mock wallet exactly", () => {
    expect([MOCK_WALLET_MARKER, MOCK_WALLET_ADDRESS, MOCK_ACCESS_TOKEN]).toEqual([
      web.MOCK_WALLET_MARKER,
      web.MOCK_WALLET_ADDRESS,
      web.MOCK_ACCESS_TOKEN,
    ]);
  });

  it("accepts only the mock token and links only the mock wallet", async () => {
    const id = mockIdentity();
    await expect(id.verify("anything else")).rejects.toThrow();
    const session = await id.verify(MOCK_ACCESS_TOKEN);
    expect(await id.walletsOf(session)).toEqual([MOCK_WALLET_ADDRESS]);
  });
});
