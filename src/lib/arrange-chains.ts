/**
 * Arrange by product chains v2 (pure, no DOM).
 *
 * A GOAL is a resource the plan is asked to make: a drawer with an active
 * output target (not Ignore, not an input rate, not rate 0), merged by
 * resource, plus one Power goal (EU drawers and generators). Drawers are
 * transparent: shares flow through drawer to drawer and buffer chains to the
 * cards behind them. Product drawers without a target are not goals, they ride
 * with the card that feeds them. Goals fed mainly by one card (a Distillation
 * Tower's outputs) merge into one goal named after that card.
 *
 * Flow attribution: every card gets a share per goal from the solve's wire
 * flows. A generator counts its fuel fully toward Power. A card whose top
 * share is under half is "mixed"; it sits in its top goal's band and bands
 * are ordered so goals that share many cards sit side by side.
 *
 * Focus: one goal's region (every card with any share toward it, plus its
 * drawers) is laid out as the top band with an extra gap below it.
 *
 * Layout: columns by longest-path depth (a drawer is half a step), barycenter
 * sweeps over the whole stacked layout, band gaps that grow with the wires
 * between neighbours. Only root-level cards are placed; deterministic.
 */

import { BOARD_GRID, cells, snapToGrid } from "./board-grid";
import { insertChainBuffers } from "./arrange-buffers";
import { hasStorageTarget, isInputRate } from "./model/storage-target";
import { isPowerRecipe } from "./power/power-recipe";
import { calculateThroughput } from "./solver/throughput";
import type {
  FactoryEdge,
  FactoryNode,
  FactoryProject,
  FactoryStorage,
  Recipe,
  ThroughputResult,
} from "./model/types";

export interface ChainProject {
  nodes: Array<Pick<FactoryNode, "id" | "recipeId" | "position" | "pocketId">>;
  storages?: FactoryStorage[];
  edges: Array<Pick<FactoryEdge, "id" | "source" | "target">>;
  recipes: Array<
    Pick<Recipe, "id" | "power" | "category"> & Partial<Pick<Recipe, "machineType" | "name">>
  >;
}

export type ChainBandKind = "shared" | "chain" | "other" | "power";

/** A resource key such as "fluid:chlorine", or "power". */
export type GoalKey = string;

export interface ChainGoal {
  id: string;
  /** Every resource key merged into this goal. */
  keys: GoalKey[];
  name: string;
  drawerIds: string[];
}

export interface ChainBand {
  kind: ChainBandKind;
  /** The band id: a goal id, "shared", "other" or "focus". */
  id: string;
  /** The first goal drawer id for a chain band (legacy name). */
  productId?: string;
  name: string;
  /** Cards and drawers. */
  cardIds: string[];
  /** Cards whose best goal takes under half their output flow (flow attribution only). */
  mixed?: string[];
  focus?: boolean;
  /** The thin strip under the focus band: cards that partly feed the focus goal. */
  focusEdge?: boolean;
}

export interface ChainArrangement {
  bands: ChainBand[];
  goals: ChainGoal[];
  moves: Array<{ id: string; position: { x: number; y: number } }>;
  /** Cards and drawers of the focus band, for the UI to select and fit. */
  focusCardIds?: string[];
  /** Boundary cards: share toward the focus goal, 0.05 up to the threshold. */
  focusEdgeIds?: string[];
  focusShares?: Record<string, number>;
  /** The project with buffer drawers inserted (only when some were and the numbers held). */
  project?: FactoryProject;
  inserted: number;
  buffersMessage?: string;
}

export interface ChainOptions {
  focus?: GoalKey;
  /** Core cards have at least this share toward the focus goal (default 0.5). */
  focusMin?: number;
  insertBuffers?: boolean;
  solve?: (project: FactoryProject) => ThroughputResult;
}

type Size = { width: number; height: number };
type Flows = Record<string, { transferredPerSecond: number } | undefined>;
type Vec = Map<string, number>;

const COLUMN_GAP = cells(3);
const ROW_GAP = cells(2);
const BAND_GAP = cells(6);
const FOCUS_GAP = cells(10);
const WIRE_GAP = BOARD_GRID / 2;
const WIRE_GAP_CAP = cells(20);
const EPS = 1e-6;
const EDGE_MIN = 0.05;

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Analysis {
  goals: ChainGoal[];
  bandOf: Map<string, string>;
  bandMeta: Map<string, { kind: ChainBandKind; name: string; productId?: string; focus?: boolean; focusEdge?: boolean }>;
  bandOrder: string[];
  mixed: Set<string>;
  focusShares?: Record<string, number>;
}

