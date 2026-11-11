import { initLpEngine } from "@/lib/solver/lp-engine";
import { createBrowserRecipeSource } from "./browser-source";
import { DiscoverCancelled, discoverRoutes } from "./discover";
import type { DiscoverReply, DiscoverRequest } from "./discover-protocol";

// Same HiGHS load as the solve worker: every full-plan solve of a route search
// waits for the load to settle, and a failed load falls back to the simplex.
const engineReady = initLpEngine({ glueUrl: "/highs.js", wasmUrl: "/highs.wasm" });

const cancelled = new Set<number>();
const reply = (message: DiscoverReply) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<DiscoverRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }
  const { id } = message;
  try {
    await engineReady;
    const result = await discoverRoutes({
      project: message.project,
      target: message.target,
      options: message.options,
      source: createBrowserRecipeSource("", message.version),
      isCancelled: () => cancelled.has(id),
      onProgress: (progress) => reply({ type: "progress", id, progress }),
    });
    reply({ type: "result", id, result });
  } catch (error) {
    reply({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
      cancelled: error instanceof DiscoverCancelled,
    });
  } finally {
    cancelled.delete(id);
  }
};
