import { fail, json, readJson, serverError, sessionOr401 } from "@/lib/server/local/http";
import {
  getDatasetRecipe,
  queryDatasetRecipes,
  queryDatasetResources,
} from "@/lib/server/dataset-query";
import {
  GeminiError,
  buildModelContent,
  buildUserContent,
  geminiApiKey,
  geminiModel,
  listGeminiModels,
  runGeminiToolLoop,
  type GeminiFunctionDeclaration,
} from "@/lib/server/gemini";
import { ASSISTANT_SYSTEM_PROMPT, boardBriefing } from "@/lib/assistant/prompt";
import { parseAssistantRequest } from "@/lib/assistant/request";
import { readAssistantAction } from "@/lib/assistant/action-parse";
import type { AssistantAction, AssistantReply } from "@/lib/assistant/types";
import type { Recipe } from "@/lib/model/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this server can actually run: the model it is set to, and the names the
 * key may call. A 404 from Gemini means the name does not exist for the key,
 * and the names move between releases, so the server owner needs to be able to
 * read the real list off the running instance rather than guess.
 */
export async function GET(request: Request) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  if (!geminiApiKey()) {
    return fail(503, "No Gemini key is configured on this server.");
  }
  try {
    const models = await listGeminiModels();
    return json({ model: geminiModel(), usable: models.includes(geminiModel()), models });
  } catch (error) {
    if (error instanceof GeminiError) {
      return fail(502, error.message);
    }
    return serverError("assistant/models", error, "The model list could not be read.");
  }
}

/** How many board actions one answer may propose. A longer list is a plan, not a step. */
const ACTION_LIMIT = 12;
/** Rows handed back per lookup: enough to choose from, small enough to read. */
const LOOKUP_LIMIT = 8;

/**
 * One ask to the assistant. The browser sends the conversation and a photo of
 * the board; Gemini may look recipes and items up here (the dataset lives on
 * this server), and whatever it wants done to the board comes back as actions
 * for the player to apply. Nothing here touches a plan.
 */
export async function POST(request: Request) {
  const session = sessionOr401(request);
  if ("response" in session) return session.response;
  if (!geminiApiKey()) {
    return fail(503, "No Gemini key is configured on this server.");
  }

  const body = await readJson(request);
  const parsed = body ? parseAssistantRequest(body) : undefined;
  if (!parsed) {
    return fail(400, "That ask could not be read.");
  }

  const { datasetVersionId, messages, board } = parsed;
  const actions: AssistantAction[] = [];
  const lookups: string[] = [];

  try {
    const result = await runGeminiToolLoop({
      systemInstruction: `${ASSISTANT_SYSTEM_PROMPT}\n\n${boardBriefing(board)}`,
      contents: messages.map((message) =>
        message.role === "user" ? buildUserContent(message.text) : buildModelContent(message.text),
      ),
      tools: ASSISTANT_TOOLS,
      onToolCall: async (call) => {
        switch (call.name) {
          case "search_items":
            return await searchItems(datasetVersionId, call.args, lookups);
          case "search_recipes":
            return await searchRecipes(datasetVersionId, call.args, lookups);
          case "get_recipe":
            return await getRecipe(datasetVersionId, call.args, lookups);
          default: {
            const action = readAssistantAction(call.name, call.args);
            if (!action) {
              return { error: `No tool named ${call.name}.` };
            }
            if (actions.length >= ACTION_LIMIT) {
              return { error: `Only ${ACTION_LIMIT} board changes fit in one answer.` };
            }
            actions.push(action);
            return { proposed: true, note: "Shown to the player, who applies it." };
          }
        }
      },
    });

    const reply: AssistantReply = {
      text: result.text || "Gemini had nothing to say about that.",
      actions,
      lookups,
    };
    return json(reply);
  } catch (error) {
    if (error instanceof GeminiError) {
      console.error("[assistant]", geminiModel(), error.message);
      return fail(502, error.message);
    }
    return serverError("assistant", error, "The assistant could not answer.");
  }
}

async function searchItems(
  versionId: string,
  args: Record<string, unknown>,
  lookups: string[],
): Promise<Record<string, unknown>> {
  const query = readString(args.query) ?? "";
  const kind = args.kind === "item" || args.kind === "fluid" ? args.kind : undefined;
  lookups.push(`items: ${query || "(everything)"}`);
  const result = await queryDatasetResources(versionId, {
    query,
    offset: 0,
    limit: readLimit(args.limit),
    kind,
  });
  return {
    items: result.resources.map((resource) => ({
      ref: `${resource.kind}:${resource.id}`,
      name: resource.displayName ?? resource.id,
    })),
    total: result.total,
  };
}

async function searchRecipes(
  versionId: string,
  args: Record<string, unknown>,
  lookups: string[],
): Promise<Record<string, unknown>> {
  const query = readString(args.query) ?? "";
  const makes = readResourceRef(args.makes);
  const takes = readResourceRef(args.takes);
  lookups.push(
    `recipes: ${[query, makes && `makes ${makes.id}`, takes && `takes ${takes.id}`]
      .filter(Boolean)
      .join(" ") || "(everything)"}`,
  );
  const clauses = [
    ...(makes ? [{ role: "makes" as const, kind: makes.kind, id: makes.id }] : []),
    ...(takes ? [{ role: "takes" as const, kind: takes.kind, id: takes.id }] : []),
  ];
  const result = await queryDatasetRecipes(versionId, {
    query,
    mode: "recipes",
    // An empty clause list is not "no conditions": it would ask the set
    // algebra for the intersection of nothing.
    clauses: clauses.length > 0 ? clauses : undefined,
    allMaps: true,
    maxTier: "all",
    offset: 0,
    limit: readLimit(args.limit),
  });
  return {
    recipes: result.recipes.map(recipeDigest),
    total: result.total,
  };
}

