import type {
  FactoryEdge,
  FactoryProject,
  FactoryStorage,
  ResourceAmount,
  ThroughputResult,
} from "@/lib/model/types";

/**
 * Chain arrangement puts a buffer drawer on every wire that crosses from one
 * chain band to another, so the long link reads as "drawer, then wire" and the
 * layout can park the drawer between the bands.
 *
 * The buffer is STRICT: it passes on only what its consumers pull and hands the
 * surplus back to the producer, exactly what the direct wire did (an overflow
 * buffer banks surplus and lets the producer run past its consumers). It
 * carries no target, drain mode or pool side, so the solver sees a plain
 * pass-through (`getStorageRoles` = buffer). The insertion is never trusted:
 * both projects are solved and every figure the player reads is compared; any
 * resource whose buffers move a number is dropped.
 */

export interface InsertChainBuffersOptions {
  solve: (project: FactoryProject) => ThroughputResult;
}

export interface InsertChainBuffersResult {
  project: FactoryProject;
  inserted: number;
  verified: boolean;
  message: string;
}

const TOLERANCE = 1e-6;

interface Group {
  id: string;
  resourceKey: string;
  resourceName: string;
  storage: FactoryStorage;
  inEdge: FactoryEdge;
  outEdges: FactoryEdge[];
  replaced: Set<string>;
}

/** Two FNV-style 32-bit hashes: stable ids without crypto. */
function stableHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function handleId(side: "input" | "output", kind: string, id: string): string {
  return `${side}:${kind}:${encodeURIComponent(id)}`;
}

function resourceInfo(project: FactoryProject, edge: FactoryEdge): Partial<ResourceAmount> {
  const drawer = (project.storages ?? []).find(
    (s) => s.kind === edge.resourceKind && s.resourceId === edge.resourceId && (s.iconAtlas || s.iconPath),
  );
  if (drawer) {
    return {
      displayName: drawer.displayName,
      iconPath: drawer.iconPath,
      iconAtlas: drawer.iconAtlas,
      dominantColor: drawer.dominantColor,
    };
  }
  const node = project.nodes.find((n) => n.id === edge.source);
  const recipe = node && project.recipes.find((r) => r.id === node.recipeId);
  const port = recipe?.outputs.find((o) => o.kind === edge.resourceKind && o.id === edge.resourceId);
  return port
    ? {
        displayName: port.displayName,
        iconPath: port.iconPath,
        iconAtlas: port.iconAtlas,
        dominantColor: port.dominantColor ?? port.iconAtlas?.dominantColor,
      }
    : {};
}

function planGroups(project: FactoryProject, assignment: ReadonlyMap<string, string>): Group[] {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const existing = new Set([...(project.storages ?? []).map((s) => s.id), ...project.edges.map((e) => e.id)]);
  const groups = new Map<string, Group>();
  for (const edge of project.edges) {
    if (edge.resourceKind === "power" || edge.crossForm) continue;
    const from = nodes.get(edge.source);
    const to = nodes.get(edge.target);
    if (!from || !to || from.id === to.id) continue;
    const fromBand = assignment.get(from.id);
    const toBand = assignment.get(to.id);
    if (fromBand === undefined || toBand === undefined || fromBand === toBand) continue;
    const key = `${from.id}|${edge.sourceHandle ?? ""}|${edge.resourceKind}|${edge.resourceId}|${toBand}`;
    const hash = stableHash(key);
    const id = `storage-buf-${hash}`;
    if (existing.has(id)) continue;
    let group = groups.get(key);
    if (!group) {
      const info = resourceInfo(project, edge);
      const storage: FactoryStorage = {
        id,
        kind: edge.resourceKind,
        resourceId: edge.resourceId,
        displayName: info.displayName ?? edge.label,
        iconPath: info.iconPath,
        iconAtlas: info.iconAtlas,
        dominantColor: info.dominantColor,
        bufferMode: "strict",
        position: { ...to.position },
        pocketId: to.pocketId,
        productionGroupId: to.productionGroupId,
      };
      for (const k of Object.keys(storage) as Array<keyof FactoryStorage>) {
        if (storage[k] === undefined) delete storage[k];
      }
      group = {
        id,
        resourceKey: `${edge.resourceKind}:${edge.resourceId}`,
        resourceName: storage.displayName ?? edge.resourceId,
        storage,
        inEdge: {
          id: `edge-buf-in-${hash}`,
          source: from.id,
          target: id,
          sourceHandle: edge.sourceHandle,
          targetHandle: handleId("input", edge.resourceKind, edge.resourceId),
          resourceKind: edge.resourceKind,
          resourceId: edge.resourceId,
          label: edge.label,
        },
        outEdges: [],
        replaced: new Set(),
      };
      if (group.inEdge.sourceHandle === undefined) delete group.inEdge.sourceHandle;
      if (group.inEdge.label === undefined) delete group.inEdge.label;
      groups.set(key, group);
    }
    const { waypoints: _waypoints, ...rest } = edge;
    group.outEdges.push({
      ...rest,
      id: `edge-buf-out-${stableHash(edge.id)}`,
      source: group.id,
      sourceHandle: handleId("output", edge.resourceKind, edge.resourceId),
    });
    group.replaced.add(edge.id);
  }
  return [...groups.values()];
}

