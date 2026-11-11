import { entryIconSchema } from "@/lib/model/schemas";
import type { EntryIcon } from "@/lib/model/types";

/**
 * The one item face an author picks for a design. Client-supplied but
 * harmless: it only ever renders as an icon. Anything that doesn't parse
 * becomes "no icon", never a rejection.
 */
export function parseEntryIcon(value: unknown): EntryIcon | null {
  const parsed = entryIconSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** True for a well-formed ISO timestamp the client is allowed to stamp. */
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** Ids are client-minted: a UUID, or the older `design-<base36>` form. */
export function isLibraryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}
