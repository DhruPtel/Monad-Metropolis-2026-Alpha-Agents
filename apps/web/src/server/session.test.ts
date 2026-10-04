import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "../app/api/session/route";
import { configuredPrivyVerifier, privyVerifier } from "./privy";
import { type AccessTokenVerifier, bearerToken, sessionResponse } from "./session";

/**
 * The session check against Privy's real token verification. The tests mint
 * their own ES256 tokens with a throwaway key and give Privy's verifier the
 * matching public key, so verification runs locally and exactly as in
 * production, without a Privy account or network.
 */
const APP_ID = "test-app-id";
const USER = "did:privy:test-user";
const NOW = () => Math.floor(Date.now() / 1000);

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let verify: AccessTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  verify = privyVerifier({
    appId: APP_ID,
    appSecret: "test-only-app-secret",
    verificationKey: await exportSPKI(pair.publicKey),
  });
});

async function token(
  overrides: { iss?: string; aud?: string; exp?: number; key?: CryptoKey; sub?: string } = {},
) {
  return new SignJWT({ sid: "test-session" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(overrides.iss ?? "privy.io")
    .setAudience(overrides.aud ?? APP_ID)
    .setSubject(overrides.sub ?? USER)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? NOW() + 3600)
    .sign(overrides.key ?? signingKey);
}

const request = (authorization?: string) =>
  new Request("http://127.0.0.1/api/session", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("bearerToken", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["Bearer", null],
    ["Bearer ", null],
    ["Basic abc", null],
    ["Bearer a b", null],
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
  ])("%j gives %j", (header, expected) => {
    expect(bearerToken(request(header))).toBe(expected);
  });
});

describe("the session check with Privy's verifier", () => {
  it("accepts a valid Privy access token and returns who the user is", async () => {
    const res = await sessionResponse(request(`Bearer ${await token()}`), verify);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { userId: string; sessionId: string; expiresAt: number };
    expect(body).toMatchObject({ userId: USER, sessionId: "test-session" });
    expect(body.expiresAt).toBeGreaterThan(NOW());
  });

  it("rejects a missing token", async () => {
    const res = await sessionResponse(request(), verify);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_token" });
  });

  it.each([
    ["signed by another key", { key: undefined as CryptoKey | undefined, other: true }],
    ["for another app", { aud: "someone-elses-app" }],
    ["from another issuer", { iss: "evil.example" }],
    ["expired", { exp: NOW() - 60 }],
  ] as const)("rejects a token %s", async (_, o) => {
    const t = await token({
      ...("aud" in o ? { aud: o.aud } : {}),
      ...("iss" in o ? { iss: o.iss } : {}),
      ...("exp" in o ? { exp: o.exp } : {}),
      ...("other" in o ? { key: otherKey } : {}),
    });
    const res = await sessionResponse(request(`Bearer ${t}`), verify);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("rejects a malformed token and never echoes it", async () => {
    const res = await sessionResponse(request("Bearer not.a.jwt"), verify);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("not.a.jwt");
  });
});

describe("configuration", () => {
  it("answers 503 when Privy is not configured", async () => {
    const res = await sessionResponse(request("Bearer x"), null);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });

  it.each([
    ["nothing set", {}],
    ["only the app ID", { PRIVY_APP_ID: APP_ID }],
    [
      "the .env.example placeholders",
      { PRIVY_APP_ID: "your-privy-app-id", PRIVY_APP_SECRET: "your-privy-app-secret" },
    ],
  ])("has no verifier with %s", (_, env) => {
    expect(configuredPrivyVerifier(env)).toBeNull();
  });

  it("builds a verifier from the app ID and secret, without needing a chain RPC", () => {
    const env = { APP_ENV: "beta", PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "test-only-app-secret" };
    expect(configuredPrivyVerifier(env)).toBeTypeOf("function");
  });

  it("the route itself answers 503 here, where no Privy app is configured", async () => {
    const saved = { id: process.env.PRIVY_APP_ID, secret: process.env.PRIVY_APP_SECRET };
    delete process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
    try {
      expect((await GET(request("Bearer x"))).status).toBe(503);
    } finally {
      if (saved.id !== undefined) process.env.PRIVY_APP_ID = saved.id;
      if (saved.secret !== undefined) process.env.PRIVY_APP_SECRET = saved.secret;
    }
  });
});
