import type { DatasetVersion } from "@/lib/datasets/types";
import type { FactoryProject } from "@/lib/model/types";
import type { DiscoverProgress } from "./discover";
import type { DiscoverOptions, DiscoverResult, RouteTarget } from "./types";

/** Messages between the route-search worker and the page. */
export type DiscoverRequest =
  | {
      type: "discover";
      id: number;
      /** The plan as the solver sees it (route choices already applied). */
      project: FactoryProject;
      target: RouteTarget;
      options: Partial<DiscoverOptions>;
      version: DatasetVersion;
    }
  | { type: "cancel"; id: number };

export type DiscoverReply =
  | { type: "progress"; id: number; progress: DiscoverProgress }
  | { type: "result"; id: number; result: DiscoverResult }
  | { type: "error"; id: number; message: string; cancelled: boolean };
