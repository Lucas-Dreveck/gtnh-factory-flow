import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { EntryIcon } from "@/lib/model/types";
import type {
  DesignUpsertBody,
  FolderUpsertBody,
  LibraryListResponse,
  RemoteDesignMeta,
  RemoteFolder,
} from "@/lib/library/sync-types";
import { LIBRARY_MAX_DESIGNS, LIBRARY_MAX_FOLDERS } from "@/lib/library/sync-types";
import { getDb, transaction } from "./db";

/**
 * The account's library with full history.
 *
 * Every plan the browser pushes becomes an immutable revision (gzip JSON +
 * SHA-256). The design row only points at its head. Consequences:
 * - Nothing a client sends can destroy an earlier plan: a stale or broken
 *   client writes a new revision, never over an old one.
 * - A push that arrives "behind" (another tab or device wrote later) is still
 *   kept, as a `conflict` revision off the head, so neither side's work is lost.
 * - Delete is a tombstone; the revisions stay and the design can be restored.
 * - A save that drops many cards at once marks the previous head as an
 *   automatic checkpoint ("guard"), so it is easy to find and restore.
 * - Checkpoints are named revisions; restore writes a NEW head equal to an old
 *   revision (history is never rewritten); fork copies a revision into a new
 *   design, a branch to try another route without touching the first.
 *
 * Kinds: autosave | checkpoint | guard | restore | conflict | fork | import
 */

export type RevisionKind =
  | "autosave"
  | "checkpoint"
  | "guard"
  | "restore"
  | "conflict"
  | "fork"
  | "import";

/** Kinds pruning never removes. */
const KEPT_KINDS = new Set<RevisionKind>(["checkpoint", "guard", "restore", "conflict", "fork", "import"]);

export const PLAN_MAX_BYTES = Number(process.env.GTNH_PLAN_MAX_BYTES ?? 32 * 1024 * 1024);
/** A save that loses at least this share of cards (and at least GUARD_MIN_CARDS) checkpoints the head first. */
const GUARD_DROP_SHARE = 0.25;
const GUARD_MIN_CARDS = 3;
const LABEL_MAX = 80;
const NOTE_MAX = 2000;

interface DesignRow {
  id: string;
  name: string;
  icon: string | null;
  folder_id: string | null;
  closed: number;
  favorite: number;
  sort_order: number | null;
  community_plan_id: string | null;
  created_at: string;
  updated_at: string;
  plan_updated_at: string;
  deleted_at: string | null;
  head_revision_id: number | null;
}

interface FolderRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface RevisionRow {
  id: number;
  design_id: string;
  parent_id: number | null;
  created_at: string;
  client_updated_at: string | null;
  kind: RevisionKind;
  label: string | null;
  note: string | null;
  sha256: string;
  byte_size: number;
  node_count: number;
  edge_count: number;
  storage_count: number;
}

export interface RevisionMeta {
  id: number;
  designId: string;
  parentId: number | null;
  createdAt: string;
  clientUpdatedAt: string | null;
  kind: RevisionKind;
  label: string | null;
  note: string | null;
  sha256: string;
  byteSize: number;
  nodeCount: number;
  edgeCount: number;
  storageCount: number;
  isHead: boolean;
}

const REVISION_META_COLUMNS =
  "id, design_id, parent_id, created_at, client_updated_at, kind, label, note, sha256, byte_size, node_count, edge_count, storage_count";

function parseIcon(text: string | null): EntryIcon | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as EntryIcon;
  } catch {
    return null;
  }
}

function toDesignMeta(row: DesignRow): RemoteDesignMeta {
  return {
    id: row.id,
    name: row.name,
    icon: parseIcon(row.icon),
    folderId: row.folder_id,
    closed: row.closed === 1,
    favorite: row.favorite === 1,
    order: row.sort_order,
    communityPlanId: row.community_plan_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    planUpdatedAt: row.plan_updated_at,
    deletedAt: row.deleted_at,
  };
}

