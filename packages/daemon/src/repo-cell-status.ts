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
  readonly projection: TaskProjection;
  readonly lastError: string | null;
  readonly causeClass: RepoCellStatus["causeClass"];
  readonly recovery: { readonly elapsedMs: number; readonly status: "none" | "indeterminate" };
  readonly recoveryUncertain: boolean;
}): RepoCellStatus {
  const read = readStatusCut(context);
  return {
    ...read?.cuts,
    repoId: context.input.repoId,
    rootDir: context.rootDir,
    mode: context.mode,
    state: context.state,
    projectionReadable:
      (context.state === "attached" || context.state === "unavailable") &&
      context.recovery.status === "none" &&
      !context.recoveryUncertain &&
      context.causeClass !== "projection" &&
      (read === null || read.ready),
    generation: context.generation,
    queueDepth: context.queueDepth,
    lastError: context.lastError,
    causeClass: context.causeClass,
    recoveryMs: context.recovery.elapsedMs,
    // Git-less edges mirror the center cut; their local store is not a canonical Git publisher.
    materialization: context.mode === "remote-edge" ? null : context.store.materializationHealth(),
  };
}

type StatusReadContext = {
  readonly state: RepoCellStatus["state"];
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
};
export function repoCellStatusCuts(
  context: StatusReadContext,
): Pick<RepoCellStatus, "projectionWatermark" | "ledgerRevision"> | null {
  return readStatusCut(context)?.cuts ?? null;
}
function readStatusCut(context: StatusReadContext) {
  if (context.state !== "attached") return null;
  const cut = context.projection.readCut();
  return {
    ready: cut.status === "ready",
    cuts: { projectionWatermark: cut.watermark, ledgerRevision: context.store.readHead()?.revision ?? 0 },
  };
}
