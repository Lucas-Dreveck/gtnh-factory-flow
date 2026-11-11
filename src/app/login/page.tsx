"use client";

import { AuthForm } from "@/components/community/auth";

/** Only a same-origin relative path may be followed after sign-in. */
function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  return next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-canvas p-4 text-fg">
      <div className="w-full max-w-sm rounded border border-line-strong bg-surface p-4 shadow-xl">
        <h1 className="mb-1 text-base font-bold tracking-tight">
          GTNH <span className="text-cyan-500">Planner</span>
        </h1>
        <p className="mb-3 text-xs text-fg-muted">
          Private instance. Sign in, or create an account with an invite code.
        </p>
        <AuthForm onSignedIn={() => window.location.assign(safeNext())} />
      </div>
    </main>
  );
}
