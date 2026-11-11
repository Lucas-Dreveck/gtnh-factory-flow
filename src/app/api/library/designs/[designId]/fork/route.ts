import {
  fail,
  json,
  parseRevisionId,
  readJson,
  serverError,
  sessionOr401,
} from "@/lib/server/local/http";
import { forkRevision } from "@/lib/server/local/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A branch: a new design starting from a revision. The original is untouched. */
export async function POST(request: Request, context: { params: Promise<{ designId: string }> }) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    const body = await readJson(request);
    const revisionId = parseRevisionId(body?.revisionId);
    if (revisionId === undefined) return fail(400, "Bad revision id.");
    const name = typeof body?.name === "string" ? body.name : "";
    const design = forkRevision(session.user.id, designId, revisionId, name);
    if (!design) return fail(404, "Design or revision not found, or the library is full.");
    return json({ design }, { status: 201 });
  } catch (error) {
    return serverError("library/fork", error, "The branch could not be created.");
  }
}
