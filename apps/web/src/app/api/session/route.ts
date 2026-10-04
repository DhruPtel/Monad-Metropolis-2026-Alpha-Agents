import { configuredPrivyVerifier } from "@/server/privy";
import { sessionResponse } from "@/server/session";

// Verifies the caller's Privy access token (Authorization: Bearer <token>).
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return sessionResponse(request, configuredPrivyVerifier());
}
