import { solveLpAuto } from "@/lib/solver/lp-engine";
import type { LinearProgram } from "@/lib/solver/simplex";
import { machineRate, type MachineRate } from "./machine-rate";
import type { PlanContext } from "./plan-context";
import type { FlowLine, RouteCandidate, RoutePreScore } from "./types";

const EPS = 1e-9;
/** Machines are the unit of cost; imports are priced well below one machine per unit/s. */
const IMPORT_COST_PLAN = 0.002;
const IMPORT_COST_NEW = 0.02;

const rateCache = new WeakMap<object, MachineRate>();
export function cachedMachineRate(recipe: RouteCandidate["steps"][number]["recipe"]): MachineRate {
  let rate = rateCache.get(recipe);
  if (!rate) {
    rate = machineRate(recipe);
    rateCache.set(recipe, rate);
  }
  return rate;
}

const infeasible = (): RoutePreScore => ({
  machines: {},
  machinesTotal: 0,
  machinesBuilt: 0,
  euT: 0,
  planInputs: [],
  newImports: [],
  byproducts: [],
  lost: [],
  score: Number.POSITIVE_INFINITY,
  feasible: false,
});

/**
 * Route-local LP: how fast each recipe of the route must run (operations per
 * second) to hand the plan `ctx.rate` of the target, drawing only on the
 * route's own recipes and its declared external inputs. One balance row per
 * resource (produced + imported - consumed = surplus), imports allowed only
 * for resources the route takes from outside. Minimizes machines, with
 * imports priced below a machine so a shared intermediate is made, not bought.
 */
export function preScoreRoute(route: RouteCandidate, ctx: PlanContext): RoutePreScore {
  const steps = route.steps;
  const rates = steps.map((step) => cachedMachineRate(step.recipe));

  const keyIndex = new Map<string, number>();
  const keys: string[] = [];
  const touch = (key: string) => {
    if (!keyIndex.has(key)) {
      keyIndex.set(key, keys.length);
      keys.push(key);
    }
    return keyIndex.get(key)!;
  };
  touch(ctx.targetKey);
  steps.forEach((step, i) => {
    step.inputKeys.forEach((key) => key && touch(key));
    step.recipe.outputs.forEach((output) => touch(`${output.kind}:${output.id}`));
    void i;
  });

  const importable = route.externalInputs.filter((key) => keyIndex.has(key) && key !== ctx.targetKey);
  const n = steps.length;
  const uBase = n;
  const sBase = n + importable.length;
  const total = sBase + keys.length;

  const maximize = new Array<number>(total).fill(0);
  steps.forEach((_, i) => {
    maximize[i] = -1 / Math.max(EPS, rates[i].opsPerSecond);
  });
  importable.forEach((key, j) => {
    maximize[uBase + j] = -(ctx.isFree(key)
      ? 0
      : ctx.matchAvailable([key]) !== undefined
        ? IMPORT_COST_PLAN
        : IMPORT_COST_NEW);
  });

  const equalities: LinearProgram["equalities"] = [];
  keys.forEach((key, k) => {
    const coefficients = new Map<number, number>();
    const put = (column: number, value: number) =>
      coefficients.set(column, (coefficients.get(column) ?? 0) + value);
    steps.forEach((step, i) => {
      step.recipe.outputs.forEach((output, j) => {
        if (`${output.kind}:${output.id}` === key) put(i, rates[i].outputPerOp[j]);
      });
      step.recipe.inputs.forEach((_, j) => {
        if (step.inputKeys[j] === key) put(i, -(rates[i].inputPerOp[j]?.amount ?? 0));
      });
    });
    const importColumn = importable.indexOf(key);
    if (importColumn >= 0) put(uBase + importColumn, 1);
    put(sBase + k, -1);
    equalities.push({ coefficients, rhs: 0 });
  });

  const upperBounds: LinearProgram["upperBounds"] = [
    { coefficients: new Map([[sBase + keyIndex.get(ctx.targetKey)!, -1]]), rhs: -ctx.rate },
  ];

  const solution = solveLpAuto({ maximize, equalities, upperBounds });
  if (solution.status !== "optimal") return infeasible();
  const x = solution.x;

  const machines: Record<string, number> = {};
  let machinesTotal = 0;
  let machinesBuilt = 0;
  let euT = 0;
  steps.forEach((step, i) => {
    const m = Math.max(0, x[i]) / Math.max(EPS, rates[i].opsPerSecond);
    machines[step.recipe.id] = (machines[step.recipe.id] ?? 0) + m;
    machinesTotal += m;
    machinesBuilt += m > 1e-7 ? Math.max(1, Math.ceil(m - 1e-7)) : 0;
    euT += m * rates[i].euT;
  });

  const line = (key: string, perSecond: number): FlowLine => ({
    key,
    name: ctx.names.get(key) ?? key.slice(key.indexOf(":") + 1),
    perSecond,
  });
  const planInputs: FlowLine[] = [];
  const newImports: FlowLine[] = [];
  importable.forEach((key, j) => {
    const amount = x[uBase + j];
    if (amount <= 1e-7) return;
    if (ctx.matchAvailable([key]) !== undefined) planInputs.push(line(key, amount));
    else newImports.push(line(key, amount));
  });
  const byproducts: RoutePreScore["byproducts"] = [];
  keys.forEach((key, k) => {
    if (key === ctx.targetKey) return;
    const amount = x[sBase + k];
    if (amount <= 1e-7) return;
    byproducts.push({ ...line(key, amount), planConsumes: (ctx.consumedPerSecond.get(key) ?? 0) > 1e-9 });
  });

  const made = new Set(steps.flatMap((step) => step.recipe.outputs.map((o) => `${o.kind}:${o.id}`)));
  const lost: FlowLine[] = ctx.companions
    .filter((entry) => !made.has(entry.key))
    .map((entry) => line(entry.key, entry.perSecond));
  // A companion the plan can still get elsewhere costs little; one nothing else makes costs a lot.
  // Empty cells and the like are carried everywhere; they rebuild nothing.
  const spare = byproducts.map((b) => b.key).filter((key) => key !== "item:ic2:itemcellempty");
  const lostPenalty = lost.reduce(
    (sum, entry) =>
      sum +
      (ctx.recoverable(entry.key, spare) ? 1 : ctx.matchAvailable([entry.key]) !== undefined ? 3 : 12),
    0,
  );

  const score =
    lostPenalty +
    machinesBuilt +
    euT / 100 +
    6 * newImports.length +
    0.5 * planInputs.filter((entry) => !ctx.isFree(entry.key)).length -
    2 * byproducts.filter((b) => b.planConsumes).length +
    0.3 * byproducts.filter((b) => !b.planConsumes).length;

  return { machines, machinesTotal, machinesBuilt, euT, planInputs, newImports, byproducts, lost, score, feasible: true };
}
