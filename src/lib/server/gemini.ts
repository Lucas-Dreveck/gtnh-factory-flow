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
const REQUEST_TIMEOUT_MS = 60_000;

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

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    const parts = await callGemini(key, {
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

async function callGemini(key: string, body: unknown): Promise<GeminiPart[]> {
  const response = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(geminiModel())}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The body carries the key's quota and project, so it stays in the log.
    console.error("[assistant/gemini]", response.status, await response.text().catch(() => ""));
    throw new GeminiError(
      response.status === 429
        ? "Gemini is rate limiting this key. Try again in a minute."
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
