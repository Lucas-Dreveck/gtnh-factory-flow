"use client";

import { LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMachineHandlerIcons, useRecipeMapIcons } from "@/components/flow/machine-icons";
import { machineArtPixels } from "@/components/flow/MachinePicker";
import { ResourceIcon } from "@/components/nei/ResourceIcon";
import { GT_VOLTAGE_TIERS } from "@/lib/model/tiers";
import type { FactoryProject, MachineTier, Recipe } from "@/lib/model/types";
import { DiscoverCancelled, type DiscoverProgress } from "@/lib/routes/discover";
import { startDiscovery, type DiscoverRun } from "@/lib/routes/discover-client";
import type { DiscoverResult, RouteResult } from "@/lib/routes/types";
import { useFactoryStore } from "@/store/factory-store";
import { useRouteUi } from "./route-ui-store";

const FACE =
  "bg-[var(--mc-49)] text-white shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25)] hover:brightness-110";
const BTN = `h-6 border-2 border-[var(--mc-15)] px-2 text-xs ${FACE} disabled:opacity-40`;
const FIELD = "h-6 border-2 border-[var(--mc-15)] bg-[var(--mc-15)] px-1 text-xs text-white";

type Tier = Exclude<MachineTier, "DEMO">;

const num = (value: number, digits = 2) =>
  Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : Number(value.toFixed(digits)).toString();
const signed = (value: number, digits = 2) => (value > 0 ? "+" : value < 0 ? "-" : "") + num(Math.abs(value), digits);

const PHASES: Record<DiscoverProgress["phase"], string> = {
  baseline: "Solving the plan",
  search: "Searching the recipe book",
  score: "Ranking the candidates",
  evaluate: "Solving the plan with each route",
  done: "Done",
};

interface PlanResource {
  kind: "item" | "fluid";
  id: string;
  name: string;
  recipe?: Recipe;
}

