import { applyRouteChoices, SOLVER_PICKS } from "@/lib/model/route-choices";
import type { FactoryProject, ResourceBalance, RouteChoice, ThroughputResult } from "@/lib/model/types";
import { calculateThroughput } from "./throughput";

/**
 * Route comparison: solve the WHOLE plan once per option of one choice (that
 * option active, every other choice left as the player set it) and once with
 * all options on ("solver"). Metrics stay separate on purpose: there is no
 * combined score, only which option is lower per metric.
 */

export type RouteSolve = (project: FactoryProject) => ThroughputResult;

export interface MachineGroup {
  machineType: string;
  tier: string;
  count: number;
}

export interface ResourceRate {
  resource: string;
  name: string;
  perSecond: number;
}

export interface RouteDelta {
  machines: number;
  euT: number;
  /** Positive: more than the option the plan currently runs. */
  imports: ResourceRate[];
  surplus: ResourceRate[];
  machinesByType: MachineGroup[];
}

export interface RouteColumn {
  /** An option id, or "solver". */
  id: string;
  label: string;
  targetsMet: boolean;
  unmetTargets: string[];
  machinesByType: MachineGroup[];
  totalMachines: number;
  totalEuT: number;
  imports: ResourceRate[];
  surplus: ResourceRate[];
  /** Change versus the option the plan currently runs. */
  delta: RouteDelta;
  /** Solver column only: how much of each option ran, summed over its cards. */
  optionUse?: { optionId: string; label: string; machines: number; share: number }[];
}

export type RouteMetric = "totalMachines" | "totalEuT" | "imports" | "surplus";

export interface RouteComparison {
  choiceId: string;
  /** Column id the deltas are measured against. */
  baselineId: string;
  columns: RouteColumn[];
  /** Per metric, the option ids (never "solver") with the lowest value. Empty when all tie. */
  cheapest: Record<RouteMetric, string[]>;
  elapsedMs: number;
}

const EPS = 1e-6;

type Summary = Omit<RouteColumn, "id" | "label" | "delta" | "optionUse">;

export function summarizeRoute(project: FactoryProject, result: ThroughputResult): Summary {
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const groups = new Map<string, MachineGroup>();
  let totalMachines = 0;
  for (const node of project.nodes) {
    const books = result.nodes[node.id];
    if (!books || !books.enabled || books.status === "disabled" || books.status === "missing-recipe") continue;
    if (!(books.utilization > EPS)) continue;
    const count = books.theoreticalMachinesRequired;
    if (!(count > EPS)) continue;
    const machineType = recipes.get(node.recipeId)?.machineType ?? "unknown";
    const tier = String(node.overclockTier);
    const key = `${machineType}|${tier}`;
    const group = groups.get(key) ?? { machineType, tier, count: 0 };
    group.count += count;
    groups.set(key, group);
    totalMachines += count;
  }
  const unmetTargets: string[] = [];
  for (const storage of project.storages ?? []) {
    if (result.storages[storage.id]?.targetUnreachable) {
      unmetTargets.push(storage.displayName ?? storage.resourceId);
    }
  }
  return {
    targetsMet: unmetTargets.length === 0,
    unmetTargets,
    machinesByType: [...groups.values()].sort((a, b) => b.count - a.count),
    totalMachines,
    totalEuT: result.totalEuT,
    imports: rates(result.externalInputs, (b) => b.importedPerSecond),
    surplus: rates(result.unconsumedOutputs, (b) => b.surplusPerSecond),
  };
}

function rates(list: ResourceBalance[], pick: (balance: ResourceBalance) => number): ResourceRate[] {
  const out: ResourceRate[] = [];
  for (const balance of list) {
    const perSecond = pick(balance);
    if (perSecond > EPS) {
      out.push({ resource: balance.key, name: balance.displayName ?? balance.resourceId, perSecond });
    }
  }
  return out.sort((a, b) => b.perSecond - a.perSecond);
}

function diffRates(a: ResourceRate[], base: ResourceRate[]): ResourceRate[] {
  const map = new Map<string, ResourceRate>();
  for (const r of base) map.set(r.resource, { ...r, perSecond: -r.perSecond });
  for (const r of a) {
    const prev = map.get(r.resource);
    map.set(r.resource, { ...r, perSecond: r.perSecond + (prev?.perSecond ?? 0) });
  }
  return [...map.values()]
    .filter((r) => Math.abs(r.perSecond) > EPS)
    .sort((x, y) => Math.abs(y.perSecond) - Math.abs(x.perSecond));
}

function diffMachines(a: MachineGroup[], base: MachineGroup[]): MachineGroup[] {
  const map = new Map<string, MachineGroup>();
  for (const g of base) map.set(`${g.machineType}|${g.tier}`, { ...g, count: -g.count });
  for (const g of a) {
    const key = `${g.machineType}|${g.tier}`;
    map.set(key, { ...g, count: g.count + (map.get(key)?.count ?? 0) });
  }
  return [...map.values()]
    .filter((g) => Math.abs(g.count) > EPS)
    .sort((x, y) => Math.abs(y.count) - Math.abs(x.count));
}

