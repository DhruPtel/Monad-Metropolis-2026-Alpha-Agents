import { randomBytes } from "node:crypto";
import {
  type Hex,
  bytesToHex,
  hexToBytes,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  toBytes,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type AwsKmsApi,
  KmsKeyProvider,
  type KmsKeyRefs,
  addressFromSpki,
  parseDerSignature,
} from "./kms.ts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** DER for one non-negative integer. */
function derInt(n: bigint): number[] {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = [...hexToBytes(`0x${hex}`)];
  if ((bytes[0] ?? 0) & 0x80) bytes = [0, ...bytes];
  return [0x02, bytes.length, ...bytes];
}

const must = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
};
const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";

/**
 * A mock of AWS KMS for secp256k1 keys: it keeps private keys to itself,
 * returns DER public keys and DER signatures, and, like KMS, returns a
 * high s about half the time.
 */
class MockKms implements AwsKmsApi {
  readonly keys = new Map<string, Hex>();
  readonly calls: string[] = [];
  highS = true;

  async createKey() {
    this.calls.push("createKey");
    const id = `mock-${this.keys.size + 1}`;
    this.keys.set(id, bytesToHex(randomBytes(32)));
    return { KeyMetadata: { KeyId: id } };
  }
  async getPublicKey({ KeyId }: { KeyId: string }) {
    this.calls.push("getPublicKey");
    const pk = this.keys.get(KeyId);
    if (!pk) throw new Error("NotFoundException");
    const pub = privateKeyToAccount(pk).publicKey; // 0x04 || X || Y
    return { KeySpec: "ECC_SECG_P256K1", PublicKey: hexToBytes(`0x${SPKI_PREFIX}${pub.slice(2)}`) };
  }
  async sign({ KeyId, Message }: { KeyId: string; Message: Uint8Array }) {
    this.calls.push("sign");
    const pk = this.keys.get(KeyId);
    if (!pk) throw new Error("NotFoundException");
    const sig = await sign({ hash: bytesToHex(Message), privateKey: pk });
    let s = BigInt(sig.s);
    if (this.highS) s = N - s;
    const body = [...derInt(BigInt(sig.r)), ...derInt(s)];
    return { Signature: new Uint8Array([0x30, body.length, ...body]) };
  }
}

class MemoryRefs implements KmsKeyRefs {
  readonly ids = new Map<number, string>();
  async get(agentId: number) {
    return this.ids.get(agentId) ?? null;
  }
  async set(agentId: number, keyId: string) {
    this.ids.set(agentId, keyId);
  }
}

describe("the AWS KMS key provider, against a mock (P2-U4, D-244)", () => {
  it("creates one secp256k1 key per agent and derives its address from the DER public key", async () => {
    const kms = new MockKms();
    const refs = new MemoryRefs();
    const p = new KmsKeyProvider(kms, refs);
    const a = await p.key(5);
    const again = await p.key(5);
    expect(again.address).toBe(a.address);
    expect(kms.calls.filter((c) => c === "createKey")).toHaveLength(1);
    expect(a.address).toBe(privateKeyToAccount(must(kms.keys.get(must(refs.ids.get(5))))).address);
  });

  it("turns KMS's DER signature, high s and all, into a transaction that recovers to the key", async () => {
    const kms = new MockKms();
    const key = await new KmsKeyProvider(kms, new MemoryRefs()).key(9);
    for (const highS of [true, false]) {
      kms.highS = highS;
      const tx = {
        type: "eip1559" as const,
        chainId: 143143,
        nonce: 4,
        to: "0xE712468eB37544B7Eafe20F402867f7a49C19F43" as Hex,
        data: "0x1234" as Hex,
        value: 0n,
        gas: 1_100_000n,
        maxFeePerGas: 100_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      };
      const sig = await key.signDigest(keccak256(serializeTransaction(tx)));
      expect(BigInt(sig.s) <= N / 2n).toBe(true);
      const raw = serializeTransaction(tx, sig);
      expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(
        key.address,
      );
      expect(parseTransaction(raw).nonce).toBe(4);
    }
  });

  it("refuses a key that is not secp256k1 and a malformed signature", async () => {
    const kms = new MockKms();
    const odd = Object.assign(Object.create(kms) as MockKms, {
      getPublicKey: async () => ({ KeySpec: "ECC_NIST_P256", PublicKey: new Uint8Array(88) }),
    });
    await expect(new KmsKeyProvider(odd, new MemoryRefs()).key(1)).rejects.toThrow(
      "is not secp256k1",
    );
    expect(() => parseDerSignature(new Uint8Array([0x30, 2, 0x02]))).toThrow("truncated");
    expect(() => addressFromSpki(hexToBytes(`0x${SPKI_PREFIX}02${"00".repeat(64)}`))).toThrow(
      "not an uncompressed secp256k1 point",
    );
    void toBytes;
  });
});
