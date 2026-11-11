"use client";

import { useDropdownDismiss } from "@/lib/hooks/use-dropdown-dismiss";

import { ChevronDown, Factory, KeyRound, LoaderCircle, LogOut, ShieldCheck, User } from "lucide-react";
import { useRef, useState } from "react";
import { openLibrary } from "@/lib/library/library-tab";
import { changeCommunityPassword } from "@/lib/community/client";
import { AuthForm, useCommunityUser } from "./auth";

/** Current and new password; success signs every session out, so it ends at /login. */
function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string>();
  const [isBusy, setBusy] = useState(false);
  const field = "w-full rounded border border-line-strong bg-surface-sunken px-2 py-1.5 text-sm";
  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-neutral-950/50 p-4" onClick={onClose}>
      <form
        className="w-full max-w-sm space-y-2 rounded border border-line-strong bg-surface p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          changeCommunityPassword(current, next)
            .then(() => window.location.assign("/login"))
            .catch((failure: unknown) => {
              setError(failure instanceof Error ? failure.message : "Password change failed.");
              setBusy(false);
            });
        }}
      >
        <h2 className="text-base font-semibold">Change password</h2>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
          placeholder="Current password" autoComplete="current-password" maxLength={256} className={field} />
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)}
          placeholder="New password (10+ characters)" autoComplete="new-password" maxLength={256} className={field} />
        <p className="text-xs text-fg-muted">You will be signed out everywhere and asked to sign in again.</p>
        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        <div className="flex gap-2">
          <button type="submit" disabled={isBusy || !current || next.length < 10}
            className="inline-flex items-center gap-2 rounded border border-cyan-700 bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50">
            {isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Change password
          </button>
          <button type="button" onClick={onClose}
            className="rounded border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-raised">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Top-right account control: a Sign in button when logged out, a username
 * menu when logged in.
 */
export function AccountMenu() {
  const { user, isLoading, setUser, signOut } = useCommunityUser();
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [isAuthOpen, setAuthOpen] = useState(false);
  const [isPasswordOpen, setPasswordOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useDropdownDismiss(isMenuOpen, { refs: [menuRef], onClose: () => setMenuOpen(false), fade: true });

  if (isLoading) {
    return <div className="h-5 w-20 animate-pulse rounded bg-surface-sunken" aria-hidden />;
  }

  if (!user) {
    return (
      <>
        <button
          type="button"
          onClick={() => setAuthOpen(true)}
          className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-line-strong bg-surface px-2.5 font-medium text-fg hover:bg-surface-raised"
        >
          <User className="h-3.5 w-3.5" /> Sign in
        </button>
        {isAuthOpen ? (
          <div
            className="fixed inset-0 z-[110] grid place-items-center bg-neutral-950/50 p-4"
            onClick={() => setAuthOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded border border-line-strong bg-surface p-4 shadow-xl"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="mb-1 text-base font-semibold">Account</h2>
              <p className="mb-3 text-xs text-fg-muted">
                Your designs sync to this server while you are signed in.
              </p>
              <AuthForm
                onSignedIn={(signedInUser) => {
                  setUser(signedInUser);
                  setAuthOpen(false);
                }}
              />
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-expanded={isMenuOpen}
        className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded border border-line-strong bg-surface px-2.5 font-medium text-fg hover:bg-surface-raised"
      >
        {user.isAdmin ? (
          <ShieldCheck className="h-3.5 w-3.5 text-cyan-500" />
        ) : (
          <User className="h-3.5 w-3.5" />
        )}
        <span className="max-w-32 truncate">{user.username}</span>
        <ChevronDown className="h-3 w-3 text-fg-muted" />
      </button>
      {isMenuOpen ? (
        <div className="absolute right-0 top-full mt-1 z-[110] min-w-44 rounded border border-line-strong bg-surface py-1 text-sm shadow-lg">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              openLibrary({ kind: "all" });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-raised"
          >
            <Factory className="h-3.5 w-3.5 text-fg-muted" /> My setups
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setPasswordOpen(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-raised"
          >
            <KeyRound className="h-3.5 w-3.5 text-fg-muted" /> Change password
          </button>
          {user.isAdmin ? (
            <a
              href="/admin"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-raised"
            >
              <ShieldCheck className="h-3.5 w-3.5 text-fg-muted" /> Admin
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-raised"
          >
            <LogOut className="h-3.5 w-3.5 text-fg-muted" /> Sign out
          </button>
        </div>
      ) : null}
      {isPasswordOpen ? <ChangePasswordDialog onClose={() => setPasswordOpen(false)} /> : null}
    </div>
  );
}
