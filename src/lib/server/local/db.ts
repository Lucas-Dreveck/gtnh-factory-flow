import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The self-hosted store: one SQLite file under GTNH_DATA_DIR (default ./var).
 * Accounts, sessions, the library and every revision of every plan live here.
 *
 * Durability rules (the reason this file exists):
 * - WAL + synchronous=FULL: a save that returned 200 survives a power cut.
 * - Plan revisions are append-only. Nothing in this codebase UPDATEs or
 *   DELETEs a row of `plan_revisions` except the explicit, opt-in pruning in
 *   library-store.ts, which never touches checkpoints.
 * - Schema changes go through numbered migrations, each in a transaction.
 */

const MIGRATIONS: string[] = [
  // 1: accounts, sessions, invites, library, revisions
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    password_changed_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE invites (
    code_hash TEXT PRIMARY KEY,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    used_at INTEGER,
    make_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE auth_attempts (
    key TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX auth_attempts_key ON auth_attempts(key, at);

  CREATE TABLE library_folders (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE library_designs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    folder_id TEXT,
    closed INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    community_plan_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    plan_updated_at TEXT NOT NULL,
    deleted_at TEXT,
    head_revision_id INTEGER,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE plan_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    design_id TEXT NOT NULL,
    parent_id INTEGER REFERENCES plan_revisions(id),
    created_at TEXT NOT NULL,
    client_updated_at TEXT,
    kind TEXT NOT NULL,
    label TEXT,
    note TEXT,
    sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    edge_count INTEGER NOT NULL,
    storage_count INTEGER NOT NULL,
    plan_gz BLOB NOT NULL
  );
  CREATE INDEX plan_revisions_design ON plan_revisions(user_id, design_id, id);
  CREATE INDEX plan_revisions_checkpoints ON plan_revisions(user_id, design_id, kind);
  `,
];

let instance: DatabaseSync | undefined;

export function dataDir(): string {
  return path.resolve(process.env.GTNH_DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "var"));
}

export function getDb(): DatabaseSync {
  if (instance) {
    return instance;
  }
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "planner.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  instance = db;
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[index]);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(index + 1);
    });
  }
}

/** Runs `work` in one IMMEDIATE transaction (writers queue, never interleave). */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** A consistent copy of the whole store, safe while the app runs. */
export function backupTo(file: string): void {
  getDb().prepare("VACUUM INTO ?").run(file);
}
