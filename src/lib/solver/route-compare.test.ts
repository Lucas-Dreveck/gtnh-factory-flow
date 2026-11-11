import { describe, expect, it } from "vitest";
import { gtnhFuelProfiles } from "@/lib/model/fuels";
import { applyRouteChoices, pruneRouteChoices } from "@/lib/model/route-choices";
import {
  PROJECT_SCHEMA_VERSION,
  type FactoryNode,
  type FactoryProject,
  type FactoryStorage,
  type Recipe,
  type RouteChoice,
} from "@/lib/model/types";
import { compareRouteChoice } from "./route-compare";
import { calculateThroughput } from "./throughput";

function recipe(id: string, machineType: string, inputs: Recipe["inputs"], outputs: Recipe["outputs"]): Recipe {
  return { id, name: id, kind: "custom", machineType, minimumTier: "LV", durationTicks: 20, eut: 30, inputs, outputs };
}

function node(id: string, recipeId: string): FactoryNode {
  return { id, recipeId, machineCount: 1, parallel: 1, overclockTier: "LV", enabled: true, position: { x: 0, y: 0 } };
}

function drawer(id: string, resourceId: string, extra: Partial<FactoryStorage> = {}): FactoryStorage {
  return { id, kind: "item", resourceId, position: { x: 0, y: 0 }, ...extra };
}

/** Route A: ore -> product (cheap, 1 machine type). Route B: ore + dust -> product + junk. */
function twoRoutes(): FactoryProject {
  const choice: RouteChoice = {
    id: "c1",
    name: "Product",
    active: "a",
    createdAt: "2026-01-01T00:00:00.000Z",
    options: [
      { id: "a", label: "A: Direct", nodeIds: ["na"], storageIds: [] },
      { id: "b", label: "B: Dusty", nodeIds: ["nb"], storageIds: ["dust", "junk"] },
    ],
  };
  const e = (id: string, source: string, target: string, resourceId: string) => ({
    id, source, target, resourceKind: "item" as const, resourceId,
  });
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "p",
    name: "Two routes",
    recipes: [
      recipe("ra", "Assembler", [{ kind: "item", id: "ore", amount: 1 }], [{ kind: "item", id: "product", amount: 1 }]),
      recipe(
        "rb",
        "Mixer",
        [{ kind: "item", id: "ore", amount: 1 }, { kind: "item", id: "dust", amount: 1 }],
        [{ kind: "item", id: "product", amount: 2 }, { kind: "item", id: "junk", amount: 1 }],
      ),
    ],
    solveMode: true,
    nodes: [node("na", "ra"), node("nb", "rb")],
    storages: [
      drawer("ore", "ore"),
      drawer("dust", "dust"),
      drawer("junk", "junk", { drainMode: "byproduct" }),
      drawer("out", "product", { targetPerSecond: 2, targetMode: "at-least" }),
    ],
    edges: [
      e("e1", "ore", "na", "ore"),
      e("e2", "ore", "nb", "ore"),
      e("e3", "dust", "nb", "dust"),
      e("e4", "na", "out", "product"),
      e("e5", "nb", "out", "product"),
      e("e6", "nb", "junk", "junk"),
    ],
    fuelProfiles: gtnhFuelProfiles,
    selectedFuelProfileId: "biodiesel",
    routeChoices: [choice],
  };
}

describe("applyRouteChoices", () => {
  it("switches off the other options without touching stored flags", () => {
    const project = twoRoutes();
    const applied = applyRouteChoices(project);
    expect(applied.nodes.find((n) => n.id === "na")!.enabled).toBe(true);
    expect(applied.nodes.find((n) => n.id === "nb")!.enabled).toBe(false);
    expect(project.nodes.find((n) => n.id === "nb")!.enabled).toBe(true);
    expect(applied.storages!.some((s) => s.id === "dust")).toBe(false);
    expect(applied.edges.some((x) => x.source === "dust")).toBe(false);
  });

  it("leaves everything on when the solver picks, and returns the same object with no choices", () => {
    const project = twoRoutes();
    project.routeChoices![0].active = "solver";
    expect(applyRouteChoices(project).nodes.every((n) => n.enabled)).toBe(true);
    expect(applyRouteChoices({ ...project, routeChoices: undefined })).toEqual({ ...project, routeChoices: undefined });
  });
});

describe("pruneRouteChoices", () => {
  it("drops vanished ids and a choice left with fewer than two options", () => {
    const project = twoRoutes();
    const pruned = pruneRouteChoices({ ...project, nodes: project.nodes.filter((n) => n.id !== "nb"), storages: project.storages!.filter((s) => s.id !== "dust" && s.id !== "junk") });
    expect(pruned.routeChoices).toBeUndefined();
  });

  it("keeps a healthy choice untouched", () => {
    const project = twoRoutes();
    expect(pruneRouteChoices(project)).toBe(project);
  });
});

describe("compareRouteChoice", () => {
  it("compares each option and the solver on the whole plan", () => {
    const project = twoRoutes();
    const cmp = compareRouteChoice(project, "c1");
    const a = cmp.columns.find((c) => c.id === "a")!;
    const b = cmp.columns.find((c) => c.id === "b")!;
    const solver = cmp.columns.find((c) => c.id === "solver")!;
    expect(cmp.baselineId).toBe("a");
    expect(a.targetsMet).toBe(true);
    expect(b.targetsMet).toBe(true);
    expect(a.machinesByType.map((g) => g.machineType)).toEqual(["Assembler"]);
    expect(b.machinesByType.map((g) => g.machineType)).toEqual(["Mixer"]);
    expect(a.delta.machines).toBe(0);
    // B makes two per craft, so it needs fewer machines and leaves junk with nowhere to go.
    expect(b.totalMachines).toBeLessThan(a.totalMachines);
    expect(b.delta.machines).toBeLessThan(0);
    expect(b.surplus.map((r) => r.name)).toContain("junk");
    expect(a.surplus.map((r) => r.name)).not.toContain("junk");
    expect(cmp.cheapest.totalMachines).toEqual(["b"]);
    expect(solver.optionUse!.map((u) => u.optionId)).toEqual(["a", "b"]);
    expect(solver.optionUse!.reduce((n, u) => n + u.share, 0)).toBeCloseTo(1, 6);
  });

  it("reports unmet targets when an option cannot make the product", () => {
    const project = twoRoutes();
    project.routeChoices![0].options[1] = { id: "b", label: "B: Nothing", nodeIds: [], storageIds: [] };
    project.routeChoices![0].options[0].nodeIds = ["na", "nb"];
    const cmp = compareRouteChoice(project, "c1", (p) => calculateThroughput(p));
    const b = cmp.columns.find((c) => c.id === "b")!;
    expect(b.targetsMet).toBe(false);
    expect(b.unmetTargets).toContain("product");
  });
});