function toFolder(row: FolderRow): RemoteFolder {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function toRevisionMeta(row: RevisionRow, headId: number | null): RevisionMeta {
  return {
    id: row.id,
    designId: row.design_id,
    parentId: row.parent_id,
    createdAt: row.created_at,
    clientUpdatedAt: row.client_updated_at,
    kind: row.kind,
    label: row.label,
    note: row.note,
    sha256: row.sha256,
    byteSize: row.byte_size,
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    storageCount: row.storage_count,
    isHead: row.id === headId,
  };
}

function countOf(plan: unknown, key: string): number {
  const value = (plan as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function readDesignRow(userId: string, designId: string): DesignRow | undefined {
  return getDb()
    .prepare("SELECT * FROM library_designs WHERE user_id = ? AND id = ?")
    .get(userId, designId) as DesignRow | undefined;
}

function readRevisionRow(userId: string, designId: string, revisionId: number): RevisionRow | undefined {
  return getDb()
    .prepare(`SELECT ${REVISION_META_COLUMNS} FROM plan_revisions WHERE user_id = ? AND design_id = ? AND id = ?`)
    .get(userId, designId, revisionId) as RevisionRow | undefined;
}

function readRevisionPlan(userId: string, revisionId: number): unknown {
  const row = getDb()
    .prepare("SELECT plan_gz, sha256 FROM plan_revisions WHERE user_id = ? AND id = ?")
    .get(userId, revisionId) as { plan_gz: Uint8Array; sha256: string } | undefined;
  if (!row) return undefined;
  const json = gunzipSync(row.plan_gz).toString("utf8");
  if (createHash("sha256").update(json).digest("hex") !== row.sha256) {
    throw new Error(`Revision ${revisionId} failed its checksum.`);
  }
  return JSON.parse(json);
}

interface InsertRevision {
  userId: string;
  designId: string;
  parentId: number | null;
  kind: RevisionKind;
  plan: unknown;
  clientUpdatedAt?: string | null;
  label?: string | null;
  note?: string | null;
}

/** Inserts one revision; must run inside a transaction. Returns its id and sha. */
function insertRevision(input: InsertRevision): { id: number; sha256: string } {
  const json = JSON.stringify(input.plan);
  const sha256 = createHash("sha256").update(json).digest("hex");
  const result = getDb()
    .prepare(
      `INSERT INTO plan_revisions
        (user_id, design_id, parent_id, created_at, client_updated_at, kind, label, note, sha256, byte_size, node_count, edge_count, storage_count, plan_gz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.designId,
      input.parentId,
      new Date().toISOString(),
      input.clientUpdatedAt ?? null,
      input.kind,
      input.label?.slice(0, LABEL_MAX) ?? null,
      input.note?.slice(0, NOTE_MAX) ?? null,
      sha256,
      Buffer.byteLength(json),
      countOf(input.plan, "nodes"),
      countOf(input.plan, "edges"),
      countOf(input.plan, "storages"),
      gzipSync(json, { level: 6 }),
    );
  return { id: Number(result.lastInsertRowid), sha256 };
}

function headSha(userId: string, headId: number | null): string | undefined {
  if (headId === null) return undefined;
  const row = getDb()
    .prepare("SELECT sha256 FROM plan_revisions WHERE user_id = ? AND id = ?")
    .get(userId, headId) as { sha256: string } | undefined;
  return row?.sha256;
}

// --- library sync contract (same wire shapes as the original cloud library) --

export function listLibrary(userId: string): LibraryListResponse {
  const db = getDb();
  const designs = db
    .prepare("SELECT * FROM library_designs WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as unknown as DesignRow[];
  const folders = db
    .prepare("SELECT id, name, created_at, updated_at, deleted_at FROM library_folders WHERE user_id = ?")
    .all(userId) as unknown as FolderRow[];
  return { designs: designs.map(toDesignMeta), folders: folders.map(toFolder) };
}

export function getDesignWithPlan(
  userId: string,
  designId: string,
): { design: RemoteDesignMeta; plan: unknown } | undefined {
  const row = readDesignRow(userId, designId);
  if (!row || row.head_revision_id === null) return undefined;
  return { design: toDesignMeta(row), plan: readRevisionPlan(userId, row.head_revision_id) };
}

export type UpsertResult =
  | { ok: true; design: RemoteDesignMeta; behind: boolean; guardRevisionId?: number }
  | { ok: false; status: 400 | 409; error: string };

/**
 * The sync engine's PUT. `plan` is already schema-validated by the route.
 * Same "behind" rule as before (the newer row wins the head), but the losing
 * plan is kept as a conflict revision instead of being dropped.
 */
export function upsertDesign(
  userId: string,
  designId: string,
  body: DesignUpsertBody,
  plan: unknown | undefined,
): UpsertResult {
  const db = getDb();
  return transaction(db, (): UpsertResult => {
    const current = readDesignRow(userId, designId);

    if (current && Date.parse(current.updated_at) > Date.parse(body.updatedAt)) {
      if (plan !== undefined && headSha(userId, current.head_revision_id) !== sha(plan)) {
        insertRevision({
          userId,
          designId,
          parentId: current.head_revision_id,
          kind: "conflict",
          plan,
          clientUpdatedAt: body.planUpdatedAt,
          label: "Older copy from another tab or device",
        });
      }
      return { ok: true, design: toDesignMeta(current), behind: true };
    }

    if (plan === undefined && (!current || current.head_revision_id === null)) {
      return { ok: false, status: 400, error: "A new design needs its plan." };
    }
    if (!current) {
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM library_designs WHERE user_id = ? AND deleted_at IS NULL")
        .get(userId) as { n: number };
      if (count.n >= LIBRARY_MAX_DESIGNS) {
        return { ok: false, status: 409, error: `Your library is full (${LIBRARY_MAX_DESIGNS} designs).` };
      }
    }

    let headId = current?.head_revision_id ?? null;
    let guardRevisionId: number | undefined;
    if (plan !== undefined && headSha(userId, headId) !== sha(plan)) {
      if (headId !== null) {
        const head = readRevisionRow(userId, designId, headId);
        const before = head?.node_count ?? 0;
        const after = countOf(plan, "nodes");
        const lost = before - after;
        if (head && lost >= GUARD_MIN_CARDS && lost >= before * GUARD_DROP_SHARE && head.kind === "autosave") {
          db.prepare("UPDATE plan_revisions SET kind = 'guard', label = ? WHERE id = ?").run(
            `Before ${lost} cards were removed (${before} → ${after})`,
            head.id,
          );
          guardRevisionId = head.id;
        }
      }
      headId = insertRevision({
        userId,
        designId,
        parentId: headId,
        kind: "autosave",
        plan,
        clientUpdatedAt: body.planUpdatedAt,
      }).id;
    }

    const values = [
      body.name,
      body.icon ? JSON.stringify(body.icon) : null,
      body.folderId ?? null,
      body.closed ? 1 : 0,
      body.favorite ? 1 : 0,
      Number.isInteger(body.order) ? body.order : null,
      typeof body.communityPlanId === "string" ? body.communityPlanId.slice(0, 64) : null,
      body.updatedAt,
      body.planUpdatedAt,
      headId,
    ];
    if (current) {
      db.prepare(
        `UPDATE library_designs SET name = ?, icon = ?, folder_id = ?, closed = ?, favorite = ?, sort_order = ?,
           community_plan_id = ?, updated_at = ?, plan_updated_at = ?, head_revision_id = ?, deleted_at = NULL
         WHERE user_id = ? AND id = ?`,
      ).run(...values, userId, designId);
    } else {
      db.prepare(
        `INSERT INTO library_designs (name, icon, folder_id, closed, favorite, sort_order, community_plan_id,
           updated_at, plan_updated_at, head_revision_id, user_id, id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...values, userId, designId, body.createdAt);
    }
    pruneAutosaves(userId, designId, headId);
    const saved = readDesignRow(userId, designId)!;
    return { ok: true, design: toDesignMeta(saved), behind: false, guardRevisionId };
  });
}

function sha(plan: unknown): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

/** Tombstone only: the revisions stay, so a deleted plan can be restored. */
export function deleteDesign(userId: string, designId: string): string {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE library_designs SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?")
    .run(now, now, userId, designId);
  return now;
}

/** Brings a tombstoned design back with a fresh stamp, so every device pulls it. */
export function undeleteDesign(userId: string, designId: string): RemoteDesignMeta | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "UPDATE library_designs SET deleted_at = NULL, updated_at = ?, plan_updated_at = ? WHERE user_id = ? AND id = ?",
    )
    .run(now, now, userId, designId);
  const row = readDesignRow(userId, designId);
  return row ? toDesignMeta(row) : undefined;
}

