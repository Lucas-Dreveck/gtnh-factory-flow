import type { DatasetVersion } from "@/lib/datasets/types";
import type { FactoryProject } from "@/lib/model/types";
import { applyRouteChoices } from "@/lib/model/route-choices";
import { DiscoverCancelled, discoverRoutes, type DiscoverProgress } from "./discover";
import type { DiscoverReply, DiscoverRequest } from "./discover-protocol";
import { createBrowserRecipeSource } from "./browser-source";
import type { DiscoverOptions, DiscoverResult, RouteTarget } from "./types";

export interface DiscoverRun {
  /** Resolves with the routes; rejects with DiscoverCancelled after cancel(). */
  promise: Promise<DiscoverResult>;
  cancel: () => void;
}

let worker: Worker | undefined;
let nextId = 0;

function getWorker(): Worker {
  worker ??= new Worker(new URL("./discover.worker.ts", import.meta.url));
  return worker;
}

/**
 * Runs the route search off the main thread (HiGHS for the full-plan solves).
 * Without Worker support it falls back to the pre-score only search on the
 * page, which keeps the simplex off long solves.
 */
export function startDiscovery(input: {
  project: FactoryProject;
  target: RouteTarget;
  options: Partial<DiscoverOptions>;
  version: DatasetVersion;
  onProgress?: (progress: DiscoverProgress) => void;
}): DiscoverRun {
  const project = applyRouteChoices(input.project);
  if (typeof Worker === "undefined") {
    let stop = false;
    return {
      cancel: () => {
        stop = true;
      },
      promise: discoverRoutes({
        project,
        target: input.target,
        options: { ...input.options, skipFullEvaluation: true },
        source: createBrowserRecipeSource("", input.version),
        onProgress: input.onProgress,
        isCancelled: () => stop,
      }),
    };
  }
  const id = ++nextId;
  const w = getWorker();
  let settle: { resolve: (r: DiscoverResult) => void; reject: (e: Error) => void };
  const promise = new Promise<DiscoverResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const cleanup = () => {
    w.removeEventListener("message", onMessage);
    w.removeEventListener("error", onError);
  };
  const onMessage = (event: MessageEvent<DiscoverReply>) => {
    const reply = event.data;
    if (reply.id !== id) return;
    if (reply.type === "progress") {
      input.onProgress?.(reply.progress);
      return;
    }
    cleanup();
    if (reply.type === "result") settle.resolve(reply.result);
    else settle.reject(reply.cancelled ? new DiscoverCancelled() : new Error(reply.message));
  };
  const onError = (event: ErrorEvent) => {
    cleanup();
    // A worker that cannot run is dropped so the next press starts a fresh one.
    worker = undefined;
    settle.reject(new Error(event.message || "The route search could not start."));
  };
  w.addEventListener("message", onMessage);
  w.addEventListener("error", onError);
  const request: DiscoverRequest = {
    type: "discover",
    id,
    project,
    target: input.target,
    options: input.options,
    version: input.version,
  };
  w.postMessage(request);
  return {
    promise,
    cancel: () => w.postMessage({ type: "cancel", id } satisfies DiscoverRequest),
  };
}
