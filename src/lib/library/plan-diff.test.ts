import { describe, expect, it } from "vitest";
import type { FactoryProject } from "@/lib/model/types";
import { cardDeltaLabel, diffPlans } from "./plan-diff";

function plan(
  cards: Array<[string, string]>,
  edges: string[] = [],
  storages: string[] = [],
): Pick<FactoryProject, "nodes" | "edges" | "recipes" | "storages"> {
  return {
    recipes: [...new Set(cards.map(([, r]) => r))].map((id) => ({ id, name: `Recipe ${id}` })),
    nodes: cards.map(([id, recipeId]) => ({ id, recipeId })),
    edges: edges.map((id) => ({ id })),
    storages: storages.map((id) => ({ id })),
  } as never;
}

describe("diffPlans", () => {
  it("reports nothing for identical plans, ignoring card ids", () => {
    const a = plan([["n1", "a"]], ["e1"], ["s1"]);
    const b = plan([["n9", "a"]], ["e1"], ["s1"]);
    expect(diffPlans(a, b).unchanged).toBe(true);
  });

  it("names added and removed recipes with counts", () => {
    const current = plan([["1", "a"], ["2", "b"]]);
    const old = plan([["1", "a"], ["3", "c"], ["4", "c"]]);
    const diff = diffPlans(current, old);
    expect(diff.addedCards).toEqual(["Recipe c x2"]);
    expect(diff.removedCards).toEqual(["Recipe b"]);
    expect(diff.cardsAdded).toBe(2);
    expect(diff.cardsRemoved).toBe(1);
  });

  it("counts wires and drawers by id", () => {
    const diff = diffPlans(plan([], ["e1", "e2"], ["s1"]), plan([], ["e2", "e3", "e4"], []));
    expect([diff.wiresAdded, diff.wiresRemoved]).toEqual([2, 1]);
    expect([diff.drawersAdded, diff.drawersRemoved]).toEqual([0, 1]);
    expect(diff.unchanged).toBe(false);
  });
});

describe("cardDeltaLabel", () => {
  it("signs the difference", () => {
    expect(cardDeltaLabel(5, 3)).toBe("+2 cards");
    expect(cardDeltaLabel(1, 3)).toBe("-2 cards");
    expect(cardDeltaLabel(3, 3)).toBe("same cards");
  });
});
