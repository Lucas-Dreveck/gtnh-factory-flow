import { clientAddress, registerWithInvite, sessionCookie } from "@/lib/server/local/auth";
import { fail, json, readJson, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const invite = typeof body?.invite === "string" ? body.invite.trim() : "";
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!invite) return fail(400, "An invite code is required.");

    const result = registerWithInvite(
      invite,
      username,
      password,
      clientAddress(request),
      request.headers.get("user-agent"),
    );
    if (!result.ok) return fail(result.status, result.error);
    return json(
      { username: result.user.username, isAdmin: result.user.isAdmin },
      { status: 201, headers: { "Set-Cookie": sessionCookie(request, result.token) } },
    );
  } catch (error) {
    return serverError("auth/register", error, "Sign up failed.");
  }
}