function apply(project: FactoryProject, groups: Group[]): FactoryProject {
  if (groups.length === 0) return project;
  const replaced = new Set(groups.flatMap((g) => [...g.replaced]));
  return {
    ...project,
    storages: [...(project.storages ?? []), ...groups.map((g) => g.storage)],
    edges: [...project.edges.filter((e) => !replaced.has(e.id)), ...groups.flatMap((g) => [g.inEdge, ...g.outEdges])],
  };
}

const close = (a: number, b: number) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
};

class Differs extends Error {}

/** First figure that differs between two solves, over the original cards only. */
function firstDifference(
  original: FactoryProject,
  base: ThroughputResult,
  next: ThroughputResult,
): string | undefined {
  const check = (label: string, a: number | undefined, b: number | undefined) => {
    if (!close(a ?? 0, b ?? 0)) throw new Differs(label);
  };
  try {
    check("total power", base.totalEuT, next.totalEuT);
    check("total power per second", base.totalEuPerSecond, next.totalEuPerSecond);
    for (const node of original.nodes) {
      const a = base.nodes[node.id];
      const b = next.nodes[node.id];
      if (!a || !b) {
        if (a !== b) throw new Differs(`card ${node.id} result`);
        continue;
      }
      check(`machines of ${a.recipeName}`, a.theoreticalMachinesRequired, b.theoreticalMachinesRequired);
      check(`utilization of ${a.recipeName}`, a.utilization, b.utilization);
      check(`power of ${a.recipeName}`, a.euT, b.euT);
    }
    for (const storage of original.storages ?? []) {
      const a = base.storages[storage.id];
      const b = next.storages[storage.id];
      if (!a || !b) {
        if (a !== b) throw new Differs(`drawer ${storage.id} result`);
        continue;
      }
      const name = a.displayName ?? a.resourceId;
      check(`${name} produced`, a.producedPerSecond, b.producedPerSecond);
      check(`${name} consumed`, a.consumedPerSecond, b.consumedPerSecond);
      if (!!a.targetUnreachable !== !!b.targetUnreachable) throw new Differs(`${name} target met`);
    }
    for (const [key, a] of Object.entries(base.resources)) {
      const b = (next.resources as Record<string, typeof a | undefined>)[key];
      const name = a.displayName ?? a.resourceId;
      check(`${name} imports`, a.importedPerSecond, b?.importedPerSecond);
      check(`${name} product`, a.productPerSecond, b?.productPerSecond);
      check(`${name} byproduct`, a.byproductPerSecond, b?.byproductPerSecond);
      check(`${name} surplus`, a.surplusPerSecond, b?.surplusPerSecond);
      check(`${name} deficit`, a.deficitPerSecond, b?.deficitPerSecond);
    }
  } catch (error) {
    if (error instanceof Differs) return error.message;
    throw error;
  }
  return undefined;
}

export function insertChainBuffers(
  project: FactoryProject,
  assignment: ReadonlyMap<string, string>,
  opts: InsertChainBuffersOptions,
): InsertChainBuffersResult {
  const groups = planGroups(project, assignment);
  if (groups.length === 0) {
    return { project, inserted: 0, verified: true, message: "No wire crosses between bands." };
  }
  let base: ThroughputResult;
  try {
    base = opts.solve(project);
  } catch {
    return { project, inserted: 0, verified: false, message: "The plan could not be solved, so no buffers were added." };
  }

  const failures = new Map<string, string>();
  const test = (subset: Group[], note?: Group[]): boolean => {
    let difference: string | undefined;
    try {
      difference = firstDifference(project, base, opts.solve(apply(project, subset)));
    } catch {
      difference = "the solve failed";
    }
    if (difference && note?.length) failures.set(note[0].resourceName, difference);
    return difference === undefined;
  };

  // Whole set first (the common case), else bisect by resource: the buffers of
  // one resource are kept or dropped together, each kept set re-verified on
  // top of the ones already kept.
  let accepted: Group[] = [];
  if (test(groups)) {
    accepted = groups;
  } else {
    const byResource = new Map<string, Group[]>();
    for (const g of groups) byResource.set(g.resourceKey, [...(byResource.get(g.resourceKey) ?? []), g]);
    const attempt = (list: Group[][]) => {
      if (list.length === 0) return;
      const flat = list.flat();
      if (test([...accepted, ...flat], list.length === 1 ? flat : undefined)) {
        accepted = [...accepted, ...flat];
        return;
      }
      if (list.length === 1) return;
      const mid = Math.ceil(list.length / 2);
      attempt(list.slice(0, mid));
      attempt(list.slice(mid));
    };
    attempt([...byResource.values()]);
  }

  if (accepted.length === 0) {
    const names = [...failures.entries()].slice(0, 3).map(([n, d]) => `${n}: ${d}`);
    return {
      project,
      inserted: 0,
      verified: false,
      message: `Buffers changed the results (${names.join("; ") || "unknown"}), so none were added.`,
    };
  }
  const droppedGroups = groups.filter((g) => !accepted.includes(g));
  const plural = accepted.length === 1 ? "" : "s";
  return {
    project: apply(project, accepted),
    inserted: accepted.length,
    verified: true,
    message:
      droppedGroups.length === 0
        ? `Added ${accepted.length} buffer${plural}; the results are unchanged.`
        : `Added ${accepted.length} buffer${plural}; skipped ${droppedGroups.length} that changed results (${[...new Set(droppedGroups.map((g) => g.resourceName))].slice(0, 3).join(", ")}).`,
  };
}
