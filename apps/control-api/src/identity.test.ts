import { describe, expect, it } from "vitest";
import * as web from "../../web/src/auth/mock-wallet-constants.ts";
import {
  MOCK_ACCESS_TOKEN,
  MOCK_WALLET_ADDRESS,
  MOCK_WALLET_MARKER,
  mockAccessTokenFor,
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

  it("accepts only mock tokens, and links only the wallet each was issued for", async () => {
    const id = mockIdentity();
    const other = "0x00000000000000000000000000000000000e2e02";
    await expect(id.verify("anything else")).rejects.toThrow();
    await expect(id.verify(MOCK_ACCESS_TOKEN)).rejects.toThrow();
    await expect(id.verify(`${MOCK_ACCESS_TOKEN}:not-an-address`)).rejects.toThrow();
    expect(mockAccessTokenFor(MOCK_WALLET_ADDRESS)).toBe(
      web.mockAccessTokenFor(MOCK_WALLET_ADDRESS),
    );
    const session = await id.verify(mockAccessTokenFor(MOCK_WALLET_ADDRESS));
    expect(await id.walletsOf(session)).toEqual([MOCK_WALLET_ADDRESS]);
    const second = await id.verify(mockAccessTokenFor(other.toUpperCase().replace("0X", "0x")));
    expect(await id.walletsOf(second)).toEqual([other]);
  });
});
