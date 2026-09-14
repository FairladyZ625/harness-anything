import type { CanonicalEventStore, TaskProjection } from "../../kernel/src/index.ts";
import type { RepoCellStatus } from "./repo-cell-types.ts";

export function repoCellStatus(context: {
  readonly input: { readonly repoId: string };
  readonly rootDir: string;
  readonly mode: RepoCellStatus["mode"];
  readonly state: RepoCellStatus["state"];
  readonly generation: number;
  readonly queueDepth: number;
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
  readonly lastError: string | null;
  readonly causeClass: RepoCellStatus["causeClass"];
  readonly recovery: { readonly elapsedMs: number };
}): RepoCellStatus {
  const cut = context.projection.readCut();
  return {
    repoId: context.input.repoId,
    rootDir: context.rootDir,
    mode: context.mode,
    state: context.state,
    generation: context.generation,
    queueDepth: context.queueDepth,
    projectionWatermark: cut.watermark,
    ledgerRevision: context.store.readHead()?.revision ?? 0,
    lastError: context.lastError,
    causeClass: context.causeClass,
    recoveryMs: context.recovery.elapsedMs,
    materialization: context.store.materializationHealth(),
  };
}
