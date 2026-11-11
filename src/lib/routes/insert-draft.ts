import { spotIsFree, type PlacementRect } from "@/components/flow/board-placement";
import {
  BOARD_GRID,
  RECIPE_NODE_WIDTH,
  STORAGE_NODE_HEIGHT,
  STORAGE_NODE_WIDTH,
  snapToGrid,
} from "@/lib/board-grid";
import { addRouteOption, createRouteChoice, pruneRouteChoices } from "@/lib/model/route-choices";
import type {
  FactoryEdge,
  FactoryNode,
  FactoryProject,
  FactoryStorage,
  RouteChoice,
} from "@/lib/model/types";
import type { RouteOptionDraft } from "./types";

const NODE_HEIGHT = BOARD_GRID * 14;
/** Clear space between the current route and the one laid beside it. */
const ROUTE_GAP = BOARD_GRID * 20;

export interface InsertedDraft {
  project: FactoryProject;
  /** The choice the alternative joined or created. */
  choiceId: string;
  /** The new option. */
  optionId: string;
  /** The ids the draft's cards ended up with. */
  nodeIds: string[];
  storageIds: string[];
}

export interface InsertDraftIds {
  choice: string;
  a: string;
  b: string;
  option: string;
  /** A fresh id for a card or wire whose draft id is already taken. */
  fresh: (prefix: string) => string;
}

function rectOf(position: { x: number; y: number }, kind: "node" | "storage"): PlacementRect {
  return kind === "node"
    ? { ...position, width: RECIPE_NODE_WIDTH, height: NODE_HEIGHT }
    : { ...position, width: STORAGE_NODE_WIDTH, height: STORAGE_NODE_HEIGHT };
}

function boundsOf(rects: PlacementRect[]): PlacementRect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

/**
 * Where the discovered route goes: beside the route it replaces (to its
 * right, top-aligned), slid down or up until the whole cluster touches
 * nothing else in that board space; failing that, past everything.
 */
function shiftFor(
  project: FactoryProject,
  replacedIds: Set<string>,
  pocketId: string | undefined,
  cluster: PlacementRect,
): { dx: number; dy: number } {
  const sameSpace = <T extends { pocketId?: string }>(entry: T) => entry.pocketId === pocketId;
  const blockers: PlacementRect[] = [
    ...project.nodes.filter(sameSpace).map((n) => rectOf(n.position, "node")),
    ...(project.storages ?? []).filter(sameSpace).map((s) => rectOf(s.position, "storage")),
  ];
  const anchors = project.nodes.filter((n) => replacedIds.has(n.id)).map((n) => rectOf(n.position, "node"));
  const anchor = anchors.length > 0 ? boundsOf(anchors) : undefined;
  const everything = blockers.length > 0 ? boundsOf(blockers) : undefined;
  const farX = snapToGrid((everything ? everything.x + everything.width : 0) + ROUTE_GAP);
  const startX = snapToGrid(anchor ? anchor.x + anchor.width + ROUTE_GAP : farX);
  const startY = snapToGrid(anchor ? anchor.y : (everything?.y ?? 0));
  const dx = startX - cluster.x;
  const baseDy = startY - cluster.y;
  const step = snapToGrid(cluster.height + BOARD_GRID * 4);
  for (let i = 0; i < 25; i += 1) {
    // 0, +1, -1, +2, -2 ... rows of the cluster's own height.
    const k = i === 0 ? 0 : i % 2 === 1 ? (i + 1) / 2 : -i / 2;
    const dy = baseDy + k * step;
    if (spotIsFree({ ...cluster, x: cluster.x + dx, y: cluster.y + dy }, blockers, BOARD_GRID * 2)) {
      return { dx, dy };
    }
  }
  return { dx: farX - cluster.x, dy: baseDy };
}

/**
 * A discovered route becomes an alternative on the board: its cards, drawers
 * and wires are added (ids made unique, positions beside the current route),
 * the replaced cards become option A, the new ones option B, and `active`
 * stays on A. Pure; the store applies it as one undo step.
 *
 * `choiceId` extends that choice (the new cards fill its first empty option or
 * add one); otherwise a choice is created from `draft.replacesNodeIds`.
 * Returns undefined when nothing can be added (no replaced cards to compare
 * against, a full choice, a choice that is gone).
 */
