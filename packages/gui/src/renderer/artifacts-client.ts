import { guiInteractionPolicy } from "../api/renderer-dto.ts";
import type { ArtifactGuiKind, ArtifactsListResult, DaemonGuiReadPayloadMap } from "@harness-anything/daemon/protocol";
import { drainCursorPages } from "./paginated-read.ts";
import { isRendererRecord, rendererReadError } from "./result-validation.ts";
import { invoke } from "./api-client-invoke.ts";

// Renderer client for the artifacts timeline: paged `repo.artifacts.list` reads return
// the complete joined DTO — file inventory, task attribution and the time source are
// daemon facts; this file never scans, recomputes times, or re-derives kinds.
/** `repo.artifacts.list` 读面的 query key(产物页与总览速览架共用同一缓存,唯一定义点)。 */
export const artifactsQueryKeys = {
  list: (repoId: string, kind: ArtifactGuiKind) => ["artifacts", repoId, kind] as const,
};

export const artifactsClient = {
  list: async (
    repoId: string,
    kind: ArtifactGuiKind,
    scope: DaemonGuiReadPayloadMap["repo.works.index"] = {},
  ): Promise<ArtifactsListResult> => {
    const pages = await drainCursorPages(async (facets) => {
      const value = await invoke("repo.artifacts.list", {
        repoId,
        kind,
        limit: guiInteractionPolicy.defaultValue.pageSizes.artifacts,
        ...scope,
        ...facets,
      });
      if (
        !isRendererRecord(value) ||
        value.ok !== true ||
        !Array.isArray(value.artifacts) ||
        !isRendererRecord(value.counts) ||
        !isRendererRecord(value.page) ||
        !(
          value.page.nextCursor === null ||
          (typeof value.page.nextCursor === "string" && value.page.nextCursor.length > 0)
        ) ||
        typeof value.watermark !== "number" ||
        typeof value.sourceRevision !== "number"
      )
        throw rendererReadError(value, "Artifacts list bridge returned an invalid result.");
      return value as unknown as ArtifactsListResult;
    }, "artifacts list");
    return { ...pages[0], artifacts: pages.flatMap((page) => page.artifacts) };
  },
};

export const artifactRowById = (
  rows: readonly ArtifactsListResult["artifacts"][number][],
  taskId: string | null,
  path: string | null,
): ArtifactsListResult["artifacts"][number] | null =>
  taskId === null || path === null ? null : (rows.find((row) => row.taskId === taskId && row.path === path) ?? null);
