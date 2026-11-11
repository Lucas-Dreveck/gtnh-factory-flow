import { revokeSession, sessionCookie } from "@/lib/server/local/auth";
import { json, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    revokeSession(request);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(request, undefined) } });
  } catch (error) {
    return serverError("auth/logout", error, "Sign out failed.");
  }
}
