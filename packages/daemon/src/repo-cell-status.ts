import type { CanonicalEventStore, TaskProjection } from "@harness-anything/kernel";
import type { RepoCellStatus } from "./repo-cell-types.ts";

export function repoCellStatus(context: {
  readonly input: { readonly repoId: string };
  readonly rootDir: string;
  readonly mode: RepoCellStatus["mode"];
  readonly state: RepoCellStatus["state"];
  readonly generation: number;
  readonly queueDepth: number;
  readonly store: CanonicalEventStore;
  readonly lastError: string | null;
  readonly causeClass: RepoCellStatus["causeClass"];
  readonly recovery: { readonly elapsedMs: number };
}): RepoCellStatus {
  return {
    repoId: context.input.repoId,
    rootDir: context.rootDir,
    mode: context.mode,
    state: context.state,
    generation: context.generation,
    queueDepth: context.queueDepth,
    lastError: context.lastError,
    causeClass: context.causeClass,
    recoveryMs: context.recovery.elapsedMs,
    materialization: context.store.materializationHealth(),
  };
}

export function repoCellStatusCuts(context: {
  readonly state: RepoCellStatus["state"];
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
}): Pick<RepoCellStatus, "projectionWatermark" | "ledgerRevision"> | null {
  if (context.state !== "attached") return null;
  return {
    projectionWatermark: context.projection.readCut().watermark,
    ledgerRevision: context.store.readHead()?.revision ?? 0,
  };
}
