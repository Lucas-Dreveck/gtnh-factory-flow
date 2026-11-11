"use client";

import { Download, GitBranch, History, Pencil, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  annotateRevision,
  createCheckpoint,
  fetchRevision,
  forkRevision,
  listRevisions,
  restoreRevision,
  type RevisionMeta,
} from "@/lib/library/history-client";
import { fetchRemoteDesignPlan } from "@/lib/library/client";
import { adoptRemotePlan, syncLibraryNow } from "@/lib/library/library-sync";
import { cardDeltaLabel, diffPlans, type PlanDiff } from "@/lib/library/plan-diff";
import { serializeFactoryProject } from "@/lib/import-export";
import { useCommunityAuthStore } from "@/store/community-auth-store";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";

const KIND_LABEL: Record<RevisionMeta["kind"], string> = {
  autosave: "Autosave",
  checkpoint: "Checkpoint",
  guard: "Safety copy",
  restore: "Restore",
  conflict: "Other device",
  fork: "Branch",
  import: "Import",
};

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function describe(revision: RevisionMeta): string {
  return revision.label?.trim() || KIND_LABEL[revision.kind];
}

const BUTTON =
  "inline-flex h-6 items-center gap-1 rounded border border-line-strong bg-surface px-2 text-xs text-fg hover:bg-surface-raised disabled:opacity-40";
const INPUT =
  "h-7 min-w-0 rounded border border-line-strong bg-surface-sunken px-2 text-xs text-fg";

