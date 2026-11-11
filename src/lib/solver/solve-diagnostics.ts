import type { FactoryProject, NodeThroughputResult, ThroughputResult } from "../model/types";
import { makeResourceKey } from "../model/resources";
import { getStorageRoles } from "../model/storage-role";
import { hasStorageTarget } from "../model/storage-target";
import { hasAnySolveNumbers } from "./throughput";

export type SolveDiagnosticCode =
  | "NO_GOAL"
  | "PINS_INFEASIBLE"
  | "TARGET_UNREACHABLE"
  | "BARE_INPUT"
  | "DORMANT_NUMBER"
  | "ZERO_RESULT"
  | "DISCONNECTED_DRAWER";

export interface SolveDiagnostic {
  severity: "error" | "warning" | "info";
  code: SolveDiagnosticCode;
  /** What is wrong, in player words. */
  message: string;
  /** What to do about it. */
  fix: string;
  nodeIds?: string[];
  storageIds?: string[];
  resourceIds?: string[];
}

export interface SolveDiagnosticExtras {
  /** Cap on BARE_INPUT rows, so a half-wired plan does not bury the panel. */
  maxBareRows?: number;
  /**
   * Optional re-solve, used only when the pins fail for no visible wiring
   * reason: each pin is dropped in turn to find the ones that clash. One solve
   * per pin, so the board leaves it off and tests or tools pass it in.
   */
  probe?: (project: FactoryProject) => ThroughputResult;
}

const EPSILON = 1e-6;

interface PortGap {
  resourceId: string;
  name: string;
}

/**
 * Why a Solve or Pool result is empty or partial, as ordered (problem, fix)
 * rows. Pure and cheap: it reads the finished books and the wiring and runs
 * no solve. Port rows only carry CONSUMED inputs (a programmed circuit or
 * catalyst never appears in `nodeResult.inputs`), so a bare row is a real need.
 */
