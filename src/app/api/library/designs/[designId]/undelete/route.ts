import { fail, json, serverError, sessionOr401 } from "@/lib/server/local/http";
import { undeleteDesign } from "@/lib/server/local/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Brings a deleted design back with a fresh stamp, so every device pulls it. */
export async function POST(request: Request, context: { params: Promise<{ designId: string }> }) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    const design = undeleteDesign(session.user.id, designId);
    if (!design) return fail(404, "Design not found.");
    return json({ design });
  } catch (error) {
    return serverError("library/undelete", error, "The design could not be restored.");
  }
}
