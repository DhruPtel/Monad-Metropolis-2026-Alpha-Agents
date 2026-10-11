import { type Hex, decodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { fixedSource, usdToE18 } from "./attestor-sources.ts";
import {
  type AttestationRefused,
  Attestor,
  type PriceSource,
  attestationSignedBy,
  attestorKeyFrom,
  localAttestorKey,
  medianE18,
  spreadBps,
} from "./attestor.ts";

/**
 * The price attestor (F-U12): the median of at least two fresh sources,
 * signed for 60 seconds as the verifier decodes it; a refusal with one
 * source, with sources too far apart, with a stale reading, or without a
 * verifier; a signed attestation reused within its window; and the key that
 * signs attestations and nothing else.
 */
/** Anvil account 1 (a public development account), the test attestor. */
const SIGNER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const VERIFIER = "0x00000000000000000000000000000000000000ee" as Hex;
/** GHO on Monad, a class A token. */
const GHO = "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73" as Hex;
const T0 = new Date("2026-10-11T12:00:00Z");
const E18 = 10n ** 18n;

const source = (name: string, priceE18: bigint | null, ageSeconds = 0): PriceSource => ({
  name,
  async priceOf(_token, now) {
    return priceE18 === null
      ? null
      : { priceE18, observedAt: new Date(now.getTime() - ageSeconds * 1000) };
  },
});

const attestor = (
  sources: PriceSource[],
  over: Partial<ConstructorParameters<typeof Attestor>[0]> = {},
) =>
  new Attestor({
    chainId: 143143,
    verifier: async () => VERIFIER,
    key: attestorKeyFrom(SIGNER),
    sources,
    now: () => T0,
    ...over,
  });

describe("the attestor's arithmetic", () => {
  it("takes the median, the lower middle of an even count, and measures a spread in basis points", () => {
    expect(medianE18([3n, 1n, 2n])).toBe(2n);
    expect(medianE18([4n, 1n, 2n, 3n])).toBe(2n);
    expect(medianE18([7n])).toBe(7n);
    expect(spreadBps(105n * E18, 100n * E18)).toBe(500);
    expect(spreadBps(95n * E18, 100n * E18)).toBe(500);
    expect(usdToE18(1.5)).toBe(15n * 10n ** 17n);
    expect(usdToE18(0.000123)).toBe(123n * 10n ** 12n);
  });
});

describe("the attestor", () => {
  it("signs the median of two fresh sources for 60 seconds, as the verifier decodes and checks it", async () => {
    const a = attestor([source("pool", 102n * E18), source("gecko", 100n * E18)]);
    const r = await a.attest(GHO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.priceE18).toBe(100n * E18);
    expect(r.observedAt).toEqual(T0);
    expect(r.validUntil.getTime() - r.observedAt.getTime()).toBe(60_000);
    expect(r.sources).toEqual([
      { name: "pool", priceE18: 102n * E18 },
      { name: "gecko", priceE18: 100n * E18 },
    ]);
    const [token, price, observedAt, validUntil, signature] = decodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes" },
      ],
      r.bytes,
    );
    expect(token.toLowerCase()).toBe(GHO);
    expect(price).toBe(100n * E18);
    expect(validUntil - observedAt).toBe(60n);
    expect(
      await attestationSignedBy(
        {
          chainId: 143143,
          verifier: VERIFIER,
          token: GHO,
          priceE18: price,
          observedAt,
          validUntil,
          signature,
        },
        privateKeyToAccount(SIGNER).address,
      ),
    ).toBe(true);
    // Another key's address does not verify it, nor another chain's domain.
    expect(
      await attestationSignedBy(
        {
          chainId: 143143,
          verifier: VERIFIER,
          token: GHO,
          priceE18: price,
          observedAt,
          validUntil,
          signature,
        },
        privateKeyToAccount(localAttestorKey()).address,
      ),
    ).toBe(false);
    expect(
      await attestationSignedBy(
        {
          chainId: 143,
          verifier: VERIFIER,
          token: GHO,
          priceE18: price,
          observedAt,
          validUntil,
          signature,
        },
        privateKeyToAccount(SIGNER).address,
      ),
    ).toBe(false);
  });

  it("refuses with one source, with sources too far apart, with a stale reading, or with no verifier", async () => {
    const one = await attestor([source("pool", 100n * E18), source("gecko", null)]).attest(GHO);
    expect(one).toMatchObject({ ok: false, reason: "TOO_FEW_SOURCES" });
    expect((one as AttestationRefused).detail).toBe("1 fresh source of 2; at least 2 are needed");
    const apart = await attestor([source("pool", 106n * E18), source("gecko", 100n * E18)]).attest(
      GHO,
    );
    expect(apart).toMatchObject({ ok: false, reason: "SOURCES_DISAGREE" });
    expect((apart as AttestationRefused).detail).toMatch(/600 bps apart/);
    const stale = await attestor([
      source("pool", 100n * E18),
      source("gecko", 101n * E18, 121),
    ]).attest(GHO);
    expect(stale).toMatchObject({ ok: false, reason: "TOO_FEW_SOURCES" });
    const none = await attestor([source("pool", 100n * E18), source("gecko", 100n * E18)], {
      verifier: async () => null,
    }).attest(GHO);
    expect(none).toMatchObject({ ok: false, reason: "NO_VERIFIER" });
    // A source that throws counts as none, and three sources agree by their median.
    const throwing: PriceSource = {
      name: "cmc",
      priceOf: async () => {
        throw new Error("rate limited");
      },
    };
    const three = await attestor([
      source("pool", 100n * E18),
      source("gecko", 101n * E18),
      throwing,
    ]).attest(GHO);
    expect(three).toMatchObject({ ok: true, priceE18: 100n * E18 });
    const zero = await attestor([source("pool", 0n), source("gecko", 100n * E18)]).attest(GHO);
    expect(zero).toMatchObject({ ok: false, reason: "TOO_FEW_SOURCES" });
  });

  it("reuses an attestation signed moments ago and signs again once it is older than the reuse window", async () => {
    const clock = { now: T0 };
    let price = 100n * E18;
    const live: PriceSource = {
      name: "pool",
      priceOf: async (_t, now) => ({ priceE18: price, observedAt: now }),
    };
    const a = attestor([live, source("gecko", 100n * E18)], { now: () => clock.now });
    const first = await a.attest(GHO);
    price = 101n * E18;
    clock.now = new Date(T0.getTime() + 10_000);
    const second = await a.attest(GHO);
    expect(second).toBe(first);
    clock.now = new Date(T0.getTime() + 21_000);
    const third = await a.attest(GHO);
    expect(third).not.toBe(first);
    expect(third.ok && third.observedAt).toEqual(clock.now);
    // Never more than 60 seconds, whatever the rules ask.
    expect(() => attestor([], { rules: { lifeSeconds: 61 } })).toThrow(/at most 60/);
  });

  it("the fixed source answers only the tokens it was given, and the local key is anvil account 2", async () => {
    const s = fixedSource("fixed", { [GHO]: 3n * E18 });
    expect(await s.priceOf(GHO, T0)).toEqual({ priceE18: 3n * E18, observedAt: T0 });
    expect(await s.priceOf("0x00000000000000000000000000000000000000aa", T0)).toBeNull();
    expect(privateKeyToAccount(localAttestorKey()).address).toBe(
      "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    );
    expect(attestorKeyFrom(SIGNER).address).toBe(privateKeyToAccount(SIGNER).address);
    expect(Object.keys(attestorKeyFrom(SIGNER))).toEqual(["address", "signAttestation"]);
  });
});
