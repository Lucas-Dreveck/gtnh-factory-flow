"use client";

import { DEFAULT_DATASET_MANIFEST_URL } from "@/lib/datasets";
import { getRecipeDatasetRecipe } from "@/lib/datasets/browser-loader";
import { describeAssistantAction, type AssistantAction } from "@/lib/assistant/types";
import { useFactoryStore } from "@/store/factory-store";

export interface ApplyAssistantActionsResult {
  /** One line per action, said in the past tense, for the panel to show. */
  done: string[];
  /** One line per action that could not be applied, and why. */
  skipped: string[];
}

/**
 * Applies what the assistant proposed, in order, against the board as it is
 * NOW. Each action is checked again here: the board may have moved on since
 * the answer was written, and an action that no longer fits is skipped and
 * reported, never forced.
 *
 * Every action is an ordinary store action, so undo walks back through them
 * one at a time exactly as it does for a player's own edits.
 */
export async function applyAssistantActions(
  actions: AssistantAction[],
): Promise<ApplyAssistantActionsResult> {
  const done: string[] = [];
  const skipped: string[] = [];

  for (const action of actions) {
    try {
      const failure = await applyOne(action);
      if (failure) {
        skipped.push(`${describeAssistantAction(action)}: ${failure}`);
      } else {
        done.push(describeAssistantAction(action));
      }
    } catch (error) {
      skipped.push(
        `${describeAssistantAction(action)}: ${
          error instanceof Error ? error.message : "could not be applied."
        }`,
      );
    }
  }

  return { done, skipped };
}

/** Returns a reason when the action was not applied, nothing when it was. */
async function applyOne(action: AssistantAction): Promise<string | undefined> {
  const store = useFactoryStore.getState();
  if (store.isReadOnly) {
    return "this plan is open for viewing only.";
  }

  switch (action.kind) {
    case "add_recipe": {
      const recipe = await fetchRecipe(action.recipeId);
      if (!recipe) {
        return "that recipe is not in the loaded dataset.";
      }
      const before = new Set(useFactoryStore.getState().project.nodes.map((node) => node.id));
      useFactoryStore.getState().addNodeForRecipeObject(recipe, undefined, { focusCamera: true });
      const placed = useFactoryStore
        .getState()
        .project.nodes.find((node) => !before.has(node.id));
      if (!placed) {
        return "the card could not be placed.";
      }
      if (action.machineCount && action.machineCount > 1) {
        useFactoryStore.getState().updateNode(placed.id, { machineCount: action.machineCount });
      }
      if (action.connect !== false) {
        useFactoryStore.getState().autoConnectNode(placed.id);
      }
      return undefined;
    }
    case "set_machine_count": {
      if (!hasNode(action.nodeId)) {
        return `there is no card ${action.nodeId} on the board.`;
      }
      useFactoryStore.getState().updateNode(action.nodeId, { machineCount: action.machineCount });
      return undefined;
    }
    case "connect_nodes": {
      if (!hasNode(action.sourceNodeId) || !hasNode(action.targetNodeId)) {
        return "one of those cards is not on the board.";
      }
      const before = useFactoryStore.getState().project.edges.length;
      useFactoryStore.getState().connectNodes(action.sourceNodeId, action.targetNodeId);
      return useFactoryStore.getState().project.edges.length > before
        ? undefined
        : "those two cards share no resource to wire.";
    }
    case "auto_connect": {
      if (!hasNode(action.nodeId)) {
        return `there is no card ${action.nodeId} on the board.`;
      }
      const before = useFactoryStore.getState().project.edges.length;
      useFactoryStore.getState().autoConnectNode(action.nodeId);
      return useFactoryStore.getState().project.edges.length > before
        ? undefined
        : "nothing on the board fits that card's slots.";
    }
    case "delete_node": {
      if (!hasNode(action.nodeId)) {
        return `there is no card ${action.nodeId} on the board.`;
      }
      useFactoryStore.getState().deleteNode(action.nodeId);
      return undefined;
    }
  }
}

function hasNode(nodeId: string): boolean {
  return useFactoryStore.getState().project.nodes.some((node) => node.id === nodeId);
}

/**
 * The full recipe, slots and runtime table included. The search the answer was
 * built from ran on the server against summaries; a card needs the whole
 * recipe, and it comes through the same cached loader the recipe book uses.
 */
async function fetchRecipe(recipeId: string) {
  const state = useFactoryStore.getState();
  const versionId = state.dataset?.datasetVersionId;
  const version = state.datasetManifest?.versions.find((entry) => entry.id === versionId);
  if (!version) {
    return undefined;
  }
  try {
    return await getRecipeDatasetRecipe(
      state.datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
      version,
      recipeId,
    );
  } catch {
    return undefined;
  }
}
