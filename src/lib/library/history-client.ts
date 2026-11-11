"use client";

import type { FactoryProject } from "@/lib/model/types";
import { LibraryRequestRefused, LibrarySyncUnavailable } from "./client";
import type { RemoteDesignMeta } from "./sync-types";

export type RevisionKind =
  | "autosave"
  | "checkpoint"
  | "guard"
  | "restore"
  | "conflict"
  | "fork"
  | "import";

/** One saved version of a design, as the account lists it (no plan). */
export interface RevisionMeta {
  id: number;
  designId: string;
  parentId: number | null;
  createdAt: string;
  clientUpdatedAt: string | null;
  kind: RevisionKind;
  label: string | null;
  note: string | null;
  sha256: string;
  byteSize: number;
  nodeCount: number;
  edgeCount: number;
  storageCount: number;
  isHead: boolean;
}

export interface RevisionListOptions {
  limit?: number;
  /** Revisions older than this id. */
  before?: number;
  /** Only the named kinds (everything but autosaves). */
  checkpoints?: boolean;
}

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as
    | (T & { error?: string })
    | undefined;
  if (!response.ok || !body) {
    const message = body?.error ?? `Request failed (${response.status})`;
    if (response.status === 401 || response.status === 503) {
      throw new LibrarySyncUnavailable(message);
    }
    if (response.status === 400 || response.status === 409 || response.status === 413) {
      throw new LibraryRequestRefused(message, response.status);
    }
    throw new Error(message);
  }
  return body;
}

function base(designId: string): string {
  return `/api/library/designs/${encodeURIComponent(designId)}`;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function listRevisions(
  designId: string,
  options: RevisionListOptions = {},
): Promise<RevisionMeta[]> {
  const query = new URLSearchParams();
  query.set("limit", String(options.limit ?? 100));
  if (options.before !== undefined) query.set("before", String(options.before));
  if (options.checkpoints) query.set("checkpoints", "1");
  const response = await fetch(`${base(designId)}/revisions?${query}`, { cache: "no-store" });
  return (await parse<{ revisions: RevisionMeta[] }>(response)).revisions;
}

export async function fetchRevision(
  designId: string,
  revisionId: number,
): Promise<{ revision: RevisionMeta; plan: FactoryProject }> {
  const response = await fetch(`${base(designId)}/revisions/${revisionId}`, { cache: "no-store" });
  return parse(response);
}

export async function annotateRevision(
  designId: string,
  revisionId: number,
  body: { label: string; note: string },
): Promise<void> {
  const response = await fetch(`${base(designId)}/revisions/${revisionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await parse<{ ok: true }>(response);
}

export async function createCheckpoint(
  designId: string,
  body: { label: string; note?: string; plan?: unknown },
): Promise<RevisionMeta> {
  const response = await post(`${base(designId)}/checkpoints`, body);
  return (await parse<{ revision: RevisionMeta }>(response)).revision;
}

export async function restoreRevision(
  designId: string,
  revisionId: number,
): Promise<{ design: RemoteDesignMeta; revision: RevisionMeta }> {
  const response = await post(`${base(designId)}/restore`, { revisionId });
  return parse(response);
}

export async function forkRevision(
  designId: string,
  revisionId: number,
  name: string,
): Promise<RemoteDesignMeta> {
  const response = await post(`${base(designId)}/fork`, { revisionId, name });
  return (await parse<{ design: RemoteDesignMeta }>(response)).design;
}

export async function undeleteRemoteDesign(designId: string): Promise<RemoteDesignMeta> {
  const response = await post(`${base(designId)}/undelete`, {});
  return (await parse<{ design: RemoteDesignMeta }>(response)).design;
}
