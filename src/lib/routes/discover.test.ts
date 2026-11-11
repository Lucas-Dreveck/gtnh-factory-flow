import { describe, expect, it } from "vitest";
import { makeResourceHandleId } from "@/components/flow/resource-handles";
import {
  PROJECT_SCHEMA_VERSION,
  type FactoryProject,
  type Recipe,
  type RecipeInput,
  type RecipeOutput,
} from "@/lib/model/types";
import { discoverRoutes } from "./discover";
import type { RecipeSource } from "./types";

const fluid = (id: string, amount: number): RecipeInput & RecipeOutput => ({
  kind: "fluid",
  id,
  amount,
  displayName: id,
});
const item = (id: string, amount: number): RecipeInput & RecipeOutput => ({
  kind: "item",
  id,
  amount,
  displayName: id,
});

function recipe(
  id: string,
  machineType: string,
  tier: string,
  eut: number,
  inputs: RecipeInput[],
  outputs: RecipeOutput[],
): Recipe {
  return {
    id,
    name: `${machineType}: ${id}`,
    kind: "gregtech_machine",
    machineType,
    minimumTier: tier,
    durationTicks: 100,
    eut,
    inputs,
    outputs,
  };
}

// The plan: Salt -> Electrolyzer -> Sodium + Chlorine; chlorine -> Reactor -> plastic (target 2/s).
const electrolyzer = recipe("electrolyzer-salt", "Electrolyzer", "LV", 30, [item("salt", 2)], [
  item("sodium", 1),
  fluid("chlorine", 1000),
]);
const reactor = recipe("reactor-plastic", "Chemical Reactor", "LV", 30, [fluid("chlorine", 1000)], [
  fluid("plastic", 1000),
]);

// What the recipe book knows about chlorine and what its makers need.
const plant = recipe("plant-saltwater", "Chemical Plant", "LV", 30, [fluid("saltwater", 1000)], [
  fluid("chlorine", 1000),
  item("naoh", 3),
]);
const mixer = recipe("mixer-saltwater", "Mixer", "LV", 8, [item("salt", 1), fluid("water", 1000)], [
  fluid("saltwater", 1000),
]);
const evPlant = recipe("evplant", "Electrolyzer", "EV", 2000, [fluid("brine", 1000)], [
  fluid("chlorine", 4000),
]);
// A loop: saltwater from chlorine, chlorine from saltwater.
const loopMaker = recipe("loop-saltwater", "Mixer", "LV", 8, [fluid("chlorine", 500)], [
  fluid("saltwater", 500),
]);
// The same reaction under another circuit: collapses to one.
const plantCircuit2: Recipe = { ...plant, id: "plant-saltwater-c2" };

const BOOK: Record<string, Recipe[]> = {
  "fluid:chlorine": [electrolyzer, plant, plantCircuit2, evPlant],
  "fluid:saltwater": [mixer, loopMaker],
  "item:naoh": [plant],
};

function fakeSource(calls: string[] = []): RecipeSource {
  return {
    async producersOf(resource) {
      const key = `${resource.kind}:${resource.id}`;
      calls.push(key);
      return BOOK[key] ?? [];
    },
  };
}

function plan(): FactoryProject {
  const node = (id: string, recipeId: string, x: number) => ({
    id,
    recipeId,
    machineCount: 1,
    parallel: 1,
    overclockTier: "LV",
    enabled: true,
    position: { x, y: 0 },
  });
  const drawer = (id: string, kind: "item" | "fluid", resourceId: string, extra: object = {}) => ({
    id,
    kind,
    resourceId,
    position: { x: 0, y: 200 },
    ...extra,
  });
  const edge = (
    id: string,
    source: string,
    target: string,
    kind: "item" | "fluid",
    rid: string,
    sourceSlot?: number,
    targetSlot?: number,
  ) => ({
    id,
    source,
    target,
    sourceHandle: makeResourceHandleId("output", { kind, id: rid }, sourceSlot),
    targetHandle: makeResourceHandleId("input", { kind, id: rid }, targetSlot),
    resourceKind: kind,
    resourceId: rid,
  });
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "p",
    name: "tiny",
    solveMode: true,
    recipes: [electrolyzer, reactor],
    nodes: [node("n-elec", electrolyzer.id, 400), node("n-react", reactor.id, 900)],
    storages: [
      drawer("s-salt", "item", "salt"),
      drawer("s-sodium", "item", "sodium", { drainMode: "byproduct" }),
      drawer("s-plastic", "fluid", "plastic", {
        drainMode: "product",
        targetPerSecond: 2,
        targetMode: "exact",
      }),
      drawer("s-cl", "fluid", "chlorine", { bufferMode: "overflow" }),
    ],
    edges: [
      edge("e1", "s-salt", "n-elec", "item", "salt", undefined, 0),
      edge("e2", "n-elec", "s-sodium", "item", "sodium"),
      edge("e3", "n-elec", "s-cl", "fluid", "chlorine"),
      edge("e4", "s-cl", "n-react", "fluid", "chlorine"),
      edge("e5", "n-react", "s-plastic", "fluid", "plastic"),
    ],
    fuelProfiles: [],
  } as unknown as FactoryProject;
}