function analyze(
  project: ChainProject,
  flows: Flows | undefined,
  focus: GoalKey | undefined,
  focusMin = 0.5,
): Analysis {
  const nodes = project.nodes.filter((node) => node.pocketId === undefined);
  const storages = (project.storages ?? []).filter((storage) => storage.pocketId === undefined);
  const ids = new Set([...nodes.map((n) => n.id), ...storages.map((s) => s.id)]);
  const storageById = new Map(storages.map((s) => [s.id, s]));
  const recipeById = new Map(project.recipes.map((r) => [r.id, r]));
  const generators = new Set<string>();
  const cardName = new Map<string, string>();
  for (const node of nodes) {
    const recipe = recipeById.get(node.recipeId);
    if (isPowerRecipe(recipe)) generators.add(node.id);
    cardName.set(node.id, recipe?.machineType ?? recipe?.name ?? node.id);
  }
  const powerDrawers = new Set(storages.filter((s) => s.kind === "power").map((s) => s.id));

  type Wire = { other: string; flow: number };
  const incoming = new Map<string, Wire[]>();
  const outgoing = new Map<string, Wire[]>();
  for (const edge of project.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    const flow = Math.max(0, flows?.[edge.id]?.transferredPerSecond ?? 0);
    push(outgoing, edge.source, { other: edge.target, flow });
    push(incoming, edge.target, { other: edge.source, flow });
  }
  const inCount = (id: string) => incoming.get(id)?.length ?? 0;
  const outCount = (id: string) => outgoing.get(id)?.length ?? 0;
  const nameOf = (s: FactoryStorage) => s.displayName ?? s.resourceId;

  // 1. Goal drawers, merged by resource.
  const isGoalDrawer = (s: FactoryStorage): boolean =>
    s.kind !== "power" &&
    inCount(s.id) > 0 &&
    s.drainMode !== "byproduct" &&
    s.drainMode !== "trash" &&
    hasStorageTarget(s) &&
    !isInputRate(s);
  let goalDrawers = storages.filter(isGoalDrawer);
  if (goalDrawers.length === 0) {
    // No targets anywhere: fall back to explicit product drawers.
    goalDrawers = storages.filter(
      (s) => s.kind !== "power" && s.drainMode === "product" && inCount(s.id) > 0 && outCount(s.id) === 0,
    );
  }
  const goalDrawerIds = new Set(goalDrawers.map((s) => s.id));
  goalDrawers.sort((a, b) => byText(a.id, b.id));
  const byResource = new Map<string, FactoryStorage[]>();
  for (const s of goalDrawers) push(byResource, `${s.kind}:${s.resourceId}`, s);

  // Cards feeding a drawer, through the drawers behind it, as fractions of its inflow.
  const feedersOf = (drawerId: string): Map<string, number> => {
    const result = new Map<string, number>();
    const walk = (id: string, fraction: number, seen: Set<string>) => {
      const wires = incoming.get(id) ?? [];
      const total = wires.reduce((sum, w) => sum + w.flow, 0);
      for (const w of wires) {
        const part = total > 0 ? (fraction * w.flow) / total : fraction / wires.length;
        if (part <= 0) continue;
        if (storageById.has(w.other)) {
          if (seen.has(w.other) || goalDrawerIds.has(w.other)) continue;
          walk(w.other, part, new Set(seen).add(w.other));
        } else {
          result.set(w.other, (result.get(w.other) ?? 0) + part);
        }
      }
    };
    walk(drawerId, 1, new Set([drawerId]));
    return result;
  };

  // Resource goal -> main feeder card (at least half of its inflow).
  const resourceKeys = [...byResource.keys()].sort(byText);
  const mainFeeder = new Map<string, string>();
  for (const key of resourceKeys) {
    const total = new Map<string, number>();
    const drawers = byResource.get(key)!;
    for (const d of drawers) {
      for (const [card, f] of feedersOf(d.id)) total.set(card, (total.get(card) ?? 0) + f / drawers.length);
    }
    let best: string | undefined;
    let bestFraction = 0;
    for (const [card, f] of [...total].sort((a, b) => byText(a[0], b[0]))) {
      if (f > bestFraction + 1e-9) {
        best = card;
        bestFraction = f;
      }
    }
    if (best !== undefined && bestFraction >= 0.5 && !generators.has(best)) mainFeeder.set(key, best);
  }
  const byFeeder = new Map<string, string[]>();
  for (const [key, card] of mainFeeder) push(byFeeder, card, key);
  const goals: ChainGoal[] = [];
  const merged = new Set<string>();
  for (const [card, keys] of [...byFeeder].sort((a, b) => byText(a[0], b[0]))) {
    if (keys.length < 2) continue;
    const sortedKeys = [...keys].sort(byText);
    const drawers = sortedKeys.flatMap((k) => byResource.get(k)!);
    const names = [...new Set(drawers.map(nameOf))].sort(byText);
    goals.push({
      id: sortedKeys[0],
      keys: sortedKeys,
      name: `${cardName.get(card) ?? card}: ${names.join(", ")}`,
      drawerIds: drawers.map((d) => d.id),
    });
    sortedKeys.forEach((k) => merged.add(k));
  }
  for (const key of resourceKeys) {
    if (merged.has(key)) continue;
    const drawers = byResource.get(key)!;
    goals.push({ id: key, keys: [key], name: nameOf(drawers[0]), drawerIds: drawers.map((d) => d.id) });
  }
  if (powerDrawers.size > 0 || generators.size > 0) {
    goals.push({ id: "power", keys: ["power"], name: "Power", drawerIds: [...powerDrawers].sort(byText) });
  }
  goals.sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id));
  const goalOfNode = new Map<string, string>();
  for (const g of goals) for (const d of g.drawerIds) goalOfNode.set(d, g.id);
  for (const id of generators) goalOfNode.set(id, "power");
  const goalById = new Map(goals.map((g) => [g.id, g]));

  // 2. Share vectors by flow attribution (goal drawers and generators absorb).
  const share = new Map<string, Vec>();
  for (const [id, goal] of goalOfNode) share.set(id, new Map([[goal, 1]]));
  const free = [...ids].filter((id) => !goalOfNode.has(id)).sort(byText);
  for (const id of free) share.set(id, new Map());
  const massOf = (vec: Vec | undefined) => {
    let m = 0;
    for (const v of vec?.values() ?? []) m += v;
    return m;
  };
  for (let iter = 0; iter < 100; iter += 1) {
    let delta = 0;
    for (const id of free) {
      const outs = (outgoing.get(id) ?? []).filter((w) => massOf(share.get(w.other)) > EPS);
      const next: Vec = new Map();
      if (outs.length > 0) {
        let total = outs.reduce((sum, w) => sum + w.flow, 0);
        const equal = total <= 0;
        if (equal) total = outs.length;
        for (const w of outs) {
          const weight = (equal ? 1 : w.flow) / total;
          const target = share.get(w.other)!;
          const mass = massOf(target);
          for (const [g, v] of target) next.set(g, (next.get(g) ?? 0) + (weight * v) / mass);
        }
      }
      const prev = share.get(id)!;
      for (const g of new Set([...prev.keys(), ...next.keys()])) {
        delta = Math.max(delta, Math.abs((next.get(g) ?? 0) - (prev.get(g) ?? 0)));
      }
      share.set(id, next);
    }
    if (delta < EPS) break;
  }

  // 3. Assignment.
  const bandOf = new Map<string, string>();
  const mixed = new Set<string>();
  const topOf = (vec: Vec): { goal: string; value: number } | undefined => {
    let best: { goal: string; value: number } | undefined;
    for (const [g, v] of vec) {
      if (v <= EPS) continue;
      const wins =
        !best ||
        v > best.value + 1e-9 ||
        (Math.abs(v - best.value) <= 1e-9 &&
          (byText(goalById.get(g)!.name, goalById.get(best.goal)!.name) || byText(g, best.goal)) < 0);
      if (wins) best = { goal: g, value: v };
    }
    return best;
  };
  for (const [id, goal] of goalOfNode) bandOf.set(id, goal);
  const sinkDrawers: string[] = [];
  for (const id of free) {
    if (storageById.has(id) && outCount(id) === 0) {
      sinkDrawers.push(id);
      continue;
    }
    const vec = share.get(id)!;
    const top = topOf(vec);
    if (!top) {
      bandOf.set(id, "other");
      continue;
    }
    const strong = [...vec.values()].filter((v) => v > EPS).length;
    if (!flows && strong > 1) {
      bandOf.set(id, "shared");
      continue;
    }
    bandOf.set(id, top.goal);
    if (flows && top.value < 0.5) mixed.add(id);
  }
  // Drawers nothing leaves ride with their heaviest feeder.
  for (const id of sinkDrawers) {
    const feeders = [...(incoming.get(id) ?? [])].sort((a, b) => b.flow - a.flow || byText(a.other, b.other));
    const home = feeders.map((w) => bandOf.get(w.other)).find((b) => b !== undefined);
    bandOf.set(id, home ?? "other");
  }

  // 4. Focus region: any share toward the goal, plus its drawers.
  const focusGoal = focus ? goals.find((g) => g.id === focus || g.keys.includes(focus)) : undefined;
  let hasFocus = false;
  let hasEdge = false;
  let focusShares: Record<string, number> | undefined;
  if (focusGoal) {
    const core = new Set<string>();
    const edge = new Set<string>();
    focusShares = {};
    for (const id of ids) {
      const v = share.get(id)?.get(focusGoal.id) ?? 0;
      if (v > EPS) focusShares[id] = v;
      if (v >= focusMin - 1e-9 && v > EPS) core.add(id);
      else if (v >= EDGE_MIN && !goalOfNode.has(id)) edge.add(id);
    }
    for (const id of sinkDrawers) {
      const feeders = (incoming.get(id) ?? []).map((w) => w.other);
      if (feeders.some((f) => core.has(f))) core.add(id);
      else if (feeders.some((f) => edge.has(f))) edge.add(id);
    }
    if (core.size > 0) {
      hasFocus = true;
      for (const id of core) bandOf.set(id, "focus");
      for (const id of edge) {
        if (!core.has(id)) {
          bandOf.set(id, "focus-edge");
          hasEdge = true;
        }
      }
    }
  }

  // 5. Band meta and order.
  const bandMeta: Analysis["bandMeta"] = new Map();
  const metaOf = (g: ChainGoal) => ({
    kind: (g.id === "power" ? "power" : "chain") as ChainBandKind,
    name: g.name,
    productId: g.id === "power" ? undefined : g.drawerIds[0],
  });
  for (const g of goals) bandMeta.set(g.id, metaOf(g));
  if (hasFocus && focusGoal) bandMeta.set("focus", { ...metaOf(focusGoal), focus: true });
  if (hasEdge && focusGoal) {
    bandMeta.set("focus-edge", { kind: "other", name: `Also feeds ${focusGoal.name}`, focusEdge: true });
  }
  bandMeta.set("shared", { kind: "shared", name: "Shared" });
  bandMeta.set("other", { kind: "other", name: "Other" });

  const populated = new Set(bandOf.values());
  const goalBands = goals.map((g) => g.id).filter((id) => populated.has(id));
  // Greedy chain: neighbours share as many cards as possible.
  const affinity = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const id of free) {
    const vec = [...(share.get(id) ?? [])].filter(([, v]) => v > EPS);
    for (let i = 0; i < vec.length; i += 1) {
      for (let j = i + 1; j < vec.length; j += 1) {
        const key = pairKey(vec[i][0], vec[j][0]);
        affinity.set(key, (affinity.get(key) ?? 0) + Math.min(vec[i][1], vec[j][1]));
      }
    }
  }
  const aff = (a: string, b: string) => affinity.get(pairKey(a, b)) ?? 0;
  const totalAff = (a: string) => goalBands.reduce((sum, b) => (b === a ? sum : sum + aff(a, b)), 0);
  const ordered: string[] = [];
  const remaining = new Set(goalBands);
  const bandName = (id: string) => bandMeta.get(id)?.name ?? id;
  while (remaining.size > 0) {
    const last = ordered[ordered.length - 1];
    const score = (x: string) => (last === undefined ? totalAff(x) : aff(last, x) * 1e6 + totalAff(x));
    let pick: string | undefined;
    for (const id of remaining) {
      const better =
        pick === undefined ||
        score(id) > score(pick) + 1e-9 ||
        (Math.abs(score(id) - score(pick)) <= 1e-9 && byText(bandName(id), bandName(pick)) < 0);
      if (better) pick = id;
    }
    ordered.push(pick!);
    remaining.delete(pick!);
  }
  const bandOrder: string[] = [];
  if (hasFocus) bandOrder.push("focus");
  if (hasEdge) bandOrder.push("focus-edge");
  bandOrder.push("shared", ...ordered, "other");
  return { goals, bandOf, bandMeta, bandOrder, mixed, focusShares };
}

