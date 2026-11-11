import {
  fail,
  json,
  parseRevisionId,
  readJson,
  serverError,
  sessionOr401,
} from "@/lib/server/local/http";
import { getRevision, renameRevision } from "@/lib/server/local/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string; revisionId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId, revisionId } = await context.params;
    const id = parseRevisionId(revisionId);
    if (id === undefined) return fail(404, "Revision not found.");
    const found = getRevision(session.user.id, designId, id);
    if (!found) return fail(404, "Revision not found.");
    return json(found);
  } catch (error) {
    return serverError("library/revision-get", error, "The revision could not be loaded.");
  }
}

/** Names or annotates a revision; null or an empty string clears a field. */
export async function PATCH(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId, revisionId } = await context.params;
    const id = parseRevisionId(revisionId);
    if (id === undefined) return fail(404, "Revision not found.");
    const body = await readJson(request);
    if (!body) return fail(400, "Invalid request body.");
    const text = (value: unknown): string | null | undefined =>
      value === null ? null : typeof value === "string" ? value.trim() || null : undefined;
    const label = text(body.label);
    const note = text(body.note);
    if (label === undefined || note === undefined) return fail(400, "label and note are required.");
    if (!renameRevision(session.user.id, designId, id, label, note)) {
      return fail(404, "Revision not found.");
    }
    const found = getRevision(session.user.id, designId, id);
    if (!found) return fail(404, "Revision not found.");
    return json({ revision: found.revision });
  } catch (error) {
    return serverError("library/revision-patch", error, "The revision could not be updated.");
  }
}