export function upsertFolder(
  userId: string,
  folderId: string,
  body: FolderUpsertBody,
): { ok: true; folder: RemoteFolder; behind: boolean } | { ok: false; status: 409; error: string } {
  const db = getDb();
  return transaction(db, () => {
    const current = db
      .prepare("SELECT id, name, created_at, updated_at, deleted_at FROM library_folders WHERE user_id = ? AND id = ?")
      .get(userId, folderId) as FolderRow | undefined;
    if (current && Date.parse(current.updated_at) > Date.parse(body.updatedAt)) {
      return { ok: true as const, folder: toFolder(current), behind: true };
    }
    if (!current) {
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM library_folders WHERE user_id = ? AND deleted_at IS NULL")
        .get(userId) as { n: number };
      if (count.n >= LIBRARY_MAX_FOLDERS) {
        return { ok: false as const, status: 409 as const, error: "Too many folders." };
      }
      db.prepare(
        "INSERT INTO library_folders (user_id, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(userId, folderId, body.name, body.createdAt, body.updatedAt);
    } else {
      db.prepare(
        "UPDATE library_folders SET name = ?, updated_at = ?, deleted_at = NULL WHERE user_id = ? AND id = ?",
      ).run(body.name, body.updatedAt, userId, folderId);
    }
    const saved = db
      .prepare("SELECT id, name, created_at, updated_at, deleted_at FROM library_folders WHERE user_id = ? AND id = ?")
      .get(userId, folderId) as unknown as FolderRow;
    return { ok: true as const, folder: toFolder(saved), behind: false };
  });
}

export function deleteFolder(userId: string, folderId: string): string {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE library_folders SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?")
    .run(now, now, userId, folderId);
  return now;
}

// --- history: revisions, checkpoints, restore, fork --------------------------

export function listRevisions(
  userId: string,
  designId: string,
  options: { limit?: number; beforeId?: number; checkpointsOnly?: boolean } = {},
): RevisionMeta[] | undefined {
  const design = readDesignRow(userId, designId);
  if (!design) return undefined;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = getDb()
    .prepare(
      `SELECT ${REVISION_META_COLUMNS} FROM plan_revisions
        WHERE user_id = ? AND design_id = ? AND id < ? ${options.checkpointsOnly ? "AND kind <> 'autosave'" : ""}
        ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, designId, options.beforeId ?? Number.MAX_SAFE_INTEGER, limit) as unknown as RevisionRow[];
  return rows.map((row) => toRevisionMeta(row, design.head_revision_id));
}

export function getRevision(
  userId: string,
  designId: string,
  revisionId: number,
): { revision: RevisionMeta; plan: unknown } | undefined {
  const design = readDesignRow(userId, designId);
  const row = readRevisionRow(userId, designId, revisionId);
  if (!design || !row) return undefined;
  return { revision: toRevisionMeta(row, design.head_revision_id), plan: readRevisionPlan(userId, row.id) };
}

/**
 * Names a revision (the head when none is given). With a `plan`, the browser's
 * current plan is stored first, so a checkpoint is exactly what is on screen
 * even if the autosave has not reached the server yet.
 */
export function createCheckpoint(
  userId: string,
  designId: string,
  input: { label: string; note?: string; revisionId?: number; plan?: unknown },
): RevisionMeta | undefined {
  const db = getDb();
  return transaction(db, () => {
    const design = readDesignRow(userId, designId);
    if (!design) return undefined;
    const label = input.label.trim().slice(0, LABEL_MAX) || "Checkpoint";
    let revisionId = input.revisionId ?? design.head_revision_id;
    if (input.plan !== undefined && input.revisionId === undefined) {
      if (headSha(userId, design.head_revision_id) !== sha(input.plan)) {
        revisionId = insertRevision({
          userId,
          designId,
          parentId: design.head_revision_id,
          kind: "checkpoint",
          plan: input.plan,
          label,
          note: input.note,
        }).id;
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE library_designs SET head_revision_id = ?, updated_at = ?, plan_updated_at = ? WHERE user_id = ? AND id = ?",
        ).run(revisionId, now, now, userId, designId);
      }
    }
    if (revisionId === null || revisionId === undefined) return undefined;
    const row = readRevisionRow(userId, designId, revisionId);
    if (!row) return undefined;
    db.prepare("UPDATE plan_revisions SET kind = 'checkpoint', label = ?, note = ? WHERE id = ?").run(
      label,
      input.note?.slice(0, NOTE_MAX) ?? row.note,
      row.id,
    );
    const head = readDesignRow(userId, designId)!.head_revision_id;
    return toRevisionMeta(readRevisionRow(userId, designId, row.id)!, head);
  });
}

export function renameRevision(
  userId: string,
  designId: string,
  revisionId: number,
  label: string | null,
  note: string | null,
): boolean {
  const result = getDb()
    .prepare("UPDATE plan_revisions SET label = ?, note = ? WHERE user_id = ? AND design_id = ? AND id = ?")
    .run(label?.slice(0, LABEL_MAX) ?? null, note?.slice(0, NOTE_MAX) ?? null, userId, designId, revisionId);
  return Number(result.changes) > 0;
}

/**
 * Makes an old revision the plan again by writing it as a NEW head (kind
 * `restore`). The current head is checkpointed first if it is a bare
 * autosave, so the undo of a restore is one click away.
 */
export function restoreRevision(
  userId: string,
  designId: string,
  revisionId: number,
): { design: RemoteDesignMeta; revision: RevisionMeta } | undefined {
  const db = getDb();
  return transaction(db, () => {
    const design = readDesignRow(userId, designId);
    const target = readRevisionRow(userId, designId, revisionId);
    if (!design || !target) return undefined;
    if (design.head_revision_id !== null) {
      db.prepare(
        "UPDATE plan_revisions SET kind = 'guard', label = COALESCE(label, 'Before restoring an older version') WHERE id = ? AND kind = 'autosave'",
      ).run(design.head_revision_id);
    }
    const plan = readRevisionPlan(userId, target.id);
    const created = insertRevision({
      userId,
      designId,
      parentId: design.head_revision_id,
      kind: "restore",
      plan,
      label: `Restored #${target.id}${target.label ? ` (${target.label})` : ""}`,
    });
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE library_designs SET head_revision_id = ?, updated_at = ?, plan_updated_at = ?, deleted_at = NULL WHERE user_id = ? AND id = ?",
    ).run(created.id, now, now, userId, designId);
    return {
      design: toDesignMeta(readDesignRow(userId, designId)!),
      revision: toRevisionMeta(readRevisionRow(userId, designId, created.id)!, created.id),
    };
  });
}

