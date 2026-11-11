"use client";

import { LoaderCircle, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { otherOptionCards, SOLVER_PICKS } from "@/lib/model/route-choices";
import type { RouteChoice } from "@/lib/model/types";
import {
  compareRouteChoiceAsync,
  type MachineGroup,
  type ResourceRate,
  type RouteColumn,
  type RouteComparison,
  type RouteMetric,
} from "@/lib/solver/route-compare";
import { useFactoryStore } from "@/store/factory-store";
import { useRouteUi } from "./route-ui-store";

const FACE =
  "bg-[var(--mc-49)] text-white shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25)] hover:brightness-110";
const BTN = `h-6 border-2 border-[var(--mc-15)] px-2 text-xs ${FACE} disabled:opacity-40`;
/** Edits that settle for this long start a fresh comparison (only after one was asked for). */
const AUTO_COMPARE_MS = 500;

const num = (value: number, digits = 2) =>
  Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : Number(value.toFixed(digits)).toString();
const signed = (value: number, digits = 2) => (value > 0 ? "+" : value < 0 ? "-" : "") + num(Math.abs(value), digits);

/** The route alternatives sheet: one comparison table per choice. */
export function RoutesDialog() {
  const open = useRouteUi((state) => state.panelOpen);
  const focusId = useRouteUi((state) => state.focusChoiceId);
  const close = useRouteUi((state) => state.closePanel);
  const choices = useFactoryStore((state) => state.project.routeChoices);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const ordered = [...(choices ?? [])].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0));

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-neutral-950/75 p-4 backdrop-blur-sm compact:bg-neutral-950/92 compact:[backdrop-filter:none]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Route alternatives"
        className="flex max-h-[calc(90*var(--ui-vh))] w-full max-w-4xl flex-col overflow-hidden border-2 border-[var(--mc-15)] bg-[var(--mc-49)] text-[var(--mc-ink)] shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25),4px_4px_0_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b-2 border-[var(--mc-15)] px-4 py-2.5">
          <h2 className="text-sm font-bold">Route alternatives</h2>
          <button
            type="button"
            className={`ml-auto mr-2 h-7 border-2 border-[var(--mc-15)] px-2 text-xs ${FACE}`}
            title="Search the recipe book for other ways to make a resource in this plan"
            onClick={() => useRouteUi.getState().openFinder()}
          >
            Find routes...
          </button>
          <button type="button" onClick={close} aria-label="Close" className={`flex h-7 w-7 items-center justify-center border-2 border-[var(--mc-15)] ${FACE}`}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          {ordered.length === 0 ? (
            <p className="text-sm text-[var(--mc-ink-muted)]">
              No comparisons yet. Select the machines and drawers of one route on the board, right click one of them
              and choose Make route alternative, or press Find routes to search for other ways to make a resource.
            </p>
          ) : (
            ordered.map((choice) => <ChoiceSection key={choice.id} choice={choice} startOpen={choice.id === focusId || ordered.length === 1} />)
          )}
        </div>
      </div>
    </div>
  );
}

