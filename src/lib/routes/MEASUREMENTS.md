# Route discovery: measurements

Plan: `hv-plan(5).json` (50 cards, 35 drawers, 140 wires, Solve mode, max tier HV).
Dataset: GTNH 2.9.0 (`stable-2.9.0`). Node 24 on a desktop, one run each, via
`measure.local.test.ts` (`PLAN_FILE=... OUT_FILE=... [HIGHS=1] npx vitest run
src/lib/routes/measure.local.test.ts --config vitest.local.config.ts`).

## What is timed

- **io**: wall time of the recipe-book questions ("what makes X", the recipe browser's
  `mode: "recipes"`, all machines, `maxTier` = plan max). In node this is dataset-query CPU
  (queries run on one thread, so parallel questions queue); in the browser it is network
  plus server time and the questions of one level go out together. Only the first question
  of the server process also loads the lookup index: **about 1.2 s once**, not per press.
- **search + pre-score**: compute only. Search is filter, dedupe, rank, enumerate (1-17 ms).
  Pre-score is one small LP per candidate route through `solveLpAuto` (0.1-0.6 ms each).
- **full solve**: `calculateThroughput` on a plan copy with the route added and wired.
  This is the cost that varies, and it depends on the LP engine (below).
- **hydrate**: fetching full recipe objects for the routes that get a full solve
  (`/recipes/{id}` in the browser).
- Baseline plan solve (the "before"): 13-90 ms with HiGHS, 45-60 ms with the homegrown simplex.

## Producer recipes per level (fetched / after filter / after dedupe)

Filter = tier above the plan max, non-GregTech kinds, recipes that need the target
themselves (cycle), recipes whose net output of the resource is not positive, the replaced
card's own recipe, blocked machines (Tank, Canner: cell detours). Dedupe = same consumed
inputs and outputs regardless of circuit or singleblock/multiblock twin.

Default settings (depth 2, beam 3, 24 roots, K 5):

| Target | L1 (1 question) | L2 (questions; sum of rows) | Candidate routes | Full solves |
|---|---|---|---|---|
| Chlorine | 92 / 54 / 44 | 21 q; 371 / 208 / 181 | 70 | 5 |
| Sodium Dust | 200 / 199 / 180 | 20 q; 552 / 535 / 491 | 83 | 15 |
| Hydrogen | 200 / 114 / 113 | 18 q; 460 / 366 / 359 | 65 | 5 |
| Hydrochloric Acid | 90 / 66 / 56 | 5 q; 142 / 61 / 61 | 43 | 15 |
| Ethylene | 85 / 75 / 75 | 21 q; 232 / 134 / 130 | 93 | 9 |

(Fetch is capped at 200 rows; Sodium Dust and Hydrogen hit the cap, so L1 is truncated
there. Full solves exceed K=5 when fewer than 2 routes kept the plan whole, up to 3K.)

## Time per button press, default settings (ms)

LP engine HiGHS (what the browser solve worker uses):

| Target | io | search | pre-score | full solves | hydrate | total |
|---|---|---|---|---|---|---|
| Chlorine | 764 (22 q) | 3 | 44 | 95 (5 x 19) | 52 | 975 |
| Sodium Dust | 611 (21 q) | 4 | 44 | 261 (15 x 17) | 83 | 1022 |
| Hydrogen | 435 (19 q) | 2 | 37 | 87 (5 x 17) | 43 | 623 |
| Hydrochloric Acid | 98 (6 q) | 1 | 31 | 488 (15 x 33) | 60 | 692 |
| Ethylene | 482 (22 q) | 2 | 59 | 242 (9 x 27) | 26 | 827 |

Homegrown simplex (node tests, SSR, main thread without the worker): same search, but
full solves are **60-1600 ms each** (Hydrogen 5 solves = 8.1 s, Hydrochloric Acid 15 solves
= 5.9 s, Ethylene 9 = 3.5 s; Chlorine 5 = 0.3 s). Totals 1.1-8.7 s.

Other settings (HiGHS, totals in ms; Chlorine / Sodium Dust / Hydrogen / HCl / Ethylene):

| Setting | Chlorine | Sodium Dust | Hydrogen | HCl | Ethylene |
|---|---|---|---|---|---|
| depth 1, beam 3, K 5 | 495 | 597 | 496 | 927 | 186 |
| depth 2, beam 3, K 5 (default) | 975 | 1022 | 623 | 692 | 827 |
| depth 2, beam 2, K 3 | 325 | 290 | 347 | 436 | 719 |
| depth 3, beam 3, K 5 | 1276 | 1228 | 811 | 628 | 1110 |

Depth 3 asks 38-67 questions (vs 6-22) and found no better routes on this plan.

## Memory

Heap grew 16-44 MB over the whole run, mostly dataset shard and index caches that the
server already keeps. A route search itself holds a few hundred small recipe objects.

## Recommended defaults

- depth 2, beam 3, root limit 24, K 5 (adaptive up to 15 solves until 2 routes keep the
  plan whole), fetch limit 200. About 0.6-1.0 s on this plan with HiGHS.
- Run the full-plan solves in the solve worker (HiGHS loaded). On the main thread with the
  simplex a press can take 4-9 s; that does not fit under 3 s. Alternative there: run the
  search with `skipFullEvaluation` (about 0.1-0.5 s of search, pre-score only) and solve
  the routes one at a time as the player opens them.
- Depth 3 costs 2-3x the questions for no gain here; leave it off.
- Browser: the 20-odd questions of level 2 are issued together, so network round trips
  overlap; budget 20 requests of ~50-100 ms. A batched "producers of these N resources"
  endpoint would cut that to one request.
