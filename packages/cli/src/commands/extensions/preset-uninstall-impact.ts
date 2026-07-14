import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  analyzePresetUninstallImpact,
  parseTaskContractSnapshot,
  type PresetRuntimeRequirement,
  type PresetUninstallImpactReport,
  type PresetUninstallTaskReference
} from "../../../../application/src/index.ts";
import {
  listTaskIndexPaths,
  readFrontmatter,
  readScalar,
  type HarnessLayoutInput,
  type PresetManifest
} from "../../../../kernel/src/index.ts";
import { readPresetManifestFromSourceResult } from "./preset-manifest-reader.ts";

export function buildPresetUninstallImpact(
  rootInput: HarnessLayoutInput,
  presetId: string,
  manifestPath: string
): PresetUninstallImpactReport {
  const decoded = readPresetManifestFromSourceResult(manifestPath);
  const preset = decoded.ok && decoded.value.id === presetId
    ? {
      id: decoded.value.id,
      version: decoded.value.version,
      runtimeRequirement: runtimeRequirement(decoded.value)
    }
    : { id: presetId, version: "unknown", runtimeRequirement: "unknown" as const };
  return analyzePresetUninstallImpact({
    preset,
    tasks: listTaskIndexPaths(rootInput).map((indexPath) => readTaskReference(indexPath, presetId))
  });
}

function readTaskReference(indexPath: string, targetPresetId: string): PresetUninstallTaskReference {
  const taskDir = path.dirname(indexPath);
  const fallbackTaskId = path.basename(taskDir).split("-")[0] || path.basename(taskDir);
  try {
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    if (!frontmatter) return unprovenTask(fallbackTaskId, targetPresetId, "INDEX.md missing frontmatter");
    const taskId = readScalar(frontmatter, "task_id") || fallbackTaskId;
    const contractPath = path.join(taskDir, "task-contract.json");
    const base = {
      taskId,
      status: readScalar(frontmatter, "  status"),
      packageDisposition: readScalar(frontmatter, "packageDisposition"),
      metadata: {
        vertical: readScalar(frontmatter, "vertical"),
        presetId: readScalar(frontmatter, "preset"),
        ...(readScalar(frontmatter, "profile") ? { profileId: readScalar(frontmatter, "profile") } : {})
      }
    };
    if (!existsSync(contractPath)) return base;
    try {
      return { ...base, snapshot: parseTaskContractSnapshot(readFileSync(contractPath, "utf8")) };
    } catch (error) {
      return {
        ...base,
        snapshotError: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    return unprovenTask(
      fallbackTaskId,
      targetPresetId,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function unprovenTask(taskId: string, presetId: string, snapshotError: string): PresetUninstallTaskReference {
  return {
    taskId,
    status: "unknown",
    packageDisposition: "unknown",
    metadata: { vertical: "unknown", presetId },
    snapshotError
  };
}

function runtimeRequirement(manifest: PresetManifest): PresetRuntimeRequirement {
  return manifest.kind === "process-action" || Object.keys(manifest.entrypoints ?? {}).length > 0
    ? "required"
    : "none";
}
