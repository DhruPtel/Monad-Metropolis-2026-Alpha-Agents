import { type Hex, bytesToHex, getAddress, hexToBytes } from "viem";
import { HDKey, privateKeyToAddress, sign } from "viem/accounts";

/**
 * The key interface (P2-U4, D-243). A session key is one secp256k1 key per
 * agent that never leaves its provider: callers get its address and ask it to
 * sign a 32-byte digest, nothing else. There is no method that returns key
 * material, and a provider's own fields are private (#) so neither
 * JSON.stringify nor util.inspect can reach them.
 *
 * Three providers: LocalKeyProvider derives keys from the platform seed for
 * the local fork and testnet, KmsKeyProvider (kms.ts) asks AWS KMS, and
 * CanaryKeyProvider holds the P2-EC mainnet canary's one raw session key
 * (D-252). KMS is required before the beta (D-244); the config refuses the
 * seed there.
 */
export interface DigestSignature {
  readonly r: Hex;
  readonly s: Hex;
  readonly yParity: 0 | 1;
}

export interface SessionKey {
  readonly agentId: number;
  readonly address: Hex;
  /** Signs a 32-byte digest. The key itself never comes back. */
  signDigest(digest: Hex): Promise<DigestSignature>;
}

export interface KeyProvider {
  readonly kind: "local" | "kms" | "canary";
  /** The agent's session key: the same key, and so the same address, every time. */
  key(agentId: number): Promise<SessionKey>;
}

/**
 * The session key is the agent's funding address (FINAL_PLAN 4.2.3, D-243):
 * the same derivation path the orchestrator's FundingKeys uses (D-207).
 */
export const sessionKeyPath = (agentId: number): `m/44'/60'/${string}` => {
  if (!Number.isSafeInteger(agentId) || agentId < 1 || agentId >= 2 ** 31)
    throw new RangeError(`invalid agent ID ${agentId}`);
  return `m/44'/60'/0'/0/${agentId}`;
};

export class LocalKeyProvider implements KeyProvider {
  readonly kind = "local" as const;
  readonly #root: HDKey;

  constructor(seed: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new Error("the signer seed must be 32 bytes");
    this.#root = HDKey.fromMasterSeed(hexToBytes(seed));
  }

  #privateKey(agentId: number): Hex {
    const child = this.#root.derive(sessionKeyPath(agentId));
    if (!child.privateKey) throw new Error(`no key at agent ${agentId}'s path`);
    return bytesToHex(child.privateKey);
  }

  async key(agentId: number): Promise<SessionKey> {
    const address = getAddress(privateKeyToAddress(this.#privateKey(agentId)));
    const derive = (id: number) => this.#privateKey(id);
    return {
      agentId,
      address,
      async signDigest(digest: Hex) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error("a digest is 32 bytes");
        const sig = await sign({ hash: digest, privateKey: derive(agentId) });
        return { r: sig.r, s: sig.s, yParity: sig.yParity === 1 ? 1 : 0 };
      },
    };
  }

  toJSON(): Record<string, string> {
    return { kind: this.kind };
  }
}

/**
 * The P2-EC mainnet canary's session key (D-252, D-251): one raw throwaway
 * key from `CANARY_SESSION_PRIVATE_KEY`, never derived from a seed, for the
 * canary's one agent (ID 1) only. Any other agent is refused.
 */
export class CanaryKeyProvider implements KeyProvider {
  readonly kind = "canary" as const;
  /** The one agent the canary knows (CanaryAgent, D-250). */
  static readonly AGENT_ID = 1;
  readonly #key: Hex;

  constructor(privateKey: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey))
      throw new Error("the canary session key must be 32 bytes");
    this.#key = privateKey;
  }

  async key(agentId: number): Promise<SessionKey> {
    if (agentId !== CanaryKeyProvider.AGENT_ID)
      throw new Error(`the canary has one agent, ${CanaryKeyProvider.AGENT_ID}, not ${agentId}`);
    const privateKey = this.#key;
    return {
      agentId,
      address: getAddress(privateKeyToAddress(privateKey)),
      async signDigest(digest: Hex) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error("a digest is 32 bytes");
        const sig = await sign({ hash: digest, privateKey });
        return { r: sig.r, s: sig.s, yParity: sig.yParity === 1 ? 1 : 0 };
      },
    };
  }

  toJSON(): Record<string, string> {
    return { kind: this.kind };
  }
}
