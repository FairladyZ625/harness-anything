import { watch } from "node:fs";
import {
  consumeKnownError,
  makeTaskProjectionReader,
  type EdgeReadFreshness,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { locateFleetMirrorView, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import { readReplicaGeneration } from "./fleet/replica-generation.ts";
import type { RepositoryReadFrame } from "./protocol/repository-read-frame.ts";

export const DEFAULT_EDGE_READ_MAX_AGE_MS = 60_000;
export const DEFAULT_EDGE_READ_MAX_LAG_REVISIONS = 32;
export const DEFAULT_WRITE_READ_WAIT_MS = 5_000;
export interface EdgeReadCut {
  readonly revision: number;
  readonly headDigest: string;
}
export interface EdgeTaskReadInput {
  readonly viewRoot: string;
  readonly repoId: string;
  readonly nodeId: string;
  readonly writeReadWaitMs?: number;
  readonly minCut?: EdgeReadCut;
  readonly action: Readonly<Record<string, unknown>>;
}
export function withEdgeReadModel<T>(
  input: {
    readonly viewRoot: string;
    readonly repoId: string;
    readonly nodeId: string;
    readonly principalId: string | undefined;
    readonly maxAgeMs?: number;
    readonly maxLagRevisions?: number;
  },
  read: (projection: TaskProjectionQueries, frame: RepositoryReadFrame, view: FleetMirrorView) => T,
  now: () => number = Date.now,
): T {
  const view = locateFleetMirrorView(input.viewRoot, input.repoId, input.nodeId),
    generation = view && readReplicaGeneration(view.viewDir);
  if (!view || !generation)
    throw new EdgeReadError("replica_unavailable", "The edge replica generation is unavailable.");
  const reader = makeTaskProjectionReader({ rootDir: generation.rootDir, projectionPath: generation.projectionPath });
  try {
    const fresh = edgeFreshness(view, generation.metadata.position.revision, input, now);
    return reader.withSession((projection) =>
      read(
        projection,
        {
          cut: { revision: generation.metadata.position.revision, headDigest: view.headDigest },
          freshness: fresh.freshness,
          warning: fresh.warning,
        },
        view,
      ),
    );
  } finally {
    reader.close();
  }
}
class EdgeReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export function edgeFreshness(
  view: FleetMirrorView,
  sourceRevision: number,
  input: { readonly maxAgeMs?: number; readonly maxLagRevisions?: number },
  now: () => number,
): { readonly freshness: EdgeReadFreshness; readonly warning: string | null } {
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_EDGE_READ_MAX_AGE_MS,
    maxLagRevisions = input.maxLagRevisions ?? DEFAULT_EDGE_READ_MAX_LAG_REVISIONS;
  return {
    freshness: {
      state: "fresh",
      ageMs: 0,
      lagRevisions: 0,
      maxAgeMs,
      maxLagRevisions,
      confirmedAt: new Date(now()).toISOString(),
    },
    warning: null,
  };
}
export async function readEdgeRepository(
  input: EdgeTaskReadInput,
  pull: () => Promise<unknown>,
  readLocal: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (!locateFleetMirrorView(input.viewRoot, input.repoId, input.nodeId)) {
    try {
      await pull();
    } catch (error) {
      consumeKnownError(error);
    }
  }
  return readLocal();
}
export function edgeReadModelPresent(input: EdgeTaskReadInput): boolean {
  return locateFleetMirrorView(input.viewRoot, input.repoId, input.nodeId) !== null;
}
export function waitForMinimumCut(input: EdgeTaskReadInput): Promise<boolean> {
  if (!input.minCut) return Promise.resolve(true);
  const view = locateFleetMirrorView(input.viewRoot, input.repoId, input.nodeId);
  if (view && view.revision >= input.minCut.revision) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      watcher.close();
      resolve(false);
    }, input.writeReadWaitMs ?? DEFAULT_WRITE_READ_WAIT_MS);
    const watcher = view
      ? watch(view.viewDir, () => {
          const current = locateFleetMirrorView(input.viewRoot, input.repoId, input.nodeId);
          if (current && current.revision >= input.minCut!.revision) {
            clearTimeout(timer);
            watcher.close();
            resolve(true);
          }
        })
      : { close: () => undefined };
  });
}
