import { isRecipeInputConsumed } from "@/lib/model/resources";
import type { FactoryProject, Recipe, ThroughputResult } from "@/lib/model/types";
import { calculateThroughput } from "@/lib/solver";
import { recipeTierIndex, resourceKey } from "./machine-rate";
import {
  buildPlanContext,
  inputCandidateKeys,
  type PlanContext,
} from "./plan-context";
import { preScoreRoute } from "./route-lp";
import {
  DEFAULT_DISCOVER_OPTIONS,
  type DiscoverOptions,
  type DiscoverResult,
  type DiscoverTimings,
  type FlowLine,
  type LevelStat,
  type PlanMetrics,
  type RecipeSource,
  type RouteCandidate,
  type RouteResult,
  type RouteStep,
  type RouteTarget,
} from "./types";
import { layRouteOnProject } from "./wire";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const EMPTY_CELL = "item:ic2:itemcellempty";

/** A partly built route: one recipe and, per input slot, how that input is met. */
interface Option {
  recipe: Recipe;
  inputKeys: Array<string | undefined>;
  /** Sub-recipes feeding this one's inputs (absent = taken from outside). */
  children: Option[];
  /** Keys taken from outside the route. */
  external: string[];
}

interface SearchState {
  ctx: PlanContext;
  opts: DiscoverOptions;
  source: RecipeSource;
  cache: Map<string, Promise<Recipe[]>>;
  timings: DiscoverTimings;
  levels: LevelStat[];
  replacedRecipeIds: Set<string>;
  blockedResources: Set<string>;
  blockedMachines: Set<string>;
  inflight: number;
  ioSince: number;
}

function splitKey(key: string) {
  const colon = key.indexOf(":");
  return { kind: key.slice(0, colon) as "item" | "fluid", id: key.slice(colon + 1) };
}

/** Net amount of `keys` a recipe hands over per operation (chance counted, own consumption netted). */
function netMade(recipe: Recipe, keys: string[]): number {
  let made = 0;
  for (const output of recipe.outputs) {
    if (keys.includes(resourceKey(output))) made += output.amount * (output.chance ?? 1);
  }
  for (const input of recipe.inputs) {
    if (isRecipeInputConsumed(input) && inputCandidateKeys(input).some((key) => keys.includes(key))) {
      made -= input.amount;
    }
  }
  return made;
}

function usable(state: SearchState, recipe: Recipe, keys: string[], path: Set<string>): boolean {
  const { opts, ctx } = state;
  if (recipe.power) return false;
  if (!opts.allowNonMachineRecipes && recipe.kind && recipe.kind !== "gregtech_machine") return false;
  if (state.blockedMachines.has(recipe.machineType)) return false;
  if (recipeTierIndex(recipe) > ctx.maxTierIndex) return false;
  if (netMade(recipe, keys) <= 1e-9) return false;
  for (const input of recipe.inputs) {
    if (!isRecipeInputConsumed(input)) continue;
    const candidates = inputCandidateKeys(input);
    if (candidates.some((key) => state.blockedResources.has(key))) return false;
    // Cycle guard: a route may not need what it is trying to make.
    if (candidates.some((key) => path.has(key))) return false;
  }
  return true;
}

/** Near-identical recipes (same machine, same consumed inputs and outputs; circuit variants) collapse to the cheapest. */
function dedupe(recipes: Recipe[]): Recipe[] {
  const best = new Map<string, Recipe>();
  for (const recipe of recipes) {
    // The machine is not part of the signature: a singleblock and its multiblock twin
    // with the same slots are one choice (the lower tier, then the plainer machine, wins).
    const sig = [
      recipe.inputs
        .filter(isRecipeInputConsumed)
        .map((i) => `${resourceKey(i)}x${i.amount}`)
        .sort()
        .join(","),
      recipe.outputs.map((o) => `${resourceKey(o)}x${o.amount}`).sort().join(","),
    ].join("|");
    const held = best.get(sig);
    const better =
      !held ||
      recipeTierIndex(recipe) < recipeTierIndex(held) ||
      (recipeTierIndex(recipe) === recipeTierIndex(held) &&
        recipe.machineType.length < held.machineType.length);
    if (better) best.set(sig, recipe);
  }
  return [...best.values()];
}