export function diagnoseSolve(
  project: FactoryProject,
  result: ThroughputResult,
  extras: SolveDiagnosticExtras = {},
): SolveDiagnostic[] {
  if (project.solveMode !== true) return [];
  const out: SolveDiagnostic[] = [];
  const poolMode = project.poolMode === true;
  // Pool wires nothing by hand; its hidden drawers feed and drain every port,
  // so port gaps are never reported there.
  const roles = getStorageRoles(project);
  const storages = project.storages ?? [];

  const recipeById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const label = (nodeId: string) => {
    const node = project.nodes.find((n) => n.id === nodeId);
    const recipe = node ? recipeById.get(node.recipeId) : undefined;
    if (!recipe) return "A machine";
    return recipe.machineType && !recipe.name.includes(recipe.machineType)
      ? `${recipe.name} (${recipe.machineType})`
      : recipe.name;
  };

  const incomingKeys = new Map<string, Set<string>>();
  const outgoingKeys = new Map<string, Set<string>>();
  const edgeCount = new Map<string, number>();
  for (const edge of project.edges) {
    const key = makeResourceKey(edge.resourceKind, edge.resourceId);
    if (!outgoingKeys.has(edge.source)) outgoingKeys.set(edge.source, new Set());
    if (!incomingKeys.has(edge.target)) incomingKeys.set(edge.target, new Set());
    outgoingKeys.get(edge.source)!.add(key);
    incomingKeys.get(edge.target)!.add(key);
    edgeCount.set(edge.source, (edgeCount.get(edge.source) ?? 0) + 1);
    edgeCount.set(edge.target, (edgeCount.get(edge.target) ?? 0) + 1);
  }

  const bareInputs = (report: NodeThroughputResult): PortGap[] => {
    if (poolMode) return [];
    const wired = incomingKeys.get(report.nodeId);
    const gaps: PortGap[] = [];
    for (const [key, flow] of Object.entries(report.inputs)) {
      if (flow.amountPerSecond > EPSILON && !wired?.has(key)) {
        gaps.push({ resourceId: flow.resourceId, name: flow.displayName ?? flow.resourceId });
      }
    }
    return gaps;
  };
  const deadOutputs = (report: NodeThroughputResult): PortGap[] => {
    if (poolMode) return [];
    const wired = outgoingKeys.get(report.nodeId);
    const gaps: PortGap[] = [];
    for (const [key, flow] of Object.entries(report.outputs)) {
      // Unbanked power dissipates: the closed-plan rule waives it.
      if (flow.kind === "power") continue;
      if (flow.amountPerSecond > EPSILON && !wired?.has(key)) {
        gaps.push({ resourceId: flow.resourceId, name: flow.displayName ?? flow.resourceId });
      }
    }
    return gaps;
  };

  const pinned = project.nodes.filter((node) => node.enabled && (node.solvePin ?? 0) > 0);
  const hasGoal = hasAnySolveNumbers(project);

  // a. Nothing asks for anything.
  if (!hasGoal) {
    out.push({
      severity: "error",
      code: "NO_GOAL",
      message: "Nothing asks for output.",
      fix: "Set a rate on a product drawer, or pin a machine count.",
      storageIds: storages
        .filter((s) => roles.get(s.id) === "product" && !((s.targetPerSecond ?? 0) > 0))
        .map((s) => s.id),
    });
  }

  // a2. Pins but no drawer rate: the pins alone cannot say what the plan is for.
  if (hasGoal && pinned.length > 0 && !storages.some((s) => hasStorageTarget(s, roles.get(s.id)) && s.drainMode !== "byproduct" && s.drainMode !== "trash")) {
    out.push({
      severity: "info",
      code: "NO_GOAL",
      message: "No drawer asks for output; only pinned machine counts drive this plan.",
      fix: "Set a rate on a product drawer.",
      storageIds: storages.filter((s) => roles.get(s.id) === "product").map((s) => s.id),
    });
  }

  // b. Pins that cannot all run.
  let pinsExplained = false;
  if (result.solveStatus?.pinsInfeasible) {
    for (const node of pinned) {
      const report = result.nodes[node.id];
      if (!report) continue;
      const bare = bareInputs(report);
      const dead = deadOutputs(report);
      if (bare.length === 0 && dead.length === 0) continue;
      pinsExplained = true;
      const parts: string[] = [];
      if (bare.length) parts.push(`has no supply for ${bare.map((g) => g.name).join(", ")}`);
      if (dead.length) parts.push(`has nowhere to send ${dead.map((g) => g.name).join(", ")}`);
      out.push({
        severity: "error",
        code: "PINS_INFEASIBLE",
        message: `${label(node.id)} is pinned to ${node.solvePin} but ${parts.join(" and ")}.`,
        fix: bare.length
          ? "Wire the input from a machine or an input drawer, or remove the pin."
          : "Wire the output to a machine or a drawer, or remove the pin.",
        nodeIds: [node.id],
        resourceIds: [...bare, ...dead].map((g) => g.resourceId),
      });
    }
    if (!pinsExplained) {
      let culprits: string[] = [];
      if (extras.probe && pinned.length > 1) {
        culprits = pinned
          .filter((node) => {
            const without = {
              ...project,
              nodes: project.nodes.map((n) => (n.id === node.id ? { ...n, solvePin: undefined } : n)),
            };
            return extras.probe!(without).solveStatus?.pinsInfeasible === false;
          })
          .map((node) => node.id);
      }
      // What they fight over, when cheap: a machine two culprits both feed.
      const downstream = (id: string) =>
        new Set(project.edges.filter((e) => e.source === id).map((e) => e.target));
      const shared = culprits.length > 1
        ? [...downstream(culprits[0]!)].filter((t) => culprits.slice(1).every((c) => downstream(c).has(t)))
        : [];
      const sharedName = shared.length
        ? project.nodes.some((n) => n.id === shared[0]) ? label(shared[0]!) : undefined
        : undefined;
      const outRes = culprits.length > 1 && !sharedName
        ? [...new Set(culprits.flatMap((c) => Object.values(result.nodes[c]?.outputs ?? {}).map((f) => f.displayName ?? f.resourceId)))].slice(0, 3).join(", ")
        : "";
      out.push({
        severity: "error",
        code: "PINS_INFEASIBLE",
        message: culprits.length
          ? `${culprits.map(label).join(" and ")} cannot both run at their pinned counts${sharedName ? `: they fight over ${sharedName}` : ""}.`
          : "The pinned machine counts cannot run together.",
        fix: culprits.length
          ? `Unpin one, or add an output or trash drawer for ${sharedName ?? (outRes || "their outputs")}.`
          : "Remove one of these pins, or wire the outputs of the pinned machines to a drawer.",
        nodeIds: culprits.length ? culprits : pinned.map((node) => node.id),
      });
    }
  }

  // c. Targets no chain can meet.
  for (const storage of storages) {
    if (!result.storages[storage.id]?.targetUnreachable) continue;
    const name = storage.displayName ?? storage.resourceId;
    out.push({
      severity: "error",
      code: "TARGET_UNREACHABLE",
      message: `${name}: no chain can reach ${Math.abs(storage.targetPerSecond ?? 0).toFixed(2)}/s.`,
      fix: "Wire a recipe that makes it, lower the rate, or relax Exactly / At most.",
      storageIds: [storage.id],
      resourceIds: [storage.resourceId],
    });
  }

  // d. Idle wired machines missing a feed. Pinned ones were reported in b.
  if (hasGoal) {
    const cap = extras.maxBareRows ?? 12;
    let shown = 0;
    const pinnedIds = new Set(pinned.map((node) => node.id));
    for (const node of project.nodes) {
      const report = result.nodes[node.id];
      if (!node.enabled || !report || report.status === "missing-recipe") continue;
      if (report.utilization > EPSILON) continue;
      if (pinnedIds.has(node.id) && pinsExplained) continue;
      // A card nothing touches is not "needed"; only wired ones count.
      if (!(edgeCount.get(node.id) ?? 0)) continue;
      const bare = bareInputs(report);
      if (bare.length === 0) continue;
      if (shown++ >= cap) break;
      out.push({
        severity: "warning",
        code: "BARE_INPUT",
        message: `${label(node.id)} needs ${bare.map((g) => g.name).join(", ")}.`,
        fix: "Wire it from a machine or add an input drawer.",
        nodeIds: [node.id],
        resourceIds: bare.map((g) => g.resourceId),
      });
    }
  }

  // e. A number typed where it asks nothing.
  for (const storage of storages) {
    if ((storage.drainMode === "byproduct" || storage.drainMode === "trash") && hasStorageTarget(storage)) {
      out.push({
        severity: "info",
        code: "DORMANT_NUMBER",
        message: `${storage.displayName ?? storage.resourceId} is a ${storage.drainMode} drawer, so its rate is ignored.`,
        fix: "Switch it to Product to use the rate, or clear it.",
        storageIds: [storage.id],
      });
    }
  }

  // g. Drawers nothing is wired to.
  if (!poolMode) {
    for (const storage of storages) {
      if (edgeCount.get(storage.id)) continue;
      out.push({
        severity: "info",
        code: "DISCONNECTED_DRAWER",
        message: `${storage.displayName ?? storage.resourceId} drawer has no wires.`,
        fix: "Wire it to a machine, or delete it.",
        storageIds: [storage.id],
      });
    }
  }

  // f. Goals exist, nothing runs, and nothing above says why.
  const anyRunning = Object.values(result.nodes).some(
    (report) => report.enabled && report.utilization > EPSILON,
  );
  if (hasGoal && !anyRunning && !out.some((d) => d.severity !== "info")) {
    out.push({
      severity: "error",
      code: "ZERO_RESULT",
      message: "Nothing can run for these goals.",
      fix: "Check that every machine on the path is wired and enabled, then lower the rate.",
    });
  }

  return out;
}
