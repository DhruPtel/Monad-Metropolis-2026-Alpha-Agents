import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secrets the orchestrator handles: agents' LiteLLM virtual keys (encrypted at
 * rest, D-203), gate tokens (only their hash is stored) and the keeper's key.
 * Every value it creates or reads is registered with a Redactor, and every log
 * line passes through it, so no secret can reach a log (unit acceptance).
 */
const VERSION = "v1";

function keyFrom(secret: string): Buffer {
  if (secret.length < 32) throw new Error("ORCHESTRATOR_SECRET must be 32+ characters");
  return createHash("sha256").update(`alpha-agents/orchestrator/${VERSION}\0${secret}`).digest();
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function encryptSecret(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptSecret(sealed: string, secret: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined)
    throw new Error("not an orchestrator ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** 32 random bytes as hex: gate tokens and per-sandbox API server keys. */
export const randomToken = (): string => randomBytes(32).toString("hex");

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Replaces every registered secret, and anything shaped like a LiteLLM key, in text. */
export class Redactor {
  private readonly values = new Set<string>();

  add(...secrets: (string | null | undefined)[]): void {
    for (const s of secrets) if (s && s.length >= 8) this.values.add(s);
  }

  redact(text: string): string {
    let out = text;
    for (const s of [...this.values].sort((a, b) => b.length - a.length))
      out = out.split(s).join("<redacted>");
    // LiteLLM keys and its masked forms ("sk-...abcd") never belong in a log.
    return out.replace(/sk-[A-Za-z0-9_.-]{4,}/g, "sk-<redacted>");
  }
}

export type Log = (line: string) => void;

export function createLog(name: string, redactor: Redactor, sink: Log = console.log): Log {
  return (line) => sink(`${new Date().toISOString()} ${name}: ${redactor.redact(line)}`);
}

/** An error's message without its cause chain, redacted; never a stack. */
export function errorText(err: unknown, redactor: Redactor): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactor.redact(message).slice(0, 500);
}
