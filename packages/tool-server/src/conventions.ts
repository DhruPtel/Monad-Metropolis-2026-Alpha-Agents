import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Shared conventions of the tool servers (FINAL_PLAN 4.4.1, D-213).
 *
 * Identity comes from the connection, never from a parameter: the bearer token
 * is the lease's gate token that E2B injects at egress, and a server resolves
 * its hash to the agent the lease belongs to. Handlers receive that identity
 * and nothing in a tool's input can name another agent.
 */
export interface AgentIdentity {
  readonly chainId: number;
  readonly agentId: number;
  /** The agent's tier name (base, medium, pro). */
  readonly tier: string;
  /** The active lease the token belongs to: every call is recorded against it. */
  readonly leaseId: string;
}

/** Resolves a token's SHA-256 hash (hex) to an active lease's identity, or null. */
export type IdentityResolver = (tokenHash: string) => Promise<AgentIdentity | null>;

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** The error codes of FINAL_PLAN 4.4.1. */
export const TOOL_ERROR_CODES = [
  "UNAUTHENTICATED",
  "TIER_NOT_ALLOWED",
  "RATE_LIMITED",
  "INVALID_INPUT",
  "ASSET_NOT_ALLOWED",
  "ACCOUNT_NOT_AVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "STALE_DATA",
  "INTENT_NOT_FOUND",
  "INTENT_NOT_CANCELLABLE",
  "DUPLICATE_REQUEST",
  "INTERNAL",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export const ToolErrorBody = z.strictObject({
  code: z.enum(TOOL_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ToolErrorBody = z.infer<typeof ToolErrorBody>;

/** Thrown by a handler to answer with a typed error; anything else becomes INTERNAL. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/** A success: the structured content, and the same JSON as text (4.4.1). */
export function okResult(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** An error result in the 4.4.1 shape, as text and structured content. */
export function errorResult(body: ToolErrorBody): CallToolResult {
  const parsed = ToolErrorBody.parse(body);
  return {
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    structuredContent: parsed,
    isError: true,
  };
}

/** Turns anything a handler threw into an error result; internal messages are not shown. */
export function errorFrom(err: unknown): CallToolResult {
  if (err instanceof ToolError)
    return errorResult({
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      ...(err.details ? { details: err.details } : {}),
    });
  return errorResult({
    code: "INTERNAL",
    message: "The tool failed on the server.",
    retryable: true,
  });
}

/**
 * Input fields that would let a call choose whose accounts it acts on
 * (4.4.1's lint rule). `target` is the allowed name for a lookup address.
 */
export const FORBIDDEN_INPUT_FIELDS = ["address", "agentId", "owner", "wallet"] as const;

/** Every field name in a zod schema, at any depth (objects, arrays, optionals, unions). */
export function fieldNames(schema: z.ZodType): string[] {
  const names: string[] = [];
  const walk = (s: z.ZodType): void => {
    const def = (s as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
    switch (def.type) {
      case "object": {
        const shape = def.shape as Record<string, z.ZodType>;
        for (const [key, value] of Object.entries(shape)) {
          names.push(key);
          walk(value);
        }
        return;
      }
      case "array":
        return walk(def.element as z.ZodType);
      case "optional":
      case "nullable":
      case "default":
      case "readonly":
      case "nonoptional":
        return walk(def.innerType as z.ZodType);
      case "union":
        for (const option of def.options as z.ZodType[]) walk(option);
        return;
      case "pipe":
        walk(def.in as z.ZodType);
        return walk(def.out as z.ZodType);
      default:
        return;
    }
  };
  walk(schema);
  return names;
}

/** The forbidden identity fields a tool's input schema contains (empty when it is clean). */
export function identityFields(schema: z.ZodType): string[] {
  const forbidden = new Set<string>(FORBIDDEN_INPUT_FIELDS);
  return fieldNames(schema).filter((n) => forbidden.has(n));
}