const target = { kind: "fluid" as const, id: "chlorine" };

describe("route discovery on a tiny plan", () => {
  it("finds the salt-water route, wires it and judges it on the whole plan", async () => {
    const result = await discoverRoutes({ project: plan(), target, source: fakeSource() });
    expect(result.replacedNodeIds).toEqual(["n-elec"]);
    const route = result.routes.find((r) =>
      r.candidate.steps.some((step) => step.recipe.id === mixer.id),
    );
    expect(route, "plant fed by mixer").toBeDefined();
    expect(route!.candidate.steps.map((step) => step.recipe.id)).toEqual([plant.id, mixer.id]);

    // Pre-score: water is free, salt is already in the plan, naoh is a byproduct.
    expect(route!.pre.newImports).toEqual([]);
    expect(route!.pre.planInputs.map((entry) => entry.key)).toContain("item:salt");
    expect(route!.pre.byproducts.map((entry) => entry.key)).toContain("item:naoh");
    // The reactor eats one chlorine per plastic: the plastic target of 2/s.
    expect(result.rate).toBeCloseTo(2, 6);

    // The plan stays whole with the route in place of the electrolyzer.
    expect(route!.plan?.targetsMet).toBe(true);
    const draft = route!.draft!;
    expect(draft.replacesNodeIds).toEqual(["n-elec"]);
    expect(draft.nodes).toHaveLength(2);
    const [plantNode, mixerNode] = draft.nodes;
    const between = (from: string, to: string) =>
      draft.edges.find((entry) => entry.source === from && entry.target === to);
    expect(between(mixerNode.id, plantNode.id)?.resourceId).toBe("saltwater");
    expect(between(plantNode.id, "s-cl")?.resourceId).toBe("chlorine");
    expect(draft.rewiredEdgeIds).toContain("e3");
    expect(between("s-salt", mixerNode.id)?.resourceId).toBe("salt");
    expect(draft.storages.map((entry) => entry.resourceId)).toContain("water");
    expect(draft.edges.some((entry) => entry.source === plantNode.id && entry.resourceId === "naoh")).toBe(
      true,
    );
    expect(draft.recipes.map((entry) => entry.id).sort()).toEqual([mixer.id, plant.id].sort());
    expect(draft.nodes.every((entry) => entry.enabled)).toBe(true);
  });

  it("never offers the existing route, tier-blocked recipes or loops", async () => {
    const calls: string[] = [];
    const result = await discoverRoutes({
      project: plan(),
      target,
      source: fakeSource(calls),
      options: { depth: 3, topK: 20 },
    });
    const ids = result.routes.flatMap((r) => r.candidate.steps.map((step) => step.recipe.id));
    expect(ids).not.toContain(electrolyzer.id);
    expect(ids).not.toContain(evPlant.id);
    expect(ids).not.toContain(loopMaker.id);
    expect(ids.filter((id) => id.startsWith("plant-saltwater") && id !== plant.id)).toEqual([]);
    // The search ended and asked about each resource once.
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("lets a higher tier in when asked to", async () => {
    const result = await discoverRoutes({
      project: plan(),
      target,
      source: fakeSource(),
      options: { maxTier: "EV", topK: 20, skipFullEvaluation: true },
    });
    const ids = result.routes.flatMap((r) => r.candidate.steps.map((step) => step.recipe.id));
    expect(ids).toContain(evPlant.id);
  });

  it("can skip the full-plan solve", async () => {
    const result = await discoverRoutes({
      project: plan(),
      target,
      source: fakeSource(),
      options: { skipFullEvaluation: true },
    });
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.every((r) => r.plan === undefined && r.draft === undefined)).toBe(true);
    expect(result.timings.fullEvalCount).toBe(0);
  });
});
