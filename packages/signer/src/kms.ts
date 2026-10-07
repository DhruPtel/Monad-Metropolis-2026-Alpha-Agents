import {
  type Hex,
  bytesToHex,
  getAddress,
  keccak256,
  recoverAddress,
  serializeSignature,
} from "viem";
import type { DigestSignature, KeyProvider, SessionKey } from "./keys.ts";

/**
 * AWS KMS secp256k1 keys (P2-U4, D-244). The calls and their shapes are KMS's
 * own (CreateKey, GetPublicKey, Sign with MessageType DIGEST); the binding to
 * the AWS SDK client and real credentials come with PB-U1, so this unit tests
 * against a mock that signs like KMS: DER signatures, high s values allowed,
 * and no recovery ID.
 */
export interface AwsKmsApi {
  createKey(input: {
    KeySpec: "ECC_SECG_P256K1";
    KeyUsage: "SIGN_VERIFY";
    Description: string;
  }): Promise<{ KeyMetadata?: { KeyId?: string } }>;
  getPublicKey(input: { KeyId: string }): Promise<{ PublicKey?: Uint8Array; KeySpec?: string }>;
  sign(input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: "DIGEST";
    SigningAlgorithm: "ECDSA_SHA_256";
  }): Promise<{ Signature?: Uint8Array }>;
}

/** Where each agent's KMS key ID is recorded (the signer_keys table in production). */
export interface KmsKeyRefs {
  get(agentId: number): Promise<string | null>;
  set(agentId: number, keyId: string): Promise<void>;
}

/** secp256k1's group order; a signature with s above half of it is flipped (EIP-2). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

class Der {
  private i = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  byte(): number {
    const v = this.b[this.i++];
    if (v === undefined) throw new Error("KMS returned a truncated DER value");
    return v;
  }
  length(): number {
    const first = this.byte();
    if (first < 0x80) return first;
    let n = 0;
    for (let k = 0; k < (first & 0x7f); k++) n = (n << 8) | this.byte();
    return n;
  }
  take(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error("KMS returned a truncated DER value");
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
  expect(tag: number): number {
    if (this.byte() !== tag) throw new Error("KMS returned an unexpected DER value");
    return this.length();
  }
}

const toBig = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt(bytesToHex(b)));
const pad32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

/** r and s from a DER ECDSA-Sig-Value, with s moved to the low half. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const d = new Der(der);
  d.expect(0x30);
  const r = toBig(d.take(d.expect(0x02)));
  let s = toBig(d.take(d.expect(0x02)));
  if (r === 0n || s === 0n || r >= N || s >= N)
    throw new Error("KMS returned an invalid signature");
  if (s > N / 2n) s = N - s;
  return { r, s };
}

/** The Ethereum address of a DER SubjectPublicKeyInfo holding an uncompressed secp256k1 point. */
export function addressFromSpki(spki: Uint8Array): Hex {
  const d = new Der(spki);
  d.expect(0x30);
  d.take(d.expect(0x30)); // the algorithm identifier
  const bits = d.take(d.expect(0x03));
  // One byte of unused bits (0), then 0x04 || X || Y.
  if (bits.length !== 66 || bits[0] !== 0 || bits[1] !== 0x04)
    throw new Error("KMS returned a public key that is not an uncompressed secp256k1 point");
  return getAddress(`0x${keccak256(bits.subarray(2)).slice(-40)}`);
}

export class KmsKeyProvider implements KeyProvider {
  readonly kind = "kms" as const;
  readonly #api: AwsKmsApi;
  readonly #refs: KmsKeyRefs;
  readonly #addresses = new Map<string, Hex>();

  constructor(api: AwsKmsApi, refs: KmsKeyRefs) {
    this.#api = api;
    this.#refs = refs;
  }

  async #keyId(agentId: number): Promise<string> {
    const known = await this.#refs.get(agentId);
    if (known) return known;
    const created = await this.#api.createKey({
      KeySpec: "ECC_SECG_P256K1",
      KeyUsage: "SIGN_VERIFY",
      Description: `Alpha Agents session key for agent ${agentId}`,
    });
    const id = created.KeyMetadata?.KeyId;
    if (!id) throw new Error("KMS created no key");
    await this.#refs.set(agentId, id);
    return id;
  }

  async #address(keyId: string): Promise<Hex> {
    const cached = this.#addresses.get(keyId);
    if (cached) return cached;
    const out = await this.#api.getPublicKey({ KeyId: keyId });
    if (out.KeySpec && out.KeySpec !== "ECC_SECG_P256K1")
      throw new Error(`KMS key spec ${out.KeySpec} is not secp256k1`);
    if (!out.PublicKey) throw new Error("KMS returned no public key");
    const address = addressFromSpki(out.PublicKey);
    this.#addresses.set(keyId, address);
    return address;
  }

  async key(agentId: number): Promise<SessionKey> {
    const keyId = await this.#keyId(agentId);
    const address = await this.#address(keyId);
    const api = this.#api;
    return {
      agentId,
      address,
      async signDigest(digest: Hex): Promise<DigestSignature> {
        if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error("a digest is 32 bytes");
        const out = await api.sign({
          KeyId: keyId,
          Message: Buffer.from(digest.slice(2), "hex"),
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        });
        if (!out.Signature) throw new Error("KMS returned no signature");
        const { r, s } = parseDerSignature(out.Signature);
        // KMS gives no recovery ID: the one that recovers this key's address is it.
        for (const yParity of [0, 1] as const) {
          const signature = serializeSignature({ r: pad32(r), s: pad32(s), yParity });
          if ((await recoverAddress({ hash: digest, signature })) === address)
            return { r: pad32(r), s: pad32(s), yParity };
        }
        throw new Error("the KMS signature does not recover to the key's address");
      },
    };
  }

  toJSON(): Record<string, string> {
    return { kind: this.kind };
  }
}
