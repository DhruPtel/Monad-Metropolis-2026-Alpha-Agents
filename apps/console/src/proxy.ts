import { isLocalHostHeader } from "@alpha-agents/devenv";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Answers only requests addressed to this machine (127.0.0.1 or localhost).
 * The server binds to 127.0.0.1; this also stops a web page from reaching the
 * console through DNS rebinding.
 */
export function proxy(request: NextRequest) {
  if (!isLocalHostHeader(request.headers.get("host"))) {
    return new NextResponse("The dev console only answers on 127.0.0.1.", { status: 403 });
  }
  return NextResponse.next();
}
