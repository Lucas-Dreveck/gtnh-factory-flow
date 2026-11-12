/**
 * Arrange by product chains (pure, no DOM).
 *
 * Every final PRODUCT drawer (drain mode product, or an output target) owns
 * the chain of cards that feed it, walked backward over wires. A card feeding
 * two or more products is SHARED and goes to the Shared band. Power (EU)
 * drawers are never products and never pull cards: generators and EU drawers
 * sit in a Power band. Each band is laid left to right by longest-path depth,
 * columns ordered by barycenter. Deterministic; cycles are tolerated.
 * Only root-level cards are placed; cards inside boards are left alone.
 */

import { BOARD_GRID, cells, snapToGrid } from "./board-grid";
import { hasStorageTarget, isInputRate } from "./model/storage-target";
import { isPowerRecipe } from "./power/power-recipe";
import type { FactoryEdge, FactoryNode, FactoryStorage, Recipe } from "./model/types";

export interface ChainProject {
  nodes: Array<Pick<FactoryNode, "id" | "recipeId" | "position" | "pocketId">>;
  storages?: FactoryStorage[];
  edges: Array<Pick<FactoryEdge, "id" | "source" | "target">>;
  recipes: Array<Pick<Recipe, "id" | "power" | "category">>;
}

export type ChainBandKind = "shared" | "chain" | "other" | "power";

export interface ChainBand {
  kind: ChainBandKind;
  /** The product drawer id for a chain band. */
  productId?: string;
  name: string;
  cardIds: string[];
  /** Cards whose best product takes under half their output flow (flow attribution only). */
  mixed?: string[];
}

export interface ChainArrangement {
  bands: ChainBand[];
  moves: Array<{ id: string; position: { x: number; y: number } }>;
}

type Size = { width: number; height: number };

const COLUMN_GAP = cells(3);
const ROW_GAP = cells(2);
const BAND_GAP = cells(6);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function isProductStorage(storage: FactoryStorage): boolean {
  if (storage.kind === "power") return false;
  if (storage.drainMode === "byproduct" || storage.drainMode === "trash") return false;
  if (isInputRate(storage)) return false;
  return storage.drainMode === "product" || hasStorageTarget(storage);
}