export function insertRouteDraft(
  project: FactoryProject,
  draft: RouteOptionDraft,
  options: { name: string; choiceId?: string; currentLabel?: string },
  ids: InsertDraftIds,
): InsertedDraft | undefined {
  if (draft.nodes.length === 0) return undefined;
  const existingChoice = options.choiceId
    ? project.routeChoices?.find((choice) => choice.id === options.choiceId)
    : undefined;
  if (options.choiceId && !existingChoice) return undefined;

  const nodeIdsOnBoard = new Set(project.nodes.map((n) => n.id));
  const storageIdsOnBoard = new Set((project.storages ?? []).map((s) => s.id));
  const edgeIdsOnBoard = new Set(project.edges.map((e) => e.id));
  const remap = new Map<string, string>();
  const unique = (prefix: string, id: string, taken: Set<string>) => {
    const next = taken.has(id) ? ids.fresh(prefix) : id;
    taken.add(next);
    remap.set(id, next);
    return next;
  };

  const replaced = draft.replacesNodeIds.filter((id) => project.nodes.some((n) => n.id === id));
  const pocketId = project.nodes.find((n) => n.id === replaced[0])?.pocketId;

  const cluster = boundsOf([
    ...draft.nodes.map((n) => rectOf(n.position, "node")),
    ...draft.storages.map((s) => rectOf(s.position, "storage")),
  ]);
  const { dx, dy } = shiftFor(project, new Set(replaced), pocketId, cluster);

  const nodes: FactoryNode[] = draft.nodes.map((n) => ({
    ...n,
    id: unique("node", n.id, nodeIdsOnBoard),
    pocketId,
    position: { x: n.position.x + dx, y: n.position.y + dy },
  }));
  const storages: FactoryStorage[] = draft.storages.map((s) => ({
    ...s,
    id: unique("storage", s.id, storageIdsOnBoard),
    pocketId,
    position: { x: s.position.x + dx, y: s.position.y + dy },
  }));
  // A wire may touch a card the route shares with the plan (a feeder card or a
  // drawer already on the board); only the route's own ids are remapped.
  const edges: FactoryEdge[] = draft.edges.map((e) => ({
    ...e,
    id: unique("edge", e.id, edgeIdsOnBoard),
    source: remap.get(e.source) ?? e.source,
    target: remap.get(e.target) ?? e.target,
    waypoints: e.waypoints?.map((w) => ({ x: w.x + dx, y: w.y + dy })),
  }));

  const known = new Set(project.recipes.map((r) => r.id));
  let next: FactoryProject = {
    ...project,
    recipes: [...project.recipes, ...draft.recipes.filter((r) => !known.has(r.id))],
    nodes: [...project.nodes, ...nodes],
    storages: [...(project.storages ?? []), ...storages],
    edges: [...project.edges, ...edges],
  };

  const selection = { nodeIds: nodes.map((n) => n.id), storageIds: storages.map((s) => s.id) };
  let choiceId: string;
  if (existingChoice) {
    const added = addRouteOption(next, existingChoice.id, selection, ids.option);
    if (added === next) return undefined;
    next = added;
    choiceId = existingChoice.id;
  } else {
    if (replaced.length === 0) return undefined;
    next = createRouteChoice(
      next,
      options.name,
      { nodeIds: replaced, storageIds: [] },
      { choice: ids.choice, a: ids.a, b: ids.b },
    );
    next = addRouteOption(next, ids.choice, selection, ids.option);
    choiceId = ids.choice;
  }

  // Name the options: A is the route running now, the new one is what was found.
  const holds = (option: RouteChoice["options"][number]) =>
    selection.nodeIds.length > 0
      ? option.nodeIds.includes(selection.nodeIds[0])
      : option.storageIds.includes(selection.storageIds[0]);
  let optionId = ids.option;
  next = {
    ...next,
    routeChoices: next.routeChoices?.map((choice) => {
      if (choice.id !== choiceId) return choice;
      return {
        ...choice,
        options: choice.options.map((option, index) => {
          const letter = "ABCDEF"[index] ?? String(index + 1);
          if (holds(option)) {
            optionId = option.id;
            return { ...option, label: `${letter}: ${draft.label}`, origin: "discovered" as const };
          }
          if (!existingChoice && option.id === ids.a && options.currentLabel) {
            return { ...option, label: `${letter}: ${options.currentLabel}` };
          }
          return option;
        }),
      };
    }),
  };
  return {
    project: pruneRouteChoices(next),
    choiceId,
    optionId,
    nodeIds: selection.nodeIds,
    storageIds: selection.storageIds,
  };
}
