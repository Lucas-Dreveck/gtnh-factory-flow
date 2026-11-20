import { describe, expect, it } from "vitest";
import { readAssistantAction } from "./action-parse";
import { describeAssistantAction } from "./types";

describe("readAssistantAction", () => {
  it("takes an add with its name and defaults to wiring it up", () => {
    expect(readAssistantAction("add_recipe", { recipeId: "r1", recipeName: "Steel dust" })).toEqual({
      kind: "add_recipe",
      recipeId: "r1",
      recipeName: "Steel dust",
      machineCount: undefined,
      connect: true,
      reason: undefined,
    });
  });

  it("keeps connect off when the model turned it off", () => {
    const action = readAssistantAction("add_recipe", {
      recipeId: "r1",
      recipeName: "Steel dust",
      connect: false,
    });
    expect(action).toMatchObject({ connect: false });
  });

  it("drops an add with no recipe id, since nothing could be fetched", () => {
    expect(readAssistantAction("add_recipe", { recipeName: "Steel dust" })).toBeUndefined();
    expect(readAssistantAction("add_recipe", { recipeId: "   ", recipeName: "x" })).toBeUndefined();
  });

  it("falls back to the id when the model left the name out", () => {
    expect(readAssistantAction("add_recipe", { recipeId: "r1" })).toMatchObject({
      recipeName: "r1",
    });
  });

  it("rounds a machine count and refuses one outside the range", () => {
    expect(readAssistantAction("set_machine_count", { nodeId: "n1", machineCount: 2.4 })).toMatchObject({
      machineCount: 2,
    });
    expect(readAssistantAction("set_machine_count", { nodeId: "n1", machineCount: "6" })).toMatchObject({
      machineCount: 6,
    });
    expect(readAssistantAction("set_machine_count", { nodeId: "n1", machineCount: 0 })).toBeUndefined();
    expect(
      readAssistantAction("set_machine_count", { nodeId: "n1", machineCount: 100000 }),
    ).toBeUndefined();
  });

  it("refuses a wire from a card to itself", () => {
    expect(
      readAssistantAction("connect_nodes", { sourceNodeId: "n1", targetNodeId: "n1" }),
    ).toBeUndefined();
  });

  it("refuses a tool it does not know", () => {
    expect(readAssistantAction("drop_database", { nodeId: "n1" })).toBeUndefined();
  });
});

describe("describeAssistantAction", () => {
  it("says the machine count only when there is more than one", () => {
    expect(
      describeAssistantAction({ kind: "add_recipe", recipeId: "r", recipeName: "Steel dust" }),
    ).toBe("Add Steel dust");
    expect(
      describeAssistantAction({
        kind: "add_recipe",
        recipeId: "r",
        recipeName: "Steel dust",
        machineCount: 4,
      }),
    ).toBe("Add Steel dust (4 machines)");
  });
});
