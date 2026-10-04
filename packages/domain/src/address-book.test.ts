import { ENVIRONMENT_IDS } from "@alpha-agents/config";
import { isAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_BOOK,
  ADDRESS_BOOK_IDS,
  type AddressEntry,
  UnverifiedAddressError,
  type VerifiedAddress,
  addressEntry,
  signingAddress,
} from "./index.ts";

describe("address book", () => {
  it.each(ENVIRONMENT_IDS)("has every entry exactly once for %s", (env) => {
    const ids = ADDRESS_BOOK[env].map((e) => e.id);
    expect([...ids].sort()).toEqual([...ADDRESS_BOOK_IDS].sort());
  });

  it("writes every address in valid EIP-55 checksum case or all lowercase", () => {
    // A mixed-case address with a wrong checksum is rejected by viem and every EIP-55 client.
    for (const env of ENVIRONMENT_IDS) {
      for (const e of ADDRESS_BOOK[env]) {
        if (e.address === null) continue;
        expect(isAddress(e.address, { strict: true }), `${env} ${e.id} ${e.address}`).toBe(true);
      }
    }
  });

  it("gives every entry a source, a status and a note", () => {
    for (const env of ENVIRONMENT_IDS) {
      for (const e of ADDRESS_BOOK[env]) {
        expect(e.source, `${env} ${e.id}`).toMatch(/^(Planv2\/|https:\/\/)/);
        expect(["verified", "unverified"]).toContain(e.status);
        expect(e.note.length).toBeGreaterThan(0);
        if (e.openQuestion !== null) expect(e.openQuestion).toMatch(/^Q-\d{2}$/);
      }
    }
  });

  it("marks verified only entries with an address and a chain 143 fork observation", () => {
    for (const env of ENVIRONMENT_IDS) {
      for (const e of ADDRESS_BOOK[env]) {
        if (e.status !== "verified") continue;
        expect(e.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(e.verification.chainId).toBe(143);
        expect(e.verification.codeSize).toBeGreaterThan(0);
      }
    }
  });

  it("uses the same mainnet entries for local and beta, and none verified on testnet", () => {
    expect(ADDRESS_BOOK.local).toBe(ADDRESS_BOOK.beta);
    expect(ADDRESS_BOOK.testnet.filter((e) => e.status === "verified")).toEqual([]);
  });

  it("records token decimals as read on the fork", () => {
    const decimals = (id: (typeof ADDRESS_BOOK_IDS)[number]) => {
      const e: AddressEntry = addressEntry("local", id);
      return e.status === "verified" ? e.verification.decimals : undefined;
    };
    expect([decimals("usdc"), decimals("wmon"), decimals("chainlink_mon_usd")]).toEqual([6, 18, 8]);
  });

  it("keeps entries with no known address unverified with their open question", () => {
    expect(addressEntry("beta", "erc8004_identity_registry")).toMatchObject({
      address: null,
      status: "unverified",
      openQuestion: "Q-13",
    });
    expect(addressEntry("beta", "usdc").openQuestion).toBe("Q-03");
  });
});

describe("signing block for unverified addresses", () => {
  it("returns a verified address", () => {
    const usdc: VerifiedAddress = signingAddress("beta", "usdc");
    expect(usdc).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
  });

  it.each([
    [
      "beta",
      "erc8004_identity_registry",
      /erc8004_identity_registry is unverified in beta.*Q-13.*no known address/,
    ],
    ["testnet", "kuru_router", /kuru_router is unverified in testnet/],
    ["testnet", "usdc", /usdc is unverified in testnet/],
    ["testnet", "erc6551_registry", /erc6551_registry is unverified in testnet/],
  ] as const)("refuses %s %s", (env, id, message) => {
    expect(() => signingAddress(env, id)).toThrow(UnverifiedAddressError);
    expect(() => signingAddress(env, id)).toThrow(message);
  });
});
