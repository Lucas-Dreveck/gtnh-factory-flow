import { getChanceMultiplier, isRecipeInputConsumed } from "@/lib/model/resources";
import { applyMachineHandlerToRecipe } from "@/lib/model/recipe-rules";
import { normalizeHatchInput } from "@/lib/solver/hatch-input";
import { createRecipeNode } from "@/lib/model/recipe-node";
import { getRecipeMinimumVoltageTier, getVoltageTierIndex } from "@/lib/model/tiers";
import type { FactoryNode, MachineTier, Recipe, ResourceAmount } from "@/lib/model/types";
import { TICKS_PER_SECOND } from "@/lib/model/types";
import { getMachineOutputMultiplier, getMachineParallelMultiplier } from "@/lib/solver/machine-effects";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import {
  getRuntimeCalculationOutputs,
  selectRuntimeCalculationVariant,
} from "@/lib/solver/runtime-calculation";

export const resourceKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;

export interface MachineRate {
  tier: Exclude<MachineTier, "DEMO">;
  /** Operations per second of ONE machine at full speed (same maths as the solver's nameplate). */
  opsPerSecond: number;
  euT: number;
  /** Consumed amount per operation, by slot index. */
  inputPerOp: Array<{ index: number; amount: number } | undefined>;
  /** Amount per operation (chance and machine multipliers folded in), by slot index. */
  outputPerOp: number[];
}

/**
 * The card the recipe search would place: one machine, the same defaults
 * (createRecipeNode), and the hatch seed every board edit gives a multiblock
 * (normalizeHatchInput, run by the store's touchProject). Without that seed a
 * multiblock's power budget is open and its parallels would be sized wrong.
 */
export function routeNodeFor(recipe: Recipe, id: string): FactoryNode {
  const node = createRecipeNode(recipe, { id, position: { x: 0, y: 0 } });
  try {
    return normalizeHatchInput(recipe, node);
  } catch {
    return node;
  }
}

/**
 * One machine's nameplate rates, from the solver's own helpers so a route is
 * sized with the numbers the board will show. Falls back to the raw recipe
 * if a helper cannot read an exotic recipe.
 */
export function machineRate(recipe: Recipe): MachineRate {
  const node = routeNodeFor(recipe, "probe");
  const tier = getRecipeMinimumVoltageTier(recipe);
  try {
    const effective = applyMachineHandlerToRecipe(recipe, node);
    const stats = getOverclockedRecipeStats(recipe, node);
    const variant = selectRuntimeCalculationVariant(effective, node);
    const runtimeOutputs = getRuntimeCalculationOutputs(effective, node);
    const parallel = variant?.parallel ?? getMachineParallelMultiplier(effective, node);
    const opsPerSecond = (parallel * TICKS_PER_SECOND) / Math.max(1, stats.durationTicks);
    const outs: ResourceAmount[] = runtimeOutputs ?? effective.outputs;
    return {
      tier,
      opsPerSecond,
      euT: stats.eut * parallel,
      inputPerOp: recipe.inputs.map((input, index) =>
        isRecipeInputConsumed(input) ? { index, amount: input.amount } : undefined,
      ),
      outputPerOp: outs.map(
        (output) =>
          output.amount *
          getChanceMultiplier(effective, output as Recipe["outputs"][number]) *
          (runtimeOutputs
            ? 1
            : getMachineOutputMultiplier(
                effective,
                node,
                output as Recipe["outputs"][number],
                stats.tier,
              )),
      ),
    };
  } catch {
    return {
      tier,
      opsPerSecond: TICKS_PER_SECOND / Math.max(1, recipe.durationTicks),
      euT: recipe.eut,
      inputPerOp: recipe.inputs.map((input, index) =>
        isRecipeInputConsumed(input) ? { index, amount: input.amount } : undefined,
      ),
      outputPerOp: recipe.outputs.map((o) => o.amount * (o.chance ?? 1)),
    };
  }
}

export function tierIndex(tier: string | undefined): number {
  return getVoltageTierIndex((tier ?? "ULV") as Exclude<MachineTier, "DEMO">);
}

export function recipeTierIndex(recipe: Recipe): number {
  return getVoltageTierIndex(getRecipeMinimumVoltageTier(recipe));
}
