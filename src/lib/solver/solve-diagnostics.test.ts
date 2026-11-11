import { describe, expect, it } from "vitest";
import { calculateThroughput } from "./throughput";
import { diagnoseSolve } from "./solve-diagnostics";
import { PROJECT_SCHEMA_VERSION, type FactoryProject } from "../model/types";

// ore -> Crush -> crushed -> Finish -> product, plus an optional unwired seed on Crush.
function plan(opts: { seed?: boolean; wireOre?: boolean; wireOut?: boolean } = {}): FactoryProject {
  const drawer = (id: string) => ({ id, kind: "item" as const, resourceId: id, position: { x: 0, y: 0 } });
  const wire = (source: string, target: string, resourceId: string) => ({
    id: `${source}:${target}`, source, target, resourceId, resourceKind: "item" as const,
  });
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "diag",
    name: "Diag",
    solveMode: true,
    fuelProfiles: [],
    recipes: [
      {
        id: "crush", name: "Crush", machineType: "Test", durationTicks: 20, eut: 0, minimumTier: "NONE",
        inputs: [
          { kind: "item", id: "ore", amount: 1 },
          ...(opts.seed ? [{ kind: "item" as const, id: "seed", amount: 1 }] : []),
        ],
        outputs: [{ kind: "item", id: "crushed", amount: 2 }],
      },
      {
        id: "finish", name: "Finish", machineType: "Test", durationTicks: 20, eut: 0, minimumTier: "NONE",
        inputs: [{ kind: "item", id: "crushed", amount: 2 }],
        outputs: [{ kind: "item", id: "product", amount: 1 }],
      },
    ],
    nodes: ["crush", "finish"].map((id) => ({
      id, recipeId: id, machineCount: 1, parallel: 1, overclockTier: "NONE", enabled: true, position: { x: 0, y: 0 },
    })),
    storages: [drawer("ore"), drawer("product")],
    edges: [
      ...(opts.wireOre === false ? [] : [wire("ore", "crush", "ore")]),
      wire("crush", "finish", "crushed"),
      ...(opts.wireOut === false ? [] : [wire("finish", "product", "product")]),
    ],
  };
}
const codes = (p: FactoryProject) => diagnoseSolve(p, calculateThroughput(p));

describe("diagnoseSolve", () => {
  it("is silent outside solve mode", () => {
    const p = { ...plan(), solveMode: false };
    expect(codes(p)).toEqual([]);
  });

  it("NO_GOAL when nothing asks for output", () => {
    const d = codes(plan());
    expect(d.find((x) => x.code === "NO_GOAL")).toMatchObject({ severity: "error", storageIds: ["product"] });
  });

  it("is clean with a working target", () => {
    const p = plan();
    Object.assign(p.storages!.find((s) => s.id === "product")!, { targetPerSecond: 1, targetMode: "at-least" });
    expect(codes(p).filter((x) => x.severity !== "info")).toEqual([]);
  });

  it("PINS_INFEASIBLE names the pinned node with an unwired consumed input", () => {
    const p = plan({ seed: true });
    p.nodes.find((n) => n.id === "crush")!.solvePin = 2;
    const r = calculateThroughput(p);
    expect(r.solveStatus?.pinsInfeasible).toBe(true);
    const d = diagnoseSolve(p, r).find((x) => x.code === "PINS_INFEASIBLE");
    expect(d?.nodeIds).toEqual(["crush"]);
    expect(d?.message).toContain("Crush");
    expect(d?.message).toContain("seed");
    expect(d?.resourceIds).toEqual(["seed"]);
  });

  it("PINS_INFEASIBLE names an output with nowhere to go", () => {
    const p = plan({ wireOut: false });
    p.nodes.find((n) => n.id === "finish")!.solvePin = 1;
    const d = codes(p).find((x) => x.code === "PINS_INFEASIBLE");
    expect(d?.nodeIds).toEqual(["finish"]);
    expect(d?.message).toContain("nowhere to send");
  });

  it("TARGET_UNREACHABLE for a target no chain can make", () => {
    const p = plan();
    Object.assign(p.storages!.find((s) => s.id === "product")!, { targetPerSecond: 1, targetMode: "exact" });
    p.edges = p.edges.filter((e) => e.id !== "finish:product");
    p.storages!.push({ id: "other", kind: "item", resourceId: "other", position: { x: 0, y: 0 }, targetPerSecond: 1, targetMode: "exact" });
    p.edges.push({ id: "finish:other", source: "finish", target: "other", resourceId: "other", resourceKind: "item" });
    const d = codes(p).filter((x) => x.code === "TARGET_UNREACHABLE");
    expect(d.length).toBeGreaterThan(0);
  });

  it("BARE_INPUT for an idle wired machine missing a feed", () => {
    const p = plan({ seed: true });
    Object.assign(p.storages!.find((s) => s.id === "product")!, { targetPerSecond: 1, targetMode: "at-least" });
    const d = codes(p);
    const bare = d.find((x) => x.code === "BARE_INPUT");
    expect(bare?.nodeIds).toEqual(["crush"]);
    expect(bare?.message).toContain("seed");
  });

  it("DORMANT_NUMBER for a rate on a trash drawer", () => {
    const p = plan();
    Object.assign(p.storages!.find((s) => s.id === "product")!, { targetPerSecond: 1, drainMode: "trash" });
    expect(codes(p).some((x) => x.code === "DORMANT_NUMBER")).toBe(true);
  });
});
