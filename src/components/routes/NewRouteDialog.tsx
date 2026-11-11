"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { splitBoardIds } from "@/lib/model/route-choices";
import { useFactoryStore } from "@/store/factory-store";
import { useRouteUi } from "./route-ui-store";

const FACE =
  "bg-[var(--mc-49)] text-white shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25)] hover:brightness-110";

/**
 * "Make route alternative": the selected cards and drawers become one route.
 * Either a new comparison (the selection is option A, option B waits for the
 * next selection) or one more option of a comparison that exists.
 */
export function NewRouteDialog() {
  const boardIds = useRouteUi((state) => state.pendingBoardIds);
  const close = useRouteUi((state) => state.closeNewOption);
  const choices = useFactoryStore((state) => state.project.routeChoices);
  const project = useFactoryStore((state) => state.project);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<string>("new");

  useEffect(() => {
    if (!boardIds) return;
    setName("");
    setTarget("new");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boardIds, close]);

  if (!boardIds) return null;
  const selection = splitBoardIds(project, boardIds);
  const count = selection.nodeIds.length + selection.storageIds.length;
  const openChoices = (choices ?? []).filter((choice) => choice.options.length < 6 || choice.options.some((o) => o.nodeIds.length + o.storageIds.length === 0));

  const submit = () => {
    const store = useFactoryStore.getState();
    if (target === "new") {
      const id = store.createRouteChoice(name, boardIds);
      close();
      if (id) useRouteUi.getState().openPanel(id);
    } else {
      store.addRouteOption(target, boardIds);
      close();
      useRouteUi.getState().openPanel(target);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-neutral-950/75 p-4 backdrop-blur-sm compact:bg-neutral-950/92 compact:[backdrop-filter:none]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New comparison"
        className="flex w-full max-w-sm flex-col overflow-hidden border-2 border-[var(--mc-15)] bg-[var(--mc-49)] text-[var(--mc-ink)] shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25),4px_4px_0_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b-2 border-[var(--mc-15)] px-4 py-2.5">
          <h2 className="text-sm font-bold">{target === "new" ? "New comparison" : "Add as option"}</h2>
          <button type="button" onClick={close} aria-label="Close" className={`flex h-7 w-7 items-center justify-center border-2 border-[var(--mc-15)] ${FACE}`}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 text-sm">
          <p className="text-xs text-[var(--mc-ink-muted)]">
            {selection.nodeIds.length} {selection.nodeIds.length === 1 ? "machine" : "machines"}
            {selection.storageIds.length > 0 ? ` and ${selection.storageIds.length} ${selection.storageIds.length === 1 ? "drawer" : "drawers"}` : ""} selected
            as one route. Only the route you pick runs; the others stay on the board, dimmed.
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold">Use the selection as</span>
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className={`h-7 border-2 border-[var(--mc-15)] px-1 text-sm ${FACE}`}
            >
              <option value="new">Option A of a new comparison</option>
              {openChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  Add as option to {choice.name}
                </option>
              ))}
            </select>
          </label>
          {target === "new" ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold">Name</span>
              <input
                autoFocus
                value={name}
                maxLength={60}
                placeholder="e.g. Sodium + Chlorine"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && count > 0) submit();
                }}
                className="h-7 border-2 border-[var(--mc-15)] bg-[var(--mc-15)] px-2 text-sm text-white"
              />
            </label>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-2 border-[var(--mc-15)] px-4 py-2.5">
          <button type="button" onClick={close} className={`h-7 border-2 border-[var(--mc-15)] px-3 text-sm ${FACE}`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={count === 0}
            onClick={submit}
            className={`h-7 border-2 border-[var(--mc-15)] px-3 text-sm font-bold disabled:opacity-40 ${FACE}`}
          >
            {target === "new" ? "Create" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
