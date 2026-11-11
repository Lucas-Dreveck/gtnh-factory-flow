import { fail, json, parseRevisionId, serverError, sessionOr401 } from "@/lib/server/local/http";
import { listRevisions } from "@/lib/server/local/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    const params = new URL(request.url).searchParams;
    const limitParam = params.get("limit");
    const beforeParam = params.get("before");
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return fail(400, "Bad limit.");
    }
    const beforeId = beforeParam === null ? undefined : parseRevisionId(beforeParam);
    if (beforeParam !== null && beforeId === undefined) return fail(400, "Bad revision id.");
    const revisions = listRevisions(session.user.id, designId, {
      limit,
      beforeId,
      checkpointsOnly: params.get("checkpoints") === "1",
    });
    if (!revisions) return fail(404, "Design not found.");
    return json({ revisions });
  } catch (error) {
    return serverError("library/revisions", error, "History could not be loaded.");
  }
}
