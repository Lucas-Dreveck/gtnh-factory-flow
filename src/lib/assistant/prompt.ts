import type { AssistantBoardSnapshot } from "./types";

/**
 * What the assistant is and what it may do. The rules that matter are the
 * ones about ids: a guessed recipe id lands nothing, and a card id that is
 * not on the board is an action the player cannot apply.
 */
export const ASSISTANT_SYSTEM_PROMPT = `You help a player plan a GregTech New Horizons factory inside a planner app.

What you can do:
- Answer questions about the player's board, which is described below, and about GTNH processing in general.
- Look recipes and items up in the loaded dataset with search_items, search_recipes and get_recipe.
- Propose changes to the board with add_recipe, set_machine_count, connect_nodes, auto_connect and delete_node.

Rules:
- Never invent a recipe id. Call search_recipes or search_items first and use the ids they return.
- Only name card ids that appear in the board listing below.
- Propose a change only when the player asked for the board to change. A question gets an answer, not cards.
- Keep a proposal small: the few cards that answer the ask, not a whole production line, unless the player asked for the line.
- Your proposals are shown to the player, who applies them. Say what they do, never that you have already done it.
- Rates in the planner are per second. Power is EU/t.
- Write plainly and briefly: the number, the rule, the consequence. No em dashes.
- If the dataset has no recipe for what was asked, say so instead of guessing one.`;

/** The board as a block of plain lines, which the model reads far better than JSON. */
export function boardBriefing(board: AssistantBoardSnapshot): string {
  const lines: string[] = [
    `The player's open plan: "${board.planName}", in ${board.mode} mode, ${board.nodeCount} cards and ${board.edgeCount} wires.`,
  ];

  if (board.nodes.length === 0) {
    lines.push("", "The board is empty.");
  } else {
    lines.push("", "Cards:");
    for (const node of board.nodes) {
      const power = node.euPerTick === undefined ? "" : `, ${node.euPerTick} EU/t`;
      lines.push(
        `- ${node.id}: ${node.recipeName} on ${node.machine}, ${node.machineCount}x at ${node.tier}${power}`,
        `  takes ${node.takes.join(", ") || "nothing"}`,
        `  makes ${node.makes.join(", ") || "nothing"}`,
      );
    }
  }

  if (board.edges.length > 0) {
    lines.push("", "Wires:");
    for (const edge of board.edges) {
      const rate = edge.perSecond === undefined ? "" : ` at ${round(edge.perSecond)}/s`;
      lines.push(`- ${edge.from} -> ${edge.to}: ${edge.resource}${rate}`);
    }
  }

  if (board.drawers.length > 0) {
    lines.push("", "Drawers and tanks:");
    for (const drawer of board.drawers) {
      const target =
        drawer.targetPerSecond === undefined ? "" : `, target ${round(drawer.targetPerSecond)}/s`;
      lines.push(`- ${drawer.id}: ${drawer.resource} (${drawer.role})${target}`);
    }
  }

  if (board.notes.length > 0) {
    lines.push("", "What the solve says:");
    for (const note of board.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
