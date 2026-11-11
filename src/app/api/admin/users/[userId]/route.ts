import { getSessionUser, listUsers, setUserDisabled } from "@/lib/server/local/auth";
import { fail, json, readJson, serverError } from "@/lib/server/local/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const user = getSessionUser(request);
    if (!user?.isAdmin) return fail(404, "Not found.");
    const { userId } = await context.params;
    const body = await readJson(request);
    if (typeof body?.disabled !== "boolean") return fail(400, "disabled must be true or false.");
    if (userId === user.id && body.disabled) return fail(400, "You cannot disable yourself.");
    if (!listUsers().some((candidate) => candidate.id === userId)) return fail(404, "Not found.");
    setUserDisabled(userId, body.disabled);
    return json({ ok: true });
  } catch (error) {
    return serverError("admin/users/disable", error);
  }
}
