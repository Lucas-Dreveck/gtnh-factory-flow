import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { backupTo, dataDir } from "./db";

/**
 * Consistent snapshots of the store (VACUUM INTO), safe while the app runs.
 * Copying planner.sqlite by hand (or a panel's file backup) while the server
 * runs can catch it mid-write with its WAL; these copies cannot.
 *
 * GTNH_BACKUP_HOURS (default 24, 0 = off) and GTNH_BACKUP_KEEP (default 14).
 * Files land in <data dir>/backups/planner-YYYYMMDD-HHMMSS.sqlite.
 */

export function backupDir(): string {
  return path.join(dataDir(), "backups");
}

export function runBackup(): string {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `planner-${stamp}.sqlite`);
  backupTo(file);
  prune(dir, Number(process.env.GTNH_BACKUP_KEEP ?? 14));
  return file;
}

function prune(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((name) => /^planner-\d{8}-\d{6}\.sqlite$/.test(name))
    .map((name) => ({ name, at: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const file of files.slice(Math.max(keep, 1))) {
    rmSync(path.join(dir, file.name));
  }
}

let started = false;

export function startBackupSchedule(log: (line: string) => void = console.log): void {
  if (started) return;
  started = true;
  const hours = Number(process.env.GTNH_BACKUP_HOURS ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) return;
  const tick = () => {
    try {
      log(`[backup] wrote ${runBackup()}`);
    } catch (error) {
      log(`[backup] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // First copy a minute after boot, so a crash loop still leaves one behind.
  setTimeout(tick, 60_000).unref();
  setInterval(tick, hours * 3600_000).unref();
}
