import type {
  FactoryEdge,
  FactoryNode,
  FactoryStorage,
  MachineTier,
  Recipe,
} from "@/lib/model/types";

/** "What makes X": the one question the engine asks the recipe book. */
export interface RecipeSource {
  /**
   * Recipes that make `resource`, best match first. Results may be summary
   * grade (slots, amounts, ticks, EU, handlers); `hydrate` upgrades the few
   * that survive to the full objects a board card needs.
   */
  producersOf(
    resource: { kind: "item" | "fluid"; id: string },
    opts: { limit: number; maxTier?: string },
  ): Promise<Recipe[]>;
  hydrate?(recipes: Recipe[]): Promise<Recipe[]>;
}

export interface RouteTarget {
  kind: "item" | "fluid";
  id: string;
}

export interface DiscoverOptions {
  /** Backward search depth below the target's producer (1 = producer only). */
  depth: number;
  /** Producers kept per unmet input at every level. */
  beam: number;
  /** Producers of the target itself that get expanded. */
  rootLimit: number;
  /** Routes the cheap pre-score keeps for the full-plan solve. */
  topK: number;
  /** Solve past topK (up to 3x) until this many routes keep the plan's targets. */
  minPassing: number;
  /** Cap on routes built from one root recipe. */
  routesPerRoot: number;
  /** Rows asked of the recipe book per resource. */
  fetchLimit: number;
  /** Highest machine tier a route may use; defaults to the plan's own highest. */
  maxTier?: Exclude<MachineTier, "DEMO">;
  /** Resources treated as always available ("fluid:water"). */
  freeResources: string[];
  /** Machine types (recipe.machineType) that never appear in a route. */
  blockedMachineTypes: string[];
  /** Resources the route may not use ("item:..." / "fluid:..."). */
  blockedResources: string[];
  /** Keep non-GregTech recipe kinds (bees, crops, ores ...). */
  allowNonMachineRecipes: boolean;
  /** Cards to replace; default is picked from who makes the target (see buildPlanContext). */
  replaceNodeIds?: string[];
  /** Skip the full-plan solves (pre-score only). */
  skipFullEvaluation: boolean;
  /** "demand": consumed by the plan (fallback produced); "produced": what the producers make now. */
  rate: "demand" | "produced";
}

export const DEFAULT_DISCOVER_OPTIONS: DiscoverOptions = {
  depth: 2,
  beam: 3,
  rootLimit: 24,
  topK: 5,
  minPassing: 2,
  routesPerRoot: 4,
  fetchLimit: 200,
  freeResources: ["fluid:water", "fluid:air"],
  // Cell <-> fluid conversion is a detour, not a route.
  blockedMachineTypes: ["Tank", "Canner"],
  blockedResources: [],
  allowNonMachineRecipes: false,
  skipFullEvaluation: false,
  rate: "demand",
};

/** One recipe of a route with the resource each consumed input is read as. */
export interface RouteStep {
  recipe: Recipe;
  /** Resource key bound to each recipe.inputs slot; undefined when not consumed. */
  inputKeys: Array<string | undefined>;
}

export interface RouteCandidate {
  id: string;
  /** Root first: the step that makes the target. */
  steps: RouteStep[];
  /** Resources the route draws from outside itself (plan stock or new imports). */
  externalInputs: string[];
}

export interface FlowLine {
  key: string;
  name: string;
  perSecond: number;
}

export interface RoutePreScore {
  /** Machines needed, fractional, per recipe id. */
  machines: Record<string, number>;
  machinesTotal: number;
  /** ceil per recipe */
  machinesBuilt: number;
  euT: number;
  /** Inputs the plan already has (made in it, imported, or free). */
  planInputs: FlowLine[];
  /** Inputs nothing in the plan provides. */
  newImports: FlowLine[];
  byproducts: Array<FlowLine & { planConsumes: boolean }>;
  /** Outputs of the replaced cards the plan uses that this route does not make. */
  lost: FlowLine[];
  /** Lower is better. A heuristic ordering, not a prediction. */
  score: number;
  feasible: boolean;
}

export interface PlanMetrics {
  /** Machines by machine type (ceil of the solved count). */
  machinesByType: Record<string, number>;
  machinesTotal: number;
  totalEuT: number;
  imports: FlowLine[];
  surplus: FlowLine[];
  /** Drawers with a typed target the solve does not reach. */
  targetsMissed: string[];
  targetsMet: boolean;
  /** The solve itself failed (pinned counts, or targets nothing can reach). */
  solveFailed: boolean;
}

export interface RouteOptionDraft {
  label: string;
  /** Recipes the nodes use; merge into the project's recipe list. */
  recipes: Recipe[];
  nodes: FactoryNode[];
  storages: FactoryStorage[];
  edges: FactoryEdge[];
  /** Cards of the route being replaced; the option switch turns these off. */
  replacesNodeIds: string[];
  /** Existing wires re-created from the new route (the old ones stay). */
  rewiredEdgeIds: string[];
}

export interface RouteResult {
  candidate: RouteCandidate;
  label: string;
  pre: RoutePreScore;
  /** Absent when the full solve was skipped or failed. */
  plan?: PlanMetrics;
  delta?: {
    machines: number;
    euT: number;
    importsAdded: FlowLine[];
    importsRemoved: FlowLine[];
  };
  draft?: RouteOptionDraft;
  warnings: string[];
}

export interface DiscoverTimings {
  /** Wall time of recipe-book calls (dataset I/O), summed. */
  ioMs: number;
  ioCalls: number;
  searchMs: number;
  preScoreMs: number;
  fullEvalMs: number;
  fullEvalCount: number;
  baselineSolveMs: number;
  hydrateMs: number;
  totalMs: number;
}

export interface LevelStat {
  level: number;
  resource: string;
  fetched: number;
  afterFilter: number;
  afterDedupe: number;
}

export interface DiscoverResult {
  target: string;
  /** Rate of the target the routes are sized for, per second. */
  rate: number;
  rateBasis: string;
  replacedNodeIds: string[];
  maxTier: string;
  baseline?: PlanMetrics;
  routes: RouteResult[];
  candidatesBuilt: number;
  levels: LevelStat[];
  timings: DiscoverTimings;
}
