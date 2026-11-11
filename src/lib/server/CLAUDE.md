# Server and API (src/lib/server, src/app/api)

## Recipe queries (dataset-query.ts)

- A query is clauses (`role:kind:id`, `src/lib/datasets/recipe-query.ts`) plus
  `takesOp` / `makesOp` (any / all / only) and the map selection. The server does set
  algebra over the lookup index (`getClauseLookupRecipesByMap`): any = union,
  all = intersection, sides intersect. Every clause gets the concrete-context rewrite
  (`applyClauseResourceContexts`).
- ONLY is verified against recipe bodies (`recipeIsOnlyMatch`) up to `ONLY_VERIFY_LIMIT`
  candidates, then degrades to ALL. Non-consumed inputs never count against takes-ONLY.
- All-maps answers page through `recipeMaps` in chip order, best match first inside each
  map (`orderByRecipeMap`).
- The catalog mixes in server output, so its cache key includes `APP_VERSION`. A new
  catalog field must be added to `getDatasetCatalog`'s explicit field list (and
  `RecipeDataset` in types.ts) or it never reaches the client.
- Dataset files other than textures may be replaced in place; textures are
  cache-immutable, so a changed icon needs a new name.
- Every server cache is bounded or index-sized (the Node heap is capped at 3 GB). A slow
  site: check the heap first.
- The OG card route reads fonts through `process.cwd()` (non-standalone build).

## Private instance storage (src/lib/server/local, src/proxy.ts)

- Accounts, sessions, invites, the library and every plan revision live in one SQLite file under `GTNH_DATA_DIR`
  (`db.ts`). `auth.ts` owns sign-in; `library-store.ts` owns designs and history. Their tests pin the rules.
- `src/proxy.ts` requires a session for every path except the sign-in surface, checks Origin/Host on writes, and sets
  the security headers (CSP allows 'unsafe-eval' only because HiGHS glue is loaded with `new Function`).
- Routes return fixed error sentences; detail goes to the server log. The community hub, blueprints, feedback and
  telemetry are gone; `resource-popularity.ts` is an always-empty map.
- If `public/datasets/gtnh` is a symlink outside the repo, build with `GTNH_TRACING_ROOT=<parent dir>`.

