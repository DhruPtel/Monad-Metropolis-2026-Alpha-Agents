import { MINT_STATES } from "@alpha-agents/ui";
import { describe, expect, it } from "vitest";
import { type MintPageInputs, type WalletMintRead, mintPageView } from "./mint-page-state";

const fresh: WalletMintRead = {
  status: "ready",
  mintsUsed: 0,
  mintsLeft: 2,
  agents: [],
  reason: "eligible",
  message: "ok",
};
const oneMinted = (species: number): WalletMintRead => ({
  status: "ready",
  mintsUsed: 1,
  mintsLeft: 1,
  agents: [{ id: 9n, species }],
  reason: "eligible",
  message: "ok",
});
const atLimit: WalletMintRead = {
  status: "ready",
  mintsUsed: 2,
  mintsLeft: 0,
  agents: [
    { id: 9n, species: 14 },
    { id: 12n, species: 0 },
  ],
  reason: "already_minted",
  message: "m",
};
const base: MintPageInputs = {
  deployed: true,
  walletState: "connected",
  walletMint: fresh,
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

  it("ready to mint, with both mints left", () => {
    expect(view({})).toEqual({ state: "ready", agents: [], mintsLeft: 2 });
  });

  it("one minted: still ready, with that agent beside the mint (two per wallet, NFT-U1)", () => {
    expect(view({ walletMint: oneMinted(14) })).toEqual({
      state: "ready",
      agents: [{ id: 9n, species: 14 }],
      mintsLeft: 1,
    });
  });

  it("at the limit: already minted, with every agent it minted", () => {
    expect(view({ walletMint: atLimit })).toEqual({
      state: "already-minted",
      agents: atLimit.agents,
    });
    // The API's answer alone is enough, even before the index lists the agents.
    expect(
      view({
        walletMint: { ...fresh, mintsUsed: 2, mintsLeft: 0, reason: "already_minted" },
      }),
    ).toEqual({ state: "already-minted", agents: [] });
  });

  it("at the limit wins over sold out: the owner still sees their agents", () => {
    expect(view({ soldOut: true, walletMint: atLimit }).state).toBe("already-minted");
  });

  it("sold out for a wallet with mints left shows what it minted", () => {
    expect(view({ soldOut: true })).toEqual({ state: "sold-out", agents: [] });
    expect(view({ soldOut: true, walletMint: oneMinted(3) })).toEqual({
      state: "sold-out",
      agents: [{ id: 9n, species: 3 }],
    });
  });

  it.each(["claiming", "signing", "minting", "rejected", "claim-refused", "error"] as const)(
    "a mint in the %s state keeps the panel on the mint button",
    (state) => {
      expect(view({ progress: { state }, walletMint: oneMinted(3) })).toEqual({
        state: "ready",
        agents: [{ id: 9n, species: 3 }],
        mintsLeft: 1,
      });
    },
  );

  it("just minted: waiting for reveal, with the new agent", () => {
    expect(
      view({
        progress: { state: "awaiting-reveal", agentId: 12n },
        walletMint: atLimit,
      }),
    ).toEqual({ state: "awaiting-reveal", agent: { id: 12n, species: 0 } });
    // Without the ID from the flow, the newest agent the index lists is the one.
    expect(view({ progress: { state: "awaiting-reveal" }, walletMint: oneMinted(0) })).toEqual({
      state: "awaiting-reveal",
      agent: { id: 9n, species: 0 },
    });
  });

  it("just minted, and the page's read saw the reveal first: revealed", () => {
    expect(
      view({
        progress: { state: "awaiting-reveal", agentId: 9n },
        walletMint: oneMinted(14),
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
          ...fresh,
          reason: "not_allowlisted",
          message: "This wallet is not on the beta mint allowlist.",
        },
      }),
    ).toEqual({ state: "not-eligible", message: "This wallet is not on the beta mint allowlist." });
  });

  it("the API's sold-out answer closes the mint even before the supply says so", () => {
    expect(view({ walletMint: { ...fresh, reason: "sold_out", message: "s" } })).toEqual({
      state: "sold-out",
      agents: [],
    });
  });

  it("minting not configured on the API: unavailable, with its message", () => {
    expect(
      view({ walletMint: { status: "unavailable", message: "Minting is not configured" } }),
    ).toEqual({ state: "unavailable", message: "Minting is not configured" });
  });

  it("at the limit wins over not eligible: a minted wallet sees its agents", () => {
    expect(
      view({
        walletMint: { ...atLimit, reason: "not_allowlisted", message: "m" },
      }).state,
    ).toBe("already-minted");
  });
});
