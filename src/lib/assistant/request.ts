import { z } from "zod";
import type { AssistantRequestBody } from "./types";

/**
 * The guard on `/api/assistant`. The body is a board photo the browser built,
 * so it is the player's own data, but it is still parsed: the prompt is sent
 * to a paid API, and an unbounded ask is an unbounded bill.
 */

/** Characters per message, and per board field. Long enough for a paragraph. */
const MESSAGE_MAX = 4000;
const LABEL_MAX = 200;
const MESSAGE_COUNT_MAX = 30;

const label = z.string().max(LABEL_MAX);

const boardNode = z.object({
  id: label,
  recipeName: label,
  machine: label,
  machineCount: z.number().finite(),
  tier: label,
  euPerTick: z.number().finite().optional(),
  takes: z.array(label).max(12),
  makes: z.array(label).max(12),
});

const boardEdge = z.object({
  from: label,
  to: label,
  resource: label,
  perSecond: z.number().finite().optional(),
});

const boardDrawer = z.object({
  id: label,
  resource: label,
  role: z.enum(["source", "product", "buffer"]),
  targetPerSecond: z.number().finite().optional(),
});

const schema = z.object({
  datasetVersionId: z.string().min(1).max(LABEL_MAX),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(MESSAGE_MAX),
      }),
    )
    .min(1)
    .max(MESSAGE_COUNT_MAX),
  board: z.object({
    planName: label,
    mode: z.enum(["build", "solve", "pool"]),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    nodes: z.array(boardNode).max(80),
    edges: z.array(boardEdge).max(160),
    drawers: z.array(boardDrawer).max(60),
    notes: z.array(z.string().max(MESSAGE_MAX)).max(40),
  }),
});

export function parseAssistantRequest(body: unknown): AssistantRequestBody | undefined {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
