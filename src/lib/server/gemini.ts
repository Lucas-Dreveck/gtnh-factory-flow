/**
 * The Gemini call, server side only: the key never reaches the browser, and
 * the page's CSP allows no outbound connection but this site anyway.
 *
 * `runGeminiToolLoop` runs one ask to its end. The model may call tools; each
 * call is handed to the caller's handler and its answer fed back, until the
 * model replies with text or the turn budget runs out.
 */

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
/**
 * How many times the model may come back for another tool round. Recipe work
 * is a search, a look at the result and sometimes a second search; past this
 * it is looping rather than answering, and every round is a paid request.
 */
const MAX_TURNS = 6;
/**
 * The whole ask, tool rounds included, must answer inside this. A proxy in
 * front of the app gives up long before six slow rounds do and hands the
 * player a bad gateway page with nothing in it; an answer that says it ran out
 * of time is worth more than that. Well under the 100 s a Cloudflare tunnel
 * allows an origin.
 */
const ASK_BUDGET_MS = 45_000;
/** One round's own ceiling, so a single stalled call cannot eat the budget. */
const REQUEST_TIMEOUT_MS = 25_000;

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiToolLoopRequest {
  systemInstruction: string;
  contents: GeminiContent[];
  tools: GeminiFunctionDeclaration[];
  /**
   * Answers one tool call. Returning `undefined` tells the model the tool did
   * nothing it needs to read back (a proposed board action, for instance).
   */
  onToolCall: (call: GeminiToolCall) => Promise<Record<string, unknown> | undefined>;
}

export interface GeminiToolLoopResult {
  text: string;
  turns: number;
}

export class GeminiError extends Error {}

/** Unset means the assistant is off; the panel says so instead of failing per ask. */
export function geminiApiKey(): string | undefined {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * The model names THIS key may call `generateContent` on. A 404 on an ask is
 * almost always a name that does not exist for the key, and the names move
 * between Gemini releases, so the only honest answer is the one the API gives.
 */
export async function listGeminiModels(): Promise<string[]> {
  const key = geminiApiKey();
  if (!key) {
    throw new GeminiError("No Gemini key is configured on this server.");
  }
  const response = await fetch(`${GEMINI_ENDPOINT}?pageSize=200`, {
    headers: { "x-goog-api-key": key },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    console.error("[assistant/gemini] model listing failed", error);
    throw new GeminiError("Gemini could not be reached from this server.");
  });
  if (!response.ok) {
    console.error("[assistant/gemini] model listing", response.status, await response.text().catch(() => ""));
    throw new GeminiError("Gemini would not list its models for this key.");
  }
  const payload = (await response.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  return (payload.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => model.name?.replace(/^models\//, "") ?? "")
    .filter((name) => name.length > 0)
    .sort();
}

export function buildUserContent(text: string): GeminiContent {
  return { role: "user", parts: [{ text }] };
}

export function buildModelContent(text: string): GeminiContent {
  return { role: "model", parts: [{ text }] };
}

export async function runGeminiToolLoop(
  request: GeminiToolLoopRequest,
): Promise<GeminiToolLoopResult> {
  const key = geminiApiKey();
  if (!key) {
    throw new GeminiError("No Gemini key is configured on this server.");
  }

  const contents = [...request.contents];
  const texts: string[] = [];
  const deadline = Date.now() + ASK_BUDGET_MS;

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    // Checked before each round, not only at the end: the budget exists to
    // answer the player, so a round that cannot finish inside it is not started.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { text: outOfTime(texts), turns: turn - 1 };
    }

    const parts = await callGemini(key, Math.min(remaining, REQUEST_TIMEOUT_MS), {
      systemInstruction: { parts: [{ text: request.systemInstruction }] },
      contents,
      tools: request.tools.length > 0 ? [{ functionDeclarations: request.tools }] : undefined,
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    });

    for (const part of parts) {
      if (part.text) {
        texts.push(part.text);
      }
    }

    const calls = parts
      .map((part) => part.functionCall)
      .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name));
    if (calls.length === 0) {
      return { text: texts.join("\n").trim(), turns: turn };
    }

    // The model's own turn has to go back verbatim, calls included, or the
    // next request has tool answers with nothing to answer.
    contents.push({ role: "model", parts });
    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const answer = await request.onToolCall({ name, args: call.args ?? {} });
      responses.push({
        functionResponse: { name, response: answer ?? { ok: true } },
      });
    }
    contents.push({ role: "user", parts: responses });
  }

  return { text: texts.join("\n").trim(), turns: MAX_TURNS };
}

/**
 * What the player gets when the budget ran out: whatever the model had already
 * said, and a line saying it stopped there. An empty hand is an error instead,
 * so the panel does not show a blank answer.
 */
function outOfTime(texts: string[]): string {
  const said = texts.join("\n").trim();
  if (said.length === 0) {
    throw new GeminiError("Gemini took too long. Ask again, or ask something smaller.");
  }
  return `${said}\n\nI ran out of time before finishing. Ask again for the rest.`;
}

async function callGemini(
  key: string,
  timeoutMs: number,
  body: unknown,
): Promise<GeminiPart[]> {
  const response = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(geminiModel())}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => {
    // A timeout and a dead network both arrive here. Either way the route must
    // answer the browser: an unhandled reject is the bad gateway page.
    console.error("[assistant/gemini] request failed", error);
    throw new GeminiError(
      error instanceof Error && error.name === "TimeoutError"
        ? "Gemini took too long. Ask again, or ask something smaller."
        : "Gemini could not be reached from this server.",
    );
  });

  if (!response.ok) {
    // The body carries the key's quota and project, so it stays in the log.
    console.error("[assistant/gemini]", response.status, await response.text().catch(() => ""));
    throw new GeminiError(
      response.status === 429
        ? "Gemini is rate limiting this key. Try again in a minute."
        : response.status === 404
          ? // The one failure a server owner can fix alone, so it says the
            // name that failed and where the real names are listed.
            `Gemini has no model named "${geminiModel()}" for this key. Set GEMINI_MODEL to one of the names at /api/assistant.`
          : response.status === 400 || response.status === 403
            ? "Gemini refused this key. Check GEMINI_API_KEY."
            : "Gemini did not answer.",
    );
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    promptFeedback?: { blockReason?: string };
  };
  if (payload.promptFeedback?.blockReason) {
    throw new GeminiError("Gemini refused to answer that.");
  }
  return payload.candidates?.[0]?.content?.parts ?? [];
}
