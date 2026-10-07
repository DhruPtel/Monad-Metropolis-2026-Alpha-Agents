import { inspect } from "node:util";
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  recoverAddress,
  serializeSignature,
  toBytes,
} from "viem";
import { HDKey, privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider, sessionKeyPath } from "./keys.ts";

const SEED = `0x${"5e".repeat(32)}` as const;
const must = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
};
const privateKeyOf = (agentId: number) =>
  bytesToHex(
    must(HDKey.fromMasterSeed(hexToBytes(SEED)).derive(sessionKeyPath(agentId)).privateKey),
  );

describe("the local key provider (P2-U4)", () => {
  it("gives each agent its own key at the funding address's path, the same every time", async () => {
    const p = new LocalKeyProvider(SEED);
    const a = await p.key(7);
    expect(a.address).toBe(privateKeyToAddress(privateKeyOf(7)));
    expect((await p.key(7)).address).toBe(a.address);
    expect((await p.key(8)).address).not.toBe(a.address);
    expect(sessionKeyPath(7)).toBe("m/44'/60'/0'/0/7");
    expect(() => sessionKeyPath(0)).toThrow(RangeError);
  });

  it("signs a digest that recovers to the key's address", async () => {
    const key = await new LocalKeyProvider(SEED).key(3);
    const digest = keccak256(toBytes("a swap"));
    const sig = await key.signDigest(digest);
    expect(await recoverAddress({ hash: digest, signature: serializeSignature(sig) })).toBe(
      key.address,
    );
    await expect(key.signDigest("0x1234")).rejects.toThrow("a digest is 32 bytes");
  });

  it("never shows the seed or a private key, however it is printed", async () => {
    const p = new LocalKeyProvider(SEED);
    const key = await p.key(3);
    const secret = privateKeyOf(3).slice(2);
    for (const shown of [
      JSON.stringify(p),
      inspect(p, { depth: 5, showHidden: true }),
      JSON.stringify(key),
      inspect(key, { depth: 5, showHidden: true }),
    ]) {
      expect(shown).not.toContain(SEED.slice(2));
      expect(shown).not.toContain(secret);
    }
    expect(() => new LocalKeyProvider("0x1234")).toThrow("the signer seed must be 32 bytes");
  });
});
