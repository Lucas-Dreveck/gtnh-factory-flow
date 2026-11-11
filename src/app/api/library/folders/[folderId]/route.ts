import { LIBRARY_FOLDER_NAME_MAX_LENGTH, type FolderUpsertBody } from "@/lib/library/sync-types";
import { fail, json, readJson, serverError, sessionOr401 } from "@/lib/server/local/http";
import { deleteFolder, upsertFolder } from "@/lib/server/local/library-store";
import { isIsoTimestamp, isLibraryId } from "@/lib/server/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ folderId: string }> };

/** Upsert, client timestamps, newer row wins: see the designs route. */
export async function PUT(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { folderId } = await context.params;
    if (!isLibraryId(folderId)) return fail(400, "Bad folder id.");
    const body = (await readJson(request)) as Partial<FolderUpsertBody> | undefined;
    if (!body) return fail(400, "Invalid request body.");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > LIBRARY_FOLDER_NAME_MAX_LENGTH) {
      return fail(400, "Folder names run 1 to 60 characters.");
    }
    if (!isIsoTimestamp(body.createdAt) || !isIsoTimestamp(body.updatedAt)) {
      return fail(400, "Bad timestamps.");
    }
    const result = upsertFolder(session.user.id, folderId, {
      name,
      createdAt: body.createdAt,
      updatedAt: body.updatedAt,
    });
    if (!result.ok) return fail(result.status, result.error);
    return json({ folder: result.folder, behind: result.behind });
  } catch (error) {
    return serverError("library/folder-put", error, "The folder could not be saved.");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    const { folderId } = await context.params;
    return json({ ok: true, deletedAt: deleteFolder(session.user.id, folderId) });
  } catch (error) {
    return serverError("library/folder-delete", error, "The folder could not be deleted.");
  }
}