/** A branch: a new design starting from a revision. The original is untouched. */
export function forkRevision(
  userId: string,
  designId: string,
  revisionId: number,
  name: string,
): RemoteDesignMeta | undefined {
  const db = getDb();
  return transaction(db, () => {
    const source = readDesignRow(userId, designId);
    const target = readRevisionRow(userId, designId, revisionId);
    if (!source || !target) return undefined;
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM library_designs WHERE user_id = ? AND deleted_at IS NULL")
      .get(userId) as { n: number };
    if (count.n >= LIBRARY_MAX_DESIGNS) return undefined;
    const newId = randomUUID();
    const plan = readRevisionPlan(userId, target.id) as Record<string, unknown>;
    const branchName = (name.trim() || `${source.name} (branch)`).slice(0, 80);
    const branchPlan = { ...plan, name: branchName };
    const created = insertRevision({
      userId,
      designId: newId,
      parentId: null,
      kind: "fork",
      plan: branchPlan,
      label: `Branched from "${source.name}" #${target.id}`,
    });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO library_designs (user_id, id, name, icon, folder_id, created_at, updated_at, plan_updated_at, head_revision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, newId, branchName, source.icon, source.folder_id, now, now, now, created.id);
    return toDesignMeta(readDesignRow(userId, newId)!);
  });
}

