import { createInvite, getSessionUser } from "@/lib/server/local/auth";
import { fail, json, readJson, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = getSessionUser(request);
    if (!user?.isAdmin) return fail(404, "Not found.");
    const body = await readJson(request);
    return json({ code: createInvite(user.id, body?.makeAdmin === true) }, { status: 201 });
  } catch (error) {
    return serverError("admin/invites", error);
  }
}
