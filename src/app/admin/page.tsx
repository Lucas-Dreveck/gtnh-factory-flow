"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface AdminUser {
  id: string;
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
}

const button =
  "rounded border border-line-strong bg-surface px-2.5 py-1 text-sm hover:bg-surface-raised disabled:opacity-50";

async function call(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>();
  const [denied, setDenied] = useState(false);
  const [invite, setInvite] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const response = await call("/api/admin/users");
    if (!response.ok) {
      setDenied(true);
      return;
    }
    setUsers(((await response.json()) as { users: AdminUser[] }).users);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void call("/api/admin/users").then(async (response) => {
      if (cancelled) return;
      if (!response.ok) {
        setDenied(true);
        return;
      }
      setUsers(((await response.json()) as { users: AdminUser[] }).users);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const createInvite = async (makeAdmin: boolean) => {
    setError(undefined);
    const response = await call("/api/admin/invites", { makeAdmin });
    if (!response.ok) {
      setError("The invite could not be created.");
      return;
    }
    setInvite(((await response.json()) as { code: string }).code);
  };

  const setDisabled = async (user: AdminUser, disabled: boolean) => {
    setError(undefined);
    const response = await call(`/api/admin/users/${encodeURIComponent(user.id)}`, { disabled });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      setError(body?.error ?? "The change failed.");
    }
    await load();
  };

  if (denied) {
    return (
      <main className="grid min-h-screen place-items-center bg-canvas p-4 text-fg">
        <p className="text-sm text-fg-muted">Not found.</p>
      </main>
    );
  }

  return (
    <main className="h-screen overflow-auto bg-canvas p-4 text-fg">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold tracking-tight">Admin</h1>
          <Link href="/" className="text-sm text-cyan-500 hover:underline">
            Back to the planner
          </Link>
        </div>

        <section className="space-y-2 rounded border border-line-strong bg-surface p-3">
          <h2 className="text-sm font-semibold">Invites</h2>
          <p className="text-xs text-fg-muted">
            A code works once and expires after 7 days. It is shown only here, once.
          </p>
          <div className="flex gap-2">
            <button type="button" className={button} onClick={() => void createInvite(false)}>
              Create invite
            </button>
            <button type="button" className={button} onClick={() => void createInvite(true)}>
              Create admin invite
            </button>
          </div>
          {invite ? (
            <p className="text-sm">
              Invite code:{" "}
              <code className="select-all rounded bg-surface-sunken px-1.5 py-0.5">{invite}</code>
            </p>
          ) : null}
        </section>

        {error ? <p className="text-sm text-red-500">{error}</p> : null}

        <section className="rounded border border-line-strong bg-surface p-3">
          <h2 className="mb-2 text-sm font-semibold">Users</h2>
          {users ? (
            <ul className="divide-y divide-line">
              {users.map((user) => (
                <li key={user.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="min-w-0 truncate">
                    {user.username}
                    {user.isAdmin ? <span className="ml-2 text-xs text-cyan-500">admin</span> : null}
                    {user.disabled ? (
                      <span className="ml-2 text-xs text-red-500">disabled</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className={button}
                    onClick={() => void setDisabled(user, !user.disabled)}
                  >
                    {user.disabled ? "Enable" : "Disable"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">Loading...</p>
          )}
        </section>
      </div>
    </main>
  );
}
