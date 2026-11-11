import { getSessionUser } from "@/lib/server/local/auth";
import { json, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = getSessionUser(request);
    return json({ user: user ? { username: user.username, isAdmin: user.isAdmin } : null });
  } catch (error) {
    return serverError("auth/me", error);
  }
}
