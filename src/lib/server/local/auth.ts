import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb, transaction } from "./db";

/**
 * Accounts for the self-hosted planner. Closed by design:
 * - No open sign-up. A new account needs a one-time invite code made by an
 *   admin. On a store with no users, one admin invite is minted and printed
 *   to the server log (the Pelican console) - that is the only bootstrap.
 * - Session tokens are 256 random bits; only their SHA-256 is stored, so a
 *   leaked database file cannot be replayed as a login. Sessions are rows:
 *   logout, password change and disabling a user revoke them at once.
 * - Passwords: scrypt (N=2^15, r=8, p=1), per-user salt, constant-time check.
 * - Failed logins are throttled per username and per address.
 */

export const SESSION_COOKIE = "gtnh_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT_PER_USER = 8;
const FAIL_LIMIT_PER_ADDRESS = 30;

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

export interface LocalUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const candidate = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Burns the same time as a real check, so a missing user is not faster. */
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

export function validatePasswordRules(password: string): string | undefined {
  if (password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) {
    return "Password is too long.";
  }
  return undefined;
}

// --- request helpers --------------------------------------------------------

export function readSessionToken(request: Request): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/** Secure cookies need HTTPS; behind `tailscale serve` or a TLS proxy, set GTNH_COOKIE_SECURE=1. */
function isSecureRequest(request: Request): boolean {
  const flag = process.env.GTNH_COOKIE_SECURE;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return (
    request.headers.get("x-forwarded-proto") === "https" || new URL(request.url).protocol === "https:"
  );
}