function toBands(a: Analysis, flows: Flows | undefined): ChainBand[] {
  const members = new Map<string, string[]>();
  for (const [id, band] of [...a.bandOf].sort((x, y) => byText(x[0], y[0]))) push(members, band, id);
  return a.bandOrder
    .filter((id) => (members.get(id)?.length ?? 0) > 0)
    .map((id) => {
      const meta = a.bandMeta.get(id)!;
      const cardIds = members.get(id)!;
      return {
        kind: meta.kind,
        id,
        ...(meta.productId ? { productId: meta.productId } : {}),
        name: meta.name,
        cardIds,
        ...(meta.focus ? { focus: true } : {}),
        ...(meta.focusEdge ? { focusEdge: true } : {}),
        ...(flows ? { mixed: cardIds.filter((m) => a.mixed.has(m)) } : {}),
      };
    });
}

/** Group the project's root-level cards and drawers into bands (no geometry). */
export function findProductChains(
  project: ChainProject,
  flows?: Flows,
  options: { focus?: GoalKey; focusMin?: number } = {},
): ChainBand[] {
  return toBands(analyze(project, flows, options.focus, options.focusMin), flows);
}

/** The goals found in a project, for the focus picker. */
export function findChainGoals(project: ChainProject, flows?: Flows): ChainGoal[] {
  return analyze(project, flows, undefined).goals;
}

