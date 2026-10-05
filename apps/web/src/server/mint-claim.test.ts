import { readFileSync } from "node:fs";
import { type EnvironmentId, LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { type Address, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { CLAIM_TYPES, type MintClaim, claimDomain } from "@/agent/agent-nft";
import { CLAIM_TTL_SECONDS, type MintClaimDeps, mintClaimResponse } from "./mint-claim";

const CONTRACT: Address = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E";
const WALLET: Address = "0x960f4063b0242aD076978759f3A52c0140300891";
const OTHER: Address = "0xC79b887E3ef56d06867527ceC8D846e2D7424f9d";
const NONCE = `0x${"ab".repeat(32)}` as const;
const NOW_MS = 1_800_000_000_000;

const SIGNER_KEY = generatePrivateKey();
const signer = privateKeyToAccount(SIGNER_KEY);

function deps(overrides: Partial<MintClaimDeps> = {}): MintClaimDeps {
  return {
    environment: "local",
    verify: async (token) => {
      if (token !== "good") throw new Error("bad token");
      return { userId: "did:privy:user", sessionId: "s", expiresAt: 0 };
    },
    walletsOf: async () => [WALLET.toLowerCase()],
    signer,
    contract: CONTRACT,
    chainId: LOCAL_FORK_CHAIN_ID,
    hasMinted: async () => false,
    now: () => NOW_MS,
    randomNonce: () => NONCE,
    ...overrides,
  };
}

function post(body: unknown, token: string | null = "good"): Request {
  return new Request("http://localhost/api/mint-claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(request: Request, d: MintClaimDeps = deps()) {
  const res = await mintClaimResponse(request, d);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the dev mint claim route", () => {
  it("signs a claim for the caller's own linked wallet that recovers to the signer", async () => {
    const { status, body } = await call(post({ wallet: WALLET }));
    expect(status).toBe(200);
    const claim = body as unknown as MintClaim;
    expect(claim).toMatchObject({ wallet: WALLET, nonce: NONCE, contract: CONTRACT });
    expect(claim.deadline).toBe(String(NOW_MS / 1000 + CLAIM_TTL_SECONDS));
    const recovered = await recoverTypedDataAddress({
      domain: claimDomain(LOCAL_FORK_CHAIN_ID, CONTRACT),
      types: CLAIM_TYPES,
      primaryType: "MintClaim",
      message: { wallet: WALLET, nonce: NONCE, deadline: BigInt(claim.deadline) },
      signature: claim.signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it.each<EnvironmentId>(["testnet", "beta"])(
    "refuses to run on %s, before anything else",
    async (environment) => {
      const { status, body } = await call(post({ wallet: WALLET }), deps({ environment }));
      expect(status).toBe(404);
      expect(body.error).toBe("local_only");
    },
  );

  it("says it is not configured without a signer, a verifier or a contract", async () => {
    for (const missing of [{ signer: null }, { verify: null }, { contract: null }]) {
      const { status, body } = await call(post({ wallet: WALLET }), deps(missing));
      expect(status).toBe(503);
      expect(body.error).toBe("not_configured");
    }
  });

  it("needs a valid session", async () => {
    expect((await call(post({ wallet: WALLET }, null))).body.error).toBe("missing_token");
    const bad = await call(post({ wallet: WALLET }, "forged"));
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("invalid_token");
  });

  it("refuses a malformed request", async () => {
    for (const body of ["not json", {}, { wallet: "0x123" }, { wallet: 7 }]) {
      const res = await call(post(body));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
    }
  });

  it("refuses a wallet the user has not linked", async () => {
    const { status, body } = await call(post({ wallet: OTHER }));
    expect(status).toBe(403);
    expect(body.error).toBe("wallet_not_linked");
  });

  it("says when Privy rejects the server's app secret, instead of a bare 500", async () => {
    const { status, body } = await call(
      post({ wallet: WALLET }),
      deps({ walletsOf: () => Promise.reject(new Error("401 Invalid app ID or app secret")) }),
    );
    expect(status).toBe(503);
    expect(body.error).toBe("privy_unavailable");
    expect(body.message).toContain("PRIVY_APP_SECRET");
  });

  it("refuses a wallet that has already minted", async () => {
    const { status, body } = await call(
      post({ wallet: WALLET }),
      deps({ hasMinted: async () => true }),
    );
    expect(status).toBe(409);
    expect(body.error).toBe("already_minted");
  });

  it("never returns or echoes the signer key", async () => {
    for (const request of [post({ wallet: WALLET }), post({ wallet: OTHER }), post("x")]) {
      const res = await mintClaimResponse(request, deps());
      expect((await res.text()).toLowerCase()).not.toContain(SIGNER_KEY.slice(2).toLowerCase());
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("the claim matches AgentNFT", () => {
  const source = readFileSync(
    new URL("../../../../chains/monad/src/AgentNFT.sol", import.meta.url),
    "utf8",
  );

  it("uses the contract's EIP-712 name, version and claim type", () => {
    const domain = claimDomain(LOCAL_FORK_CHAIN_ID, CONTRACT);
    expect(source).toContain(`EIP712("${domain.name}", "${domain.version}")`);
    const fields = CLAIM_TYPES.MintClaim.map((f) => `${f.type} ${f.name}`).join(",");
    expect(source).toContain(`keccak256("MintClaim(${fields})")`);
  });
});