async function getRecipe(
  versionId: string,
  args: Record<string, unknown>,
  lookups: string[],
): Promise<Record<string, unknown>> {
  const recipeId = readString(args.recipeId);
  if (!recipeId) {
    return { error: "recipeId is required." };
  }
  lookups.push(`recipe: ${recipeId}`);
  const recipe = await getDatasetRecipe(versionId, recipeId);
  if (!recipe) {
    return { error: `No recipe with id ${recipeId} in this dataset.` };
  }
  return { recipe: recipeDigest(recipe, { allSlots: true }) };
}

/** A recipe small enough to put several in a prompt: names, amounts, power, time. */
function recipeDigest(recipe: Recipe, options: { allSlots?: boolean } = {}) {
  const slots = options.allSlots ? 32 : 6;
  return {
    recipeId: recipe.id,
    name: recipe.name,
    machine: recipe.machineType,
    minimumTier: recipe.minimumTier,
    euPerTick: recipe.eut,
    seconds: Math.round((recipe.durationTicks / 20) * 100) / 100,
    takes: recipe.inputs.slice(0, slots).map((slot) => ({
      ref: `${slot.kind}:${slot.id}`,
      name: slot.displayName ?? slot.id,
      amount: slot.amount,
    })),
    makes: recipe.outputs.slice(0, slots).map((slot) => ({
      ref: `${slot.kind}:${slot.id}`,
      name: slot.displayName ?? slot.id,
      amount: slot.amount,
      chance: slot.chance,
    })),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readLimit(value: unknown): number {
  const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isInteger(parsed) ? Math.max(1, Math.min(LOOKUP_LIMIT, parsed)) : LOOKUP_LIMIT;
}

/** A `kind:id` reference, the one shape every lookup hands back and takes. */
function readResourceRef(value: unknown): { kind: "item" | "fluid"; id: string } | undefined {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  const colon = raw.indexOf(":");
  const kind = colon > 0 ? raw.slice(0, colon) : "";
  const id = colon > 0 ? raw.slice(colon + 1) : "";
  if ((kind !== "item" && kind !== "fluid") || id.length === 0) {
    return undefined;
  }
  return { kind, id };
}

const RESOURCE_REF_DESCRIPTION =
  'A "kind:id" reference exactly as a lookup returned it, for example "item:gregtech:gt.metaitem.01:2086" or "fluid:water".';

const ASSISTANT_TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: "search_items",
    description:
      "Find items and fluids in the loaded GTNH dataset by name. Use it to turn a name the player used into the kind:id reference the other tools need.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the item or fluid name." },
        kind: { type: "string", enum: ["item", "fluid"], description: "Narrow to one form." },
        limit: { type: "number", description: `Rows to return, up to ${LOOKUP_LIMIT}.` },
      },
      required: ["query"],
    },
  },
  {
    name: "search_recipes",
    description:
      "Find recipes in the loaded GTNH dataset. Free text matches the recipe and machine name; makes and takes filter by what the recipe produces and consumes. Always search before proposing a recipe: recipe ids cannot be guessed.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text, such as an output or machine name." },
        makes: { type: "string", description: `Only recipes producing this. ${RESOURCE_REF_DESCRIPTION}` },
        takes: { type: "string", description: `Only recipes consuming this. ${RESOURCE_REF_DESCRIPTION}` },
        limit: { type: "number", description: `Rows to return, up to ${LOOKUP_LIMIT}.` },
      },
      required: [],
    },
  },
  {
    name: "get_recipe",
    description: "Every slot, the power and the duration of one recipe, by the id a search returned.",
    parameters: {
      type: "object",
      properties: {
        recipeId: { type: "string", description: "The recipeId from a search result." },
      },
      required: ["recipeId"],
    },
  },
  {
    name: "add_recipe",
    description:
      "Propose a new card on the board for a recipe found by search. The player applies it; it is not placed by this call.",
    parameters: {
      type: "object",
      properties: {
        recipeId: { type: "string", description: "The recipeId from a search result." },
        recipeName: { type: "string", description: "The recipe name, for the player to read." },
        machineCount: { type: "number", description: "How many machines, 1 by default." },
        connect: {
          type: "boolean",
          description: "Wire the new card to every card on the board it fits, true by default.",
        },
        reason: { type: "string", description: "One short sentence on why this card." },
      },
      required: ["recipeId", "recipeName"],
    },
  },
  {
    name: "set_machine_count",
    description: "Propose a new machine count for a card that is already on the board.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The card id from the board listing." },
        machineCount: { type: "number", description: "The new count, at least 1." },
        reason: { type: "string", description: "One short sentence on why." },
      },
      required: ["nodeId", "machineCount"],
    },
  },
  {
    name: "connect_nodes",
    description:
      "Propose a wire from one card's output to another card's input. Both cards must already be on the board.",
    parameters: {
      type: "object",
      properties: {
        sourceNodeId: { type: "string", description: "The producing card's id." },
        targetNodeId: { type: "string", description: "The consuming card's id." },
        reason: { type: "string", description: "One short sentence on why." },
      },
      required: ["sourceNodeId", "targetNodeId"],
    },
  },
  {
    name: "auto_connect",
    description: "Propose wiring one card to every card on the board whose slots fit it.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The card id from the board listing." },
        reason: { type: "string", description: "One short sentence on why." },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "delete_node",
    description: "Propose removing a card from the board, with its wires.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The card id from the board listing." },
        reason: { type: "string", description: "One short sentence on why." },
      },
      required: ["nodeId"],
    },
  },
];
