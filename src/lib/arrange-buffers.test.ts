import { describe, expect, it } from "vitest";
import { PROJECT_SCHEMA_VERSION, type FactoryProject, type ThroughputResult } from "@/lib/model/types";
import { insertChainBuffers } from "./arrange-buffers";
import { calculateThroughput } from "./solver/throughput";

const recipe = (id: string, inputs: [string, number][], outputs: [string, number][]) => ({
  id,
  name: id,
  machineType: "Bender",
  minimumTier: "LV",
  durationTicks: 20,
  eut: 30,
  inputs: inputs.map(([r, amount]) => ({ kind: "item" as const, id: r, amount })),
  outputs: outputs.map(([r, amount]) => ({ kind: "item" as const, id: r, amount })),
});
const node = (id: string, recipeId: string) => ({
  id,
  recipeId,
  machineCount: 1,
  parallel: 1,
  overclockTier: "LV",
  enabled: true,
  position: { x: 5, y: 7 },
});
const drawer = (id: string, resourceId: string, extra = {}) => ({
  id,
  kind: "item" as const,
  resourceId,
  position: { x: 0, y: 0 },
  ...extra,
});
const wire = (id: string, source: string, target: string, resourceId: string, handles = true) => ({
  id,
  source,
  target,
  ...(handles ? { sourceHandle: `output:item:${resourceId}:0`, targetHandle: `input:item:${resourceId}:0` } : {}),
  resourceKind: "item" as const,
  resourceId,
});

function chain(extraEdges: unknown[] = []): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "p",
    name: "p",
    solveMode: true,
    recipes: [
      recipe("ra", [["ore", 2]], [["x", 2]]),
      recipe("rb", [["x", 1]], [["y", 1]]),
      recipe("rc", [["x", 1]], [["z", 1]]),
    ],
    nodes: [node("A", "ra"), node("B", "rb"), node("C", "rc")],
    storages: [
      drawer("src", "ore"),
      drawer("outY", "y", { drainMode: "product", targetPerSecond: 1, targetMode: "at-least" }),
      drawer("outZ", "z", { drainMode: "product", targetPerSecond: 1, targetMode: "at-least" }),
    ],
    edges: [
      wire("e0", "src", "A", "ore"),
      wire("e1", "A", "B", "x"),
      wire("e2", "A", "C", "x"),
      wire("e3", "B", "outY", "y"),
      wire("e4", "C", "outZ", "z"),
      ...extraEdges,
    ],
    fuelProfiles: [],
  } as unknown as FactoryProject;
}

const solve = (p: FactoryProject) => calculateThroughput(p);

describe("insertChainBuffers", () => {
  it("replaces a cross-band wire with a shared buffer and keeps every number", () => {
    const p = chain();
    const assignment = new Map([["A", "1"], ["B", "2"], ["C", "2"], ["src", "1"], ["outY", "2"], ["outZ", "2"]]);
    const r = insertChainBuffers(p, assignment, { solve });
    expect(r.verified).toBe(true);
    expect(r.inserted).toBe(1);
    const buf = r.project.storages!.find((s) => s.id.startsWith("storage-buf-"))!;
    expect(buf).toMatchObject({ resourceId: "x", bufferMode: "strict", position: { x: 5, y: 7 } });
    expect(r.project.edges.filter((e) => e.source === buf.id)).toHaveLength(2);
    expect(r.project.edges.filter((e) => e.target === buf.id)).toHaveLength(1);
    expect(r.project.edges.find((e) => e.id === "e1")).toBeUndefined();
    const out = r.project.edges.find((e) => e.source === buf.id && e.target === "B")!;
    expect(out.sourceHandle).toBe("output:item:x");
    expect(out.targetHandle).toBe("input:item:x:0");
    const a = solve(p);
    const b = solve(r.project);
    expect(b.totalEuT).toBeCloseTo(a.totalEuT, 9);
    for (const id of ["A", "B", "C"]) {
      expect(b.nodes[id].theoreticalMachinesRequired).toBeCloseTo(a.nodes[id].theoreticalMachinesRequired, 9);
    }
  });

  it("is idempotent in ids and leaves same-band wires alone", () => {
    const p = chain();
    const same = new Map([["A", "1"], ["B", "1"], ["C", "1"]]);
    const r0 = insertChainBuffers(p, same, { solve });
    expect(r0.inserted).toBe(0);
    expect(r0.project).toBe(p);
    const split = new Map([["A", "1"], ["B", "2"], ["C", "2"]]);
    const r1 = insertChainBuffers(p, split, { solve });
    const r2 = insertChainBuffers(p, split, { solve });
    expect(r2.project.storages!.map((s) => s.id)).toEqual(r1.project.storages!.map((s) => s.id));
    const again = insertChainBuffers(r1.project, split, { solve });
    expect(again.inserted).toBe(0);
  });

  it("gives a producer one buffer per consuming band", () => {
    const p = chain();
    const r = insertChainBuffers(p, new Map([["A", "1"], ["B", "2"], ["C", "3"]]), { solve });
    expect(r.inserted).toBe(2);
    expect(r.verified).toBe(true);
  });

  it("never touches power wires or wires through a drawer", () => {
    const p = chain([{ id: "pw", source: "A", target: "B", resourceKind: "power", resourceId: "eu" }]);
    const r = insertChainBuffers(p, new Map([["A", "1"], ["B", "2"], ["C", "2"], ["src", "2"], ["outY", "1"]]), {
      solve,
    });
    expect(r.project.edges.find((e) => e.id === "pw")).toBeDefined();
    expect(r.project.edges.find((e) => e.id === "e0")).toBeDefined();
    expect(r.project.edges.find((e) => e.id === "e3")).toBeDefined();
    expect(r.inserted).toBe(1);
  });

  it("drops the buffers of a resource whose insertion changes results", () => {
    const p = chain();
    const lying = (q: FactoryProject): ThroughputResult => {
      const res = solve(q);
      if (q.storages!.some((s) => s.id.startsWith("storage-buf-"))) res.totalEuT += 5;
      return res;
    };
    const r = insertChainBuffers(p, new Map([["A", "1"], ["B", "2"], ["C", "2"]]), { solve: lying });
    expect(r.verified).toBe(false);
    expect(r.inserted).toBe(0);
    expect(r.project).toBe(p);
    expect(r.message).toContain("total power");
  });

  it("keeps the verified resources when only one offends", () => {
    const p = chain();
    const bad = (q: FactoryProject): ThroughputResult => {
      const res = solve(q);
      if (q.storages!.some((s) => s.id.startsWith("storage-buf-") && s.resourceId === "x")) res.totalEuT += 5;
      return res;
    };
    const two = chain([
      wire("e5", "B", "C", "y"),
    ]);
    const r = insertChainBuffers(two, new Map([["A", "1"], ["B", "2"], ["C", "3"]]), { solve: bad });
    expect(r.verified).toBe(true);
    expect(r.project.storages!.filter((s) => s.id.startsWith("storage-buf-")).every((s) => s.resourceId === "y")).toBe(
      true,
    );
    expect(p.storages).toHaveLength(3);
  });
});
