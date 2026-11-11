import type { RecipeSummary } from "@/lib/datasets/types";
import type { Recipe } from "@/lib/model/types";

/** A search row read as the recipe a card would run (slots, amounts, ticks, EU, handlers). */
export function summaryAsRecipeShape(summary: RecipeSummary): Recipe {
  return {
    id: summary.id,
    name: summary.name,
    kind: summary.kind,
    category: summary.category,
    machineType: summary.machineType,
    minimumTier: summary.minimumTier,
    durationTicks: summary.durationTicks,
    eut: summary.eut,
    inputs: summary.inputs,
    outputs: summary.outputs,
    programmedCircuit: summary.programmedCircuit,
    specialValue: summary.specialValue,
    machineHandlers: summary.machineHandlers,
    machineConfigControls: summary.machineConfigControls,
    source: summary.source ?? (summary.recipeMap ? { recipeMap: summary.recipeMap } : undefined),
    metadata: summary.metadata,
    nei: summary.nei,
  };
}
