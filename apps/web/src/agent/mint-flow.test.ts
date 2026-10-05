import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { AGENT_NFT_ABI, type MintClaim } from "./agent-nft";
import { type MintFlowDeps, type MintProgress, runMint } from "./mint-flow";

const WALLET = "0x960f4063b0242aD076978759f3A52c0140300891";
const HASH = `0x${"12".repeat(32)}` as const;
const CLAIM: MintClaim = {
  wallet: WALLET,
  nonce: `0x${"ab".repeat(32)}`,
  deadline: "1800000600",
  signature: `0x${"cd".repeat(65)}`,
  contract: "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E",
};

function deps(overrides: Partial<MintFlowDeps> = {}): MintFlowDeps {
  return {
    wallet: WALLET,
    requestClaim: async () => ({ status: 200, body: CLAIM }),
    sendMint: async () => HASH,
    waitForMint: async () => 7n,
    waitForReveal: async () => 14,
    ...overrides,
  };
}

async function run(d: MintFlowDeps) {
  const seen: MintProgress[] = [];
  const result = await runMint(d, (p) => seen.push(p));
  return { result, states: seen.map((p) => p.state) };
}

function revert(errorName: "AlreadyMinted" | "SoldOut" | "ClaimExpired") {
  const args = errorName === "AlreadyMinted" ? [WALLET] : errorName === "ClaimExpired" ? [1n] : [];
  const data = encodeErrorResult({ abi: AGENT_NFT_ABI, errorName, args } as never);
  return new ContractFunctionRevertedError({
    abi: AGENT_NFT_ABI,
    data,
    functionName: "mintWithClaim",
  });
}

describe("the mint flow", () => {
  it("goes claiming, signing, minting, waiting for reveal, revealed", async () => {
    const { result, states } = await run(deps());
    expect(states).toEqual(["claiming", "signing", "minting", "awaiting-reveal", "revealed"]);
    expect(result).toEqual({ state: "revealed", agentId: 7n, species: 14, hash: HASH });
  });

  it("sends exactly the claim the route returned", async () => {
    let sent: MintClaim | undefined;
    await run(deps({ sendMint: async (c) => ((sent = c), HASH) }));
    expect(sent).toEqual(CLAIM);
  });

  it.each([403, 404, 409, 503])(
    "is claim-refused with the route's reason on %i",
    async (status) => {
      const { result } = await run(
        deps({
          requestClaim: async () => ({ status, body: { error: "x", message: "No claim for you" } }),
        }),
      );
      expect(result).toEqual({ state: "claim-refused", message: "No claim for you" });
    },
  );

  it("is an error on a 401 or an unreachable route", async () => {
    expect(
      (await run(deps({ requestClaim: async () => ({ status: 401, body: {} }) }))).result.state,
    ).toBe("error");
    const down = await run(
      deps({ requestClaim: () => Promise.reject(new TypeError("fetch failed")) }),
    );
    expect(down.result).toEqual({
      state: "error",
      message: "Could not reach the platform for a mint claim.",
    });
  });

  it("says rejected when the user declines in the wallet", async () => {
    const declined = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const { result, states } = await run(deps({ sendMint: () => Promise.reject(declined) }));
    expect(states).toEqual(["claiming", "signing", "rejected"]);
    expect(result.state).toBe("rejected");
  });

  it("explains AgentNFT's reverts", async () => {
    const minted = await run(deps({ sendMint: () => Promise.reject(revert("AlreadyMinted")) }));
    expect(minted.result).toEqual({
      state: "claim-refused",
      message: "This wallet has already minted an agent.",
    });
    const expired = await run(deps({ sendMint: () => Promise.reject(revert("ClaimExpired")) }));
    expect(expired.result.state).toBe("error");
    expect(expired.result.message).toMatch(/expired/);
  });

  it("is an error when the transaction fails after sending", async () => {
    const { result, states } = await run(
      deps({ waitForMint: () => Promise.reject(new Error("reverted")) }),
    );
    expect(states).toEqual(["claiming", "signing", "minting", "error"]);
    expect(result).toEqual({ state: "error", hash: HASH, message: "The mint transaction failed." });
  });
});
