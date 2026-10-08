import {
  ENVIRONMENT_IDS,
  LOCAL_FORK_CHAIN_ID,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
} from "@alpha-agents/config";
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
        expect(e.source, `${env} ${e.id}`).toMatch(/^(Planv2\/|https:\/\/|evidence\/)/);
        expect(["verified", "unverified"]).toContain(e.status);
        expect(e.note.length).toBeGreaterThan(0);
        if (e.openQuestion !== null) expect(e.openQuestion).toMatch(/^Q-\d{2}$/);
      }
    }
  });

  it("marks verified only entries with an address and a fork observation", () => {
    for (const env of ENVIRONMENT_IDS) {
      for (const e of ADDRESS_BOOK[env]) {
        if (e.status !== "verified") continue;
        expect(e.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        // Mainnet state at the pin is chain 143; our own local contracts live
        // only on the local fork, chain 143143 (D-195); testnet entries were
        // observed on testnet itself, 10143 (P2-EC).
        expect(e.verification.chainId).toBe(
          env === "testnet"
            ? MONAD_TESTNET_CHAIN_ID
            : e.kind === "platform"
              ? LOCAL_FORK_CHAIN_ID
              : MONAD_MAINNET_CHAIN_ID,
        );
        expect(e.verification.codeSize).toBeGreaterThan(0);
      }
    }
  });

  it("uses the same external entries for local and beta, and verifies testnet only by a testnet observation", () => {
    const external = (env: "local" | "beta") =>
      ADDRESS_BOOK[env].filter((e) => e.kind !== "platform");
    expect(external("local")).toEqual(external("beta"));
    for (const env of ENVIRONMENT_IDS) {
      for (const e of ADDRESS_BOOK[env]) {
        if (e.status !== "verified") continue;
        if (env === "testnet") {
          expect(e.verification.chain?.codeHash, e.id).toMatch(/^0x[0-9a-f]{64}$/);
          expect(e.verification.chain?.explorer).toContain("testnet.monadvision.com");
        } else {
          expect(e.verification.chain, `${env} ${e.id}`).toBeUndefined();
        }
      }
    }
    // Testnet was reset (D-248): its USDC and WMON are not mainnet's.
    expect(addressEntry("testnet", "usdc").address).not.toBe(addressEntry("beta", "usdc").address);
    expect(addressEntry("testnet", "wmon").address).not.toBe(addressEntry("beta", "wmon").address);
  });

  it("never verifies a fork deployment of our own contracts for beta", () => {
    expect(addressEntry("local", "agent_nft")).toMatchObject({ status: "verified" });
    expect(addressEntry("beta", "agent_nft")).toMatchObject({
      address: null,
      status: "unverified",
    });
    expect(() => signingAddress("beta", "agent_nft")).toThrow(UnverifiedAddressError);
    for (const env of ENVIRONMENT_IDS) {
      for (const e of ADDRESS_BOOK[env]) {
        if (e.status === "verified" && e.verification.deployedBy !== undefined) {
          // Our own deployments: the local fork's, or P2-EC's on testnet with
          // their deployment transaction and Sourcify link (D-254, D-256).
          expect(["local", "testnet"], e.id).toContain(env);
          if (env === "testnet") {
            expect(e.verification.chain?.transaction, e.id).toMatch(/^0x[0-9a-f]{64}$/);
            expect(e.verification.chain?.sourcify).toContain("repo.sourcify.dev/10143/");
          } else {
            expect(e.kind).toBe("platform");
          }
        }
      }
    }
  });

  it("lists every id exactly once per environment", () => {
    for (const env of ENVIRONMENT_IDS) {
      expect(ADDRESS_BOOK[env].map((e) => e.id).sort()).toEqual([...ADDRESS_BOOK_IDS].sort());
    }
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
  it("returns testnet's own verified addresses (P2-EC)", () => {
    expect(signingAddress("testnet", "usdc")).toBe("0x534b2f3A21130d7a60830c2Df862319e593943A3");
    expect(signingAddress("testnet", "executor")).toBe(
      "0xc127997711a3D26a0967724897BCc365934DeC7c",
    );
  });

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
    ["testnet", "weth", /weth is unverified in testnet/],
    ["testnet", "uniswap_v3_swap_router02", /uniswap_v3_swap_router02 is unverified in testnet/],
    [
      "testnet",
      "venue_uniswap_v3_usdc_wmon",
      /venue_uniswap_v3_usdc_wmon is unverified in testnet/,
    ],
  ] as const)("refuses %s %s", (env, id, message) => {
    expect(() => signingAddress(env, id)).toThrow(UnverifiedAddressError);
    expect(() => signingAddress(env, id)).toThrow(message);
  });
});