/** Group the project's root-level cards into bands (no geometry). */
export function findProductChains(
  project: ChainProject,
  flows?: Record<string, { transferredPerSecond: number } | undefined>,
): ChainBand[] {
  const nodes = project.nodes.filter((node) => node.pocketId === undefined);
  const storages = (project.storages ?? []).filter((storage) => storage.pocketId === undefined);
  const allIds = [...nodes.map((n) => n.id), ...storages.map((s) => s.id)];
  const ids = new Set(allIds);
  const recipeById = new Map(project.recipes.map((r) => [r.id, r]));
  const power = new Set<string>();
  for (const node of nodes) {
    if (isPowerRecipe(recipeById.get(node.recipeId))) power.add(node.id);
  }
  for (const storage of storages) {
    if (storage.kind === "power") power.add(storage.id);
  }
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of project.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    push(incoming, edge.target, edge.source);
    push(outgoing, edge.source, edge.target);
  }
  const storageById = new Map(storages.map((s) => [s.id, s]));
  let products = storages
    .filter((s) => isProductStorage(s) && (incoming.get(s.id)?.length ?? 0) > 0)
    .map((s) => s.id);
  if (products.length === 0) {
    // Fallback: sink cards, those with inputs and nothing downstream.
    products = allIds.filter((id) => {
      const mode = storageById.get(id)?.drainMode;
      return (
        !power.has(id) &&
        (incoming.get(id)?.length ?? 0) > 0 &&
        (outgoing.get(id)?.length ?? 0) === 0 &&
        mode !== "trash" &&
        mode !== "byproduct"
      );
    });
  }
  products.sort();
  const productSet = new Set(products);

  const chainsOf = new Map<string, string[]>();
  for (const product of products) {
    const seen = new Set<string>([product]);
    const stack = [product];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const from of incoming.get(id) ?? []) {
        if (seen.has(from) || power.has(from) || productSet.has(from)) continue;
        seen.add(from);
        stack.push(from);
      }
    }
    for (const id of seen) push(chainsOf, id, product);
  }
  // Flow attribution: a card goes to the product that takes most of its output.
  const mixed = new Set<string>();
  if (flows) {
    const flowOf = (edge: { id: string }) => Math.max(0, flows[edge.id]?.transferredPerSecond ?? 0);
    const outEdges = new Map<string, Array<{ target: string; flow: number }>>();
    for (const edge of project.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target) || power.has(edge.target)) continue;
      push(outEdges, edge.source, { target: edge.target, flow: flowOf(edge) });
    }
    const share = new Map<string, Map<string, number>>();
    for (const product of products) share.set(product, new Map([[product, 1]]));
    const cardIds = allIds.filter((id) => !power.has(id) && !productSet.has(id)).sort();
    for (const id of cardIds) share.set(id, new Map());
    for (let iter = 0; iter < 50; iter += 1) {
      let delta = 0;
      for (const id of cardIds) {
        const outs = outEdges.get(id) ?? [];
        const total = outs.reduce((sum, o) => sum + o.flow, 0);
        const next = new Map<string, number>();
        if (total > 0) {
          for (const o of outs) {
            for (const [p, v] of share.get(o.target) ?? []) {
              next.set(p, (next.get(p) ?? 0) + (o.flow * v) / total);
            }
          }
        }
        const prev = share.get(id)!;
        for (const p of products) delta = Math.max(delta, Math.abs((next.get(p) ?? 0) - (prev.get(p) ?? 0)));
        share.set(id, next);
      }
      if (delta < 1e-6) break;
    }
    const nameOf = (p: string) => storageById.get(p)?.displayName ?? storageById.get(p)?.resourceId ?? p;
    for (const id of cardIds) {
      if (!chainsOf.has(id)) continue;
      let best: string | undefined;
      let bestShare = 1e-9;
      for (const [p, v] of share.get(id)!) {
        const better =
          v > bestShare + 1e-9 ||
          (Math.abs(v - bestShare) <= 1e-9 && best !== undefined && (nameOf(p) < nameOf(best) || (nameOf(p) === nameOf(best) && p < best)));
        if (better) {
          best = p;
          bestShare = v;
        }
      }
      if (best === undefined) continue;
      chainsOf.set(id, [best]);
      if (bestShare < 0.5) mixed.add(id);
    }
  }
  // Byproduct and trash drawers ride with the cards that feed them.
  for (const storage of storages) {
    if (chainsOf.has(storage.id) || power.has(storage.id)) continue;
    if ((outgoing.get(storage.id)?.length ?? 0) > 0) continue;
    const feeders = (incoming.get(storage.id) ?? []).filter((f) => chainsOf.has(f));
    const merged = [...new Set(feeders.flatMap((f) => chainsOf.get(f)!))].sort();
    if (merged.length > 0) chainsOf.set(storage.id, merged);
  }

  const shared: string[] = [];
  const perProduct = new Map<string, string[]>(products.map((p) => [p, []]));
  const other: string[] = [];
  const powerIds: string[] = [];
  for (const id of allIds) {
    const chains = chainsOf.get(id);
    if (power.has(id)) powerIds.push(id);
    else if (!chains) other.push(id);
    else if (chains.length > 1) shared.push(id);
    else perProduct.get(chains[0])!.push(id);
  }
  const bands: ChainBand[] = [];
  if (shared.length) bands.push({ kind: "shared", name: "Shared", cardIds: shared });
  for (const product of products) {
    const members = perProduct.get(product)!;
    if (!members.length) continue;
    const storage = storageById.get(product);
    bands.push({
      kind: "chain",
      productId: product,
      name: storage?.displayName ?? storage?.resourceId ?? product,
      cardIds: members,
      ...(mixed.size ? { mixed: members.filter((m) => mixed.has(m)) } : {}),
    });
  }
  if (other.length) bands.push({ kind: "other", name: "Other", cardIds: other });
  if (powerIds.length) bands.push({ kind: "power", name: "Power", cardIds: powerIds });
  return bands;
}

