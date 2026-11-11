import {
  getRecipeDatasetRecipe,
  queryRecipeDatasetRecipes,
} from "@/lib/datasets/browser-loader";
import type { DatasetVersion } from "@/lib/datasets/types";
import type { MachineTier, Recipe } from "@/lib/model/types";
import { summaryAsRecipeShape } from "./summary-shape";
import type { RecipeSource } from "./types";

/**
 * Browser source over /api/datasets/{id}/recipes (search rows) and
 * /recipes/{id} (full recipe). The query is the recipe browser's own
 * "recipes that make X" request. The engine runs in a worker or on the main
 * thread; either way only the final few recipes are fetched in full.
 */
export function createBrowserRecipeSource(manifestUrl: string, version: DatasetVersion): RecipeSource {
  return {
    async producersOf(resource, { limit, maxTier }) {
      const page = await queryRecipeDatasetRecipes(manifestUrl, version, {
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
    async hydrate(recipes: Recipe[]) {
      return Promise.all(recipes.map((recipe) => getRecipeDatasetRecipe(manifestUrl, version, recipe.id)));
    },
  };
}