/** Columns of one band by longest-path depth; a drawer is half a step. */
function bandColumns(
  members: string[],
  edges: Array<{ source: string; target: string }>,
  isDrawer: (id: string) => boolean,
): string[][] {
  const set = new Set(members);
  const order = [...members].sort(byText);
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const edge of edges) {
    if (!set.has(edge.source) || !set.has(edge.target) || edge.source === edge.target) continue;
    push(preds, edge.target, edge.source);
    push(succs, edge.source, edge.target);
  }
  // A drawer with nothing in its band behind it hangs just left of its consumer.
  const sourceLike = new Set(order.filter((id) => isDrawer(id) && !(preds.get(id)?.length ?? 0)));
  const depth = new Map<string, number>();
  const onStack = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    onStack.add(id);
    let d = 0;
    for (const from of [...(preds.get(id) ?? [])].sort(byText)) {
      if (onStack.has(from) || sourceLike.has(from)) continue;
      const step = !isDrawer(from) && !isDrawer(id) ? 2 : 1;
      d = Math.max(d, visit(from) + step);
    }
    onStack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of order) if (!sourceLike.has(id)) visit(id);
  for (const id of order) {
    if (!sourceLike.has(id)) continue;
    const consumers = (succs.get(id) ?? []).filter((c) => !sourceLike.has(c));
    depth.set(id, consumers.length ? Math.min(...consumers.map((c) => depth.get(c)!)) - 1 : 0);
  }
  const low = Math.min(0, ...depth.values());
  const byDepth = new Map<number, string[]>();
  for (const id of order) push(byDepth, depth.get(id)! - low, id);
  return [...byDepth.keys()].sort((a, b) => a - b).map((d) => byDepth.get(d)!);
}

