import { describe, expect, it } from "vitest";
import { arrangeByProductChains, findProductChains, type ChainProject } from "./arrange-chains";

const pos = { x: 0, y: 0 };
const node = (id: string, recipeId = "r") => ({ id, recipeId, position: pos, pocketId: undefined });
const store = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "item", resourceId: id, position: pos, ...extra }) as never;
const goal = (id: string, extra: Record<string, unknown> = {}) =>
  store(id, { drainMode: "product", targetPerSecond: 1, targetMode: "at-least", ...extra });
const edge = (source: string, target: string) => ({ id: `${source}>${target}`, source, target });
const size = () => ({ width: 380, height: 280 });
const flow = (...pairs: Array<[string, number]>) =>
  Object.fromEntries(pairs.map(([id, v]) => [id, { transferredPerSecond: v }]));

function project(partial: Partial<ChainProject>): ChainProject {
  return {
    nodes: [],
    storages: [],
    edges: [],
    recipes: [
      { id: "r" },
      { id: "dt", machineType: "Distillation Tower" },
      { id: "gen", power: { sourceId: "x", euPerTick: 1, stats: [] } },
    ] as never,
    ...partial,
  };
}

const bandOf = (bands: ReturnType<typeof findProductChains>, id: string) =>
  bands.find((b) => b.cardIds.includes(id))?.id;

describe("goals", () => {
  const shared = project({
    nodes: [node("feeder"), node("a"), node("b")],
    storages: [store("src"), goal("prodA"), goal("prodB")],
    edges: [edge("src", "feeder"), edge("feeder", "a"), edge("feeder", "b"), edge("a", "prodA"), edge("b", "prodB")],
  });

  it("puts a feeder of two goals in the shared band without flows", () => {
    const bands = findProductChains(shared);
    expect(bands[0].kind).toBe("shared");
    expect(bands[0].cardIds.sort()).toEqual(["feeder", "src"]);
  });

  it("assigns a feeder to the goal taking most of its flow", () => {
    const flows = flow(["feeder>a", 8], ["feeder>b", 2], ["a>prodA", 8], ["b>prodB", 2], ["src>feeder", 10]);
    const bands = findProductChains(shared, flows);
    const a = bands.find((b) => b.cardIds.includes("prodA"))!;
    expect([...a.cardIds].sort()).toEqual(["a", "feeder", "prodA", "src"]);
    expect(findProductChains(shared, flows)).toEqual(bands);
  });

  it("does not treat ignore-mode, zero-rate or targetless product drawers as goals", () => {
    const p = project({
      nodes: [node("m1"), node("m2"), node("m3"), node("m4")],
      storages: [
        goal("real"),
        goal("ign", { targetMode: "ignore" }),
        goal("zero", { targetPerSecond: 0 }),
        store("plain", { drainMode: "product" }),
      ],
      edges: [edge("m1", "real"), edge("m2", "ign"), edge("m3", "zero"), edge("m4", "plain")],
    });
    const bands = findProductChains(p, flow());
    expect(bands.filter((b) => b.kind === "chain").map((b) => b.productId)).toEqual(["real"]);
    expect(bandOf(bands, "m2")).toBe("other");
  });

  it("attaches targetless product drawers to the feeding card", () => {
    const p = project({
      nodes: [node("m"), node("n")],
      storages: [goal("real"), store("extra", { drainMode: "product" })],
      edges: [edge("m", "real"), edge("m", "extra"), edge("n", "extra")],
    });
    const bands = findProductChains(p, flow(["m>real", 1], ["m>extra", 1], ["n>extra", 5]));
    expect(bandOf(bands, "extra")).toBe(bandOf(bands, "n"));
    const q = project({ ...p, edges: [edge("m", "real"), edge("m", "extra")] });
    expect(bandOf(findProductChains(q, flow()), "extra")).toBe("item:real");
  });

  it("merges goals by resource", () => {
    const p = project({
      nodes: [node("a"), node("b")],
      storages: [goal("g1", { resourceId: "cl" }), goal("g2", { resourceId: "cl" })],
      edges: [edge("a", "g1"), edge("b", "g2")],
    });
    const bands = findProductChains(p, flow(["a>g1", 1], ["b>g2", 1]));
    expect(bands.filter((b) => b.kind === "chain")).toHaveLength(1);
    expect(bands[0].cardIds.sort()).toEqual(["a", "b", "g1", "g2"]);
  });

  it("merges goals fed mainly by one card into a goal named after it", () => {
    const p = project({
      nodes: [node("dt", "dt"), node("m")],
      storages: [store("crude"), goal("x"), goal("y"), goal("z")],
      edges: [edge("crude", "dt"), edge("dt", "x"), edge("dt", "y"), edge("m", "z")],
    });
    const bands = findProductChains(p, flow(["dt>x", 1], ["dt>y", 1], ["m>z", 1], ["crude>dt", 2]));
    const dt = bands.find((b) => b.cardIds.includes("dt"))!;
    expect(dt.name).toBe("Distillation Tower: x, y");
    expect(dt.cardIds.sort()).toEqual(["crude", "dt", "x", "y"]);
    expect(bands.filter((b) => b.kind === "chain")).toHaveLength(2);
  });

  it("sees through drawers: drawer-only feeds reach the cards behind", () => {
    const p = project({
      nodes: [node("m")],
      storages: [store("buf"), goal("h2")],
      edges: [edge("m", "buf"), edge("buf", "h2")],
    });
    const bands = findProductChains(p, flow(["m>buf", 3], ["buf>h2", 3]));
    expect(bands).toHaveLength(1);
    expect(bands[0].cardIds.sort()).toEqual(["buf", "h2", "m"]);
  });

  it("puts the fuel chain with the generator in one Power goal", () => {
    const p = project({
      nodes: [node("fuelmaker"), node("g", "gen"), node("m")],
      storages: [store("eu", { kind: "power", drainMode: "product", targetMode: "ignore", targetPerSecond: 9 }), goal("out")],
      edges: [edge("fuelmaker", "g"), edge("g", "eu"), edge("m", "out")],
    });
    const bands = findProductChains(p, flow(["fuelmaker>g", 4], ["g>eu", 9], ["m>out", 1]));
    const power = bands.find((b) => b.kind === "power")!;
    expect(power.cardIds.sort()).toEqual(["eu", "fuelmaker", "g"]);
    const at = new Map(arrangeByProductChains(p, size, flow(["fuelmaker>g", 4], ["g>eu", 9], ["m>out", 1])).moves.map((m) => [m.id, m.position]));
    expect(at.get("fuelmaker")!.x).toBeLessThan(at.get("g")!.x);
    expect(at.get("g")!.x).toBeLessThan(at.get("eu")!.x);
  });

  it("marks cards under half share as mixed", () => {
    const p = project({
      nodes: [node("f"), node("a"), node("b"), node("c")],
      storages: [goal("A"), goal("B"), goal("C")],
      edges: [edge("f", "a"), edge("f", "b"), edge("f", "c"), edge("a", "A"), edge("b", "B"), edge("c", "C")],
    });
    const bands = findProductChains(p, flow(["f>a", 4], ["f>b", 3], ["f>c", 3], ["a>A", 4], ["b>B", 3], ["c>C", 3]));
    expect(bands.flatMap((b) => b.mixed ?? [])).toEqual(["f"]);
  });
});

