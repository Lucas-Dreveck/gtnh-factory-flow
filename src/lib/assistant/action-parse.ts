import type { AssistantAction } from "./types";

/**
 * Turns one of Gemini's board tool calls into an action, or into nothing.
 *
 * A model fills arguments it was not given: a missing id arrives as "", a
 * count as a string, a machine count as 0.5. An action that cannot be applied
 * must be dropped here, where the answer can still say so, rather than fail
 * silently against the board.
 */
export function readAssistantAction(
  name: string,
  args: Record<string, unknown>,
): AssistantAction | undefined {
  const reason = text(args.reason);
  switch (name) {
    case "add_recipe": {
      const recipeId = text(args.recipeId);
      if (!recipeId) return undefined;
      return {
        kind: "add_recipe",
        recipeId,
        recipeName: text(args.recipeName) ?? recipeId,
        machineCount: count(args.machineCount),
        connect: args.connect === undefined ? true : args.connect !== false,
        reason,
      };
    }
    case "set_machine_count": {
      const nodeId = text(args.nodeId);
      const machineCount = count(args.machineCount);
      if (!nodeId || machineCount === undefined) return undefined;
      return { kind: "set_machine_count", nodeId, machineCount, reason };
    }
    case "connect_nodes": {
      const sourceNodeId = text(args.sourceNodeId);
      const targetNodeId = text(args.targetNodeId);
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return undefined;
      return { kind: "connect_nodes", sourceNodeId, targetNodeId, reason };
    }
    case "auto_connect": {
      const nodeId = text(args.nodeId);
      if (!nodeId) return undefined;
      return { kind: "auto_connect", nodeId, reason };
    }
    case "delete_node": {
      const nodeId = text(args.nodeId);
      if (!nodeId) return undefined;
      return { kind: "delete_node", nodeId, reason };
    }
    default:
      return undefined;
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 400 ? trimmed : undefined;
}

/** A machine count is a whole number of machines, 1 to 4096. */
function count(value: unknown): number | undefined {
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const whole = Math.round(raw);
  return whole >= 1 && whole <= 4096 ? whole : undefined;
}