/** Lower is better. Cheap, input-availability driven; the LP and the full solve do the real judging. */
function rankRecipe(state: SearchState, recipe: Recipe, keys: string[]): number {
  const { ctx } = state;
  const consumed = recipe.inputs.filter(isRecipeInputConsumed);
  const unmet = consumed.filter((i) => ctx.matchAvailable(inputCandidateKeys(i)) === undefined).length;
  const outputs = recipe.outputs;
  const primary = outputs.findIndex((o) => keys.includes(resourceKey(o)));
  const wanted = outputs.filter(
    (o, i) => i !== primary && (ctx.consumedPerSecond.get(resourceKey(o)) ?? 0) > 1e-9,
  ).length;
  const companionBonus = ctx.companions.filter((c) =>
    outputs.some((o) => resourceKey(o) === c.key),
  ).length * 2.5;
  return (
    unmet * 1.5 +
    consumed.length * 0.3 +
    recipeTierIndex(recipe) * 0.25 +
    (recipe.kind === "gregtech_machine" || !recipe.kind ? 0 : 1.5) +
    (primary > 0 ? 0.7 : 0) +
    (consumed.some((i) => resourceKey(i) === EMPTY_CELL) ? 0.8 : 0) +
    (outputs.length - 1) * 0.15 -
    Math.min(3, wanted) * 1.2 -
    companionBonus
  );
}

