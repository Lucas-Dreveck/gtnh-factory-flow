import { beforeEach, describe, expect, it } from "vitest";
import { makeResourceHandleId } from "@/components/flow/resource-handles";
import { createEmptyProject } from "@/examples";
import { applyRouteChoices } from "@/lib/model/route-choices";
import type { FactoryEdge, FactoryNode, FactoryProject, FactoryStorage, Recipe } from "@/lib/model/types";
import { insertRouteDraft } from "@/lib/routes/insert-draft";
import type { RouteOptionDraft } from "@/lib/routes/types";
import { useFactoryStore } from "./factory-store";

const recipe = (id: string, machineType: string, inputs: Recipe["inputs"], outputs: Recipe["outputs"]): Recipe => ({
  id,
  name: `${machineType}: ${id}`,
  kind: "gregtech_machine",
  machineType,
  minimumTier: "LV",
  durationTicks: 100,
  eut: 30,
  inputs,
  outputs,
});
const fluid = (id: string, amount: number) => ({ kind: "fluid" as const, id, amount, displayName: id });
const item = (id: string, amount: number) => ({ kind: "item" as const, id, amount, displayName: id });

const electrolyzer = recipe("electrolyzer-salt", "Electrolyzer", [item("salt", 2)], [item("sodium", 1), fluid("chlorine", 1000)]);
const plant = recipe("plant-brine", "Chemical Plant", [fluid("brine", 1000)], [fluid("chlorine", 2000)]);

const node = (id: string, recipeId: string, x: number, y = 0): FactoryNode => ({
  id,
  recipeId,
  machineCount: 1,
  parallel: 1,
  overclockTier: "LV",
  enabled: true,
  position: { x, y },
});
const edge = (
  id: string,
  source: string,
  target: string,
  kind: "item" | "fluid",
  rid: string,
  sourceSlot?: number,
  targetSlot?: number,
): FactoryEdge => ({
  id,
  source,
  target,
  sourceHandle: makeResourceHandleId("output", { kind, id: rid }, sourceSlot),
  targetHandle: makeResourceHandleId("input", { kind, id: rid }, targetSlot),
  resourceKind: kind,
  resourceId: rid,
});

function plan(): FactoryProject {
  const storages: FactoryStorage[] = [
    { id: "s-salt", kind: "item", resourceId: "salt", position: { x: 0, y: 0 } },
    { id: "s-cl", kind: "fluid", resourceId: "chlorine", drainMode: "product", targetPerSecond: 2, targetMode: "exact", position: { x: 900, y: 0 } },
    { id: "s-na", kind: "item", resourceId: "sodium", drainMode: "byproduct", position: { x: 900, y: 200 } },
  ];
  return {
    ...createEmptyProject(),
    solveMode: true,
    recipes: [electrolyzer],
    nodes: [node("n-elec", electrolyzer.id, 400)],
    storages,
    edges: [
      edge("e1", "s-salt", "n-elec", "item", "salt", undefined, 0),
      edge("e2", "n-elec", "s-cl", "fluid", "chlorine", 1),
      edge("e3", "n-elec", "s-na", "item", "sodium", 0),
    ],
  };
}

/** What the discovery engine hands over: new cards plus the wires that take over the old ones' outputs. */
function draft(): RouteOptionDraft {
  return {
    label: "Chemical Plant: Brine > Chlorine",
    recipes: [plant],
    nodes: [node("d-node", plant.id, 3000, 40)],
    storages: [{ id: "d-brine", kind: "fluid", resourceId: "brine", displayName: "brine", position: { x: 2700, y: 40 } }],
    edges: [edge("d-e1", "d-brine", "d-node", "fluid", "brine"), edge("d-e2", "d-node", "s-cl", "fluid", "chlorine", 0)],
    replacesNodeIds: ["n-elec"],
    rewiredEdgeIds: ["e2"],
  };
}

const ids = () => {
  let n = 0;
  return { choice: "c1", a: "oa", b: "ob", option: "oc", fresh: (prefix: string) => `${prefix}-fresh-${++n}` };
};

