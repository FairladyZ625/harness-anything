import type { ArtifactGuiKind, ArtifactsListResult } from "../../../daemon/src/protocol/artifacts-gui-contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

// Renderer client for the artifacts timeline: one `repo.artifacts.list` read returns
// the complete joined DTO — file inventory, task attribution and the time source are
// daemon facts; this file never scans, recomputes times, or re-derives kinds.
type ArtifactsBridge = {
  readonly listArtifacts: (payload: { repoId: string; kind?: ArtifactGuiKind }) => Promise<unknown>;
};

const bridge = (): ArtifactsBridge => {
  const value = window.harness as unknown as Partial<ArtifactsBridge> | undefined;
  if (!value?.listArtifacts) throw new Error("Artifacts bridge is unavailable.");
  return value as ArtifactsBridge;
};

export const artifactsClient = {
  list: async (repoId: string, kind: ArtifactGuiKind): Promise<ArtifactsListResult> => {
    const value = await bridge().listArtifacts({ repoId, kind });
    if (
      !isRendererRecord(value) ||
      value.ok !== true ||
      !Array.isArray(value.artifacts) ||
      !isRendererRecord(value.counts) ||
      typeof value.watermark !== "number" ||
      typeof value.sourceRevision !== "number"
    )
      throw new Error(rendererErrorHint(value, "Artifacts list bridge returned an invalid result."));
    return value as unknown as ArtifactsListResult;
  },
};

export const artifactRowById = (
  rows: readonly ArtifactsListResult["artifacts"][number][],
  taskId: string | null,
  path: string | null,
): ArtifactsListResult["artifacts"][number] | null =>
  taskId === null || path === null ? null : (rows.find((row) => row.taskId === taskId && row.path === path) ?? null);
