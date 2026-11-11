import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.GTNH_DATA_DIR = mkdtempSync(path.join(tmpdir(), "gtnh-store-"));

const auth = await import("./auth");
const store = await import("./library-store");

const plan = (cards: number, tag = "") => ({
  name: `p${tag}`,
  nodes: Array.from({ length: cards }, (_, i) => ({ id: `n${i}${tag}` })),
  edges: [],
  storages: [],
});
const body = (updatedAt: string, extra: Partial<Record<string, unknown>> = {}) => ({
  name: "Plan",
  icon: null,
  folderId: null,
  closed: false,
  favorite: false,
  order: null,
  communityPlanId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  planUpdatedAt: updatedAt,
  ...extra,
});

let userId = "";
beforeAll(() => {
  const lines: string[] = [];
  auth.ensureBootstrapInvite((l) => lines.push(l));
  const code = lines.join("\n").match(/code \(valid 7 days\):\s+(\S+)/)![1];
  const reg = auth.registerWithInvite(code, "admin", "correct horse battery", "a", null);
  if (!reg.ok) throw new Error(reg.error);
  expect(reg.user.isAdmin).toBe(true);
  userId = reg.user.id;
});

describe("auth", () => {
  it("invite is single use and bootstrap stops once a user exists", () => {
    const lines: string[] = [];
    auth.ensureBootstrapInvite((l) => lines.push(l));
    expect(lines).toHaveLength(0);
    const code = auth.createInvite(userId);
    expect(auth.registerWithInvite(code, "friend", "another long pass", "a", null).ok).toBe(true);
    expect(auth.registerWithInvite(code, "friend2", "another long pass", "a", null).ok).toBe(false);
  });
  it("login, session lookup, revoke, throttle", () => {
    const ok = auth.login("admin", "correct horse battery", "b", null);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(auth.getSessionUserByToken(ok.token)?.username).toBe("admin");
    auth.revokeAllSessions(ok.user.id);
    expect(auth.getSessionUserByToken(ok.token)).toBeUndefined();
    for (let i = 0; i < 8; i += 1) auth.login("friend", "wrong", "c", null);
    const blocked = auth.login("friend", "another long pass", "c", null);
    expect(blocked.ok).toBe(false);
  });
});

describe("library revisions", () => {
  it("never loses a plan: autosave, dedupe, behind -> conflict, guard, restore, fork, delete", () => {
    const r1 = store.upsertDesign(userId, "design-aaaa1", body("2026-01-01T00:00:01.000Z"), plan(10));
    expect(r1.ok).toBe(true);
    // same plan again: no new revision
    store.upsertDesign(userId, "design-aaaa1", body("2026-01-01T00:00:02.000Z"), plan(10));
    expect(store.listRevisions(userId, "design-aaaa1")!.length).toBe(1);
    // big drop: previous head becomes a guard
    const r3 = store.upsertDesign(userId, "design-aaaa1", body("2026-01-01T00:00:03.000Z"), plan(2));
    expect(r3.ok && r3.guardRevisionId).toBeTruthy();
    // stale client: kept as conflict, head unchanged
    const r4 = store.upsertDesign(userId, "design-aaaa1", body("2026-01-01T00:00:00.500Z"), plan(7, "x"));
    expect(r4.ok && r4.behind).toBe(true);
    const revs = store.listRevisions(userId, "design-aaaa1")!;
    expect(revs.map((r) => r.kind)).toEqual(["conflict", "autosave", "guard"]);
    expect(store.getDesignWithPlan(userId, "design-aaaa1")!.plan).toEqual(plan(2));
    // checkpoint + restore
    const guard = revs.find((r) => r.kind === "guard")!;
    const restored = store.restoreRevision(userId, "design-aaaa1", guard.id)!;
    expect(restored.revision.kind).toBe("restore");
    expect(store.getDesignWithPlan(userId, "design-aaaa1")!.plan).toEqual(plan(10));
    const cp = store.createCheckpoint(userId, "design-aaaa1", { label: "Before oil line" })!;
    expect(cp.kind).toBe("checkpoint");
    // fork
    const fork = store.forkRevision(userId, "design-aaaa1", cp.id, "Try LCR route")!;
    expect(store.getDesignWithPlan(userId, fork.id)!.plan).toMatchObject({ name: "Try LCR route" });
    // delete keeps history
    store.deleteDesign(userId, "design-aaaa1");
    expect(store.listRevisions(userId, "design-aaaa1")!.length).toBeGreaterThan(3);
    expect(store.undeleteDesign(userId, "design-aaaa1")!.deletedAt).toBeNull();
  });
  it("other users cannot read or write my design", () => {
    const other = auth.listUsers().find((u) => u.username === "friend")!;
    expect(store.getDesignWithPlan(other.id, "design-aaaa1")).toBeUndefined();
    expect(store.listRevisions(other.id, "design-aaaa1")).toBeUndefined();
    expect(store.restoreRevision(other.id, "design-aaaa1", 1)).toBeUndefined();
  });
});
