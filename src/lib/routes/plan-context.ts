import { isRecipeInputConsumed } from "@/lib/model/resources";
import { isVoltageTierName } from "@/lib/model/tiers";
import type {
  FactoryNode,
  FactoryProject,
  Recipe,
  ResourceAmount,
  ThroughputResult,
} from "@/lib/model/types";
import { resourceKey, tierIndex } from "./machine-rate";
import type { DiscoverOptions, RouteTarget } from "./types";

const ANY_DAMAGE = "@32767";

/** The same node ids a card runs (its own recipe plus a shared machine's extra sections). */
export function nodeRecipeIds(node: FactoryNode): string[] {
  return [node.recipeId, ...(node.extraRecipes ?? []).map((section) => section.recipeId)];
}

/** Keys an input slot can be satisfied by: itself and its oredict members, same kind only. */
export function inputCandidateKeys(input: ResourceAmount): string[] {
  const keys = [resourceKey(input)];
  for (const alternative of input.alternatives ?? []) {
    if (alternative.kind === input.kind) keys.push(resourceKey(alternative));
  }
  return keys;
}

export interface PlanContext {
  project: FactoryProject;
  result: ThroughputResult;
  target: RouteTarget;
  targetKey: string;
  /** Cards whose recipe makes the target while running: the route being replaced. */
  replacedNodeIds: string[];
  /** Highest voltage tier index used by an enabled card. */
  maxTierIndex: number;
  maxTierName: string;
  rate: number;
  rateBasis: string;
  names: Map<string, string>;
  /** What the plan consumes per second, by resource key (credit for byproducts). */
  consumedPerSecond: Map<string, number>;
  /** Resources the plan imports today. */
  importedKeys: Set<string>;
  /**
   * Other outputs of the replaced cards that the plan uses today (per second).
   * A route that does not make them leaves its consumers to other sources.
   */
  companions: Array<{ key: string; perSecond: number }>;
  /** Resource a plan source can hand over for this key, or undefined. */
  matchAvailable(candidates: string[]): string | undefined;
  /** Whether a card already in the plan turns one of `fromKeys` into `key` (a lost output the route's leftovers can rebuild). */
  recoverable(key: string, fromKeys: string[]): boolean;
  isFree(key: string): boolean;
}

function baseOf(id: string): string {
  const at = id.indexOf("@");
  return at < 0 ? id : id.slice(0, at);
}

