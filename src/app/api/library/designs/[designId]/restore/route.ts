import {
  fail,
  json,
  parseRevisionId,
  readJson,
  serverError,
  sessionOr401,
} from "@/lib/server/local/http";
import { restoreRevision } from "@/lib/server/local/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Writes an old revision as the new head; history is never rewritten. */
export async function POST(request: Request, context: { params: Promise<{ designId: string }> }) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    const body = await readJson(request);
    const revisionId = parseRevisionId(body?.revisionId);
    if (revisionId === undefined) return fail(400, "Bad revision id.");
    const result = restoreRevision(session.user.id, designId, revisionId);
    if (!result) return fail(404, "Design or revision not found.");
    return json(result);
  } catch (error) {
    return serverError("library/restore", error, "The revision could not be restored.");
  }
}