/** Lay one band out; positions are relative to (0,0). */
function layoutBand(
  members: string[],
  edges: Array<{ source: string; target: string }>,
  sizeOf: (id: string) => Size,
): { positions: Map<string, { x: number; y: number }>; height: number } {
  const set = new Set(members);
  const order = [...members].sort();
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const edge of edges) {
    if (!set.has(edge.source) || !set.has(edge.target) || edge.source === edge.target) continue;
    push(preds, edge.target, edge.source);
    push(succs, edge.source, edge.target);
  }
  // Longest-path depth; back edges (cycles) are skipped via the DFS stack.
  const depth = new Map<string, number>();
  const onStack = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    onStack.add(id);
    let d = 0;
    for (const from of [...(preds.get(id) ?? [])].sort()) {
      if (onStack.has(from)) continue;
      d = Math.max(d, visit(from) + 1);
    }
    onStack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of order) visit(id);
  const cols: string[][] = [];
  for (const id of order) {
    const d = depth.get(id)!;
    while (cols.length <= d) cols.push([]);
    cols[d].push(id);
  }
  const rowOf = new Map<string, number>();
  cols.forEach((col) => col.forEach((id, i) => rowOf.set(id, i)));
  const sweep = (forward: boolean) => {
    const seq = cols.map((_, i) => (forward ? i : cols.length - 1 - i));
    for (const c of seq) {
      const col = cols[c];
      const bary = new Map<string, number>();
      for (const id of col) {
        const nb = (forward ? preds.get(id) : succs.get(id)) ?? [];
        bary.set(
          id,
          nb.length ? nb.reduce((s, n) => s + (rowOf.get(n) ?? 0), 0) / nb.length : rowOf.get(id)!,
        );
      }
      col.sort((a, b) => bary.get(a)! - bary.get(b)! || (a < b ? -1 : 1));
      col.forEach((id, i) => rowOf.set(id, i));
    }
  };
  sweep(true);
  sweep(false);
  sweep(true);
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  let height = 0;
  for (const col of cols) {
    let y = 0;
    let width = 0;
    for (const id of col) {
      const size = sizeOf(id);
      positions.set(id, { x: snapToGrid(x), y: snapToGrid(y) });
      y += size.height + ROW_GAP;
      width = Math.max(width, size.width);
    }
    height = Math.max(height, y - ROW_GAP);
    x += width + COLUMN_GAP;
  }
  return { positions, height: Math.max(height, BOARD_GRID) };
}

export function arrangeByProductChains(
  project: ChainProject,
  sizeOf: (id: string) => Size,
  flows?: Record<string, { transferredPerSecond: number } | undefined>,
): ChainArrangement {
  const bands = findProductChains(project, flows);
  const current = new Map<string, { x: number; y: number }>();
  for (const n of project.nodes) if (n.pocketId === undefined) current.set(n.id, n.position);
  for (const s of project.storages ?? []) if (s.pocketId === undefined) current.set(s.id, s.position);
  const members = bands.flatMap((b) => b.cardIds);
  const originX = snapToGrid(Math.min(...members.map((id) => current.get(id)?.x ?? 0), 0));
  const originY = snapToGrid(Math.min(...members.map((id) => current.get(id)?.y ?? 0), 0));
  const moves: ChainArrangement["moves"] = [];
  let top = originY;
  for (const band of bands) {
    const { positions, height } = layoutBand(band.cardIds, project.edges, sizeOf);
    for (const id of band.cardIds) {
      const p = positions.get(id)!;
      moves.push({ id, position: { x: originX + p.x, y: top + p.y } });
    }
    top += snapToGrid(height) + BAND_GAP;
  }
  return { bands, moves };
}
