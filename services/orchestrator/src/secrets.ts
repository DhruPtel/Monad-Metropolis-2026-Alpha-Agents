import { createHash, randomBytes } from "node:crypto";
import { openSecret, sealSecret } from "@alpha-agents/trading";

/**
 * Secrets the orchestrator handles: agents' LiteLLM virtual keys (encrypted at
 * rest, D-203), gate tokens (only their hash is stored) and the keeper's key.
 * Every value it creates or reads is registered with a Redactor, and every log
 * line passes through it, so no secret can reach a log (unit acceptance).
 */
/** The platform's envelope (packages/trading sealed.ts): the control API seals owners' keys the tool servers open (BK-U1). */
export const encryptSecret = sealSecret;
export const decryptSecret = openSecret;

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
