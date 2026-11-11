import { makeResourceHandleId } from "@/components/flow/resource-handles";
import { applyEdgeInputOverride } from "@/lib/model/edge-input-overrides";
import { applyRecipeInputOverrides } from "@/lib/model/recipe-input-overrides";
import { isRecipeInputConsumed } from "@/lib/model/resources";
import type {
  FactoryEdge,
  FactoryNode,
  FactoryProject,
  FactoryStorage,
  Recipe,
} from "@/lib/model/types";
import { resourceKey, routeNodeFor } from "./machine-rate";
import type { PlanContext } from "./plan-context";
import { nodeRecipeIds } from "./plan-context";
import type { RouteCandidate, RouteOptionDraft, RoutePreScore } from "./types";

let counter = 0;
export function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(16).slice(2)}`;
}

const splitKey = (key: string) => {
  const colon = key.indexOf(":");
  return { kind: key.slice(0, colon) as "item" | "fluid", id: key.slice(colon + 1) };
};

/** Ports between two cards carry slot indexes; ports on a drawer do not. */
function outHandle(key: string, slot: number | undefined, drawer: boolean) {
  return makeResourceHandleId("output", splitKey(key), drawer ? undefined : slot);
}

export interface RouteProject {
  /** The plan with the route added and the replaced cards switched off. */
  project: FactoryProject;
  draft: RouteOptionDraft;
}

/**
 * The route laid onto a copy of the plan, wired the way a player would:
 * route outputs take over the wires the replaced cards had, route inputs draw
 * from what the plan already holds (a drawer first, then a producer card),
 * and anything the plan lacks gets a new input drawer. Leftover outputs go to
 * a drawer of that resource, or a new byproduct drawer.
 */
export function layRouteOnProject(
  ctx: PlanContext,
  route: RouteCandidate,
  pre: RoutePreScore,
  label: string,
): RouteProject {
  const base = ctx.project;
  const replaced = new Set(ctx.replacedNodeIds);
  const known = new Set(base.recipes.map((recipe) => recipe.id));
  const recipes: Recipe[] = [];
  for (const step of route.steps) {
    if (!known.has(step.recipe.id)) {
      known.add(step.recipe.id);
      recipes.push(step.recipe);
    }
  }

  const maxX = Math.max(
    0,
    ...base.nodes.map((node) => node.position.x),
    ...(base.storages ?? []).map((s) => s.position.x),
  );
  const minY = Math.min(0, ...base.nodes.map((node) => node.position.y));

  // One card per distinct recipe.
  const nodeByRecipe = new Map<string, FactoryNode>();
  const nodes: FactoryNode[] = [];
  const stepNode: FactoryNode[] = route.steps.map((step, i) => {
    const held = nodeByRecipe.get(step.recipe.id);
    if (held) return held;
    const node = routeNodeFor(step.recipe, newId("node"));
    const machines = pre.machines[step.recipe.id] ?? 1;
    node.machineCount = Math.max(1, Math.ceil(machines - 1e-7));
    node.position = { x: maxX + 600 + (route.steps.length - 1 - i) * 520, y: minY + 160 };
    nodeByRecipe.set(step.recipe.id, node);
    nodes.push(node);
    return node;
  });

  const storages: FactoryStorage[] = [];
  const edges: FactoryEdge[] = [];
  const rewired: string[] = [];

  let project: FactoryProject = {
    ...base,
    recipes: [...base.recipes, ...recipes],
    nodes: [
      ...base.nodes.map((n) => (replaced.has(n.id) ? { ...n, enabled: false } : n)),
      ...nodes,
    ],
    storages: [...(base.storages ?? [])],
    edges: [...base.edges],
  };

  const pushEdge = (
    edge: FactoryEdge,
    face?: { kind: "item" | "fluid"; id: string; displayName?: string },
  ) => {
    project = applyEdgeInputOverride({ ...project, edges: [...project.edges, edge] }, edge, face);
    // The override may re-dock the wire; the draft keeps the docked version.
    edges.push(project.edges.find((entry) => entry.id === edge.id) ?? edge);
  };
  const addStorage = (storage: FactoryStorage) => {
    storages.push(storage);
    project = { ...project, storages: [...(project.storages ?? []), storage] };
  };

  const nameOf = (key: string) => ctx.names.get(key) ?? splitKey(key).id;

  // Who makes what inside the route (root first; the root wins the target).
  const producerOf = new Map<string, { step: number; slot: number }>();
  route.steps.forEach((step, i) =>
    step.recipe.outputs.forEach((output, slot) => {
      const key = resourceKey(output);
      if (!producerOf.has(key)) producerOf.set(key, { step: i, slot });
    }),
  );

  const inputDrawers = new Map<string, FactoryStorage>();
  const newDrawer = (
    key: string,
    near: FactoryNode,
    drainMode?: FactoryStorage["drainMode"],
  ): FactoryStorage => {
    const { kind, id } = splitKey(key);
    const storage: FactoryStorage = {
      id: newId("storage"),
      kind,
      resourceId: id,
      displayName: ctx.names.get(key),
      drainMode,
      position: {
        x: near.position.x + (drainMode ? 520 : -300),
        y: near.position.y + 40 + storages.length * 120,
      },
    };
    addStorage(storage);
    return storage;
  };

  const existingStorage = (key: string, predicate: (s: FactoryStorage) => boolean) =>
    (base.storages ?? []).find(
      (s) => resourceKey({ kind: s.kind, id: s.resourceId }) === key && predicate(s),
    );

  const recipesById = new Map(project.recipes.map((r) => [r.id, r]));
  const feederNode = (key: string): { node: FactoryNode; slot: number } | undefined => {
    for (const node of base.nodes) {
      if (!node.enabled || replaced.has(node.id)) continue;
      const recipe = recipesById.get(node.recipeId);
      if (!recipe || recipe.power) continue;
      const slot = applyRecipeInputOverrides(recipe, node).outputs.findIndex(
        (o) => resourceKey(o) === key,
      );
      if (slot >= 0) return { node, slot };
    }
    return undefined;
  };

  // A. Inputs (a recipe the route uses twice is wired once).
  const wiredCards = new Set<string>();
  route.steps.forEach((step, j) => {
    const target = stepNode[j];
    if (wiredCards.has(target.id)) return;
    wiredCards.add(target.id);
    step.recipe.inputs.forEach((input, slot) => {
      const key = step.inputKeys[slot];
      if (!key || !isRecipeInputConsumed(input)) return;
      const face = { ...splitKey(key), displayName: nameOf(key) };
      const edgeBase = {
        resourceKind: face.kind,
        resourceId: face.id,
        label: face.displayName,
        target: target.id,
      };
      const inner = producerOf.get(key);
      if (inner && stepNode[inner.step] !== target) {
        pushEdge(
          {
            ...edgeBase,
            id: newId("edge"),
            source: stepNode[inner.step].id,
            sourceHandle: outHandle(key, inner.slot, false),
            targetHandle: makeResourceHandleId("input", input, slot),
          },
          face,
        );
        return;
      }
      // Prefer a drawer that holds or supplies it, then a producing card, else a new input drawer.
      const drawer = inputDrawers.get(key) ?? existingStorage(key, (s) => s.drainMode === undefined);
      if (drawer) {
        pushEdge(
          {
            ...edgeBase,
            id: newId("edge"),
            source: drawer.id,
            sourceHandle: outHandle(key, undefined, true),
            targetHandle: makeResourceHandleId("input", input),
          },
          face,
        );
        return;
      }
      const feeder = feederNode(key);
      if (feeder) {
        pushEdge(
          {
            ...edgeBase,
            id: newId("edge"),
            source: feeder.node.id,
            sourceHandle: outHandle(key, feeder.slot, false),
            targetHandle: makeResourceHandleId("input", input, slot),
          },
          face,
        );
        return;
      }
      const created = newDrawer(key, target);
      inputDrawers.set(key, created);
      pushEdge(
        {
          ...edgeBase,
          id: newId("edge"),
          source: created.id,
          sourceHandle: outHandle(key, undefined, true),
          targetHandle: makeResourceHandleId("input", input),
        },
        face,
      );
    });
  });

  // B. Outputs take over the wires of the replaced cards.
  const outputsWired = new Set<string>();
  for (const edge of base.edges) {
    if (!replaced.has(edge.source) || replaced.has(edge.target)) continue;
    const key = resourceKey({ kind: edge.resourceKind, id: edge.resourceId });
    const made = producerOf.get(key);
    if (!made) continue;
    const toDrawer = (base.storages ?? []).some((s) => s.id === edge.target);
    const copy: FactoryEdge = {
      ...edge,
      id: newId("edge"),
      source: stepNode[made.step].id,
      sourceHandle: outHandle(key, made.slot, toDrawer),
      waypoints: undefined,
    };
    edges.push(copy);
    project = { ...project, edges: [...project.edges, copy] };
    rewired.push(edge.id);
    outputsWired.add(key);
  }

  // C. What is left over: the target if nothing took it, then the byproducts the LP found.
  const consumedInside = new Set(
    route.steps.flatMap((step) => step.inputKeys.filter((key): key is string => Boolean(key))),
  );
  const leftovers = [
    ...(outputsWired.has(ctx.targetKey) ? [] : [ctx.targetKey]),
    ...pre.byproducts.map((b) => b.key).filter((key) => !outputsWired.has(key)),
  ];
  for (const key of new Set(leftovers)) {
    const made = producerOf.get(key);
    if (!made) continue;
    const spare = pre.byproducts.some((b) => b.key === key);
    if (key !== ctx.targetKey && consumedInside.has(key) && !spare) continue;
    const drawer =
      existingStorage(key, (s) => s.drainMode !== "trash" && s.targetPerSecond === undefined) ??
      existingStorage(key, (s) => s.drainMode !== "trash") ??
      newDrawer(key, stepNode[made.step], key === ctx.targetKey ? "product" : "byproduct");
    pushEdge({
      id: newId("edge"),
      source: stepNode[made.step].id,
      target: drawer.id,
      sourceHandle: outHandle(key, made.slot, true),
      targetHandle: makeResourceHandleId("input", splitKey(key)),
      resourceKind: drawer.kind,
      resourceId: drawer.resourceId,
      label: nameOf(key),
    });
  }

  return {
    project,
    draft: {
      label,
      recipes,
      nodes,
      storages,
      edges,
      replacesNodeIds: ctx.replacedNodeIds,
      rewiredEdgeIds: rewired,
    },
  };
}