/** The plan bar's History button; also owns the Ctrl+Shift+S shortcut. */
export function HistoryButton() {
  const [open, setOpen] = useState(false);
  const hasDesign = useDesignStore((state) => Boolean(state.activeDesignId));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (useDesignStore.getState().activeDesignId) setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!hasDesign}
        title="History: checkpoints and earlier versions (Ctrl+Shift+S)"
        aria-label="Plan history"
        className="plan-summary-action inline-flex h-6 shrink-0 items-center justify-center gap-1.5 rounded border border-line-strong bg-surface px-2 text-fg-subtle hover:bg-surface-raised hover:text-fg disabled:opacity-40"
      >
        <History aria-hidden className="h-3 w-3" />
        <span>History</span>
      </button>
      {open ? <HistoryPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const user = useCommunityAuthStore((state) => state.user);
  const designId = useDesignStore((state) => state.activeDesignId);
  const synced = useDesignStore((state) =>
    Boolean(state.designs.find((design) => design.id === state.activeDesignId)?.remoteUpdatedAt),
  );
  const current = useFactoryStore((state) => state.project);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [revisions, setRevisions] = useState<RevisionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [showAutosaves, setShowAutosaves] = useState(false);
  const [preview, setPreview] = useState<{ id: number; diff: PlanDiff }>();
  const [confirming, setConfirming] = useState<number>();
  const [branching, setBranching] = useState<{ id: number; name: string }>();
  const [editing, setEditing] = useState<{ id: number; label: string; note: string }>();
  const labelRef = useRef<HTMLInputElement>(null);

  const ready = Boolean(user) && online && Boolean(designId) && synced;

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const load = useCallback(
    async (before?: number) => {
      if (!designId) return;
      setLoading(true);
      setError(undefined);
      try {
        const page = await listRevisions(designId, { limit: 100, before });
        setRevisions((existing) => (before === undefined ? page : [...existing, ...page]));
        setMore(page.length >= 100);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load history");
      } finally {
        setLoading(false);
      }
    },
    [designId],
  );

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  useEffect(() => {
    if (ready) labelRef.current?.focus();
  }, [ready]);

  const named = useMemo(() => revisions.filter((revision) => revision.kind !== "autosave"), [revisions]);
  const autosaves = useMemo(() => revisions.filter((revision) => revision.kind === "autosave"), [revisions]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const currentPlan = () => useFactoryStore.getState().project;

  const saveCheckpoint = () =>
    run(async () => {
      if (!designId) return;
      await createCheckpoint(designId, {
        label: label.trim() || "Checkpoint",
        note: note.trim() || undefined,
        plan: currentPlan(),
      });
      setLabel("");
      setNote("");
      await load();
    });

  const togglePreview = (revision: RevisionMeta) =>
    run(async () => {
      if (!designId) return;
      if (preview?.id === revision.id) {
        setPreview(undefined);
        return;
      }
      const { plan } = await fetchRevision(designId, revision.id);
      setPreview({ id: revision.id, diff: diffPlans(currentPlan(), plan) });
    });

  const restore = (revision: RevisionMeta) =>
    run(async () => {
      if (!designId) return;
      // The screen as it is now becomes a checkpoint first, so a restore never
      // costs unsaved work.
      await createCheckpoint(designId, { label: "Before restore", plan: currentPlan() });
      const { design } = await restoreRevision(designId, revision.id);
      const { plan } = await fetchRemoteDesignPlan(designId);
      // The local record takes the account's stamps, so no stale autosave
      // is pushed over the restored plan.
      await adoptRemotePlan(design, plan);
      setConfirming(undefined);
      setPreview(undefined);
      await load();
    });

  const branch = () =>
    run(async () => {
      if (!designId || !branching) return;
      const design = await forkRevision(designId, branching.id, branching.name.trim() || "Branch");
      await syncLibraryNow();
      await useDesignStore.getState().switchToDesign(design.id);
      onClose();
    });

  const download = (revision: RevisionMeta) =>
    run(async () => {
      if (!designId) return;
      const { plan } = await fetchRevision(designId, revision.id);
      const url = URL.createObjectURL(new Blob([serializeFactoryProject(plan)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(plan.name || "factory").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${revision.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });

  const saveAnnotation = () =>
    run(async () => {
      if (!designId || !editing) return;
      await annotateRevision(designId, editing.id, { label: editing.label.trim(), note: editing.note.trim() });
      setEditing(undefined);
      await load();
    });

  const row = (revision: RevisionMeta) => {
    const delta = cardDeltaLabel(revision.nodeCount, current.nodes.length);
    return (
      <li key={revision.id} className="border-b border-line px-3 py-2 text-xs" data-revision-id={revision.id}>
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">{describe(revision)}</span>
          {revision.isHead ? <span className="text-fg-muted">current</span> : null}
          <span className="shrink-0 text-fg-muted" title={new Date(revision.createdAt).toLocaleString()}>
            {relativeTime(revision.createdAt)}
          </span>
        </div>
        <div className="text-fg-muted">
          {KIND_LABEL[revision.kind]} - {revision.nodeCount} cards, {revision.edgeCount} wires ({delta})
        </div>
        {revision.note ? <div className="mt-0.5 text-fg-subtle">{revision.note}</div> : null}
        <div className="mt-1 flex flex-wrap gap-1">
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void togglePreview(revision)}>
            Preview
          </button>
          {!revision.isHead ? (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => setConfirming(revision.id)}>
              <RotateCcw aria-hidden className="h-3 w-3" /> Restore
            </button>
          ) : null}
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => setBranching({ id: revision.id, name: `${current.name} (branch)` })}
          >
            <GitBranch aria-hidden className="h-3 w-3" /> Branch from here
          </button>
          {revision.kind !== "autosave" ? (
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => setEditing({ id: revision.id, label: revision.label ?? "", note: revision.note ?? "" })}
            >
              <Pencil aria-hidden className="h-3 w-3" /> Rename
            </button>
          ) : null}
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void download(revision)}>
            <Download aria-hidden className="h-3 w-3" /> JSON
          </button>
        </div>
        {preview?.id === revision.id ? <PreviewSummary diff={preview.diff} /> : null}
        {confirming === revision.id ? (
          <div className="mt-1 rounded border border-line-strong bg-surface-sunken p-2">
            Restore this version? Your current plan is kept as a checkpoint called &quot;Before restore&quot;, so you
            can come back to it.
            <div className="mt-1 flex gap-1">
              <button type="button" className={BUTTON} disabled={busy} onClick={() => void restore(revision)}>
                Restore
              </button>
              <button type="button" className={BUTTON} onClick={() => setConfirming(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {branching?.id === revision.id ? (
          <form
            className="mt-1 flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void branch();
            }}
          >
            <input
              aria-label="Branch name"
              className={`${INPUT} flex-1`}
              value={branching.name}
              maxLength={80}
              onChange={(event) => setBranching({ id: branching.id, name: event.target.value })}
            />
            <button type="submit" className={BUTTON} disabled={busy}>
              Create branch
            </button>
            <button type="button" className={BUTTON} onClick={() => setBranching(undefined)}>
              Cancel
            </button>
          </form>
        ) : null}
        {editing?.id === revision.id ? (
          <form
            className="mt-1 grid gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void saveAnnotation();
            }}
          >
            <input
              aria-label="Rename checkpoint"
              className={INPUT}
              value={editing.label}
              maxLength={120}
              onChange={(event) => setEditing({ ...editing, label: event.target.value })}
            />
            <input
              aria-label="Edit note"
              className={INPUT}
              value={editing.note}
              maxLength={500}
              placeholder="Note"
              onChange={(event) => setEditing({ ...editing, note: event.target.value })}
            />
            <div className="flex gap-1">
              <button type="submit" className={BUTTON} disabled={busy}>
                Save
              </button>
              <button type="button" className={BUTTON} onClick={() => setEditing(undefined)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </li>
    );
  };

  let body: ReactNode;
  if (!user || !online) {
    body = (
      <p className="p-4 text-sm text-fg-muted">
        History is kept in your account, so it needs you signed in and online.{" "}
        {!user ? (
          <a className="underline" href="/login">
            Sign in
          </a>
        ) : (
          "Reconnect to see it."
        )}
      </p>
    );
  } else if (!synced) {
    body = <p className="p-4 text-sm text-fg-muted">Saving to your account... History opens once this plan is saved.</p>;
  } else {
    body = (
      <>
        <form
          className="grid gap-1 border-b border-line p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCheckpoint();
          }}
        >
          <div className="flex gap-1">
            <input
              ref={labelRef}
              aria-label="Checkpoint name"
              className={`${INPUT} flex-1`}
              placeholder="Checkpoint name"
              maxLength={120}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <button type="submit" className={BUTTON} disabled={busy}>
              Create checkpoint
            </button>
          </div>
          <input
            aria-label="Checkpoint note"
            className={INPUT}
            placeholder="Note (optional)"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </form>
        {error ? <p className="px-3 py-2 text-xs text-red-400">{error}</p> : null}
        <ul>{named.map(row)}</ul>
        {autosaves.length > 0 ? (
          <div className="border-b border-line px-3 py-2 text-xs">
            <button type="button" className="underline" onClick={() => setShowAutosaves((value) => !value)}>
              {showAutosaves ? "Hide" : "Show"} {autosaves.length} autosaves
            </button>
          </div>
        ) : null}
        {showAutosaves ? <ul>{autosaves.map(row)}</ul> : null}
        {more ? (
          <div className="p-3">
            <button
              type="button"
              className={BUTTON}
              disabled={loading}
              onClick={() => void load(revisions[revisions.length - 1]?.id)}
            >
              Load older
            </button>
          </div>
        ) : null}
        {loading ? <p className="p-3 text-xs text-fg-muted">Loading...</p> : null}
        {!loading && revisions.length === 0 ? <p className="p-3 text-xs text-fg-muted">No versions yet.</p> : null}
      </>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-neutral-950/75 p-4 backdrop-blur-sm compact:bg-neutral-950/92 compact:[backdrop-filter:none]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Plan history"
        className="flex max-h-[calc(88*var(--ui-vh))] w-full max-w-lg flex-col overflow-hidden border-2 border-[var(--mc-15)] bg-[var(--mc-49)] text-[var(--mc-ink)] shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25),4px_4px_0_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b-2 border-[var(--mc-15)] px-4 py-2.5">
          <h2 className="text-sm font-bold">History</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-7 w-7 items-center justify-center">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-surface">{body}</div>
      </div>
    </div>
  );
}

function PreviewSummary({ diff }: { diff: PlanDiff }) {
  if (diff.unchanged) {
    return <div className="mt-1 text-fg-muted">Same as the plan on screen.</div>;
  }
  return (
    <div className="mt-1 rounded border border-line bg-surface-sunken p-2" data-testid="history-preview">
      <div className="font-semibold">Restoring would:</div>
      {diff.addedCards.length > 0 ? <div>Add: {diff.addedCards.join(", ")}</div> : null}
      {diff.removedCards.length > 0 ? <div>Remove: {diff.removedCards.join(", ")}</div> : null}
      <div className="text-fg-muted">
        Wires +{diff.wiresAdded} / -{diff.wiresRemoved}, drawers +{diff.drawersAdded} / -{diff.drawersRemoved}
      </div>
    </div>
  );
}
