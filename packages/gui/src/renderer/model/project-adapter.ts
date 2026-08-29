import type { SystemRepoRow } from "../api-client.ts";
import type { Project } from "./types.ts";

export function adaptRepoProject(
  repoId: string,
  repo: SystemRepoRow | undefined,
  presetId: string | undefined,
  watermarkAt: string,
): Project {
  return {
    id: repoId,
    name: repo?.displayName ?? "未选择项目",
    path: repo?.canonicalRoot ?? "unknown / 未投影",
    preset: presetId ?? "unknown / 未投影",
    engines: [],
    watermarkAt,
  };
}