interface BandLayout {
  id: string;
  cols: string[][];
  top: number;
}

export function arrangeByProductChains(
  project: ChainProject,
  sizeOf: (id: string) => Size,
  flows?: Flows,
  options: ChainOptions = {},
): ChainArrangement {
  const analysis = analyze(project, flows, options.focus, options.focusMin);
  let work = project;
  let inserted = 0;
  let buffersMessage: string | undefined;
  let builtProject: FactoryProject | undefined;
  if (options.insertBuffers) {
    const result = insertChainBuffers(project as unknown as FactoryProject, new Map(analysis.bandOf), {
      solve: options.solve ?? ((p) => calculateThroughput(p)),
    });
    buffersMessage = result.message;
    if (result.verified && result.inserted > 0) {
      builtProject = result.project;
      inserted = result.inserted;
      work = result.project;
      const known = new Set((project.storages ?? []).map((s) => s.id));
      for (const storage of work.storages ?? []) {
        if (known.has(storage.id) || storage.pocketId !== undefined) continue;
        const consumer = work.edges.find((e) => e.source === storage.id)?.target;
        analysis.bandOf.set(storage.id, (consumer && analysis.bandOf.get(consumer)) || "other");
      }
    }
  }

  const bands = toBands(analysis, flows);
  const storageIds = new Set((work.storages ?? []).map((s) => s.id));
  const current = new Map<string, { x: number; y: number }>();
  for (const n of work.nodes) if (n.pocketId === undefined) current.set(n.id, n.position);
  for (const s of work.storages ?? []) if (s.pocketId === undefined) current.set(s.id, s.position);
  const memberIds = bands.flatMap((b) => b.cardIds).filter((id) => current.has(id));
  const originX = snapToGrid(Math.min(...memberIds.map((id) => current.get(id)!.x), 0));
  const originY = snapToGrid(Math.min(...memberIds.map((id) => current.get(id)!.y), 0));
  const edges = work.edges.filter((e) => e.source !== e.target);
  const bandById = new Map<string, string>();
  for (const b of bands) for (const id of b.cardIds) bandById.set(id, b.id);

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const wires = new Map<string, number>();
  for (const e of edges) {
    const a = bandById.get(e.source);
    const b = bandById.get(e.target);
    if (a === undefined || b === undefined) continue;
    push(preds, e.target, e.source);
    push(succs, e.source, e.target);
    if (a !== b) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      wires.set(key, (wires.get(key) ?? 0) + 1);
    }
  }

  // Band tops: heights do not depend on row order.
  const layouts: BandLayout[] = [];
  let top = originY;
  bands.forEach((band, index) => {
    const cols = bandColumns(band.cardIds, edges, (id) => storageIds.has(id));
    let height = BOARD_GRID;
    for (const col of cols) {
      const h = col.reduce((sum, id, i) => sum + sizeOf(id).height + (i ? ROW_GAP : 0), 0);
      height = Math.max(height, h);
    }
    layouts.push({ id: band.id, cols, top });
    const next = bands[index + 1];
    if (next) {
      const key = band.id < next.id ? `${band.id}|${next.id}` : `${next.id}|${band.id}`;
      const spread = Math.min((wires.get(key) ?? 0) * WIRE_GAP, WIRE_GAP_CAP);
      top += snapToGrid(height) + BAND_GAP + spread + (band.focusEdge || (band.focus && !next.focusEdge) ? FOCUS_GAP : 0);
    }
  });

  const centerY = new Map<string, number>();
  const stack = (layout: BandLayout, col: string[]) => {
    let y = layout.top;
    for (const id of col) {
      const h = sizeOf(id).height;
      centerY.set(id, y + h / 2);
      y += h + ROW_GAP;
    }
  };
  for (const layout of layouts) for (const col of layout.cols) stack(layout, col);
  // Barycenter sweeps use every neighbour's real height, in any band.
  for (let pass = 0; pass < 6; pass += 1) {
    const forward = pass % 2 === 0;
    for (const layout of layouts) {
      const seq = layout.cols.map((_, i) => (forward ? i : layout.cols.length - 1 - i));
      for (const c of seq) {
        const col = layout.cols[c];
        const bary = new Map<string, number>();
        for (const id of col) {
          const near = (forward ? preds.get(id) : succs.get(id)) ?? [];
          const far = ((forward ? succs.get(id) : preds.get(id)) ?? []).filter(
            (n) => bandById.get(n) !== layout.id,
          );
          const nb = [...near, ...far];
          bary.set(id, nb.length ? nb.reduce((s, n) => s + (centerY.get(n) ?? 0), 0) / nb.length : centerY.get(id)!);
        }
        col.sort((a, b) => bary.get(a)! - bary.get(b)! || byText(a, b));
        stack(layout, col);
      }
    }
  }

  const moves: ChainArrangement["moves"] = [];
  for (const layout of layouts) {
    let x = originX;
    for (const col of layout.cols) {
      let y = layout.top;
      let width = 0;
      for (const id of col) {
        const size = sizeOf(id);
        moves.push({ id, position: { x: snapToGrid(x), y: snapToGrid(y) } });
        y += size.height + ROW_GAP;
        width = Math.max(width, size.width);
      }
      x += width + COLUMN_GAP;
    }
  }
  const focusBand = bands.find((b) => b.focus);
  const edgeBand = bands.find((b) => b.focusEdge);
  return {
    bands,
    goals: analysis.goals,
    moves,
    ...(focusBand ? { focusCardIds: focusBand.cardIds } : {}),
    ...(edgeBand ? { focusEdgeIds: edgeBand.cardIds } : {}),
    ...(focusBand && analysis.focusShares ? { focusShares: analysis.focusShares } : {}),
    ...(builtProject ? { project: builtProject } : {}),
    inserted,
    ...(buffersMessage ? { buffersMessage } : {}),
  };
}
