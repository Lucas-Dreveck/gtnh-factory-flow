import { isCropFarmRecipe } from "./passive-production";
import type { FactoryNode, FactoryNodeColorTag, Recipe } from "./types";

export interface NewRecipeNodeOptions {
  id: string;
  position: { x: number; y: number };
  /** A machine picked in the recipe finder spawns the card with that handler selected. */
  machineHandlerId?: string;
  /** Power cards: the settings the picker dialed in before placing. */
  machineConfigTiers?: Record<string, string>;
  recipeInputOverrides?: FactoryNode["recipeInputOverrides"];
  colorTag?: FactoryNodeColorTag;
}

/**
 * The card a recipe becomes the moment it lands on a board. One definition for
 * every way a card is created (recipe search, route discovery): the handler
 * defaults to the recipe's first machine and the tier to that machine's own
 * minimum, so a card's machine math never depends on who placed it.
 */
export function createRecipeNode(recipe: Recipe, options: NewRecipeNodeOptions): FactoryNode {
  const spawnHandler = options.machineHandlerId
    ? recipe.machineHandlers?.find((handler) => handler.id === options.machineHandlerId)
    : undefined;
  return {
    id: options.id,
    recipeId: recipe.id,
    cropFullFarmCount: isCropFarmRecipe(recipe) ? 1 : undefined,
    machineCount: 1,
    parallel: 1,
    machineHandlerId: spawnHandler?.id,
    machineConfigTiers: options.machineConfigTiers,
    overclockTier: spawnHandler?.minimumTier ?? recipe.minimumTier,
    recipeInputOverrides: options.recipeInputOverrides,
    // A crop picked out of the recipe book spawns green like the Sprout button's card.
    colorTag: options.colorTag ?? (isCropFarmRecipe(recipe) ? "green" : undefined),
    enabled: true,
    position: options.position,
  };
}
