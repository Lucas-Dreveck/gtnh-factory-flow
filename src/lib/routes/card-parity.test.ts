import { beforeEach, describe, expect, it } from "vitest";
import { makeResourceHandleId } from "@/components/flow/resource-handles";
import {
  PROJECT_SCHEMA_VERSION,
  type FactoryNode,
  type FactoryProject,
  type Recipe,
} from "@/lib/model/types";
import { createRecipeNode } from "@/lib/model/recipe-node";
import { calculateThroughput } from "@/lib/solver";
import { createEmptyProject } from "@/examples";
import { useFactoryStore } from "@/store/factory-store";
import { machineRate, routeNodeFor } from "./machine-rate";

// GT++ "Multiblock Electrolyzer" (Industrial Electrolyzer): speed x2.8, EU x0.9, 4 parallels per voltage tier.
const multiblock = (minimumTier: string, eut: number): Recipe => ({
  id: `mb-${minimumTier}-${eut}`,
  name: "Multiblock Electrolyzer: Salt",
  kind: "gregtech_machine",
  machineType: "Multiblock Electrolyzer",
  minimumTier,
  durationTicks: 200,
  eut,
  inputs: [{ kind: "item", id: "salt", amount: 2, displayName: "Salt" }],
  outputs: [
    { kind: "item", id: "sodium", amount: 1, displayName: "Sodium" },
    { kind: "fluid", id: "chlorine", amount: 1000, displayName: "Chlorine" },
  ],
});

function solveOne(recipe: Recipe, node: FactoryNode): number {
  const handle = (side: "input" | "output", kind: "item" | "fluid", id: string, slot?: number) =>
    makeResourceHandleId(side, { kind, id }, slot);
  const project: FactoryProject = {
    ...createEmptyProject(),
    solveMode: true,
    recipes: [recipe],
    nodes: [{ ...node, id: "card" }],
    storages: [
      { id: "in", kind: "item", resourceId: "salt", position: { x: 0, y: 0 } },
      {
        id: "out",
        kind: "fluid",
        resourceId: "chlorine",
        drainMode: "product",
        targetPerSecond: 40,
        targetMode: "exact",
        position: { x: 900, y: 0 },
      },
      { id: "by", kind: "item", resourceId: "sodium", drainMode: "byproduct", position: { x: 900, y: 200 } },
    ],
    edges: [
      {
        id: "e1",
        source: "in",
        target: "card",
        sourceHandle: handle("output", "item", "salt"),
        targetHandle: handle("input", "item", "salt", 0),
        resourceKind: "item",
        resourceId: "salt",
      },
      {
        id: "e2",
        source: "card",
        target: "out",
        sourceHandle: handle("output", "fluid", "chlorine", 1),
        targetHandle: handle("input", "fluid", "chlorine"),
        resourceKind: "fluid",
        resourceId: "chlorine",
      },
      {
        id: "e3",
        source: "card",
        target: "by",
        sourceHandle: handle("output", "item", "sodium", 0),
        targetHandle: handle("input", "item", "sodium"),
        resourceKind: "item",
        resourceId: "sodium",
      },
    ],
  };
  return calculateThroughput(project).nodes.card.theoreticalMachinesRequired;
}

describe("cards the route engine builds match cards the recipe search places", () => {
  beforeEach(() => {
    useFactoryStore.getState().setProject(createEmptyProject());
  });

  it.each([
    ["LV", 30],
    ["MV", 90],
    // Declared tier below what the EU/t needs: the search card keeps the declared one.
    ["LV", 120],
  ])("Multiblock Electrolyzer %s %i EU/t: same card, same machines required", (tier, eut) => {
    const recipe = multiblock(tier, eut);
    const store = useFactoryStore.getState();
    store.addNodeForRecipeObject(recipe);
    const placed = useFactoryStore.getState().project.nodes[0];
    const engine = routeNodeFor(recipe, "card");

    const shape = ({ id, position, ...rest }: FactoryNode) => rest;
    expect(shape(engine)).toEqual(shape(placed));
    expect(engine.overclockTier).toBe(placed.overclockTier);
    expect(engine.machineHandlerId).toBe(placed.machineHandlerId);
    expect(engine.machineConfigTiers).toBe(placed.machineConfigTiers);
    expect(engine.parallel).toBe(placed.parallel);

    const viaSearch = solveOne(recipe, placed);
    const viaEngine = solveOne(recipe, engine);
    expect(viaEngine).toBeCloseTo(viaSearch, 9);
    expect(viaSearch).toBeGreaterThan(0);
    const unseeded = solveOne(recipe, createRecipeNode(recipe, { id: "card", position: { x: 0, y: 0 } }));
    // Why the hatch seed matters: a bare multiblock card (no power budget) is sized with
    // far fewer parallels, so it would need several times the machines.
    expect(unseeded).toBeGreaterThan(viaSearch * 2);

    // The pre-score's one-machine rate is what the board's solve implies:
    // chlorine needed / (chlorine one machine makes per second).
    const rate = machineRate(recipe);
    expect(40 / (rate.outputPerOp[1] * rate.opsPerSecond)).toBeCloseTo(viaSearch, 6);
  });
});
