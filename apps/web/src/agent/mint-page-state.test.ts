import { MINT_STATES } from "@alpha-agents/ui";
import { describe, expect, it } from "vitest";
import { type MintPageInputs, mintPageView } from "./mint-page-state";

const base: MintPageInputs = {
  deployed: true,
  walletState: "connected",
  walletMint: { status: "ready", hasMinted: false, reason: "eligible", message: "ok" },
  soldOut: false,
  progress: { state: "idle" },
};
const view = (over: Partial<MintPageInputs>) => mintPageView({ ...base, ...over });

describe("mintPageView", () => {
  it("not deployed: unavailable, whatever else is true", () => {
    expect(view({ deployed: false, progress: { state: "minting" } })).toEqual({
      state: "unavailable",
    });
  });

  it("logged out, or a failed login: connect first", () => {
    expect(view({ walletState: "logged-out" }).state).toBe("logged-out");
    expect(view({ walletState: "error" }).state).toBe("logged-out");
  });

  it("logged out when sold out: says sold out", () => {
    expect(view({ walletState: "logged-out", soldOut: true }).state).toBe("sold-out");
  });

  it("connecting", () => {
    expect(view({ walletState: "connecting" }).state).toBe("connecting");
  });

  it("wrong network: no mint", () => {
    expect(view({ walletState: "wrong-chain" }).state).toBe("wrong-network");
  });

  it("while the wallet's mint is read: loading; when it fails: read-error", () => {
    expect(view({ walletMint: { status: "loading" } }).state).toBe("loading");
    expect(view({ walletMint: { status: "error" } }).state).toBe("read-error");
  });

  it("while the supply is first read: loading", () => {
    expect(view({ soldOut: "loading" }).state).toBe("loading");
  });

  it("an unreadable supply does not block the mint", () => {
    expect(view({ soldOut: "unknown" }).state).toBe("ready");
  });

  it("ready to mint", () => {
    expect(view({})).toEqual({ state: "ready" });
  });

  it("already minted, with the agent when it was found", () => {
    expect(
      view({
        walletMint: {
          status: "ready",
          hasMinted: true,
          reason: "already_minted",
          message: "m",
          agent: { id: 7n, species: 0 },
        },
      }),
    ).toEqual({ state: "already-minted", agent: { id: 7n, species: 0 } });
    expect(
      view({
        walletMint: { status: "ready", hasMinted: true, reason: "already_minted", message: "m" },
      }),
    ).toEqual({
      state: "already-minted",
    });
  });

  it("already minted wins over sold out: the owner still sees their agent", () => {
    expect(
      view({
        soldOut: true,
        walletMint: {
          status: "ready",
          hasMinted: true,
          reason: "already_minted",
          message: "m",
          agent: { id: 1000n, species: 3 },
        },
      }).state,
    ).toBe("already-minted");
  });

  it("sold out for a wallet that has not minted", () => {
    expect(view({ soldOut: true })).toEqual({ state: "sold-out" });
  });

  it.each(["claiming", "signing", "minting", "rejected", "claim-refused", "error"] as const)(
    "a mint in the %s state keeps the panel on the mint button",
    (state) => {
      expect(view({ progress: { state } })).toEqual({ state: "ready" });
    },
  );

  it("just minted: waiting for reveal, with the new agent", () => {
    expect(
      view({
        progress: { state: "awaiting-reveal", agentId: 9n },
        walletMint: {
          status: "ready",
          hasMinted: true,
          reason: "already_minted",
          message: "m",
          agent: { id: 9n, species: 0 },
        },
      }),
    ).toEqual({ state: "awaiting-reveal", agent: { id: 9n, species: 0 } });
  });

  it("just minted, and the page's read saw the reveal first: revealed", () => {
    expect(
      view({
        progress: { state: "awaiting-reveal", agentId: 9n },
        walletMint: {
          status: "ready",
          hasMinted: true,
          reason: "already_minted",
          message: "m",
          agent: { id: 9n, species: 14 },
        },
      }),
    ).toEqual({ state: "revealed", agent: { id: 9n, species: 14 } });
  });

  it("revealed by the mint flow", () => {
    expect(view({ progress: { state: "revealed", agentId: 9n, species: 3 } })).toEqual({
      state: "revealed",
      agent: { id: 9n, species: 3 },
    });
  });

  it("covers every mint button state", () => {
    const states = new Set(MINT_STATES.map((state) => view({ progress: { state } }).state));
    expect(states).toEqual(new Set(["ready"]));
  });

  it("a wallet off the allowlist is not eligible before it clicks, with the API's reason", () => {
    expect(
      view({
        walletMint: {
          status: "ready",
          hasMinted: false,
          reason: "not_allowlisted",
          message: "This wallet is not on the beta mint allowlist.",
        },
      }),
    ).toEqual({ state: "not-eligible", message: "This wallet is not on the beta mint allowlist." });
  });

  it("the API's sold-out answer closes the mint even before the supply says so", () => {
    expect(
      view({ walletMint: { status: "ready", hasMinted: false, reason: "sold_out", message: "s" } }),
    ).toEqual({ state: "sold-out" });
  });

  it("minting not configured on the API: unavailable, with its message", () => {
    expect(
      view({ walletMint: { status: "unavailable", message: "Minting is not configured" } }),
    ).toEqual({ state: "unavailable", message: "Minting is not configured" });
  });

  it("already minted wins over not eligible: a minted wallet sees its agent", () => {
    expect(
      view({
        walletMint: {
          status: "ready",
          hasMinted: true,
          reason: "not_allowlisted",
          message: "m",
          agent: { id: 3n, species: 0 },
        },
      }).state,
    ).toBe("already-minted");
  });
});
