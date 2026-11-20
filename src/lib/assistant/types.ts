/**
 * The wire between the assistant panel and `/api/assistant`.
 *
 * The board lives in the browser, the Gemini key lives on the server, so the
 * two halves meet here: the client sends a compact photo of the board and the
 * conversation so far, the server answers with text plus BOARD ACTIONS the
 * player can apply. Nothing the model says touches the board on its own.
 */

/** One card, as the model reads it. Rates are per second at the current solve. */
export interface AssistantBoardNode {
  id: string;
  recipeName: string;
  machine: string;
  machineCount: number;
  tier: string;
  euPerTick?: number;
  takes: string[];
  makes: string[];
}

export interface AssistantBoardEdge {
  from: string;
  to: string;
  resource: string;
  perSecond?: number;
}

export interface AssistantBoardDrawer {
  id: string;
  resource: string;
  role: "source" | "product" | "buffer";
  targetPerSecond?: number;
}

export interface AssistantBoardSnapshot {
  planName: string;
  mode: "build" | "solve" | "pool";
  nodeCount: number;
  edgeCount: number;
  nodes: AssistantBoardNode[];
  edges: AssistantBoardEdge[];
  drawers: AssistantBoardDrawer[];
  /** Solve verdicts and shortages, already worded for a player. */
  notes: string[];
}

export interface AssistantChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AssistantRequestBody {
  datasetVersionId: string;
  messages: AssistantChatMessage[];
  board: AssistantBoardSnapshot;
}

/**
 * What the model may ask the board to do. Every action names cards by the ids
 * the snapshot carried, so an action can always be checked against the board
 * before it is applied.
 */
export type AssistantAction =
  | {
      kind: "add_recipe";
      recipeId: string;
      recipeName: string;
      machineCount?: number;
      /** Wire the new card to whatever on the board already fits. */
      connect?: boolean;
      reason?: string;
    }
  | {
      kind: "set_machine_count";
      nodeId: string;
      machineCount: number;
      reason?: string;
    }
  | {
      kind: "connect_nodes";
      sourceNodeId: string;
      targetNodeId: string;
      reason?: string;
    }
  | {
      kind: "auto_connect";
      nodeId: string;
      reason?: string;
    }
  | {
      kind: "delete_node";
      nodeId: string;
      reason?: string;
    };

export interface AssistantReply {
  text: string;
  actions: AssistantAction[];
  /** Recipe and item lookups the answer was built on, for the panel's footnote. */
  lookups: string[];
}

/** The one sentence a card shows for an action, before it is applied. */
export function describeAssistantAction(action: AssistantAction): string {
  switch (action.kind) {
    case "add_recipe":
      return action.machineCount && action.machineCount > 1
        ? `Add ${action.recipeName} (${action.machineCount} machines)`
        : `Add ${action.recipeName}`;
    case "set_machine_count":
      return `Set ${action.nodeId} to ${action.machineCount} machines`;
    case "connect_nodes":
      return `Wire ${action.sourceNodeId} into ${action.targetNodeId}`;
    case "auto_connect":
      return `Wire ${action.nodeId} to everything that fits`;
    case "delete_node":
      return `Remove ${action.nodeId}`;
  }
}
