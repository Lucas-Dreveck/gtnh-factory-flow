import { describe, expect, it } from "vitest";
import { PROJECT_SCHEMA_VERSION, type FactoryProject, type ThroughputResult } from "@/lib/model/types";
import { SNAPSHOT_NODE_LIMIT, buildAssistantBoardSnapshot } from "./board-snapshot";
import { boardBriefing } from "./prompt";
import { parseAssistantRequest } from "./request";

const project = (patch: Partial<FactoryProject> = {}): FactoryProject => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  id: "plan",
  name: "Steel line",
  recipes: [
    {
      id: "r1",
      name: "Steel dust",
      machineType: "Mixer",
      durationTicks: 20,
      eut: 30,
      minimumTier: "LV",
      inputs: [{ kind: "item", id: "iron", amount: 2, displayName: "Iron Dust" }],
      outputs: [{ kind: "item", id: "steel", amount: 1, displayName: "Steel Dust" }],
    },
  ],
  nodes: [
    {
      id: "node-1",
      recipeId: "r1",
      machineCount: 3,
      parallel: 1,
      overclockTier: "MV",
      enabled: true,
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  storages: [],
  fuelProfiles: [],
  ...patch,
});

describe("buildAssistantBoardSnapshot", () => {
  it("names each card by its recipe, with its slots and its count", () => {
    const snapshot = buildAssistantBoardSnapshot(project(), undefined);
    expect(snapshot.nodes).toEqual([
      {
        id: "node-1",
        recipeName: "Steel dust",
        machine: "Mixer",
        machineCount: 3,
        tier: "MV",
        euPerTick: undefined,
        takes: ["Iron Dust x2"],
        makes: ["Steel Dust x1"],
      },
    ]);
    expect(snapshot.mode).toBe("build");
    expect(snapshot.planName).toBe("Steel line");
  });

  it("reads the mode off the plan", () => {
    expect(buildAssistantBoardSnapshot(project({ solveMode: true }), undefined).mode).toBe("solve");
    expect(
      buildAssistantBoardSnapshot(project({ solveMode: true, poolMode: true }), undefined).mode,
    ).toBe("pool");
  });

  it("classifies a drawer by its wires, not by its settings", () => {
    const snapshot = buildAssistantBoardSnapshot(
      project({
        storages: [
          { id: "s-in", kind: "item", resourceId: "iron", position: { x: 0, y: 0 } },
          { id: "s-out", kind: "item", resourceId: "steel", position: { x: 0, y: 0 } },
          { id: "s-mid", kind: "item", resourceId: "steel", position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: "e1", source: "s-in", target: "node-1", resourceKind: "item", resourceId: "iron" },
          { id: "e2", source: "node-1", target: "s-out", resourceKind: "item", resourceId: "steel" },
          { id: "e3", source: "node-1", target: "s-mid", resourceKind: "item", resourceId: "steel" },
          { id: "e4", source: "s-mid", target: "node-1", resourceKind: "item", resourceId: "steel" },
        ],
      }),
      undefined,
    );
    expect(snapshot.drawers.map((drawer) => [drawer.id, drawer.role])).toEqual([
      ["s-in", "source"],
      ["s-out", "product"],
      ["s-mid", "buffer"],
    ]);
  });

  it("carries the solve's verdicts, shortages and power as notes", () => {
    const result: ThroughputResult = {
      nodes: {},
      storages: {},
      resources: {},
      edges: {},
      totalEuT: 123.456,
      totalEuPerSecond: 2469,
      bottlenecks: [
        { id: "b1", kind: "resource-deficit", severity: "critical", message: "Iron Dust is short." },
      ],
      externalInputs: [
        {
          key: "item:iron",
          kind: "item",
          resourceId: "iron",
          displayName: "Iron Dust",
          producedPerSecond: 0,
          consumedPerSecond: 6,
          netPerSecond: -6,
          surplusPerSecond: 0,
          deficitPerSecond: 6,
          importedPerSecond: 0,
          productPerSecond: 0,
          byproductPerSecond: 0,
          bufferFillPerSecond: 0,
        },
      ],
      unconsumedOutputs: [],
      generatedAt: "now",
    };
    const notes = buildAssistantBoardSnapshot(project(), result).notes;
    expect(notes).toContain("Total power draw 123.46 EU/t.");
    expect(notes).toContain("Still has to be fed: Iron Dust 6/s.");
    expect(notes).toContain("Critical: Iron Dust is short.");
  });

  it("caps the card list and says so, so a big board still fits an ask", () => {
    const nodes = Array.from({ length: SNAPSHOT_NODE_LIMIT + 5 }, (_unused, index) => ({
      id: `node-${index}`,
      recipeId: "r1",
      machineCount: 1,
      parallel: 1,
      overclockTier: "LV",
      enabled: true,
      position: { x: 0, y: 0 },
    }));
    const snapshot = buildAssistantBoardSnapshot(project({ nodes }), undefined);
    expect(snapshot.nodes).toHaveLength(SNAPSHOT_NODE_LIMIT);
    expect(snapshot.nodeCount).toBe(SNAPSHOT_NODE_LIMIT + 5);
    expect(snapshot.notes[0]).toContain(`first ${SNAPSHOT_NODE_LIMIT}`);
  });
});

describe("boardBriefing", () => {
  it("writes the card ids an action has to name", () => {
    const briefing = boardBriefing(buildAssistantBoardSnapshot(project(), undefined));
    expect(briefing).toContain("node-1: Steel dust on Mixer, 3x at MV");
    expect(briefing).toContain("takes Iron Dust x2");
  });

  it("says the board is empty rather than printing an empty list", () => {
    expect(boardBriefing(buildAssistantBoardSnapshot(project({ nodes: [] }), undefined))).toContain(
      "The board is empty.",
    );
  });
});

describe("parseAssistantRequest", () => {
  const body = () => ({
    datasetVersionId: "gtnh-2.9",
    messages: [{ role: "user", text: "what is short" }],
    board: buildAssistantBoardSnapshot(project(), undefined),
  });

  it("accepts a snapshot the client built", () => {
    expect(parseAssistantRequest(body())).toBeDefined();
  });

  it("refuses an ask with no dataset, no message or an empty message", () => {
    expect(parseAssistantRequest({ ...body(), datasetVersionId: "" })).toBeUndefined();
    expect(parseAssistantRequest({ ...body(), messages: [] })).toBeUndefined();
    expect(
      parseAssistantRequest({ ...body(), messages: [{ role: "user", text: "" }] }),
    ).toBeUndefined();
  });

  it("refuses a message longer than one ask could sensibly be", () => {
    expect(
      parseAssistantRequest({ ...body(), messages: [{ role: "user", text: "x".repeat(4001) }] }),
    ).toBeUndefined();
  });
});
