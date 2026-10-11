import { type Hex, encodeAbiParameters, isAddressEqual, verifyTypedData } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

/**
 * The price attestor (F-U12, D-337): signs a class A token's USD price as
 * the median of at least two independent sources, valid for at most 60
 * seconds, so a sandwich cannot move the reference. It refuses to sign when
 * it has fewer than two fresh sources or when they disagree beyond a bound.
 * Its key signs attestations and nothing else: the signer here exposes one
 * method, and the verifier contract reads nothing but the price.
 *
 * An attestation's bytes are what AttestationVerifier decodes:
 * `abi.encode(token, priceE18, observedAt, validUntil, signature)`, the
 * signature over the EIP-712 Attestation for the chain and the verifier.
 */
export interface PriceReading {
  readonly priceE18: bigint;
  readonly observedAt: Date;
}

/** One independent source of a token's USD price; null when it has none. */
export interface PriceSource {
  readonly name: string;
  priceOf(token: Hex, now: Date): Promise<PriceReading | null>;
}

export interface AttestorRules {
  /** How long an attestation is valid; the verifier refuses more than 60 s. */
  readonly lifeSeconds: number;
  /** The widest spread between any source and the median the attestor signs. */
  readonly maxSpreadBps: number;
  /** A reading older than this does not count. */
  readonly maxSourceAgeSeconds: number;
  readonly minSources: number;
  /** A signed attestation is reused for this long, well inside its life. */
  readonly reuseSeconds: number;
}

export const DEFAULT_ATTESTOR_RULES: AttestorRules = {
  lifeSeconds: 60,
  maxSpreadBps: 500,
  maxSourceAgeSeconds: 120,
  minSources: 2,
  reuseSeconds: 20,
};

export type AttestationRefusal =
  "TOO_FEW_SOURCES" | "SOURCES_DISAGREE" | "NO_VERIFIER" | "NOT_CLASS_A";

export interface Attestation {
  readonly ok: true;
  readonly token: Hex;
  readonly priceE18: bigint;
  readonly observedAt: Date;
  readonly validUntil: Date;
  readonly bytes: Hex;
  readonly sources: readonly { readonly name: string; readonly priceE18: bigint }[];
}

export interface AttestationRefused {
  readonly ok: false;
  readonly token: Hex;
  readonly reason: AttestationRefusal;
  readonly detail: string;
  readonly sources: readonly { readonly name: string; readonly priceE18: bigint | null }[];
}

export type AttestationResult = Attestation | AttestationRefused;

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "chainId", type: "uint256" },
    { name: "token", type: "address" },
    { name: "priceE18", type: "uint256" },
    { name: "observedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export const attestationDomain = (chainId: number, verifier: Hex) =>
  ({ name: "AlphaAgentsAttestor", version: "1", chainId, verifyingContract: verifier }) as const;

/** The attestor key: one method, the EIP-712 signature of an Attestation. */
export interface AttestorKey {
  readonly address: Hex;
  signAttestation(
    domain: ReturnType<typeof attestationDomain>,
    message: {
      chainId: bigint;
      token: Hex;
      priceE18: bigint;
      observedAt: bigint;
      validUntil: bigint;
    },
  ): Promise<Hex>;
}

export function attestorKeyFrom(privateKey: Hex): AttestorKey {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signAttestation: (domain, message) =>
      account.signTypedData({
        domain,
        types: ATTESTATION_TYPES,
        primaryType: "Attestation",
        message,
      }),
  };
}

/** Anvil's mnemonic, index 2: the local fork's attestor (scripts/lib/attestor.js). */
export const LOCAL_ATTESTOR_INDEX = 2;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export function localAttestorKey(): Hex {
  const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: LOCAL_ATTESTOR_INDEX }).getHdKey()
    .privateKey;
  if (!key) throw new Error("the local attestor key could not be derived");
  return `0x${Buffer.from(key).toString("hex")}` as Hex;
}

/** The median of the readings (the lower middle of an even count, so one high outlier never lifts it). */
export function medianE18(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length === 0) throw new Error("no values");
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid] as bigint;
}

/** The spread of a reading from the median, in basis points of the median. */
export function spreadBps(value: bigint, median: bigint): number {
  if (median === 0n) return Number.POSITIVE_INFINITY;
  const diff = value > median ? value - median : median - value;
  return Number((diff * 10_000n) / median);
}

export function attestationBytes(a: {
  token: Hex;
  priceE18: bigint;
  observedAt: bigint;
  validUntil: bigint;
  signature: Hex;
}): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "bytes" },
    ],
    [a.token, a.priceE18, a.observedAt, a.validUntil, a.signature],
  );
}

