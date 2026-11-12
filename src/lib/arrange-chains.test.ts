import { describe, expect, it } from "vitest";
import { arrangeByProductChains, findProductChains, type ChainProject } from "./arrange-chains";

const pos = { x: 0, y: 0 };
const node = (id: string, recipeId = "r") => ({ id, recipeId, position: pos, pocketId: undefined });
const store = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "item", resourceId: id, position: pos, ...extra }) as never;
const edge = (source: string, target: string) => ({ id: `${source}>${target}`, source, target });
const size = () => ({ width: 380, height: 280 });

function project(partial: Partial<ChainProject>): ChainProject {
  return {
    nodes: [],
    storages: [],
    edges: [],
    recipes: [{ id: "r" }, { id: "gen", power: { sourceId: "x", euPerTick: 1, stats: [] } }] as never,
    ...partial,
  };
}

describe("arrangeByProductChains", () => {
  const shared = project({
    nodes: [node("feeder"), node("a"), node("b")],
    storages: [
      store("src"),
      store("prodA", { drainMode: "product" }),
      store("prodB", { drainMode: "product" }),
    ],
    edges: [edge("src", "feeder"), edge("feeder", "a"), edge("feeder", "b"), edge("a", "prodA"), edge("b", "prodB")],
  });

  it("puts a feeder of two products in the shared band", () => {
    const bands = findProductChains(shared);
    expect(bands[0].kind).toBe("shared");
    expect(bands[0].cardIds.sort()).toEqual(["feeder", "src"]);
    expect(bands.filter((b) => b.kind === "chain").map((b) => b.cardIds.sort())).toEqual([
      ["a", "prodA"],
      ["b", "prodB"],
    ]);
  });

  it("excludes power drawers and generators from chains", () => {
    const p = project({
      nodes: [node("m"), node("g", "gen")],
      storages: [store("out", { drainMode: "product" }), store("eu", { kind: "power", drainMode: "product" })],
      edges: [edge("m", "out"), edge("g", "eu")],
    });
    const bands = findProductChains(p);
    expect(bands.find((b) => b.kind === "power")!.cardIds.sort()).toEqual(["eu", "g"]);
    expect(bands.filter((b) => b.kind === "chain")).toHaveLength(1);
  });

  it("survives cycles and is deterministic", () => {
    const p = project({
      nodes: [node("a"), node("b")],
      storages: [store("out", { drainMode: "product" })],
      edges: [edge("a", "b"), edge("b", "a"), edge("b", "out")],
    });
    const one = arrangeByProductChains(p, size);
    expect(one.moves).toHaveLength(3);
    expect(arrangeByProductChains(p, size)).toEqual(one);
  });

  it("flows left to right, on the grid, without overlap", () => {
    const { moves } = arrangeByProductChains(shared, size);
    const at = new Map(moves.map((m) => [m.id, m.position]));
    expect(at.get("a")!.x).toBeLessThan(at.get("prodA")!.x);
    expect(at.get("feeder")!.y).toBeLessThan(at.get("a")!.y);
    for (const m of moves) {
      expect(m.position.x % 20).toBe(0);
      expect(m.position.y % 20).toBe(0);
    }
    for (const m of moves)
      for (const n of moves)
        if (m.id < n.id) {
          const apart =
            m.position.x + 380 <= n.position.x || n.position.x + 380 <= m.position.x ||
            m.position.y + 280 <= n.position.y || n.position.y + 280 <= m.position.y;
          expect(apart).toBe(true);
        }
  });

  it("assigns a feeder to the product taking most of its flow", () => {
    const flows = {
      "feeder>a": { transferredPerSecond: 8 },
      "feeder>b": { transferredPerSecond: 2 },
      "a>prodA": { transferredPerSecond: 8 },
      "b>prodB": { transferredPerSecond: 2 },
      "src>feeder": { transferredPerSecond: 10 },
    };
    const bands = findProductChains(shared, flows);
    expect(bands.some((b) => b.kind === "shared")).toBe(false);
    const a = bands.find((b) => b.productId === "prodA")!;
    expect([...a.cardIds].sort()).toEqual(["a", "feeder", "prodA", "src"]);
    expect(findProductChains(shared, flows)).toEqual(bands);
  });
});
