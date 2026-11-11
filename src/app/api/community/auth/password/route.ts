import { changePassword, getSessionUser, sessionCookie } from "@/lib/server/local/auth";
import { fail, json, readJson, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Changing the password signs every session out, this one included. */
export async function POST(request: Request) {
  try {
    const user = getSessionUser(request);
    if (!user) return fail(401, "Sign in first.");
    const body = await readJson(request);
    const current = typeof body?.current === "string" ? body.current : "";
    const next = typeof body?.next === "string" ? body.next : "";
    if (!current || !next) return fail(400, "Current and new password required.");
    const problem = changePassword(user.id, current, next);
    if (problem) return fail(400, problem);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(request, undefined) } });
  } catch (error) {
    return serverError("auth/password", error, "Password change failed.");
  }
}
