import { forwardToApi } from "@/api/proxy";

// The hosted site's same-origin API path (src/api/proxy.ts): per request, never cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request): Promise<Response> {
  return (
    (await forwardToApi(req, process.env)) ??
    Response.json({ error: "not_found", message: "No such route." }, { status: 404 })
  );
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
