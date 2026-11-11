import { NextResponse } from "next/server";
import { getSessionUser, type LocalUser } from "./auth";

/** Every local route answers uncached: sessions and plans are per user. */
export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return NextResponse.json(body, {
    status: init.status,
    headers: { "Cache-Control": "no-store", ...init.headers },
  });
}

export function fail(status: number, error: string) {
  return json({ error }, { status });
}

/** Server-side detail stays in the log; the client gets a fixed sentence. */
export function serverError(scope: string, error: unknown, message = "Something went wrong.") {
  console.error(`[${scope}]`, error);
  return fail(500, message);
}

export function sessionOr401(request: Request): { user: LocalUser } | { response: Response } {
  const user = getSessionUser(request);
  if (!user) return { response: fail(401, "Sign in to sync your library.") };
  return { user };
}

export async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A revision id from a path or body: a positive safe integer, or undefined. */
export function parseRevisionId(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
