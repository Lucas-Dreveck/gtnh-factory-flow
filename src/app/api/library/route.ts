import { json, serverError, sessionOr401 } from "@/lib/server/local/http";
import { listLibrary } from "@/lib/server/local/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The account's whole library, without plans: every design's metadata and
 * every folder, tombstones included. The browser reconciles against this
 * and fetches only the plans it is missing or that moved.
 */
export async function GET(request: Request) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  try {
    return json(listLibrary(session.user.id));
  } catch (error) {
    return serverError("library/list", error, "Your library could not be loaded.");
  }
}