export function buildPlanContext(
  project: FactoryProject,
  result: ThroughputResult,
  target: RouteTarget,
  options: Pick<DiscoverOptions, "freeResources" | "rate" | "maxTier"> & { replaceNodeIds?: string[] },
): PlanContext {
  const targetKey = resourceKey(target);
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));

  // Producers of the target while the plan runs, with the target's real flow.
  const producersNow: Array<{ id: string; flow: number; primary: boolean }> = [];
  for (const node of project.nodes) {
    if (!node.enabled) continue;
    const nodeResult = result.nodes[node.id];
    const flow = nodeResult?.outputs[targetKey as keyof typeof nodeResult.outputs]?.amountPerSecond ?? 0;
    const actual = flow * Math.min(1, Math.max(0, nodeResult?.utilization ?? 0));
    if (actual <= 1e-9) continue;
    const recipe = recipesById.get(node.recipeId);
    const first = recipe?.outputs[0];
    producersNow.push({
      id: node.id,
      flow: actual,
      primary: Boolean(first && resourceKey(first) === targetKey),
    });
  }
  // The route being replaced: every card whose main product is the target; when
  // the target is only ever a byproduct, the single biggest source. Cards that
  // make it on the side stay (they run for their own product).
  let replaced: string[];
  if (options.replaceNodeIds) {
    replaced = options.replaceNodeIds.filter((id) => producersNow.some((p) => p.id === id));
  } else if (producersNow.some((p) => p.primary)) {
    replaced = producersNow.filter((p) => p.primary).map((p) => p.id);
  } else {
    const biggest = [...producersNow].sort((a, b) => b.flow - a.flow)[0];
    replaced = biggest ? [biggest.id] : [];
  }
  const replacedFlow = producersNow
    .filter((p) => replaced.includes(p.id))
    .reduce((sum, p) => sum + p.flow, 0);
  const replacedSet = new Set(replaced);

  // Names and tiers.
  const names = new Map<string, string>();
  const noteName = (r: { kind: string; id: string; displayName?: string }) => {
    if (r.displayName) names.set(resourceKey(r), r.displayName);
  };
  for (const recipe of project.recipes) {
    recipe.inputs.forEach(noteName);
    recipe.outputs.forEach(noteName);
  }
  for (const storage of project.storages ?? []) {
    noteName({ kind: storage.kind, id: storage.resourceId, displayName: storage.displayName });
  }

  let maxTierIndex = 0;
  let maxTierName = "ULV";
  for (const node of project.nodes) {
    if (!node.enabled || !isVoltageTierName(node.overclockTier)) continue;
    const index = tierIndex(node.overclockTier);
    if (index > maxTierIndex) {
      maxTierIndex = index;
      maxTierName = node.overclockTier;
    }
  }
  if (options.maxTier) {
    maxTierIndex = tierIndex(options.maxTier);
    maxTierName = options.maxTier;
  }

  // Availability.
  const exact = new Set<string>();
  const itemBases = new Map<string, string>(); // base id -> a key carrying it
  const wildBases = new Map<string, string>(); // base id -> wildcard key
  const add = (r: { kind: string; id: string }) => {
    const key = resourceKey(r);
    exact.add(key);
    if (r.kind === "item") {
      if (r.id.endsWith(ANY_DAMAGE)) wildBases.set(baseOf(r.id), key);
      else itemBases.set(baseOf(r.id), key);
    }
  };
  // Cards fed (through any chain of wires) by the replaced cards cannot vouch for
  // a resource: their output only exists while the target does, so a route that
  // leans on it would feed itself.
  const downstream = new Set<string>();
  const queue = [...replaced];
  while (queue.length) {
    const from = queue.pop()!;
    for (const edge of project.edges) {
      if (edge.source === from && !downstream.has(edge.target) && !replacedSet.has(edge.target)) {
        downstream.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  for (const node of project.nodes) {
    if (!node.enabled || replacedSet.has(node.id) || downstream.has(node.id)) continue;
    for (const id of nodeRecipeIds(node)) {
      const recipe = recipesById.get(id);
      if (!recipe || recipe.power) continue;
      recipe.outputs.forEach(add);
    }
  }
  const inbound = new Set(project.edges.map((edge) => edge.target));
  for (const storage of project.storages ?? []) {
    if (!inbound.has(storage.id) && !downstream.has(storage.id)) add({ kind: storage.kind, id: storage.resourceId });
  }
  const importedKeys = new Set<string>();
  for (const balance of result.externalInputs) {
    importedKeys.add(balance.key);
    add({ kind: balance.kind, id: balance.resourceId });
  }
  const free = new Set(options.freeResources);
  for (const key of free) {
    const colon = key.indexOf(":");
    add({ kind: key.slice(0, colon), id: key.slice(colon + 1) });
  }

  const matchAvailable = (candidates: string[]): string | undefined => {
    for (const key of candidates) {
      if (exact.has(key)) return key;
    }
    for (const key of candidates) {
      if (!key.startsWith("item:")) continue;
      const id = key.slice(5);
      if (id.endsWith(ANY_DAMAGE)) {
        const hit = itemBases.get(baseOf(id));
        if (hit) return hit;
      } else {
        const hit = wildBases.get(baseOf(id));
        if (hit) return hit;
      }
    }
    return undefined;
  };

  const consumedPerSecond = new Map<string, number>();
  for (const [key, balance] of Object.entries(result.resources)) {
    consumedPerSecond.set(key, balance.consumedPerSecond);
  }

  const balance = result.resources[targetKey as keyof typeof result.resources];
  let rate = 0;
  let rateBasis = "";
  if (options.rate === "demand" && (balance?.consumedPerSecond ?? 0) > 1e-9) {
    rate = balance.consumedPerSecond;
    rateBasis = "consumed by the plan";
  } else if ((balance?.producedPerSecond ?? 0) > 1e-9) {
    rate = balance.producedPerSecond;
    rateBasis = options.rate === "demand" ? "produced (nothing consumes it)" : "produced";
  } else {
    rate = 1;
    rateBasis = "assumed 1/s (the plan makes none)";
  }

  const companionFlow = new Map<string, number>();
  for (const id of replaced) {
    const nodeResult = result.nodes[id];
    const utilization = Math.min(1, Math.max(0, nodeResult?.utilization ?? 0));
    for (const [key, flow] of Object.entries(nodeResult?.outputs ?? {})) {
      if (key === targetKey) continue;
      companionFlow.set(key, (companionFlow.get(key) ?? 0) + flow.amountPerSecond * utilization);
    }
  }
  const companions = [...companionFlow]
    .map(([key, made]) => ({ key, perSecond: Math.min(made, consumedPerSecond.get(key) ?? 0) }))
    .filter((entry) => entry.perSecond > 1e-7);

  if (replacedFlow > 0 && rate > replacedFlow) {
    rate = replacedFlow;
    rateBasis += ", capped at what the replaced cards make";
  }

  const recoverable = (key: string, fromKeys: string[]): boolean =>
    project.nodes.some((node) => {
      if (!node.enabled || replacedSet.has(node.id)) return false;
      const recipe = recipesById.get(node.recipeId);
      if (!recipe || recipe.power) return false;
      return (
        recipe.outputs.some((o) => resourceKey(o) === key) &&
        recipe.inputs.some(
          (input) =>
            isRecipeInputConsumed(input) &&
            inputCandidateKeys(input).some((candidate) => fromKeys.includes(candidate)),
        )
      );
    });

  return {
    project,
    result,
    target,
    targetKey,
    replacedNodeIds: replaced,
    maxTierIndex,
    maxTierName,
    rate,
    rateBasis,
    names,
    consumedPerSecond,
    importedKeys,
    companions,
    matchAvailable,
    recoverable,
    isFree: (key) => free.has(key),
  };
}

export function consumedInputs(recipe: Recipe) {
  return recipe.inputs
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => isRecipeInputConsumed(input));
}