describe("focus", () => {
  const p = project({
    nodes: [node("shared"), node("a"), node("b"), node("only")],
    storages: [store("src"), goal("A"), goal("B"), goal("C")],
    edges: [
      edge("src", "shared"), edge("shared", "a"), edge("shared", "b"),
      edge("a", "A"), edge("b", "B"), edge("only", "C"),
    ],
  });
  const flows = flow(["src>shared", 10], ["shared>a", 9], ["shared>b", 1], ["a>A", 9], ["b>B", 1], ["only>C", 1]);

  it("core is by share; partial feeders go to a strip below, wide strength pulls them in", () => {
    const normal = findProductChains(p, flows, { focus: "item:B" });
    expect(normal[0].focus).toBe(true);
    expect([...normal[0].cardIds].sort()).toEqual(["B", "b"]);
    expect(normal[1].focusEdge).toBe(true);
    expect([...normal[1].cardIds].sort()).toEqual(["shared", "src"]);
    const wide = findProductChains(p, flows, { focus: "item:B", focusMin: 0.1 });
    expect([...wide[0].cardIds].sort()).toEqual(["B", "b", "shared", "src"]);
    expect(bandOf(wide, "a")).toBe("item:A");
    const out = arrangeByProductChains(p, size, flows, { focus: "item:B" });
    expect(out.focusShares!.shared).toBeCloseTo(0.1);
    expect(out.focusEdgeIds!.sort()).toEqual(["shared", "src"]);
  });

  it("lays the focus band on top, apart from the rest, with the ids returned", () => {
    const out = arrangeByProductChains(p, size, flows, { focus: "item:B", focusMin: 0.1 });
    expect([...out.focusCardIds!].sort()).toEqual(["B", "b", "shared", "src"]);
    const at = new Map(out.moves.map((m) => [m.id, m.position]));
    const focusBottom = Math.max(...out.focusCardIds!.map((id) => at.get(id)!.y + 280));
    const rest = out.moves.filter((m) => !out.focusCardIds!.includes(m.id));
    expect(Math.min(...rest.map((m) => m.position.y)) - focusBottom).toBeGreaterThanOrEqual(320);
    expect(at.get("src")!.x).toBeLessThan(at.get("B")!.x);
  });

  it("ignores an unknown focus", () => {
    expect(arrangeByProductChains(p, size, flows, { focus: "item:nope" }).focusCardIds).toBeUndefined();
  });
});

describe("layout", () => {
  it("survives cycles and is deterministic", () => {
    const p = project({
      nodes: [node("a"), node("b")],
      storages: [goal("out")],
      edges: [edge("a", "b"), edge("b", "a"), edge("b", "out")],
    });
    const one = arrangeByProductChains(p, size);
    expect(one.moves).toHaveLength(3);
    expect(arrangeByProductChains(p, size)).toEqual(one);
  });

  it("flows left to right, on the grid, without overlap", () => {
    const p = project({
      nodes: [node("feeder"), node("a"), node("b"), node("g", "gen")],
      storages: [store("src"), goal("prodA"), goal("prodB"), store("eu", { kind: "power" }), store("by", { drainMode: "byproduct" })],
      edges: [
        edge("src", "feeder"), edge("feeder", "a"), edge("feeder", "b"), edge("a", "prodA"),
        edge("b", "prodB"), edge("a", "by"), edge("g", "eu"),
      ],
    });
    const { moves } = arrangeByProductChains(p, size, flow(["feeder>a", 1], ["feeder>b", 1]));
    expect(moves).toHaveLength(9);
    const at = new Map(moves.map((m) => [m.id, m.position]));
    expect(at.get("a")!.x).toBeLessThan(at.get("prodA")!.x);
    expect(at.get("src")!.x).toBeLessThan(at.get("feeder")!.x);
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
});