describe("insertRouteDraft", () => {
  it("adds the route beside the current one as option B, active stays on A", () => {
    const result = insertRouteDraft(plan(), draft(), { name: "Chlorine routes", currentLabel: "Current: Electrolyzer" }, ids())!;
    const choice = result.project.routeChoices![0];
    expect(choice.active).toBe("oa");
    expect(choice.options.map((o) => o.label)).toEqual(["A: Current: Electrolyzer", "B: Chemical Plant: Brine > Chlorine"]);
    expect(choice.options[0].nodeIds).toEqual(["n-elec"]);
    expect(choice.options[1].origin).toBe("discovered");
    expect(choice.options[1].nodeIds).toEqual(result.nodeIds);
    expect(choice.options[1].storageIds).toEqual(result.storageIds);

    // To the right of the current card, nothing overlapping.
    const placed = result.project.nodes.find((n) => n.id === result.nodeIds[0])!;
    expect(placed.position.x).toBeGreaterThan(400 + 380);
    expect(placed.pocketId).toBeUndefined();
    expect(result.project.recipes.map((r) => r.id)).toContain(plant.id);
  });

  it("keeps ids unique and every wire pointing at a card that exists", () => {
    // Adding the same draft twice (a second press) must not collide.
    const first = insertRouteDraft(plan(), draft(), { name: "x" }, ids())!;
    const again = insertRouteDraft(first.project, draft(), { name: "x", choiceId: first.choiceId }, { ...ids(), option: "od" })!;
    const project = again.project;
    for (const list of [project.nodes.map((n) => n.id), (project.storages ?? []).map((s) => s.id), project.edges.map((e) => e.id)]) {
      expect(new Set(list).size).toBe(list.length);
    }
    const known = new Set([...project.nodes.map((n) => n.id), ...(project.storages ?? []).map((s) => s.id)]);
    for (const e of project.edges) {
      expect(known.has(e.source)).toBe(true);
      expect(known.has(e.target)).toBe(true);
    }
    // Both finds are options of the one choice; the second sits clear of the first.
    const choice = project.routeChoices![0];
    expect(choice.options).toHaveLength(3);
    const [a, b] = [first.nodeIds[0], again.nodeIds[0]].map((id) => project.nodes.find((n) => n.id === id)!);
    expect(a.id).not.toBe(b.id);
    expect(Math.abs(a.position.x - b.position.x) >= 380 || Math.abs(a.position.y - b.position.y) >= 280).toBe(true);
  });

  it("refuses when the replaced cards are gone, or the choice is", () => {
    const gone = { ...plan(), nodes: [] };
    expect(insertRouteDraft(gone, draft(), { name: "x" }, ids())).toBeUndefined();
    expect(insertRouteDraft(plan(), draft(), { name: "x", choiceId: "nope" }, ids())).toBeUndefined();
  });

  it("turns the old route off only when B is switched on", () => {
    const { project, optionId } = insertRouteDraft(plan(), draft(), { name: "x" }, ids())!;
    const onA = applyRouteChoices(project);
    expect(onA.nodes.find((n) => n.id === "n-elec")!.enabled).toBe(true);
    expect(onA.storages!.some((s) => s.id === "d-brine")).toBe(false);
    const onB = applyRouteChoices({
      ...project,
      routeChoices: project.routeChoices!.map((c) => ({ ...c, active: optionId })),
    });
    expect(onB.nodes.find((n) => n.id === "n-elec")!.enabled).toBe(false);
    expect(onB.storages!.some((s) => s.id === "d-brine")).toBe(true);
  });
});

describe("store.addDiscoveredRoute", () => {
  beforeEach(() => {
    useFactoryStore.getState().setProject(plan());
  });

  it("is one undo step and prunes nothing it just added", () => {
    const before = useFactoryStore.getState().project;
    const depth = useFactoryStore.getState().undoHistory.length;
    const added = useFactoryStore.getState().addDiscoveredRoute(draft(), { name: "Chlorine routes" });
    expect(added).toBeTruthy();

    const after = useFactoryStore.getState();
    expect(after.undoHistory.length).toBe(depth + 1);
    const project = after.project;
    // The new drawer is wired, so orphan pruning keeps it.
    expect(project.storages!.some((s) => s.resourceId === "brine")).toBe(true);
    expect(project.routeChoices).toHaveLength(1);
    expect(project.routeChoices![0].active).toBe(project.routeChoices![0].options[0].id);
    expect(after.lastResult).toBeTruthy();

    after.undo();
    const undone = useFactoryStore.getState().project;
    expect(undone.nodes).toEqual(before.nodes);
    expect(undone.edges).toEqual(before.edges);
    expect(undone.routeChoices).toBeUndefined();
  });

  it("extends the choice of the same route instead of making a second one", () => {
    const first = useFactoryStore.getState().addDiscoveredRoute(draft(), { name: "Chlorine routes" })!;
    const second = useFactoryStore.getState().addDiscoveredRoute(draft(), { name: "Chlorine routes", choiceId: first.choiceId })!;
    expect(second.choiceId).toBe(first.choiceId);
    expect(useFactoryStore.getState().project.routeChoices![0].options).toHaveLength(3);
  });
});