function ChoiceSection({ choice, startOpen }: { choice: RouteChoice; startOpen: boolean }) {
  const project = useFactoryStore((state) => state.project);
  const [expanded, setExpanded] = useState(startOpen);
  const [comparison, setComparison] = useState<RouteComparison>();
  const [running, setRunning] = useState(false);
  const [asked, setAsked] = useState(false);
  const [confirmKeep, setConfirmKeep] = useState<string>();
  const runToken = useRef(0);

  // A route just added from the finder: solve it at once instead of waiting for Compare.
  useEffect(() => {
    if (useRouteUi.getState().autoCompareChoiceId !== choice.id) return;
    useRouteUi.setState({ autoCompareChoiceId: undefined });
    setExpanded(true);
    setAsked(true);
  }, [choice.id]);

  const run = useCallback(async () => {
    const token = ++runToken.current;
    setRunning(true);
    try {
      const next = await compareRouteChoiceAsync(
        useFactoryStore.getState().project,
        choice.id,
        undefined,
        () => token !== runToken.current,
      );
      if (next && token === runToken.current) setComparison(next);
    } finally {
      if (token === runToken.current) setRunning(false);
    }
  }, [choice.id]);

  // After the first Compare the table follows the plan: 500 ms after the last
  // edit it recomputes, and an edit that lands first cancels the run in flight.
  useEffect(() => {
    if (!asked || !expanded) return;
    const timer = window.setTimeout(() => void run(), AUTO_COMPARE_MS);
    return () => {
      window.clearTimeout(timer);
      runToken.current++;
    };
  }, [project, asked, expanded, run]);

  const store = useFactoryStore.getState;
  const columns = comparison?.columns ?? [];
  const doomed = useMemo(() => (confirmKeep ? otherOptionCards(choice, confirmKeep) : undefined), [choice, confirmKeep]);
  const runningLabel =
    choice.active === SOLVER_PICKS ? "Solver picks" : (choice.options.find((o) => o.id === choice.active)?.label ?? "");

  return (
    <section className="border-2 border-[var(--mc-15)] bg-[var(--mc-36)]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setExpanded(!expanded)} className="text-left text-sm font-bold hover:underline" aria-expanded={expanded}>
          {choice.name}
        </button>
        <span className="text-xs text-[var(--mc-ink-muted)]">
          {choice.options.length} options, running: {runningLabel}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-label="Comparing" /> : null}
          {comparison && !running ? <span className="text-xs tabular-nums text-[var(--mc-ink-muted)]">{Math.round(comparison.elapsedMs)} ms</span> : null}
          <button
            type="button"
            className={BTN}
            disabled={running}
            onClick={() => {
              setExpanded(true);
              setAsked(true);
              void run();
            }}
          >
            Compare
          </button>
          <button type="button" className={BTN} title="Delete this comparison; the cards stay on the board" onClick={() => store().deleteRouteChoice(choice.id)}>
            <Trash2 className="h-3 w-3" aria-label="Delete comparison" />
          </button>
        </span>
      </div>
      {expanded ? (
        <div className="overflow-x-auto border-t-2 border-[var(--mc-15)] px-3 py-2">
          {!comparison ? (
            <p className="text-xs text-[var(--mc-ink-muted)]">
              {running ? "Solving the whole plan once per option..." : "Compare solves the whole plan once per option and once with the solver free to pick."}
            </p>
          ) : (
            <table className="w-full min-w-[560px] border-collapse text-xs">
              <thead>
                <tr className="align-top">
                  <th className="w-32 p-1 text-left font-normal text-[var(--mc-ink-muted)]" />
                  {columns.map((column) => (
                    <th key={column.id} className="p-1 text-left align-top font-bold">
                      <div className="flex flex-col gap-1">
                        <span>
                          {column.label}
                          {choice.active === column.id ? <span className="ml-1 text-[10px] font-bold text-emerald-300">running</span> : null}
                        </span>
                        <span className="flex flex-wrap gap-1 font-normal">
                          {column.id === SOLVER_PICKS ? (
                            <button type="button" className={BTN} disabled={choice.active === SOLVER_PICKS} onClick={() => store().setRouteActive(choice.id, SOLVER_PICKS)}>
                              Let solver pick
                            </button>
                          ) : (
                            <>
                              <button type="button" className={BTN} disabled={choice.active === column.id} onClick={() => store().setRouteActive(choice.id, column.id)}>
                                Use this
                              </button>
                              <button
                                type="button"
                                className={BTN}
                                onClick={() => {
                                  const option = choice.options.find((o) => o.id === column.id);
                                  if (option) {
                                    store().setPendingBoardSelection([...option.nodeIds, ...option.storageIds]);
                                    useRouteUi.getState().closePanel();
                                  }
                                }}
                              >
                                Select cards
                              </button>
                              <button type="button" className={BTN} onClick={() => setConfirmKeep(column.id)}>
                                Keep only this...
                              </button>
                              <button type="button" className={BTN} onClick={() => store().removeRouteOption(choice.id, column.id)}>
                                Remove option
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="[&_td]:align-top [&_td]:p-1 [&_th]:p-1 [&_tr]:border-t [&_tr]:border-[var(--mc-15)]">
                <Row label="Targets met" columns={columns}>
                  {(c) => (c.targetsMet ? <span className="text-emerald-300">Yes</span> : <span className="text-red-300">No: {c.unmetTargets.join(", ")}</span>)}
                </Row>
                <MetricRow label="Machines" metric="totalMachines" comparison={comparison} value={(c) => num(c.totalMachines)} delta={(c) => signed(c.delta.machines)} deltaValue={(c) => c.delta.machines} />
                <MetricRow label="EU/t" metric="totalEuT" comparison={comparison} value={(c) => num(c.totalEuT, 0)} delta={(c) => signed(c.delta.euT, 0)} deltaValue={(c) => c.delta.euT} />
                <Row label="Machines by type" columns={columns}>
                  {(c) => <Machines groups={c.machinesByType} delta={c.id === comparison.baselineId ? undefined : c.delta.machinesByType} />}
                </Row>
                <Row label="Solver mix" columns={columns} only={SOLVER_PICKS}>
                  {(c) => (
                    <span>
                      {(c.optionUse ?? []).filter((u) => u.share > 0).length === 0
                        ? "none"
                        : (c.optionUse ?? [])
                            .filter((u) => u.share > 0)
                            .map((u) => `${u.label.split(":")[0]} ${Math.round(u.share * 100)}%`)
                            .join(", ")}
                    </span>
                  )}
                </Row>
                <MetricRow label="Imports" metric="imports" comparison={comparison} value={(c) => <Rates list={c.imports} />} />
                <MetricRow label="Surplus and byproducts" metric="surplus" comparison={comparison} value={(c) => <Rates list={c.surplus} />} />
                <Row label="Changes elsewhere" columns={columns}>
                  {(c) =>
                    c.id === comparison.baselineId ? (
                      <span className="text-[var(--mc-ink-muted)]">(this is the baseline)</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <Rates list={c.delta.imports} signedValues prefix="imports " />
                        <Rates list={c.delta.surplus} signedValues prefix="surplus " />
                        {c.delta.imports.length + c.delta.surplus.length === 0 ? <span className="text-[var(--mc-ink-muted)]">none</span> : null}
                      </div>
                    )
                  }
                </Row>
              </tbody>
            </table>
          )}
          {comparison ? (
            <p className="mt-2 text-[10px] text-[var(--mc-ink-muted)]">
              Changes are measured against {columns.find((c) => c.id === comparison.baselineId)?.label}. Lower is marked per row; there is no combined score.
            </p>
          ) : null}
          {confirmKeep && doomed ? (
            <div role="alertdialog" className="mt-2 border-2 border-red-400/60 bg-[var(--mc-15)] p-2 text-xs">
              <p>
                Keep only {choice.options.find((o) => o.id === confirmKeep)?.label} and delete {doomed.nodeIds.length}{" "}
                {doomed.nodeIds.length === 1 ? "machine" : "machines"}
                {doomed.storageIds.length > 0 ? ` and ${doomed.storageIds.length} ${doomed.storageIds.length === 1 ? "drawer" : "drawers"}` : ""} of the
                other options. Your account history keeps a checkpoint automatically, and undo works too.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={`${BTN} !border-red-400/70`}
                  onClick={() => {
                    store().keepOnlyRouteOption(choice.id, confirmKeep);
                    setConfirmKeep(undefined);
                  }}
                >
                  Delete the others
                </button>
                <button type="button" className={BTN} onClick={() => setConfirmKeep(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Row({
  label,
  columns,
  children,
  only,
}: {
  label: string;
  columns: RouteColumn[];
  children: (column: RouteColumn) => ReactNode;
  only?: string;
}) {
  return (
    <tr>
      <th className="text-left font-normal text-[var(--mc-ink-muted)]">{label}</th>
      {columns.map((column) => (
        <td key={column.id}>{only && column.id !== only ? null : children(column)}</td>
      ))}
    </tr>
  );
}

function MetricRow({
  label,
  metric,
  comparison,
  value,
  delta,
  deltaValue,
}: {
  label: string;
  metric: RouteMetric;
  comparison: RouteComparison;
  value: (column: RouteColumn) => ReactNode;
  delta?: (column: RouteColumn) => string;
  deltaValue?: (column: RouteColumn) => number;
}) {
  const cheapest = new Set(comparison.cheapest[metric]);
  return (
    <Row label={label} columns={comparison.columns}>
      {(column) => {
        const change = deltaValue?.(column) ?? 0;
        return (
          <span className={cheapest.has(column.id) ? "font-bold text-emerald-300" : undefined}>
            {value(column)}
            {cheapest.has(column.id) ? <span className="ml-1 text-[10px] font-normal">lowest</span> : null}
            {delta && column.id !== comparison.baselineId && Math.abs(change) > 1e-6 ? (
              <span className={`ml-1 text-[10px] font-normal ${change < 0 ? "text-emerald-300" : "text-amber-300"}`}>{delta(column)}</span>
            ) : null}
          </span>
        );
      }}
    </Row>
  );
}

function Machines({ groups, delta }: { groups: MachineGroup[]; delta?: MachineGroup[] }) {
  const changes = new Map((delta ?? []).map((g) => [`${g.machineType}|${g.tier}`, g.count]));
  if (groups.length === 0 && changes.size === 0) return <span className="text-[var(--mc-ink-muted)]">none</span>;
  const shown = [...groups];
  for (const [key, count] of changes) {
    if (!groups.some((g) => `${g.machineType}|${g.tier}` === key) && count < 0) {
      const [machineType, tier] = key.split("|");
      shown.push({ machineType, tier, count: 0 });
    }
  }
  return (
    <details>
      <summary className="cursor-pointer">{shown.length} {shown.length === 1 ? "type" : "types"}</summary>
      <ul className="mt-1 flex flex-col gap-0.5">
        {shown.map((group) => {
          const change = changes.get(`${group.machineType}|${group.tier}`);
          return (
            <li key={`${group.machineType}|${group.tier}`} className="tabular-nums">
              {num(group.count)} x {group.machineType} {group.tier}
              {change ? <span className={`ml-1 text-[10px] ${change < 0 ? "text-emerald-300" : "text-amber-300"}`}>{signed(change)}</span> : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Rates({ list, signedValues = false, prefix = "" }: { list: ResourceRate[]; signedValues?: boolean; prefix?: string }) {
  if (list.length === 0) return prefix ? null : <span className="text-[var(--mc-ink-muted)]">none</span>;
  return (
    <details>
      <summary className="cursor-pointer">
        {prefix}
        {list.length} {list.length === 1 ? "resource" : "resources"}
        {signedValues ? "" : ` (${num(list.reduce((n, r) => n + r.perSecond, 0))}/s)`}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5">
        {list.map((rate) => (
          <li key={rate.resource} className={`tabular-nums ${signedValues ? (rate.perSecond < 0 ? "text-emerald-300" : "text-amber-300") : ""}`}>
            {signedValues ? signed(rate.perSecond, 3) : num(rate.perSecond, 3)}/s {rate.name}
          </li>
        ))}
      </ul>
    </details>
  );
}
