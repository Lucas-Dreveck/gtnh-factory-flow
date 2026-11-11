import { getSessionUser, listUsers } from "@/lib/server/local/auth";
import { fail, json, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = getSessionUser(request);
    if (!user?.isAdmin) return fail(404, "Not found.");
    return json({ users: listUsers() });
  } catch (error) {
    return serverError("admin/users", error);
  }
}
