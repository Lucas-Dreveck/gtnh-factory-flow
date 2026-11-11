import { factoryProjectSchema } from "@/lib/model/schemas";
import {
  fail,
  json,
  parseRevisionId,
  serverError,
  sessionOr401,
} from "@/lib/server/local/http";
import { PLAN_MAX_BYTES, createCheckpoint } from "@/lib/server/local/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string }> };

/**
 * Names a revision. With `plan`, the browser's current plan is stored first so
 * the checkpoint is exactly what is on screen; with `revisionId`, that
 * revision is named; with neither, the head is.
 */
export async function POST(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return fail(400, "Invalid request body.");
    }
    if (raw.length > PLAN_MAX_BYTES) return fail(413, "This design is too large to save.");
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      body = parsed as Record<string, unknown>;
    } catch {
      return fail(400, "Invalid request body.");
    }

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) return fail(400, "A checkpoint needs a label.");
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      return fail(400, "Bad note.");
    }
    let revisionId: number | undefined;
    if (body.revisionId !== undefined && body.revisionId !== null) {
      revisionId = parseRevisionId(body.revisionId);
      if (revisionId === undefined) return fail(400, "Bad revision id.");
    }
    let plan: unknown;
    if (body.plan !== undefined) {
      const parsed = factoryProjectSchema.safeParse(body.plan);
      if (!parsed.success) return fail(400, "The plan is not valid.");
      plan = parsed.data;
    }

    const revision = createCheckpoint(session.user.id, designId, {
      label,
      note: typeof body.note === "string" ? body.note : undefined,
      revisionId,
      plan,
    });
    if (!revision) return fail(404, "Design or revision not found.");
    return json({ revision }, { status: 201 });
  } catch (error) {
    return serverError("library/checkpoint", error, "The checkpoint could not be saved.");
  }
}