async function producers(
  state: SearchState,
  keys: string[],
  level: number,
  path: Set<string>,
): Promise<Recipe[]> {
  const concrete = keys.filter((key) => !key.includes("oredict:")).slice(0, 2);
  const lookup = concrete.length ? concrete : keys.slice(0, 1);
  const all: Recipe[] = [];
  for (const key of lookup) {
    let pending = state.cache.get(key);
    if (!pending) {
      // ioMs is wall time with at least one question in flight (overlapping questions count once).
      if (state.inflight === 0) state.ioSince = now();
      state.inflight += 1;
      pending = state.source
        .producersOf(splitKey(key), { limit: state.opts.fetchLimit, maxTier: state.ctx.maxTierName })
        .finally(() => {
          state.timings.ioCalls += 1;
          state.inflight -= 1;
          if (state.inflight === 0) state.timings.ioMs += now() - state.ioSince;
        });
      state.cache.set(key, pending);
    }
    all.push(...(await pending));
  }
  const unique = [...new Map(all.map((recipe) => [recipe.id, recipe])).values()];
  for (const recipe of unique) {
    for (const slot of [...recipe.inputs, ...recipe.outputs]) {
      for (const r of [slot, ...(slot.alternatives ?? [])]) {
        const key = resourceKey(r);
        if (r.displayName && !state.ctx.names.has(key)) state.ctx.names.set(key, r.displayName);
      }
    }
  }
  const filtered = unique.filter(
    (recipe) => !state.replacedRecipeIds.has(recipe.id) && usable(state, recipe, keys, path),
  );
  const deduped = dedupe(filtered);
  state.levels.push({
    level,
    resource: keys[0],
    fetched: unique.length,
    afterFilter: filtered.length,
    afterDedupe: deduped.length,
  });
  return deduped
    .map((recipe) => ({ recipe, rank: rankRecipe(state, recipe, keys) }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.recipe);
}

/**
 * Ways to make `keys`, best first. `levels` is how many producer layers may
 * still be added below this one. `product` enumerates input combinations
 * (root only); otherwise each recipe gets its single best sub-route.
 */
async function expand(
  state: SearchState,
  keys: string[],
  levels: number,
  path: Set<string>,
  limit: number,
  product: boolean,
  depth: number,
): Promise<Option[]> {
  const candidates = (await producers(state, keys, depth, path)).slice(0, limit);
  const options: Option[] = [];
  const innerPath = new Set([...path, ...keys]);

  // Work out every recipe's unmet inputs first, then ask the recipe book about all of
  // them at once: a browser source pays a round trip per question.
  interface Prepared {
    recipe: Recipe;
    bound: Array<string | undefined>;
    external: string[];
    groups: Map<string, number[]>;
  }
  const prepared: Prepared[] = candidates.map((recipe) => {
    // Slots grouped by the resource they ask for, so one unmet resource is met once.
    const groups = new Map<string, number[]>();
    const bound: Array<string | undefined> = recipe.inputs.map(() => undefined);
    const external: string[] = [];
    recipe.inputs.forEach((input, slot) => {
      if (!isRecipeInputConsumed(input)) return;
      const cands = inputCandidateKeys(input);
      const have = state.ctx.matchAvailable(cands);
      if (have !== undefined) {
        bound[slot] = have;
        external.push(have);
        return;
      }
      const group = cands.join("|");
      groups.set(group, [...(groups.get(group) ?? []), slot]);
    });
    return { recipe, bound, external, groups };
  });
  const subSearches = new Map<string, Promise<Option[]>>();
  if (levels > 1) {
    for (const item of prepared) {
      for (const group of item.groups.keys()) {
        if (!subSearches.has(group)) {
          subSearches.set(
            group,
            expand(state, group.split("|"), levels - 1, innerPath, state.opts.beam, false, depth + 1),
          );
        }
      }
    }
  }
  await Promise.all(subSearches.values());

  for (const { recipe, bound, external, groups } of prepared) {
    // Choices per unmet group: sub-producers (best first), then "import it".
    const choiceLists: Array<{ slots: number[]; cands: string[]; subs: Option[] }> = [];
    for (const [group, slots] of groups) {
      choiceLists.push({
        slots,
        cands: group.split("|"),
        subs: (await subSearches.get(group)) ?? [],
      });
    }

    const build = (picks: number[]): Option => {
      const inputKeys = [...bound];
      const children: Option[] = [];
      const ext = [...external];
      choiceLists.forEach((choice, g) => {
        const pick = picks[g];
        if (pick < choice.subs.length) {
          const sub = choice.subs[pick];
          const made = sub.recipe.outputs
            .map(resourceKey)
            .find((key) => choice.cands.includes(key)) as string;
          choice.slots.forEach((slot) => (inputKeys[slot] = made));
          children.push(sub);
        } else {
          choice.slots.forEach((slot) => (inputKeys[slot] = choice.cands[0]));
          ext.push(choice.cands[0]);
        }
      });
      return { recipe, inputKeys, children, external: ext };
    };

    if (!product || choiceLists.length === 0) {
      options.push(build(choiceLists.map(() => 0)));
      continue;
    }
    // Root: combinations best-first by total pick index, capped.
    const sizes = choiceLists.map((choice) => choice.subs.length + 1);
    const combos: number[][] = [];
    const walk = (at: number, acc: number[]) => {
      if (combos.length > 400) return;
      if (at === sizes.length) return void combos.push(acc);
      for (let pick = 0; pick < sizes[at]; pick++) walk(at + 1, [...acc, pick]);
    };
    walk(0, []);
    combos.sort((a, b) => a.reduce((x, y) => x + y, 0) - b.reduce((x, y) => x + y, 0));
    for (const combo of combos.slice(0, state.opts.routesPerRoot)) options.push(build(combo));
  }
  return options;
}

function flatten(option: Option): RouteCandidate {
  const steps: RouteStep[] = [];
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (node: Option) => {
    if (!seen.has(node.recipe.id)) {
      seen.add(node.recipe.id);
      steps.push({ recipe: node.recipe, inputKeys: node.inputKeys });
    }
    node.external.forEach((key) => external.add(key));
    node.children.forEach(visit);
  };
  visit(option);
  const externalInputs = [...external].sort();
  return {
    // Two routes on the same recipes are one route, however an oredict slot was read.
    id: steps.map((step) => step.recipe.id).sort().join("+"),
    steps,
    externalInputs,
  };
}

export function summarizePlan(project: FactoryProject, result: ThroughputResult): PlanMetrics {
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const machinesByType: Record<string, number> = {};
  let machinesTotal = 0;
  for (const node of project.nodes) {
    if (!node.enabled) continue;
    const recipe = recipes.get(node.recipeId);
    const nodeResult = result.nodes[node.id];
    if (!recipe || !nodeResult || recipe.power) continue;
    if (recipe.kind && recipe.kind !== "gregtech_machine" && recipe.kind !== "custom") continue;
    if (recipe.machineType === "Tank") continue;
    const count = project.solveMode
      ? Math.ceil(nodeResult.theoreticalMachinesRequired - 1e-6)
      : nodeResult.utilization > 1e-3
        ? node.machineCount
        : 0;
    if (count <= 0) continue;
    machinesByType[recipe.machineType] = (machinesByType[recipe.machineType] ?? 0) + count;
    machinesTotal += count;
  }
  const line = (key: string, name: string | undefined, perSecond: number): FlowLine => ({
    key,
    name: name ?? key.slice(key.indexOf(":") + 1),
    perSecond,
  });
  const imports = result.externalInputs
    .map((b) => line(b.key, b.displayName, Math.max(b.importedPerSecond, b.deficitPerSecond)))
    .filter((entry) => entry.perSecond > 1e-7);
  const surplus = result.unconsumedOutputs
    .map((b) => line(b.key, b.displayName, b.surplusPerSecond))
    .filter((entry) => entry.perSecond > 1e-7);
  const targetsMissed: string[] = [];
  for (const storage of project.storages ?? []) {
    const target = storage.targetPerSecond;
    const mode = storage.targetMode ?? storage.poolTargetMode;
    if (!target || target <= 0 || mode === "ignore" || mode === "at-most") continue;
    const stored = result.storages[storage.id];
    const reached = Math.max(stored?.producedPerSecond ?? 0, stored?.netPerSecond ?? 0);
    if (!stored || stored.targetUnreachable || reached < target * 0.995) {
      targetsMissed.push(storage.displayName ?? storage.resourceId);
    }
  }
  const failed = Boolean(result.solveStatus?.failed || result.solveStatus?.pinsInfeasible);
  return {
    machinesByType,
    machinesTotal,
    totalEuT: result.totalEuT,
    imports,
    surplus,
    targetsMissed: failed && targetsMissed.length === 0 ? ["(solve failed)"] : targetsMissed,
    targetsMet: !failed && targetsMissed.length === 0,
    solveFailed: failed,
  };
}

function diffLines(after: FlowLine[], before: FlowLine[]) {
  const was = new Map(before.map((entry) => [entry.key, entry.perSecond]));
  const added = after.filter((entry) => entry.perSecond > (was.get(entry.key) ?? 0) + 1e-6);
  const nowKeys = new Map(after.map((entry) => [entry.key, entry.perSecond]));
  const removed = before.filter((entry) => (nowKeys.get(entry.key) ?? 0) < entry.perSecond - 1e-6);
  return { added, removed };
}

function labelFor(route: RouteCandidate, ctx: PlanContext): string {
  const nameOf = (r: { kind: string; id: string; displayName?: string }) =>
    r.displayName ?? ctx.names.get(resourceKey(r)) ?? r.id;
  const describe = (recipe: Recipe) => {
    const ins = recipe.inputs.filter(isRecipeInputConsumed).map(nameOf);
    const outs = recipe.outputs.map(nameOf);
    const clip = (list: string[]) => (list.length > 2 ? `${list.slice(0, 2).join(" + ")} +${list.length - 2}` : list.join(" + "));
    return `${recipe.machineType}: ${clip(ins)} > ${clip(outs)}`;
  };
  const [root, ...rest] = route.steps;
  return rest.length
    ? `${describe(root.recipe)}  (fed by ${rest.map((step) => step.recipe.machineType + " > " + nameOf(step.recipe.outputs[0])).join(", ")})`
    : describe(root.recipe);
}

export interface DiscoverInput {
  project: FactoryProject;
  target: RouteTarget;
  source: RecipeSource;
  options?: Partial<DiscoverOptions>;
  /** The plan's solved books, when the caller already has them. */
  result?: ThroughputResult;
  /** Called at each phase and after each full solve; cheap, never throws into the search. */
  onProgress?: (progress: DiscoverProgress) => void;
  /** Polled between steps; true stops the search with a DiscoverCancelled error. */
  isCancelled?: () => boolean;
}

export type DiscoverPhase = "baseline" | "search" | "score" | "evaluate" | "done";

export interface DiscoverProgress {
  phase: DiscoverPhase;
  /** Candidate routes built so far (known once the search ends). */
  candidates: number;
  /** Routes solved against the whole plan so far. */
  evaluated: number;
  ms: number;
}

export class DiscoverCancelled extends Error {
  constructor() {
    super("Route search cancelled.");
    this.name = "DiscoverCancelled";
  }
}

/**
 * Other ways to make `target` out of what the plan already has, ranked on the
 * whole plan. Pure of UI: it reads the recipe book through `source`, solves
 * the plan with the repo's own solver, and returns drafts a board can add.
 */
export async function discoverRoutes(input: DiscoverInput): Promise<DiscoverResult> {
  const opts: DiscoverOptions = { ...DEFAULT_DISCOVER_OPTIONS, ...input.options };
  const started = now();
  const timings: DiscoverTimings = {
    ioMs: 0,
    ioCalls: 0,
    searchMs: 0,
    preScoreMs: 0,
    fullEvalMs: 0,
    fullEvalCount: 0,
    baselineSolveMs: 0,
    hydrateMs: 0,
    totalMs: 0,
  };

  let candidates = 0;
  let evaluated = 0;
  const report = (phase: DiscoverPhase) => {
    try {
      input.onProgress?.({ phase, candidates, evaluated, ms: now() - started });
    } catch {
      // A broken listener must not break the search.
    }
  };
  const checkCancelled = () => {
    if (input.isCancelled?.()) throw new DiscoverCancelled();
  };
  const cancellable = (source: RecipeSource): RecipeSource => ({
    async producersOf(resource, query) {
      checkCancelled();
      return source.producersOf(resource, query);
    },
    hydrate: source.hydrate
      ? async (recipes) => {
          checkCancelled();
          return source.hydrate!(recipes);
        }
      : undefined,
  });

  report("baseline");
  let result = input.result;
  if (!result) {
    const t = now();
    result = calculateThroughput(input.project);
    timings.baselineSolveMs = now() - t;
  }
  const ctx = buildPlanContext(input.project, result, input.target, opts);
  const replacedRecipeIds = new Set(
    input.project.nodes.filter((n) => ctx.replacedNodeIds.includes(n.id)).map((n) => n.recipeId),
  );
  const state: SearchState = {
    ctx,
    opts,
    source: cancellable(input.source),
    cache: new Map(),
    timings,
    levels: [],
    replacedRecipeIds,
    blockedResources: new Set(opts.blockedResources),
    blockedMachines: new Set(opts.blockedMachineTypes),
    inflight: 0,
    ioSince: 0,
  };
  const baseline = summarizePlan(input.project, result);

  // 1. Backward search.
  report("search");
  const searchStart = now();
  const ioBefore = timings.ioMs;
  const roots = await expand(
    state,
    [ctx.targetKey],
    opts.depth,
    new Set([ctx.targetKey]),
    opts.rootLimit,
    true,
    1,
  );
  const unique = new Map<string, RouteCandidate>();
  for (const root of roots) {
    const route = flatten(root);
    if (!unique.has(route.id)) unique.set(route.id, route);
  }
  timings.searchMs = now() - searchStart - (timings.ioMs - ioBefore);

  // 2. Cheap pre-score.
  candidates = unique.size;
  checkCancelled();
  report("score");
  const scoreStart = now();
  const scored = [...unique.values()]
    .map((route) => ({ route, pre: preScoreRoute(route, ctx) }))
    .filter((entry) => entry.pre.feasible)
    .sort((a, b) => a.pre.score - b.pre.score);
  timings.preScoreMs = now() - scoreStart;

  // 3. Full-plan evaluation of the best K.
  // At most two routes per root recipe, so one cheap recipe's variants do not fill the list.
  const perRoot = new Map<string, number>();
  const queue: typeof scored = [];
  for (const entry of scored) {
    const root = entry.route.steps[0].recipe.id;
    if ((perRoot.get(root) ?? 0) >= 2) continue;
    perRoot.set(root, (perRoot.get(root) ?? 0) + 1);
    queue.push(entry);
  }
  // Solve the best K; if fewer than `minPassing` of them keep the plan whole, keep going
  // down the list (up to 3K solves) so the answer is never a page of broken plans.
  const maxSolves = opts.skipFullEvaluation ? opts.topK : opts.topK * 3;
  let passing = 0;
  const routes: RouteResult[] = [];
  report("evaluate");
  for (const { route, pre } of queue) {
    checkCancelled();
    if (routes.length >= opts.topK && (passing >= opts.minPassing || routes.length >= maxSolves)) break;
    let finalRoute = route;
    if (input.source.hydrate && !opts.skipFullEvaluation) {
      const t = now();
      const full = await input.source.hydrate(route.steps.map((step) => step.recipe));
      timings.hydrateMs += now() - t;
      const byId = new Map(full.map((recipe) => [recipe.id, recipe]));
      finalRoute = {
        ...route,
        steps: route.steps.map((step) => ({ ...step, recipe: byId.get(step.recipe.id) ?? step.recipe })),
      };
    }
    const label = labelFor(finalRoute, ctx);
    const entry: RouteResult = { candidate: finalRoute, label, pre, warnings: [] };
    const lostNote = pre.lost.length
      ? `Does not make ${pre.lost.map((l) => `${l.name} (${l.perSecond.toFixed(2)}/s used)`).join(", ")}; the plan must get it elsewhere.`
      : undefined;
    if (lostNote && opts.skipFullEvaluation) entry.warnings.push(lostNote);
    if (!opts.skipFullEvaluation) {
      const t = now();
      try {
        const laid = layRouteOnProject(ctx, finalRoute, pre, label);
        const solved = calculateThroughput(laid.project);
        entry.plan = summarizePlan(laid.project, solved);
        entry.draft = laid.draft;
        const imports = diffLines(entry.plan.imports, baseline.imports);
        entry.delta = {
          machines: entry.plan.machinesTotal - baseline.machinesTotal,
          euT: entry.plan.totalEuT - baseline.totalEuT,
          importsAdded: imports.added,
          importsRemoved: imports.removed,
        };
        if (!entry.plan.targetsMet) {
          entry.warnings.push(`Plan targets missed: ${entry.plan.targetsMissed.join(", ")}.`);
          if (entry.plan.solveFailed) {
            entry.warnings.push("Pinned machines or targets in the plan cannot be met with this route.");
          }
          if (lostNote) entry.warnings.push(lostNote);
        }
      } catch (error) {
        entry.warnings.push(`Full solve failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      timings.fullEvalMs += now() - t;
      timings.fullEvalCount += 1;
      if (entry.plan?.targetsMet) passing += 1;
    }
    routes.push(entry);
    evaluated = routes.length;
    report("evaluate");
    // Let a cancel message in between the solves of a worker.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  // Final order: routes that keep the plan's targets first, then by the whole-plan cost.
  const cost = (r: RouteResult) =>
    r.plan && r.delta
      ? (r.plan.targetsMet ? 0 : 1e6) +
        r.delta.machines +
        r.delta.euT / 100 +
        6 * r.delta.importsAdded.length -
        2 * r.delta.importsRemoved.length
      : 1e9 + r.pre.score;
  routes.sort((a, b) => cost(a) - cost(b));

  timings.totalMs = now() - started;
  report("done");
  return {
    target: ctx.targetKey,
    rate: ctx.rate,
    rateBasis: ctx.rateBasis,
    replacedNodeIds: ctx.replacedNodeIds,
    maxTier: ctx.maxTierName,
    baseline,
    routes,
    candidatesBuilt: unique.size,
    levels: state.levels,
    timings,
  };
}