export interface AttestorOptions {
  readonly chainId: number;
  /** The verifier the registry names; null until one is set, and then every attestation is refused. */
  readonly verifier: () => Promise<Hex | null>;
  readonly key: AttestorKey;
  readonly sources: readonly PriceSource[];
  readonly rules?: Partial<AttestorRules>;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export class Attestor {
  readonly rules: AttestorRules;
  private readonly o: AttestorOptions;
  private readonly recent = new Map<string, Attestation>();

  constructor(o: AttestorOptions) {
    this.o = o;
    this.rules = { ...DEFAULT_ATTESTOR_RULES, ...(o.rules ?? {}) };
    if (this.rules.lifeSeconds > 60) throw new Error("an attestation lives at most 60 seconds");
  }

  get address(): Hex {
    return this.o.key.address;
  }

  /** A fresh attestation for the token, or one signed moments ago, or why none can be signed. */
  async attest(token: Hex): Promise<AttestationResult> {
    const now = this.o.now?.() ?? new Date();
    const key = token.toLowerCase();
    const reused = this.recent.get(key);
    if (reused && now.getTime() - reused.observedAt.getTime() < this.rules.reuseSeconds * 1000)
      return reused;
    const verifier = await this.o.verifier();
    if (!verifier)
      return {
        ok: false,
        token,
        reason: "NO_VERIFIER",
        detail: "the registry names no attestation verifier yet",
        sources: [],
      };
    const readings = await Promise.all(
      this.o.sources.map(async (s) => {
        try {
          return { name: s.name, reading: await s.priceOf(token, now) };
        } catch (err) {
          this.o.log?.(
            `attestor: ${s.name} failed for ${token}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
          );
          return { name: s.name, reading: null };
        }
      }),
    );
    const fresh = readings.filter(
      (r): r is { name: string; reading: PriceReading } =>
        r.reading !== null &&
        r.reading.priceE18 > 0n &&
        now.getTime() - r.reading.observedAt.getTime() <= this.rules.maxSourceAgeSeconds * 1000,
    );
    const listed = readings.map((r) => ({ name: r.name, priceE18: r.reading?.priceE18 ?? null }));
    if (fresh.length < this.rules.minSources)
      return {
        ok: false,
        token,
        reason: "TOO_FEW_SOURCES",
        detail: `${fresh.length} fresh source${fresh.length === 1 ? "" : "s"} of ${readings.length}; at least ${this.rules.minSources} are needed`,
        sources: listed,
      };
    const median = medianE18(fresh.map((r) => r.reading.priceE18));
    const widest = Math.max(...fresh.map((r) => spreadBps(r.reading.priceE18, median)));
    if (widest > this.rules.maxSpreadBps)
      return {
        ok: false,
        token,
        reason: "SOURCES_DISAGREE",
        detail: `the sources are ${widest} bps apart at the widest; the bound is ${this.rules.maxSpreadBps} bps`,
        sources: listed,
      };
    const observedAt = BigInt(Math.floor(now.getTime() / 1000));
    const validUntil = observedAt + BigInt(this.rules.lifeSeconds);
    const message = {
      chainId: BigInt(this.o.chainId),
      token,
      priceE18: median,
      observedAt,
      validUntil,
    };
    const signature = await this.o.key.signAttestation(
      attestationDomain(this.o.chainId, verifier),
      message,
    );
    const out: Attestation = {
      ok: true,
      token,
      priceE18: median,
      observedAt: new Date(Number(observedAt) * 1000),
      validUntil: new Date(Number(validUntil) * 1000),
      bytes: attestationBytes({ token, priceE18: median, observedAt, validUntil, signature }),
      sources: fresh.map((r) => ({ name: r.name, priceE18: r.reading.priceE18 })),
    };
    this.recent.set(key, out);
    return out;
  }

  /** The prices of several tokens at once, for the platform's own views (never signed twice). */
  async prices(tokens: readonly Hex[]): Promise<Record<string, AttestationResult>> {
    const out: Record<string, AttestationResult> = {};
    await Promise.all(
      tokens.map(async (t) => {
        out[t.toLowerCase()] = await this.attest(t);
      }),
    );
    return out;
  }
}

/** Checks an attestation's signature the way the verifier does, for tests and the console. */
export async function attestationSignedBy(
  a: {
    chainId: number;
    verifier: Hex;
    token: Hex;
    priceE18: bigint;
    observedAt: bigint;
    validUntil: bigint;
    signature: Hex;
  },
  attestor: Hex,
): Promise<boolean> {
  const ok = await verifyTypedData({
    address: attestor,
    domain: attestationDomain(a.chainId, a.verifier),
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message: {
      chainId: BigInt(a.chainId),
      token: a.token,
      priceE18: a.priceE18,
      observedAt: a.observedAt,
      validUntil: a.validUntil,
    },
    signature: a.signature,
  });
  return ok && isAddressEqual(attestor, attestor);
}