/** Everything an enabled card makes or a drawer holds, by name. */
function planResources(project: FactoryProject): PlanResource[] {
  const found = new Map<string, PlanResource>();
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  for (const node of project.nodes) {
    const recipe = recipes.get(node.recipeId);
    if (!node.enabled || !recipe || recipe.power) continue;
    for (const output of recipe.outputs) {
      if (output.kind !== "item" && output.kind !== "fluid") continue;
      const key = `${output.kind}:${output.id}`;
      if (!found.has(key)) found.set(key, { kind: output.kind, id: output.id, name: output.displayName ?? output.id });
    }
  }
  for (const storage of project.storages ?? []) {
    if (storage.kind !== "item" && storage.kind !== "fluid") continue;
    const key = `${storage.kind}:${storage.resourceId}`;
    if (!found.has(key)) found.set(key, { kind: storage.kind, id: storage.resourceId, name: storage.displayName ?? storage.resourceId });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function MachineChip({ recipe }: { recipe: Recipe }) {
  const handlerIcons = useMachineHandlerIcons();
  const mapIcons = useRecipeMapIcons();
  const icon =
    (recipe.machineHandlers?.[0] ? handlerIcons.get(recipe.machineHandlers[0].id) : undefined) ??
    mapIcons.get(recipe.source?.recipeMap ?? recipe.machineType);
  return (
    <span className="inline-flex items-center gap-1" title={`${recipe.machineType} ${recipe.minimumTier ?? ""}`}>
      {icon ? (
        <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center overflow-hidden">
          <ResourceIcon
            resource={{ ...icon, amount: 1, consumed: true }}
            size="sm"
            showAmount={false}
            bare
            tooltip={false}
            iconPixelSize={machineArtPixels(20)}
            className="!h-full !w-full"
          />
        </span>
      ) : null}
      <span>
        {recipe.machineType} <span className="text-[var(--mc-ink-muted)]">{recipe.minimumTier}</span>
      </span>
    </span>
  );
}

/** "Find other routes": search the recipe book, rank the finds on the whole plan, add one as an alternative. */
export function FindRoutesDialog() {
  const open = useRouteUi((state) => state.finderOpen);
  if (!open) return null;
  return <FindRoutesSheet />;
}

function FindRoutesSheet() {
  const close = useRouteUi((state) => state.closeFinder);
  const initialTarget = useRouteUi((state) => state.finderTarget);
  const nodeId = useRouteUi((state) => state.finderNodeId);
  const project = useFactoryStore((state) => state.project);
  const version = useFactoryStore((state) =>
    state.datasetManifest?.versions.find((entry) => entry.id === state.selectedDatasetVersionId),
  );
  const resources = useMemo(() => planResources(project), [project]);

  const [target, setTarget] = useState(initialTarget);
  const [filter, setFilter] = useState("");
  const [depth, setDepth] = useState(2);
  const [maxTier, setMaxTier] = useState<"plan" | Tier>("plan");
  const [onlyPlanInputs, setOnlyPlanInputs] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DiscoverProgress>();
  const [result, setResult] = useState<DiscoverResult>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const runRef = useRef<DiscoverRun | undefined>(undefined);
  const searched = useRef<{ nodeId?: string }>({});

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      runRef.current?.cancel();
    };
  }, [close]);

  const targetName =
    resources.find((r) => r.kind === target?.kind && r.id === target?.id)?.name ?? target?.id ?? "";

  const search = async () => {
    if (!target || !version) return;
    runRef.current?.cancel();
    setRunning(true);
    setError(undefined);
    setNotice(undefined);
    setResult(undefined);
    setProgress(undefined);
    const stored = useFactoryStore.getState().project;
    // The card the player clicked is the route being replaced; from the picker the engine decides.
    const replaceNodeIds = nodeId && stored.nodes.some((n) => n.id === nodeId) ? [nodeId] : undefined;
    searched.current = { nodeId };
    const run = startDiscovery({
      project: stored,
      target,
      version,
      options: {
        depth,
        ...(maxTier === "plan" ? {} : { maxTier }),
        ...(replaceNodeIds ? { replaceNodeIds } : {}),
      },
      onProgress: setProgress,
    });
    runRef.current = run;
    try {
      const found = await run.promise;
      if (runRef.current === run) setResult(found);
    } catch (caught) {
      if (caught instanceof DiscoverCancelled) return;
      if (runRef.current === run) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (runRef.current === run) setRunning(false);
    }
  };

  const cancel = () => {
    runRef.current?.cancel();
    setRunning(false);
    setProgress(undefined);
  };

  const add = (route: RouteResult) => {
    if (!route.draft) return;
    const store = useFactoryStore.getState();
    const replaced = route.draft.replacesNodeIds;
    const current = store.project;
    const choice = (current.routeChoices ?? []).find((c) =>
      c.options.some((o) => o.nodeIds.some((id) => replaced.includes(id))),
    );
    const firstRecipe = current.recipes.find(
      (r) => r.id === current.nodes.find((n) => n.id === replaced[0])?.recipeId,
    );
    const added = store.addDiscoveredRoute(route.draft, {
      name: `${targetName || "Resource"} routes`,
      choiceId: choice?.id,
      currentLabel: `Current: ${firstRecipe?.machineType ?? "machines"}`,
    });
    if (!added) {
      setNotice("The plan changed since the search, or the comparison is full. Search again.");
      return;
    }
    close();
    useRouteUi.getState().openPanel(added.choiceId, { compare: true });
  };

  const shown = (result?.routes ?? []).filter(
    (route) => !onlyPlanInputs || (route.pre.newImports.length === 0 && (route.delta?.importsAdded.length ?? 0) === 0),
  );
  const hidden = (result?.routes.length ?? 0) - shown.length;
  const pickable = resources.filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 60);

  return (
    <div
      className="fixed inset-0 z-[125] grid place-items-center bg-neutral-950/75 p-4 backdrop-blur-sm compact:bg-neutral-950/92 compact:[backdrop-filter:none]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Find other routes"
        className="flex max-h-[calc(90*var(--ui-vh))] w-full max-w-4xl flex-col overflow-hidden border-2 border-[var(--mc-15)] bg-[var(--mc-49)] text-[var(--mc-ink)] shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25),4px_4px_0_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b-2 border-[var(--mc-15)] px-4 py-2.5">
          <h2 className="text-sm font-bold">Find other routes{targetName ? ` for ${targetName}` : ""}</h2>
          <button type="button" onClick={close} aria-label="Close" className={`flex h-7 w-7 items-center justify-center border-2 border-[var(--mc-15)] ${FACE}`}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-xs">
          {!initialTarget || !target ? (
            <div className="flex flex-col gap-1">
              <label className="font-bold" htmlFor="find-routes-filter">
                Resource
              </label>
              <input id="find-routes-filter" className={FIELD} placeholder="Filter the plan's resources" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <ul className="max-h-40 overflow-y-auto border-2 border-[var(--mc-15)] bg-[var(--mc-36)]">
                {pickable.map((r) => (
                  <li key={`${r.kind}:${r.id}`}>
                    <button
                      type="button"
                      className={`w-full px-2 py-0.5 text-left hover:bg-[var(--mc-15)] ${target?.id === r.id && target.kind === r.kind ? "font-bold text-emerald-300" : ""}`}
                      onClick={() => setTarget({ kind: r.kind, id: r.id })}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
                {pickable.length === 0 ? <li className="px-2 py-1 text-[var(--mc-ink-muted)]">No resource matches.</li> : null}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-0.5">
              <span className="font-bold">Depth</span>
              <select className={FIELD} value={depth} onChange={(e) => setDepth(Number(e.target.value))} title="How many recipes deep the search may chain">
                <option value={1}>1: one recipe</option>
                <option value={2}>2: plus feeders</option>
                <option value={3}>3: two levels of feeders</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="font-bold">Highest machine tier</span>
              <select className={FIELD} value={maxTier} onChange={(e) => setMaxTier(e.target.value as "plan" | Tier)}>
                <option value="plan">Plan&apos;s own</option>
                {GT_VOLTAGE_TIERS.map((entry) => (
                  <option key={entry.tier} value={entry.tier}>
                    {entry.tier}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-1">
              <input type="checkbox" checked={onlyPlanInputs} onChange={(e) => setOnlyPlanInputs(e.target.checked)} />
              <span>Only use inputs the plan already has</span>
            </label>
            <span className="ml-auto flex items-center gap-2">
              {running ? (
                <button type="button" className={BTN} onClick={cancel}>
                  Cancel
                </button>
              ) : null}
              <button type="button" className={BTN} disabled={running || !target || !version} onClick={() => void search()}>
                {result ? "Search again" : "Search"}
              </button>
            </span>
          </div>
          {!version ? <p className="text-[var(--mc-ink-muted)]">The recipe book is still loading.</p> : null}
          {running ? (
            <p className="flex items-center gap-2" role="status">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {progress
                ? `${PHASES[progress.phase]}... ${progress.candidates} candidates, ${progress.evaluated} solved, ${Math.round(progress.ms)} ms`
                : "Starting..."}
            </p>
          ) : null}
          {error ? <p className="text-red-300">The search failed: {error}</p> : null}
          {notice ? <p className="text-amber-300">{notice}</p> : null}
          {result ? (
            <>
              <p className="text-[var(--mc-ink-muted)]" data-testid="find-routes-summary">
                Sized for {num(result.rate, 3)}/s ({result.rateBasis}), up to {result.maxTier} machines, replacing{" "}
                {result.replacedNodeIds.length} {result.replacedNodeIds.length === 1 ? "machine" : "machines"}.{" "}
                {result.candidatesBuilt} candidates, {result.timings.fullEvalCount} solved against the whole plan in{" "}
                {Math.round(result.timings.totalMs)} ms (recipe book {Math.round(result.timings.ioMs)} ms, solves{" "}
                {Math.round(result.timings.fullEvalMs)} ms).
                {hidden > 0 ? ` ${hidden} hidden by the inputs filter.` : ""}
              </p>
              {shown.length === 0 ? (
                <p>No route found. Try a deeper search or a higher machine tier.</p>
              ) : (
                <ul className="flex flex-col gap-2" aria-label="Routes found">
                  {shown.map((route) => (
                    <RouteRow key={route.candidate.id} route={route} onAdd={() => add(route)} />
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RouteRow({ route, onAdd }: { route: RouteResult; onAdd: () => void }) {
  const plan = route.plan;
  const delta = route.delta;
  const chain = [...route.candidate.steps].reverse();
  const used = route.pre.byproducts.filter((b) => b.planConsumes);
  const spare = route.pre.byproducts.filter((b) => !b.planConsumes);
  const imports = delta?.importsAdded ?? route.pre.newImports;
  // A plan with no solution has no totals to compare; its zeros would read as huge savings.
  const unsolved = Boolean(plan?.solveFailed);
  return (
    <li className="border-2 border-[var(--mc-15)] bg-[var(--mc-36)] p-2" data-testid="route-row">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {chain.map((step, i) => (
          <span key={`${step.recipe.id}-${i}`} className="inline-flex items-center gap-2">
            {i > 0 ? <span aria-hidden>{">"}</span> : null}
            <MachineChip recipe={step.recipe} />
          </span>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {plan ? (
            plan.targetsMet ? (
              <span className="font-bold text-emerald-300" title="The plan's targets are still met">
                Targets met &#10003;
              </span>
            ) : (
              <span className="font-bold text-red-300" title="The plan misses a target with this route">
                Targets missed &#10007;
              </span>
            )
          ) : null}
          <button type="button" className={BTN} disabled={!route.draft} onClick={onAdd} title={route.draft ? undefined : "Not solved against the plan, so it cannot be added"}>
            Add as alternative
          </button>
        </span>
      </div>
      <p className="mt-1 text-[var(--mc-ink-muted)]">{route.label}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 sm:grid-cols-[auto_1fr_auto_1fr]">
        <dt className="text-[var(--mc-ink-muted)]">Machines</dt>
        <dd className={!unsolved && delta && delta.machines < 0 ? "text-emerald-300" : !unsolved && delta && delta.machines > 0 ? "text-amber-300" : ""}>
          {unsolved
            ? "plan has no solution"
            : delta
              ? `${signed(delta.machines)} (plan total ${num(plan?.machinesTotal ?? 0)})`
              : `about ${route.pre.machinesBuilt} for this route`}
        </dd>
        <dt className="text-[var(--mc-ink-muted)]">EU/t</dt>
        <dd className={!unsolved && delta && delta.euT < 0 ? "text-emerald-300" : !unsolved && delta && delta.euT > 0 ? "text-amber-300" : ""}>
          {unsolved
            ? "plan has no solution"
            : delta
              ? `${signed(delta.euT, 0)} (plan total ${num(plan?.totalEuT ?? 0, 0)})`
              : `about ${num(route.pre.euT, 0)} for this route`}
        </dd>
        <dt className="text-[var(--mc-ink-muted)]">New imports</dt>
        <dd>{imports.length === 0 ? "none" : imports.map((i) => `${i.name} ${num(i.perSecond, 2)}/s`).join(", ")}</dd>
        <dt className="text-[var(--mc-ink-muted)]">Byproducts</dt>
        <dd>
          {route.pre.byproducts.length === 0
            ? "none"
            : [
                used.length > 0 ? `used: ${used.map((b) => b.name).join(", ")}` : "",
                spare.length > 0 ? `unused: ${spare.map((b) => b.name).join(", ")}` : "",
              ]
                .filter(Boolean)
                .join("; ")}
        </dd>
      </dl>
      {route.warnings.length > 0 ? (
        <p className="mt-1 text-red-300" data-testid="route-why">
          Why it fails: {route.warnings.join(" ")}
        </p>
      ) : null}
    </li>
  );
}
