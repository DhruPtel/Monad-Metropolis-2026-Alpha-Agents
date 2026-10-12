import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secrets the platform keeps at rest (D-203, BK-U1): AES-256-GCM under a key
 * derived from ORCHESTRATOR_SECRET, as `v1.<iv>.<tag>.<ciphertext>` in
 * base64url parts. One implementation for the orchestrator's stored gateway
 * keys and the owners' own data keys, so the control API seals what the
 * orchestrator's tool servers open.
 */
const VERSION = "v1";

function keyFrom(secret: string): Buffer {
  if (secret.length < 32) throw new Error("ORCHESTRATOR_SECRET must be 32+ characters");
  return createHash("sha256").update(`alpha-agents/orchestrator/${VERSION}\0${secret}`).digest();
}

export function sealSecret(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function openSecret(sealed: string, secret: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined)
    throw new Error("not a platform ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
