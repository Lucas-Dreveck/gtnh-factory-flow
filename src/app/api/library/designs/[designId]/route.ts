import { factoryProjectSchema } from "@/lib/model/schemas";
import { LIBRARY_DESIGN_NAME_MAX_LENGTH, type DesignUpsertBody } from "@/lib/library/sync-types";
import { fail, json, serverError, sessionOr401 } from "@/lib/server/local/http";
import {
  PLAN_MAX_BYTES,
  deleteDesign,
  getDesignWithPlan,
  upsertDesign,
} from "@/lib/server/local/library-store";
import { isIsoTimestamp, isLibraryId, parseEntryIcon } from "@/lib/server/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ designId: string }> };

/** The plan itself, fetched when a pull finds it missing or moved. */
export async function GET(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    const found = getDesignWithPlan(session.user.id, designId);
    if (!found) return fail(404, "Design not found.");
    return json(found);
  } catch (error) {
    return serverError("library/design-get", error, "The design could not be loaded.");
  }
}

/**
 * Upsert. The client owns the timestamps: `updatedAt` moves on any change,
 * `planUpdatedAt` only when the plan did, and the plan rides only then. A
 * row already NEWER than the incoming one (another device wrote since) keeps
 * its head and is reported back; the older plan is kept as a conflict revision.
 */
export async function PUT(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    if (!isLibraryId(designId)) return fail(400, "Bad design id.");

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return fail(400, "Invalid request body.");
    }
    if (raw.length > PLAN_MAX_BYTES) return fail(413, "This design is too large to sync.");
    let body: Partial<DesignUpsertBody>;
    try {
      body = JSON.parse(raw) as Partial<DesignUpsertBody>;
    } catch {
      return fail(400, "Invalid request body.");
    }
    if (!body || typeof body !== "object") return fail(400, "Invalid request body.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > LIBRARY_DESIGN_NAME_MAX_LENGTH) {
      return fail(400, "Design names run 1 to 80 characters.");
    }
    if (
      !isIsoTimestamp(body.createdAt) ||
      !isIsoTimestamp(body.updatedAt) ||
      !isIsoTimestamp(body.planUpdatedAt)
    ) {
      return fail(400, "Bad timestamps.");
    }
    if (body.folderId !== null && body.folderId !== undefined && !isLibraryId(body.folderId)) {
      return fail(400, "Bad folder id.");
    }

    let plan: unknown;
    if (body.plan !== undefined) {
      const parsed = factoryProjectSchema.safeParse(body.plan);
      if (!parsed.success) return fail(400, "The plan is not valid.");
      plan = parsed.data;
    }

    const result = upsertDesign(
      session.user.id,
      designId,
      {
        ...(body as DesignUpsertBody),
        name,
        icon: parseEntryIcon(body.icon),
      },
      plan,
    );
    if (!result.ok) return fail(result.status, result.error);
    return json({ design: result.design, behind: result.behind });
  } catch (error) {
    return serverError("library/design-put", error, "The design could not be saved.");
  }
}

/** A tombstone, never a hole: other devices need to hear about it. */
export async function DELETE(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { designId } = await context.params;
    return json({ ok: true, deletedAt: deleteDesign(session.user.id, designId) });
  } catch (error) {
    return serverError("library/design-delete", error, "The design could not be deleted.");
  }
}