function withActive(project: FactoryProject, choiceId: string, active: string): FactoryProject {
  return {
    ...project,
    routeChoices: (project.routeChoices ?? []).map((c) => (c.id === choiceId ? { ...c, active } : c)),
  };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** The runs a comparison needs: one per option, then the solver's. */
export function routeRuns(choice: RouteChoice): { id: string; label: string }[] {
  return [
    ...choice.options.map((option) => ({ id: option.id, label: option.label })),
    { id: SOLVER_PICKS, label: "Solver picks" },
  ];
}

/** Builds the comparison from finished per-column solves. */
export function buildComparison(
  project: FactoryProject,
  choice: RouteChoice,
  results: Map<string, ThroughputResult>,
  elapsedMs: number,
): RouteComparison {
  const runs = routeRuns(choice);
  const summaries = new Map<string, Summary>();
  for (const run of runs) {
    const result = results.get(run.id);
    if (result) summaries.set(run.id, summarizeRoute(withActive(project, choice.id, run.id), result));
  }
  const baselineId = summaries.has(choice.active) ? choice.active : SOLVER_PICKS;
  const base = summaries.get(baselineId)!;
  const columns: RouteColumn[] = [];
  for (const run of runs) {
    const summary = summaries.get(run.id);
    if (!summary) continue;
    const column: RouteColumn = {
      ...summary,
      id: run.id,
      label: run.label,
      delta: {
        machines: summary.totalMachines - base.totalMachines,
        euT: summary.totalEuT - base.totalEuT,
        imports: diffRates(summary.imports, base.imports),
        surplus: diffRates(summary.surplus, base.surplus),
        machinesByType: diffMachines(summary.machinesByType, base.machinesByType),
      },
    };
    if (run.id === SOLVER_PICKS) {
      const result = results.get(SOLVER_PICKS)!;
      const use = choice.options.map((option) => {
        let machines = 0;
        for (const id of option.nodeIds) {
          const books = result.nodes[id];
          if (books?.enabled && books.utilization > EPS) machines += books.theoreticalMachinesRequired;
        }
        return { optionId: option.id, label: option.label, machines, share: 0 };
      });
      const sum = use.reduce((n, u) => n + u.machines, 0);
      for (const u of use) u.share = sum > EPS ? u.machines / sum : 0;
      column.optionUse = use;
    }
    columns.push(column);
  }
  const optionCols = columns.filter((c) => c.id !== SOLVER_PICKS);
  const lowest = (value: (c: RouteColumn) => number): string[] => {
    if (optionCols.length < 2) return [];
    const vals = optionCols.map(value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const tol = 1e-4 * Math.max(1, Math.abs(max));
    if (max - min <= tol) return [];
    return optionCols.filter((_, i) => vals[i] - min <= tol).map((c) => c.id);
  };
  const sumRates = (list: ResourceRate[]) => list.reduce((n, r) => n + r.perSecond, 0);
  return {
    choiceId: choice.id,
    baselineId,
    columns,
    cheapest: {
      totalMachines: lowest((c) => c.totalMachines),
      totalEuT: lowest((c) => c.totalEuT),
      imports: lowest((c) => sumRates(c.imports)),
      surplus: lowest((c) => sumRates(c.surplus)),
    },
    elapsedMs,
  };
}

export function compareRouteChoice(
  project: FactoryProject,
  choiceId: string,
  solve: RouteSolve = calculateThroughput,
): RouteComparison {
  const choice = project.routeChoices?.find((c) => c.id === choiceId);
  if (!choice) throw new Error(`Unknown route choice ${choiceId}`);
  const started = nowMs();
  const results = new Map<string, ThroughputResult>();
  for (const run of routeRuns(choice)) {
    results.set(run.id, solve(applyRouteChoices(withActive(project, choice.id, run.id))));
  }
  return buildComparison(project, choice, results, nowMs() - started);
}

/** Same answer, yielding to the event loop between solves so the board stays responsive. */
export async function compareRouteChoiceAsync(
  project: FactoryProject,
  choiceId: string,
  solve: RouteSolve = calculateThroughput,
  isCancelled: () => boolean = () => false,
): Promise<RouteComparison | undefined> {
  const choice = project.routeChoices?.find((c) => c.id === choiceId);
  if (!choice) return undefined;
  const started = nowMs();
  const results = new Map<string, ThroughputResult>();
  for (const run of routeRuns(choice)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (isCancelled()) return undefined;
    results.set(run.id, solve(applyRouteChoices(withActive(project, choice.id, run.id))));
  }
  return buildComparison(project, choice, results, nowMs() - started);
}
