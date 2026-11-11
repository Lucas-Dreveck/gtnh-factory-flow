import { beforeEach, describe, expect, it } from "vitest";
import { loadBiodieselDemoProject } from "@/examples";
import { noteRestorableRecipes } from "../datasets/restorable-recipes";
import { parseFactoryProjectJson, serializeFactoryProject } from "../import-export/factory-json";
import { decodePlanCode, encodePlanCode, withoutRuntimeTables } from "../import-export/plan-code";
import { useFactoryStore } from "@/store/factory-store";
import { factoryProjectSchema } from "./schemas";
import type { FactoryProject, RouteChoice } from "./types";

void noteRestorableRecipes;

function withChoice(): FactoryProject {
  const base = loadBiodieselDemoProject();
  const [n1, n2] = base.nodes;
  const choice: RouteChoice = {
    id: "choice-1",
    name: "Compare",
    active: "opt-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    options: [
      { id: "opt-a", label: "A: One", nodeIds: [n1.id], storageIds: [], origin: "discovered" },
      { id: "opt-b", label: "B: Two", nodeIds: [n2.id], storageIds: [] },
    ],
  };
  return { ...base, routeChoices: [choice] };
}

describe("route choices survive every path a plan travels", () => {
  it("zod does not strip them", () => {
    const project = withChoice();
    expect(factoryProjectSchema.parse(project).routeChoices).toEqual(project.routeChoices);
  });

  it("library export and import", () => {
    const project = withChoice();
    expect(parseFactoryProjectJson(serializeFactoryProject(project)).routeChoices).toEqual(project.routeChoices);
  });

  it("the slim plan account sync pushes", () => {
    const project = withChoice();
    expect(withoutRuntimeTables(project).routeChoices).toEqual(project.routeChoices);
  });

  it("copied plan codes", async () => {
    const project = withChoice();
    expect((await decodePlanCode(await encodePlanCode(project))).routeChoices).toEqual(project.routeChoices);
  });
});

describe("store pruning and actions", () => {
  beforeEach(() => {
    useFactoryStore.setState({ isReadOnly: false });
    useFactoryStore.getState().setProject(withChoice());
  });

  it("deleting a route's last card drops the option and then the choice", () => {
    const project = useFactoryStore.getState().project;
    useFactoryStore.getState().deleteNode(project.nodes[1].id);
    expect(useFactoryStore.getState().project.routeChoices).toBeUndefined();
  });

  it("creates, switches and removes a choice as undoable edits", () => {
    const store = useFactoryStore.getState();
    const [n1, n2, n3] = store.project.nodes;
    store.deleteRouteChoice("choice-1");
    expect(useFactoryStore.getState().project.routeChoices).toBeUndefined();
    const id = useFactoryStore.getState().createRouteChoice("Mine", [n1.id, n2.id])!;
    let choice = useFactoryStore.getState().project.routeChoices![0];
    expect(choice.id).toBe(id);
    expect(choice.options[0].nodeIds).toEqual([n1.id, n2.id]);
    expect(choice.options[1].nodeIds).toEqual([]);
    // The empty option B takes the next selection; a third selection makes option C.
    useFactoryStore.getState().addRouteOption(id, [n3.id]);
    choice = useFactoryStore.getState().project.routeChoices![0];
    expect(choice.options.map((o) => o.nodeIds)).toEqual([[n1.id, n2.id], [n3.id]]);
    useFactoryStore.getState().setRouteActive(id, "solver");
    expect(useFactoryStore.getState().project.routeChoices![0].active).toBe("solver");
    // The stored flags are the player's; the choice never rewrote them.
    expect(useFactoryStore.getState().project.nodes.every((n) => n.enabled)).toBe(true);
  });

  it("keep only deletes the other options' cards", () => {
    const store = useFactoryStore.getState();
    const [, n2] = store.project.nodes;
    store.keepOnlyRouteOption("choice-1", "opt-a");
    const project = useFactoryStore.getState().project;
    expect(project.routeChoices).toBeUndefined();
    expect(project.nodes.some((n) => n.id === n2.id)).toBe(false);
  });
});