/**
 * Thins old autosaves, never anything else: all autosaves of the last 48 h
 * stay; older ones keep the last per hour up to 30 days, then the last per
 * day. Checkpoints, guards, restores, conflicts and the head are never
 * removed. Must run inside a transaction.
 */
function pruneAutosaves(userId: string, designId: string, headId: number | null): void {
  const db = getDb();
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM plan_revisions WHERE user_id = ? AND design_id = ? AND kind = 'autosave'")
    .get(userId, designId) as { n: number };
  if (count.n < 300) return;
  const now = Date.now();
  const rows = db
    .prepare(
      "SELECT id, created_at, kind FROM plan_revisions WHERE user_id = ? AND design_id = ? ORDER BY id DESC",
    )
    .all(userId, designId) as { id: number; created_at: string; kind: RevisionKind }[];
  const seenBuckets = new Set<string>();
  const remove: number[] = [];
  for (const row of rows) {
    if (KEPT_KINDS.has(row.kind) || row.id === headId) continue;
    const at = Date.parse(row.created_at);
    const age = now - at;
    if (age < 48 * 3600_000) continue;
    const bucket =
      age < 30 * 24 * 3600_000 ? `h:${Math.floor(at / 3600_000)}` : `d:${Math.floor(at / 86_400_000)}`;
    if (seenBuckets.has(bucket)) remove.push(row.id);
    else seenBuckets.add(bucket);
  }
  if (remove.length === 0) return;
  // Children of a removed revision re-point to its parent, so the chain stays whole.
  const reparent = db.prepare(
    "UPDATE plan_revisions SET parent_id = (SELECT parent_id FROM plan_revisions WHERE id = ?) WHERE parent_id = ?",
  );
  const drop = db.prepare("DELETE FROM plan_revisions WHERE id = ? AND kind = 'autosave'");
  for (const id of remove.sort((a, b) => a - b)) {
    reparent.run(id, id);
    drop.run(id);
  }
}