export function sessionCookie(request: Request, token: string | undefined): string {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return `${SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** The peer address. Only trust X-Forwarded-For when told a proxy sits in front. */
export function clientAddress(request: Request): string {
  if (process.env.GTNH_TRUST_PROXY === "1") {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return request.headers.get("x-real-ip")?.slice(0, 64) ?? "local";
}

// --- sessions ---------------------------------------------------------------

export function createSession(userId: string, userAgent: string | null): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(sha256(token), userId, now, now + SESSION_TTL_MS, now, userAgent?.slice(0, 200) ?? null);
  return token;
}

export function getSessionUser(request: Request): LocalUser | undefined {
  const token = readSessionToken(request);
  return token ? getSessionUserByToken(token) : undefined;
}

export function getSessionUserByToken(token: string): LocalUser | undefined {
  const db = getDb();
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id, u.username, u.is_admin, u.disabled
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as
    | {
        token_hash: string;
        expires_at: number;
        last_seen_at: number;
        id: string;
        username: string;
        is_admin: number;
        disabled: number;
      }
    | undefined;
  if (!row) return undefined;
  if (row.disabled || row.expires_at < now || row.last_seen_at + SESSION_IDLE_MS < now) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    return undefined;
  }
  if (now - row.last_seen_at > SESSION_TOUCH_MS) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, row.token_hash);
  }
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}

export function revokeSession(request: Request): void {
  const token = readSessionToken(request);
  if (token) {
    getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }
}

export function revokeAllSessions(userId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// --- login throttling -------------------------------------------------------

function recentFailures(key: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND at > ?")
    .get(key, Date.now() - FAIL_WINDOW_MS) as { n: number };
  return row.n;
}

function recordFailure(keys: string[]): void {
  const db = getDb();
  const now = Date.now();
  const insert = db.prepare("INSERT INTO auth_attempts (key, at) VALUES (?, ?)");
  for (const key of keys) insert.run(key, now);
  db.prepare("DELETE FROM auth_attempts WHERE at < ?").run(now - FAIL_WINDOW_MS);
}

export type LoginResult =
  | { ok: true; user: LocalUser; token: string }
  | { ok: false; status: 401 | 429; error: string };

export function login(
  username: string,
  password: string,
  address: string,
  userAgent: string | null,
): LoginResult {
  const userKey = `user:${username.toLowerCase()}`;
  const addressKey = `addr:${address}`;
  if (recentFailures(userKey) >= FAIL_LIMIT_PER_USER || recentFailures(addressKey) >= FAIL_LIMIT_PER_ADDRESS) {
    return { ok: false, status: 429, error: "Too many failed attempts. Wait 15 minutes." };
  }
  const row = getDb()
    .prepare("SELECT id, username, password_hash, is_admin, disabled FROM users WHERE username = ?")
    .get(username) as
    | { id: string; username: string; password_hash: string; is_admin: number; disabled: number }
    | undefined;
  const valid = verifyPassword(password, row?.password_hash ?? DUMMY_HASH) && row && !row.disabled;
  if (!valid || !row) {
    recordFailure([userKey, addressKey]);
    return { ok: false, status: 401, error: "Wrong username or password." };
  }
  const user = { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
  return { ok: true, user, token: createSession(user.id, userAgent) };
}

// --- invites and registration -------------------------------------------------

export function createInvite(createdBy: string | null, makeAdmin = false): string {
  const code = randomBytes(15).toString("base64url");
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO invites (code_hash, created_by, created_at, expires_at, make_admin) VALUES (?, ?, ?, ?, ?)",
    )
    .run(sha256(code), createdBy, now, now + INVITE_TTL_MS, makeAdmin ? 1 : 0);
  return code;
}

export type RegisterResult =
  | { ok: true; user: LocalUser; token: string }
  | { ok: false; status: 400 | 403 | 409 | 429; error: string };

export function registerWithInvite(
  inviteCode: string,
  username: string,
  password: string,
  address: string,
  userAgent: string | null,
): RegisterResult {
  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, status: 400, error: "Username: 3-24 letters, numbers, - or _." };
  }
  const passwordProblem = validatePasswordRules(password);
  if (passwordProblem) {
    return { ok: false, status: 400, error: passwordProblem };
  }
  const addressKey = `addr:${address}`;
  if (recentFailures(addressKey) >= FAIL_LIMIT_PER_ADDRESS) {
    return { ok: false, status: 429, error: "Too many failed attempts. Wait 15 minutes." };
  }
  const db = getDb();
  const passwordHash = hashPassword(password);
  const result = transaction(db, (): RegisterResult => {
    const invite = db
      .prepare("SELECT code_hash, expires_at, used_by, make_admin FROM invites WHERE code_hash = ?")
      .get(sha256(inviteCode.trim())) as
      | { code_hash: string; expires_at: number; used_by: string | null; make_admin: number }
      | undefined;
    if (!invite || invite.used_by || invite.expires_at < Date.now()) {
      return { ok: false, status: 403, error: "This invite code is not valid." };
    }
    const taken = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
    if (taken) {
      return { ok: false, status: 409, error: "That username is taken." };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, username, passwordHash, invite.make_admin, now, now);
    db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?").run(
      id,
      Date.now(),
      invite.code_hash,
    );
    return {
      ok: true,
      user: { id, username, isAdmin: invite.make_admin === 1 },
      token: "",
    };
  });
  if (!result.ok) {
    if (result.status === 403) recordFailure([addressKey]);
    return result;
  }
  return { ...result, token: createSession(result.user.id, userAgent) };
}

export function changePassword(userId: string, current: string, next: string): string | undefined {
  const row = getDb().prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) {
    return "Current password is wrong.";
  }
  const problem = validatePasswordRules(next);
  if (problem) return problem;
  const db = getDb();
  transaction(db, () => {
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(
      hashPassword(next),
      new Date().toISOString(),
      userId,
    );
    revokeAllSessions(userId);
  });
  return undefined;
}

// --- admin ------------------------------------------------------------------

export function listUsers(): { id: string; username: string; isAdmin: boolean; disabled: boolean; createdAt: string }[] {
  return (
    getDb().prepare("SELECT id, username, is_admin, disabled, created_at FROM users ORDER BY created_at").all() as {
      id: string;
      username: string;
      is_admin: number;
      disabled: number;
      created_at: string;
    }[]
  ).map((row) => ({
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin === 1,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  }));
}

export function setUserDisabled(userId: string, disabled: boolean): void {
  const db = getDb();
  transaction(db, () => {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
    if (disabled) revokeAllSessions(userId);
  });
}

/**
 * First start on an empty store: mint one admin invite and print it. Called
 * from instrumentation on boot. Re-printed on every boot until used, so a
 * lost console line is not a lock-out (the old code is voided each time).
 */
export function ensureBootstrapInvite(log: (line: string) => void = console.log): void {
  const db = getDb();
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (users.n > 0) return;
  db.prepare("DELETE FROM invites WHERE created_by IS NULL AND used_by IS NULL").run();
  const code = createInvite(null, true);
  log("==================================================================");
  log(" GTNH Planner: no accounts yet. Create the admin account at /login");
  log(` with this one-time ADMIN invite code (valid 7 days):  ${code}`);
  log("==================================================================");
}
