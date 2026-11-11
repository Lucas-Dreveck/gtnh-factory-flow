import type { FactoryProject } from "@/lib/model/types";

export interface PlanDiff {
  /** Recipe names (with a count when several) present in `to` but not `from`. */
  addedCards: string[];
  removedCards: string[];
  cardsAdded: number;
  cardsRemoved: number;
  wiresAdded: number;
  wiresRemoved: number;
  drawersAdded: number;
  drawersRemoved: number;
  unchanged: boolean;
}

type DiffInput = Pick<FactoryProject, "nodes" | "edges" | "recipes" | "storages">;

function cardNames(plan: DiffInput): Map<string, number> {
  const names = new Map(plan.recipes.map((recipe) => [recipe.id, recipe.name]));
  const counts = new Map<string, number>();
  for (const node of plan.nodes) {
    const name = names.get(node.recipeId) ?? node.recipeId;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function surplus(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [name, count] of a) {
    const extra = count - (b.get(name) ?? 0);
    if (extra > 0) out.push(extra > 1 ? `${name} x${extra}` : name);
  }
  return out.sort((x, y) => x.localeCompare(y));
}

function idSurplus(a: { id: string }[], b: { id: string }[]): number {
  const ids = new Set(b.map((item) => item.id));
  return a.filter((item) => !ids.has(item.id)).length;
}

/**
 * What changing from the plan `from` to the plan `to` would add and remove.
 * Cards are matched by recipe name and count (card ids differ between
 * copies); wires and drawers by id.
 */
export function diffPlans(from: DiffInput, to: DiffInput): PlanDiff {
  const a = cardNames(from);
  const b = cardNames(to);
  const addedCards = surplus(b, a);
  const removedCards = surplus(a, b);
  const fromStorages = from.storages ?? [];
  const toStorages = to.storages ?? [];
  const result = {
    addedCards,
    removedCards,
    cardsAdded: addedCardTotal(b, a),
    cardsRemoved: addedCardTotal(a, b),
    wiresAdded: idSurplus(to.edges, from.edges),
    wiresRemoved: idSurplus(from.edges, to.edges),
    drawersAdded: idSurplus(toStorages, fromStorages),
    drawersRemoved: idSurplus(fromStorages, toStorages),
  };
  return {
    ...result,
    unchanged:
      addedCards.length === 0 &&
      removedCards.length === 0 &&
      result.wiresAdded + result.wiresRemoved + result.drawersAdded + result.drawersRemoved === 0,
  };
}

function addedCardTotal(a: Map<string, number>, b: Map<string, number>): number {
  let total = 0;
  for (const [name, count] of a) total += Math.max(0, count - (b.get(name) ?? 0));
  return total;
}

/** "+3 / -1 cards" for a revision's card count against the current plan. */
export function cardDeltaLabel(revisionCards: number, currentCards: number): string {
  const delta = revisionCards - currentCards;
  if (delta === 0) return "same cards";
  return `${delta > 0 ? "+" : "-"}${Math.abs(delta)} cards`;
}
