# The Gemini assistant (src/lib/assistant, src/components/assistant, /api/assistant)

One corner button on the shell, one side panel, one route. The player asks about the open
board; Gemini may look recipes up and may propose board changes the player applies.

- `GEMINI_API_KEY` unset switches the whole thing off: the route answers 503 and the panel
  says so. `GEMINI_MODEL` picks the model. The key never reaches the browser, and the CSP
  allows no outbound connection but this site, so the call can only happen server side.
- A 404 from Gemini is the model NAME or the API VERSION, and both move between releases:
  a model that `ListModels` still shows can stop answering on an older version. Both are
  env (`GEMINI_MODEL`, `GEMINI_API_VERSION`), and `GET /api/assistant` reports what this
  server is set to beside the names the key may call. Never hard-code a list of models or
  guess one into a message, and never name a model in copy that the API has not confirmed.
- The default model is a floating alias (`gemini-flash-latest`), not a pinned version:
  this fork deploys rarely and a pinned name ages out of the API between deploys.
- `board-snapshot.ts` builds the photo of the board the model reads: names, counts, wires,
  drawers and the solve's verdicts, capped at `SNAPSHOT_NODE_LIMIT` cards. No positions,
  no icons, no runtime tables. `prompt.ts` turns it into plain lines, which the model reads
  far better than JSON.
- The photo is rebuilt on EVERY ask and only the words are kept in the history, so a
  question asked after an edit is answered against the board as it is now.
- Recipe and item lookups run on the server (`queryDatasetRecipes`, `queryDatasetResources`):
  the dataset is there, and a recipe id cannot be guessed. The model is told to search first.
- Board changes come back as ACTIONS, never applied by the route. `apply-actions.ts` checks
  each one against the live board again and skips what no longer fits, saying why. Each
  action is an ordinary store action, so undo walks back through them one at a time.
- `action-parse.ts` is the only door from a tool call to an action: a missing id, a
  fractional machine count or a card wired to itself is dropped there. `request.ts` bounds
  the body, because every ask is a paid request.
- The whole ask answers inside `ASK_BUDGET_MS` (45 s), tool rounds included, and each
  round is capped again. A proxy in front of the app gives up around 100 s and hands the
  player its own bad gateway page with nothing in it; the route must always get there
  first, even if the answer is that it ran out of time. Every path out of the fetch
  returns a sentence: an unhandled reject IS that gateway page.
- Nothing is persisted. A conversation about one board is worthless against another, and a
  reload is the one moment a player can be sure the panel is empty.
- Exams: `action-parse.test.ts`, `board-snapshot.test.ts`.
