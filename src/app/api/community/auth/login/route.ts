import { clientAddress, login, sessionCookie } from "@/lib/server/local/auth";
import { fail, json, readJson, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) return fail(400, "Username and password required.");

    const result = login(
      username,
      password,
      clientAddress(request),
      request.headers.get("user-agent"),
    );
    if (!result.ok) return fail(result.status, result.error);
    return json(
      { username: result.user.username, isAdmin: result.user.isAdmin },
      { headers: { "Set-Cookie": sessionCookie(request, result.token) } },
    );
  } catch (error) {
    return serverError("auth/login", error, "Sign in failed.");
  }
}
