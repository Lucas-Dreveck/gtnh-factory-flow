import type {
  FactoryEdge,
  FactoryProject,
  ResourceAmount,
  ThroughputResult,
} from "@/lib/model/types";
import type {
  AssistantBoardDrawer,
  AssistantBoardEdge,
  AssistantBoardNode,
  AssistantBoardSnapshot,
} from "./types";

/**
 * How many cards, wires and drawers the model is shown. A board can hold
 * thousands; the answer gets worse, not better, once the prompt is mostly
 * card list, and the request has to stay small enough to send on every ask.
 */
export const SNAPSHOT_NODE_LIMIT = 60;
export const SNAPSHOT_EDGE_LIMIT = 120;
export const SNAPSHOT_DRAWER_LIMIT = 40;
/** Slots per side in the photo: a recipe with forty outputs says nothing more. */
const SLOT_LIMIT = 6;

/**
 * The board as the assistant reads it: names, counts, wires and whatever the
 * solve had to say, no positions, no icons, no runtime tables. Ids are the
 * real card ids, so an action that comes back can be checked against the
 * board it was built from.
 */
export function buildAssistantBoardSnapshot(
  project: FactoryProject,
  result: ThroughputResult | undefined,
): AssistantBoardSnapshot {
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const nodes: AssistantBoardNode[] = project.nodes.slice(0, SNAPSHOT_NODE_LIMIT).map((node) => {
    const recipe = recipesById.get(node.recipeId);
    const books = result?.nodes[node.id];
    return {
      id: node.id,
      recipeName: recipe?.name ?? node.recipeId,
      machine: recipe?.machineType ?? "unknown",
      machineCount: node.machineCount,
      tier: String(node.overclockTier ?? recipe?.minimumTier ?? "?"),
      euPerTick: books?.euT === undefined ? undefined : round(books.euT),
      takes: (recipe?.inputs ?? []).slice(0, SLOT_LIMIT).map(slotLabel),
      makes: (recipe?.outputs ?? []).slice(0, SLOT_LIMIT).map(slotLabel),
    };
  });

  const edges: AssistantBoardEdge[] = project.edges.slice(0, SNAPSHOT_EDGE_LIMIT).map((edge) => ({
    from: edge.source,
    to: edge.target,
    resource: edgeResourceLabel(edge, project),
    perSecond: result?.edges[edge.id]?.transferredPerSecond,
  }));

  const drawers: AssistantBoardDrawer[] = (project.storages ?? [])
    .slice(0, SNAPSHOT_DRAWER_LIMIT)
    .map((storage) => ({
      id: storage.id,
      resource: storage.displayName ?? storage.resourceId,
      role: drawerRole(storage.id, project.edges),
      targetPerSecond: storage.targetPerSecond,
    }));

  return {
    planName: project.name,
    mode: project.poolMode ? "pool" : project.solveMode ? "solve" : "build",
    nodeCount: project.nodes.length,
    edgeCount: project.edges.length,
    nodes,
    edges,
    drawers,
    notes: buildNotes(project, result),
  };
}

/**
 * The lines about the whole board: total power, what it still has to be fed,
 * what nobody takes, and every verdict the solve raised. These are what a
 * question like "why is this short" is actually answered from.
 */
function buildNotes(project: FactoryProject, result: ThroughputResult | undefined): string[] {
  const notes: string[] = [];
  if (project.nodes.length > SNAPSHOT_NODE_LIMIT) {
    notes.push(
      `Only the first ${SNAPSHOT_NODE_LIMIT} of ${project.nodes.length} cards are listed here.`,
    );
  }
  if (!result) {
    return notes;
  }
  if (result.stale) {
    notes.push("These numbers are from the previous solve; the plan changed since.");
  }
  notes.push(`Total power draw ${round(result.totalEuT)} EU/t.`);
  const inputs = result.externalInputs.slice(0, 10);
  if (inputs.length > 0) {
    notes.push(
      `Still has to be fed: ${inputs
        .map((entry) => `${balanceName(entry)} ${round(entry.deficitPerSecond || entry.consumedPerSecond)}/s`)
        .join(", ")}.`,
    );
  }
  const spare = result.unconsumedOutputs.slice(0, 10);
  if (spare.length > 0) {
    notes.push(
      `Nobody takes: ${spare
        .map((entry) => `${balanceName(entry)} ${round(entry.surplusPerSecond || entry.producedPerSecond)}/s`)
        .join(", ")}.`,
    );
  }
  for (const bottleneck of result.bottlenecks.slice(0, 12)) {
    notes.push(`${bottleneck.severity === "critical" ? "Critical" : "Warning"}: ${bottleneck.message}`);
  }
  return notes;
}

/**
 * A drawer with no wire into it is a source, one with no wire out of it is a
 * product, and one with both is a buffer in the middle. Read off the wires
 * rather than off `drainMode`, which only speaks for drains.
 */
function drawerRole(storageId: string, edges: FactoryEdge[]): AssistantBoardDrawer["role"] {
  const fed = edges.some((edge) => edge.target === storageId);
  const drawn = edges.some((edge) => edge.source === storageId);
  if (fed && drawn) return "buffer";
  return fed ? "product" : "source";
}

function slotLabel(slot: ResourceAmount): string {
  return `${slot.displayName ?? slot.id} x${slot.amount}`;
}

function edgeResourceLabel(edge: FactoryEdge, project: FactoryProject): string {
  if (edge.label) {
    return edge.label;
  }
  const named = (project.storages ?? []).find((storage) => storage.resourceId === edge.resourceId);
  return named?.displayName ?? edge.resourceId;
}

function balanceName(balance: { displayName?: string; resourceId: string }): string {
  return balance.displayName ?? balance.resourceId;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
