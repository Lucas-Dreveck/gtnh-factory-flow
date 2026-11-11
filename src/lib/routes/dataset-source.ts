import type { MachineTier, Recipe } from "@/lib/model/types";
import { getDatasetRecipe, queryDatasetRecipes } from "@/lib/server/dataset-query";
import { summaryAsRecipeShape } from "./summary-shape";
import type { RecipeSource } from "./types";

/**
 * Server-side source: the same "who makes X" query the recipe browser sends
 * (`mode: "recipes"` over every machine), straight against the dataset index.
 */
export function createServerRecipeSource(versionId: string): RecipeSource {
  return {
    async producersOf(resource, { limit, maxTier }) {
      const page = await queryDatasetRecipes(versionId, {
        query: "",
        resource: { kind: resource.kind, id: resource.id },
        mode: "recipes",
        allMaps: true,
        maxTier: (maxTier ?? "all") as "all" | Exclude<MachineTier, "DEMO">,
        offset: 0,
        limit,
      });
      return page.recipes.map(summaryAsRecipeShape);
    },
    async hydrate(recipes) {
      const full = await Promise.all(recipes.map((recipe) => getDatasetRecipe(versionId, recipe.id)));
      return full.map((recipe, i) => recipe ?? recipes[i]);
    },
  };
}
